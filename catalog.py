"""Persistent, linked-file catalog. Originals are never moved or modified."""
from __future__ import annotations

import concurrent.futures
import hashlib
import itertools
import json
import os
from pathlib import Path
import queue
import shutil
import sqlite3
import threading
import time
import uuid

import numpy as np
from PIL import Image, ImageOps
from model_assets import MODEL_EXTENSIONS, IMAGE_EXTENSIONS, dependency_stamp, prepare_model, blender_executable
from search_matching import KeywordMatcher
from auto_tags import AutoTagCatalog
from material_catalog import MaterialCatalog
from motion_catalog import MotionCatalog, MOTION_DIRECTORY_SQL
from motion_assets import MOTION_EXTENSIONS, MOTION_PROFILE

EXTENSIONS = IMAGE_EXTENSIONS | MODEL_EXTENSIONS | MOTION_EXTENSIONS
PROFILE = "embeddinggemma2:1a4ffddb7905d3f63486748deabe091a01fb6201:mlx0.7.9:768:exif-rgb-2048:v1"


class Inference:
    """One model, one inference thread; interactive queries precede indexing."""

    def __init__(self):
        self.queue = queue.PriorityQueue()
        self.sequence = itertools.count()
        self.status = "unloaded"
        self.error = None
        self.thread = threading.Thread(target=self.run, daemon=True, name="inference")
        self.thread.start()

    def submit(self, kind, value, priority=0):
        future = concurrent.futures.Future()
        self.queue.put((priority, next(self.sequence), future, kind, value))
        return future

    def run(self):
        model = None
        while True:
            _, _, future, kind, value = self.queue.get()
            if not future.set_running_or_notify_cancel():
                continue
            try:
                if model is None:
                    self.status = "loading"
                    from embed import Embedder
                    model = Embedder()
                    self.status, self.error = "ready", None
                if kind == "text":
                    vector = model.text([value])[0]
                else:
                    with Image.open(value) as image:
                        if image.width * image.height > 40_000_000:
                            raise ValueError("图片超过 4000 万像素")
                        vector = model.image(image)[0]
                future.set_result(vector)
            except Exception as exc:
                if model is None:
                    self.status, self.error = "error", str(exc)
                future.set_exception(exc)
            finally:
                self.queue.task_done()


class Catalog(MotionCatalog, MaterialCatalog, AutoTagCatalog):
    def __init__(self, root: Path, inference=None, watch=True):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self.thumbs = self.root / "thumbnails"
        self.thumbs.mkdir(exist_ok=True)
        self.models = self.root / "models"
        self.models.mkdir(exist_ok=True)
        self.init_materials()
        self.db = sqlite3.connect(self.root / "catalog.sqlite3", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
            CREATE TABLE IF NOT EXISTS folders(
                id TEXT PRIMARY KEY,path TEXT UNIQUE NOT NULL,name TEXT,
                status TEXT DEFAULT 'online',scanned REAL);
            CREATE TABLE IF NOT EXISTS assets(
                id TEXT PRIMARY KEY,folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
                path TEXT UNIQUE,name TEXT,ext TEXT,size INTEGER,mtime INTEGER,
                width INTEGER DEFAULT 0,height INTEGER DEFAULT 0,hash TEXT,
                thumbnail TEXT,vector BLOB,tags TEXT DEFAULT '[]',
                favorite INTEGER DEFAULT 0,status TEXT DEFAULT 'pending',error TEXT,
                added REAL,updated REAL);
            CREATE INDEX IF NOT EXISTS asset_folder ON assets(folder_id);
            CREATE INDEX IF NOT EXISTS asset_status ON assets(status);
            CREATE TABLE IF NOT EXISTS jobs(
                id TEXT PRIMARY KEY,folder_id TEXT REFERENCES folders(id) ON DELETE CASCADE,
                name TEXT,status TEXT,total INTEGER DEFAULT 0,done INTEGER DEFAULT 0,
                failed INTEGER DEFAULT 0,error TEXT,created REAL,finished REAL);
            CREATE TABLE IF NOT EXISTS collections(
                id TEXT PRIMARY KEY,name TEXT NOT NULL COLLATE NOCASE,created REAL,
                parent_id TEXT REFERENCES collections(id) ON DELETE RESTRICT);
            CREATE TABLE IF NOT EXISTS collection_assets(
                collection_id TEXT REFERENCES collections(id) ON DELETE CASCADE,
                asset_id TEXT REFERENCES assets(id) ON DELETE CASCADE,
                PRIMARY KEY(collection_id,asset_id));
            CREATE INDEX IF NOT EXISTS membership_asset ON collection_assets(asset_id);
            CREATE TABLE IF NOT EXISTS model_resources(
                model_id TEXT REFERENCES assets(id) ON DELETE CASCADE,
                path TEXT NOT NULL,relation TEXT NOT NULL,
                PRIMARY KEY(model_id,path));
            CREATE INDEX IF NOT EXISTS resource_path ON model_resources(path);
        """)
        self.migrate_collections()
        self.init_auto_tags()
        # Additive migration: preserve IDs, vectors, tags, favorites and paths.
        for table, column, declaration in [
            ("folders", "exclusions", "TEXT NOT NULL DEFAULT '[]'"),
            ("assets", "excluded", "INTEGER NOT NULL DEFAULT 0"),
            ("assets", "kind", "TEXT NOT NULL DEFAULT 'image'"),
            ("assets", "model_data", "TEXT"),
            ("assets", "material_data", "TEXT"),
            ("assets", "motion_data", "TEXT"),
            ("assets", "dependency_stamp", "TEXT"),
            ("assets", "archived", "INTEGER NOT NULL DEFAULT 0"),
            ("assets", "replacements", "TEXT NOT NULL DEFAULT '[]'"),
        ]:
            if column not in {r["name"] for r in self.rows(f"PRAGMA table_info({table})")}:
                self.execute(f"ALTER TABLE {table} ADD COLUMN {column} {declaration}")
        self.execute("CREATE INDEX IF NOT EXISTS asset_hash ON assets(hash)")
        self.execute("""CREATE TABLE IF NOT EXISTS relocation_history(
            id INTEGER PRIMARY KEY,asset_id TEXT,old_path TEXT,replacements TEXT,action TEXT,created REAL)""")
        old = self.rows("SELECT value FROM meta WHERE key='profile'")
        if old and old[0]["value"] != PROFILE:
            self.execute("UPDATE assets SET vector=NULL,status='pending' WHERE archived=0")
        self.execute("INSERT OR REPLACE INTO meta VALUES('profile',?)", (PROFILE,))
        motion_profile = self.rows("SELECT value FROM meta WHERE key='motion_profile'")
        if not motion_profile or motion_profile[0]["value"] != MOTION_PROFILE:
            self.execute("UPDATE assets SET status='pending',vector=NULL WHERE kind='motion' AND archived=0")
            self.execute("INSERT OR REPLACE INTO meta VALUES('motion_profile',?)", (MOTION_PROFILE,))
        self.execute("UPDATE jobs SET status='interrupted',error='上次退出时中断，已安排恢复' "
                     "WHERE status IN ('queued','running')")
        self.inference = inference or Inference()
        self.scan_queue = queue.Queue()
        self.active = set()
        self.rescan_again = set()
        self.stopping = threading.Event()
        self.observer = None
        self.worker = threading.Thread(target=self.scan_loop, daemon=True, name="scanner")
        self.worker.start()
        if watch:
            from watchdog.observers import Observer
            from watchdog.events import FileSystemEventHandler

            owner = self

            class Handler(FileSystemEventHandler):
                def on_any_event(self, event):
                    if event.event_type in {"opened", "closed_no_write"}:
                        return
                    owner.dirty.set()

            self.dirty = threading.Event()
            self.observer = Observer()
            self.handler = Handler()
            for folder in self.rows("SELECT * FROM folders"):
                self.watch_folder(folder["path"])
            self.observer.start()
            threading.Thread(target=self.watch_loop, daemon=True, name="watcher").start()
        for folder in self.rows("SELECT id FROM folders"):
            self.rescan(folder["id"])

    def execute(self, sql, params=()):
        with self.lock:
            cursor = self.db.execute(sql, params)
            self.db.commit()
            return cursor.rowcount

    def rows(self, sql, params=()):
        with self.lock:
            return [dict(r) for r in self.db.execute(sql, params).fetchall()]

    def watch_folder(self, path):
        if self.observer and Path(path).is_dir():
            try:
                self.observer.schedule(self.handler, path, recursive=True)
            except OSError:
                pass  # Periodic reconciliation also covers temporarily offline volumes.

    def watch_loop(self):
        while not self.stopping.wait(2):
            changed = self.dirty.is_set()
            self.dirty.clear()
            if changed:
                self.stopping.wait(1)  # Let image exports settle before scanning.
            if changed or time.monotonic() - getattr(self, "last_check", 0) > 60:
                self.last_check = time.monotonic()
                for folder in self.rows("SELECT id FROM folders"):
                    self.rescan(folder["id"], automatic=True)

    def add_folder(self, value):
        path = Path(value).expanduser().resolve(strict=True)
        if not path.is_dir():
            raise ValueError("请选择素材文件夹")
        if path == self.root or self.root in path.parents or path in self.root.parents:
            raise ValueError("请选择独立的素材目录，避免将应用数据目录纳入扫描")
        for folder in self.rows("SELECT * FROM folders"):
            other = Path(folder["path"])
            if other == path:
                self.rescan(folder["id"])
                return folder
            if other in path.parents or path in other.parents:
                raise ValueError("此目录与已关联目录重叠，请选择不重叠的文件夹")
        fid = uuid.uuid4().hex
        self.execute("INSERT INTO folders(id,path,name) VALUES(?,?,?)", (fid, str(path), path.name))
        self.watch_folder(str(path))
        self.rescan(fid)
        return self.rows("SELECT * FROM folders WHERE id=?", (fid,))[0]

    def remove_folder(self, fid):
        with self.lock:
            if fid in self.active:
                raise ValueError("目录正在索引，请等待任务完成后解除关联")
            thumbs = self.rows("SELECT id,thumbnail FROM assets WHERE folder_id=?", (fid,))
            self.execute("""DELETE FROM relocation_history WHERE asset_id IN
                (SELECT id FROM assets WHERE folder_id=?)""", (fid,))
            self.execute("DELETE FROM folders WHERE id=?", (fid,))
            for row in thumbs:
                if row["thumbnail"]:
                    (self.thumbs / row["thumbnail"]).unlink(missing_ok=True)
                shutil.rmtree(self.models / row["id"], ignore_errors=True)
                shutil.rmtree(self.materials / row["id"], ignore_errors=True)

    @staticmethod
    def excluded_path(path, base, rules):
        directories = Path(path).relative_to(base).parts[:-1]
        for rule in rules:
            parts = Path(rule).parts
            if not rule.startswith("./") and len(parts) == 1 and parts[0] in directories:
                return True
            if (rule.startswith("./") or len(parts) > 1) and directories[:len(parts)] == parts:
                return True
        return False

    @staticmethod
    def normalize_exclusions(rules):
        if len(rules) > 100:
            raise ValueError("最多设置 100 条目录排除规则")
        result = []
        for rule in rules:
            anchored = rule.startswith("./")
            value = (rule if anchored else rule.strip()).rstrip("/")
            path = Path(value)
            if (not value or path == Path(".") or path.is_absolute() or ".." in path.parts
                    or "\0" in value or (not anchored and any(c in value for c in "*?[]\\"))
                    or len(value) > 1000):
                raise ValueError("请输入相对目录路径，不支持 ..、通配符或绝对路径")
            # Checkbox selections are literal root-relative paths. Keep the marker
            # so a root-level selection cannot exclude same-named nested folders.
            normalized = ("./" if anchored else "") + str(path)
            if normalized not in result:
                result.append(normalized)
        return result

    def folder_directories(self, fid, parent=""):
        folders = self.rows("SELECT path FROM folders WHERE id=?", (fid,))
        if not folders:
            raise ValueError("目录不存在")
        path = Path(parent)
        if (path.is_absolute() or "\0" in parent or ".." in path.parts
                or any(part.startswith(".") for part in path.parts)):
            raise ValueError("请选择关联目录内的非隐藏文件夹")
        base = Path(folders[0]["path"])
        target = base
        try:
            # Check every component: an intermediate symlink must not escape
            # the associated root, even if the final entry is a real directory.
            if base.is_symlink():
                raise ValueError("关联目录已变为符号链接，请重新关联实际目录")
            for part in path.parts:
                target = target / part
                if target.is_symlink():
                    raise ValueError("不支持浏览符号链接目录")
            if not target.is_dir():
                raise FileNotFoundError(str(target))
            items = []
            with os.scandir(target) as entries:
                for entry in entries:
                    if not entry.name.startswith(".") and entry.is_dir(follow_symlinks=False):
                        items.append({"name": entry.name, "path": (path / entry.name).as_posix()})
            return {"items": sorted(items, key=lambda item: (item["name"].casefold(), item["name"]))}
        except FileNotFoundError:
            raise
        except OSError as exc:
            raise ValueError("无法读取文件夹，请检查访问权限或磁盘连接") from exc

    def reconcile_exclusions(self, fid, rules, base):
        changes = [(int(self.excluded_path(Path(a["path"]) / "_" if a["kind"] == "material" else a["path"], base, rules)), a["id"])
                   for a in self.rows("SELECT id,path,kind FROM assets WHERE folder_id=?", (fid,))]
        self.db.executemany("UPDATE assets SET excluded=? WHERE id=?", changes)

    def folder_exclusions(self, fid, rules, preview=False):
        rules = self.normalize_exclusions(rules)
        with self.lock:
            folders = self.rows("SELECT * FROM folders WHERE id=?", (fid,))
            if not folders:
                raise ValueError("目录不存在")
            folder = folders[0]
            assets = self.rows("SELECT path,kind,excluded FROM assets WHERE folder_id=? AND archived=0", (fid,))
            flags = [self.excluded_path(Path(a["path"]) / "_" if a["kind"] == "material" else a["path"], folder["path"], rules) for a in assets]
            result = {"rules": rules, "excluded_files": sum(flags),
                      "newly_excluded": sum(flag and not a["excluded"] for a, flag in zip(assets, flags)),
                      "restored_files": sum(not flag and a["excluded"] for a, flag in zip(assets, flags)),
                      "indexed_files_checked": len(assets)}
            if preview:
                return result
            with self.db:
                self.db.execute("UPDATE folders SET exclusions=? WHERE id=?",
                                (json.dumps(rules, ensure_ascii=False), fid))
                self.reconcile_exclusions(fid, rules, folder["path"])
            if fid in self.active:
                self.rescan_again.add(fid)
            else:
                self.rescan(fid)
            return result

    def rescan(self, fid, retry=False, automatic=False):
        with self.lock:
            folders = self.rows("SELECT * FROM folders WHERE id=?", (fid,))
            if not folders:
                raise ValueError("目录不存在")
            if fid in self.active:
                return {"status": "running"}
            jid = uuid.uuid4().hex
            self.active.add(fid)
            self.execute("INSERT INTO jobs(id,folder_id,name,status,created) VALUES(?,?,?,'queued',?)",
                         (jid, fid, folders[0]["name"], time.time()))
            self.scan_queue.put((jid, folders[0], retry, automatic, None))
            return {"id": jid, "status": "queued"}

    def retry_assets(self, ids=None, filters=None, refresh_models=False):
        """Retry failures; explicit IDs may also request a ready model preview refresh."""
        with self.lock:
            if refresh_models and not ids:
                raise ValueError("更新模型预览需要指定素材")
            if ids:
                ids = list(dict.fromkeys(self.resolve_asset_id(aid) for aid in ids))
                assets = self.rows("SELECT * FROM assets WHERE id IN (" + ",".join("?" for _ in ids) + ")", ids)
                if len(assets) != len(ids):
                    raise ValueError("部分素材不存在，请刷新后重试")
                assets = [a for a in assets if not a["excluded"] and not a["archived"] and
                          ((a["kind"] == "model" and a["status"] in ("ready", "error"))
                           if refresh_models else a["status"] == "error")]
            else:
                clauses, params = self.asset_filters({**(filters or {}), "status": "error"})
                assets = self.rows("SELECT a.* FROM assets a WHERE " + " AND ".join(clauses), params)
            response = {"queued": 0, "busy": 0, "jobs": []}
            groups = {}
            for asset in assets:
                groups.setdefault(asset["folder_id"], []).append(asset["id"])
            for fid, targets in groups.items():
                if fid in self.active:
                    response["busy"] += len(targets)
                    continue
                folder = self.rows("SELECT * FROM folders WHERE id=?", (fid,))[0]
                jid = uuid.uuid4().hex
                with self.db:
                    self.db.executemany("UPDATE assets SET status='pending',error=NULL,vector=NULL WHERE id=?",
                                        [(aid,) for aid in targets])
                    self.db.execute("INSERT INTO jobs(id,folder_id,name,status,created) VALUES(?,?,?,'queued',?)",
                                    (jid, fid, ("更新模型预览：" if refresh_models else "重试：") + folder["name"], time.time()))
                self.active.add(fid)
                self.scan_queue.put((jid, folder, False, False, targets))
                response["queued"] += len(targets)
                response["jobs"].append(jid)
            return response

    def scan_loop(self):
        while not self.stopping.is_set():
            try:
                jid, folder, retry, automatic, targets = self.scan_queue.get(timeout=.5)
            except queue.Empty:
                continue
            try:
                if targets is None:
                    self.scan(jid, folder, retry, automatic)
                else:
                    self.retry_job(jid, folder, targets)
            except Exception as exc:
                self.execute("UPDATE jobs SET status='failed',error=?,finished=? WHERE id=?",
                             (str(exc), time.time(), jid))
            finally:
                with self.lock:
                    self.active.discard(folder["id"])
                    if folder["id"] in self.rescan_again:
                        self.rescan_again.discard(folder["id"])
                        self.rescan(folder["id"])
                self.scan_queue.task_done()

    def retry_job(self, jid, folder, targets):
        self.execute("UPDATE jobs SET status='running',total=? WHERE id=?", (len(targets), jid))
        failed = 0
        for i, aid in enumerate(targets):
            if self.stopping.is_set():
                return
            asset = self.rows("SELECT * FROM assets WHERE id=?", (aid,))[0]
            try:
                if not asset["excluded"]:
                    path = Path(asset["path"])
                    stat = path.stat()
                    self.execute("UPDATE assets SET mtime=?,size=?,updated=? WHERE id=?",
                                 (stat.st_mtime_ns, stat.st_size, time.time(), aid))
                    self.index_one(aid, path, stat.st_mtime_ns, stat.st_size)
            except Exception as exc:
                failed += 1
                self.execute("UPDATE assets SET status=?,vector=NULL,error=? WHERE id=?",
                             ("missing" if isinstance(exc, FileNotFoundError) else "error", str(exc)[-1000:], aid))
            self.execute("UPDATE jobs SET done=?,failed=? WHERE id=?", (i + 1, failed, jid))
        self.execute("UPDATE jobs SET status=?,finished=? WHERE id=?",
                     ("partial" if failed else "completed", time.time(), jid))

    def scan(self, jid, folder, retry, automatic):
        fid, base = folder["id"], Path(folder["path"])
        self.execute("UPDATE jobs SET status='running' WHERE id=?", (jid,))
        if not base.is_dir():
            self.execute("UPDATE folders SET status='offline' WHERE id=?", (fid,))
            raise ValueError("目录不可访问，请重新连接磁盘后重试")
        existing = {a["path"]: a for a in self.rows("SELECT * FROM assets WHERE folder_id=?", (fid,))}
        rules = json.loads(folder["exclusions"])
        seen, pending = set(), []
        walk_errors = []
        for parent, dirs, files in os.walk(base, followlinks=False, onerror=walk_errors.append):
            dirs[:] = [d for d in dirs if not d.startswith(".") and not (Path(parent) / d).is_symlink()
                       and not self.excluded_path(Path(parent) / d / "_", base, rules)]
            for name in files:
                path = Path(parent) / name
                if name.startswith(".") or path.suffix.lower() not in EXTENSIONS or path.is_symlink():
                    continue
                key = str(path)
                seen.add(key)
                try:
                    stat = path.stat()
                except OSError as exc:
                    walk_errors.append(exc)
                    continue
                old = existing.get(key)
                kind = "model" if path.suffix.lower() in MODEL_EXTENSIONS else "motion" if path.suffix.lower() in MOTION_EXTENSIONS else "image"
                stamp = (dependency_stamp(path, json.loads(old["model_data"]) if old and old["model_data"] else None)
                         if kind == "model" else None)
                if (old and old["mtime"] == stat.st_mtime_ns and old["size"] == stat.st_size
                        and (kind != "model" or old["dependency_stamp"] == stamp)
                        and not old["archived"] and old["status"] != "pending" and old["status"] != "missing"
                        and not (retry and old["status"] == "error")):
                    continue
                aid = old["id"] if old else uuid.uuid4().hex
                now = time.time()
                with self.lock:
                    current_rules = json.loads(self.rows("SELECT exclusions FROM folders WHERE id=?", (fid,))[0]["exclusions"])
                    excluded = int(self.excluded_path(path, base, current_rules))
                    self.execute("""INSERT INTO assets(id,folder_id,path,name,ext,size,mtime,added,updated,excluded,kind,dependency_stamp)
                        VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET
                        size=excluded.size,mtime=excluded.mtime,status='pending',vector=NULL,error=NULL,
                        hash=NULL,updated=excluded.updated,excluded=excluded.excluded,
                        kind=excluded.kind,dependency_stamp=excluded.dependency_stamp,archived=0,replacements='[]'""",
                                 (aid, fid, key, name, path.suffix[1:].lower(), stat.st_size,
                                  stat.st_mtime_ns, now, now, excluded, kind, stamp))
                pending.append((aid, path, stat.st_mtime_ns, stat.st_size))
        # Re-read rules because they can change while a scan is running.
        with self.lock, self.db:
            current_rules = json.loads(self.rows("SELECT exclusions FROM folders WHERE id=?", (fid,))[0]["exclusions"])
            self.reconcile_exclusions(fid, current_rules, base)
        if walk_errors:
            self.execute("UPDATE folders SET status='error' WHERE id=?", (fid,))
        else:
            for key, old in existing.items():
                if old["kind"] != "material" and not old["archived"] and key not in seen and not self.excluded_path(key, base, rules) and not self.excluded_path(key, base, current_rules):
                    self.execute("UPDATE assets SET status='missing',vector=NULL WHERE id=?", (old["id"],))
            self.execute("UPDATE folders SET status='online',scanned=? WHERE id=?", (time.time(), fid))
        self.scan_materials(fid, base, current_rules, retry, pending)
        if automatic and not pending and not walk_errors:
            self.recover_missing(fid)
            self.refresh_model_groups(fid)
            self.execute("DELETE FROM jobs WHERE id=?", (jid,))
            return
        self.execute("UPDATE jobs SET total=? WHERE id=?", (len(pending), jid))
        failed = 0
        # Build parent cards before their dependent texture thumbnails.
        pending.sort(key=lambda item: item[1].is_file() and item[1].suffix.lower() not in MODEL_EXTENSIONS)
        for i, (aid, path, mtime, size) in enumerate(pending):
            if self.stopping.is_set():
                return
            try:
                if not self.rows("SELECT excluded FROM assets WHERE id=?", (aid,))[0]["excluded"]:
                    self.index_one(aid, path, mtime, size)
            except Exception as exc:
                failed += 1
                self.execute("UPDATE assets SET status='error',vector=NULL,error=? WHERE id=?",
                             (str(exc)[:1000], aid))
            self.execute("UPDATE jobs SET done=?,failed=? WHERE id=?", (i + 1, failed, jid))
        if not walk_errors:
            self.recover_missing(fid)
            self.refresh_model_groups(fid)
        self.execute("UPDATE jobs SET status=?,error=?,finished=? WHERE id=?",
                     ("failed" if walk_errors else "partial" if failed else "completed",
                      "; ".join(map(str, walk_errors))[:1000] if walk_errors else None, time.time(), jid))
        self.execute("""DELETE FROM jobs WHERE id NOT IN
            (SELECT id FROM jobs ORDER BY created DESC LIMIT 100) AND status NOT IN ('queued','running')""")

    def index_one(self, aid, path, mtime, size):
        if path.suffix.lower() in MOTION_EXTENSIONS:
            return self.index_motion(aid, path, mtime, size)
        if self.rows("SELECT kind FROM assets WHERE id=?", (aid,))[0]["kind"] == "material":
            return self.index_material(aid)
        if path.suffix.lower() in MODEL_EXTENSIONS:
            return self.index_model(aid, path)
        if size > 100 * 1024**2:
            raise ValueError("首版支持 100 MB 以内的图片")
        with Image.open(path) as image:
            if image.width * image.height > 40_000_000:
                raise ValueError("图片超过 4000 万像素")
            image = ImageOps.exif_transpose(image)
            width, height = image.size
            image.thumbnail((640, 640))
            image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
            thumbnail = f"{aid}-{mtime}.webp"
            temp = self.thumbs / f"{aid}.tmp"
            image.save(temp, "WEBP", quality=82)
            temp.replace(self.thumbs / thumbnail)
        digest = hashlib.sha256()
        with path.open("rb") as file:
            for chunk in iter(lambda: file.read(1024 * 1024), b""):
                digest.update(chunk)
        self.execute("UPDATE assets SET width=?,height=?,thumbnail=? WHERE id=?",
                     (width, height, thumbnail, aid))
        vector = self.inference.submit("image", str(path), priority=10).result(timeout=300)
        current = path.stat()
        if current.st_mtime_ns != mtime or current.st_size != size:
            # Do not publish an embedding computed from a moving source.
            self.execute("UPDATE assets SET status='pending',vector=NULL WHERE id=?", (aid,))
            return
        self.execute("UPDATE assets SET hash=?,vector=?,status='ready',error=NULL WHERE id=?",
                     (digest.hexdigest(), vector.astype(np.float32).tobytes(), aid))
        for old in self.thumbs.glob(f"{aid}-*.webp"):
            if old.name != thumbnail:
                old.unlink(missing_ok=True)

    def index_model(self, aid, path):
        before = dependency_stamp(path, json.loads(self.rows("SELECT model_data FROM assets WHERE id=?", (aid,))[0]["model_data"] or "{}"))
        generation = uuid.uuid4().hex
        output = self.models / aid / generation
        try:
            metadata = prepare_model(path, output)
            vectors = [self.inference.submit("image", str(output / f"view-{i}.png"), priority=10).result(timeout=300)
                       for i in range(2)]
            vector = np.mean(vectors, axis=0).astype(np.float32)
            vector /= max(float(np.linalg.norm(vector)), 1e-8)
            # Ensure source and locally discoverable dependencies did not move during conversion.
            old_metadata = json.loads(self.rows("SELECT model_data FROM assets WHERE id=?", (aid,))[0]["model_data"] or "{}")
            if before != dependency_stamp(path, old_metadata):
                self.execute("UPDATE assets SET status='pending',vector=NULL WHERE id=?", (aid,))
                shutil.rmtree(output, ignore_errors=True)
                return
            thumbnail = f"{aid}-{generation}.webp"
            with Image.open(output / "view-0.png") as image:
                image.save(self.thumbs / thumbnail, "WEBP", quality=88)
            metadata["cache"] = generation
            metadata["bound_textures"] = sum(r["kind"] == "texture" and r["relation"] == "bound" for r in metadata["resources"])
            metadata["auxiliary_files"] = sum(r["relation"] == "auxiliary" for r in metadata["resources"])
            metadata["missing_resources"] = sum(not r["exists"] for r in metadata["resources"])
            # The linked root can itself be a dedicated model folder.
            dedicated = sum(p.suffix.lower() in MODEL_EXTENSIONS
                            for p in path.parent.rglob("*") if p.is_file()) == 1
            with self.lock, self.db:
                self.db.execute("DELETE FROM model_resources WHERE model_id=?", (aid,))
                self.db.executemany("INSERT OR IGNORE INTO model_resources VALUES(?,?,?)",
                    [(aid, r["path"], r["relation"]) for r in metadata["resources"]
                     if r["path"] and r["kind"] == "texture" and (r["relation"] == "bound" or dedicated)])
                self.db.execute("""UPDATE assets SET model_data=?,dependency_stamp=?,thumbnail=?,hash=?,vector=?,
                    width=0,height=0,status='ready',error=NULL WHERE id=?""",
                    (json.dumps(metadata, ensure_ascii=False), metadata["dependency_stamp"], thumbnail,
                     metadata["content_hash"], vector.tobytes(), aid))
            for other in output.parent.iterdir():
                if other != output:
                    shutil.rmtree(other, ignore_errors=True)
            for old in self.thumbs.glob(f"{aid}-*.webp"):
                if old.name != thumbnail:
                    old.unlink(missing_ok=True)
        except Exception:
            shutil.rmtree(output, ignore_errors=True)
            raise

    def model_file(self, aid, filename):
        asset = self.get_asset(aid)
        if asset["kind"] != "model" or not asset.get("model") or asset["status"] not in ("ready", "error"):
            raise ValueError("模型预览尚未生成")
        path = self.models / asset["id"] / asset["model"]["cache"] / filename
        if not path.is_file():
            raise FileNotFoundError(path)
        return path

    def similar_vector(self, aid):
        aid = self.resolve_asset_id(aid)
        row = self.rows("SELECT * FROM assets WHERE id=?", (aid,))
        if not row or row[0]["status"] != "ready" or row[0]["vector"] is None:
            raise ValueError("请等待素材索引完成后再查找相似")
        return np.frombuffer(row[0]["vector"], dtype=np.float32)

    @staticmethod
    def public(asset):
        item = dict(asset)
        item.pop("vector", None)
        item["model"] = json.loads(item.pop("model_data") or "null")
        item["material"] = json.loads(item.pop("material_data", None) or "null")
        item["motion"] = json.loads(item.pop("motion_data", None) or "null")
        item["tags"] = json.loads(item["tags"])
        item["favorite"] = bool(item["favorite"])
        item["replacements"] = json.loads(item["replacements"])
        return item

    def resolve_asset_id(self, aid):
        visited = set()
        while aid not in visited:
            visited.add(aid)
            row = self.rows("SELECT archived,replacements FROM assets WHERE id=?", (aid,))
            if not row or not row[0]["archived"]:
                return aid
            targets = json.loads(row[0]["replacements"])
            if len(targets) != 1:
                return aid
            aid = targets[0]
        raise ValueError("恢复记录存在循环")

    def recovery_candidates(self, asset):
        """Only verified, online images inside this linked directory can replace a lost image."""
        if asset["kind"] != "image" or not asset["hash"]:
            return []
        candidates = []
        for row in self.rows("""SELECT * FROM assets WHERE folder_id=? AND hash=? AND id!=?
                AND kind='image' AND status='ready' AND excluded=0 AND archived=0""",
                (asset["folder_id"], asset["hash"], asset["id"])):
            try:
                stat = Path(row["path"]).stat()
                if stat.st_mtime_ns == row["mtime"] and stat.st_size == row["size"]:
                    candidates.append(row)
            except OSError:
                pass
        named = [a for a in candidates if a["name"].casefold() == asset["name"].casefold()]
        return sorted(named or candidates, key=lambda a: a["path"])

    def archive_relocation(self, old, candidates, action):
        ids = [a["id"] for a in candidates]
        if len(candidates) == 1:
            target = candidates[0]
            tags = list(dict.fromkeys(json.loads(target["tags"]) + json.loads(old["tags"])))
            # Migration can preserve more than the editor's 30-tag limit.
            self.db.execute("UPDATE assets SET tags=?,favorite=max(favorite,?) WHERE id=?",
                            (json.dumps(tags, ensure_ascii=False), old["favorite"], target["id"]))
            self.db.execute("""INSERT OR IGNORE INTO collection_assets(collection_id,asset_id)
                SELECT collection_id,? FROM collection_assets WHERE asset_id=?""", (target["id"], old["id"]))
        encoded = json.dumps(ids)
        self.db.execute("UPDATE assets SET archived=1,replacements=?,vector=NULL WHERE id=?", (encoded, old["id"]))
        self.db.execute("""INSERT INTO relocation_history(asset_id,old_path,replacements,action,created)
            VALUES(?,?,?,?,?)""", (old["id"], old["path"], encoded, action, time.time()))

    def recover_missing(self, fid=None):
        """Retain historical rows. Ambiguous annotated moves always require a user's choice."""
        result = {"recovered": 0, "duplicates": 0, "ambiguous": 0, "missing": 0}
        with self.lock, self.db:
            rows = self.rows("""SELECT a.* FROM assets a JOIN folders f ON f.id=a.folder_id
                WHERE a.status='missing' AND a.excluded=0 AND a.archived=0 AND f.status='online'"""
                + (" AND a.folder_id=?" if fid else ""), (fid,) if fid else ())
            for old in rows:
                if fid is None and old["folder_id"] in self.active:
                    continue
                # A file may have reappeared after enumeration: let the next scan handle it.
                if Path(old["path"]).exists():
                    continue
                candidates = self.recovery_candidates(old)
                annotated = old["favorite"] or json.loads(old["tags"]) or self.rows(
                    "SELECT 1 FROM collection_assets WHERE asset_id=? LIMIT 1", (old["id"],))
                if len(candidates) == 1:
                    self.archive_relocation(old, candidates, "reconnected")
                    result["recovered"] += 1
                elif candidates and not annotated:
                    self.archive_relocation(old, candidates, "duplicate_locations")
                    result["duplicates"] += 1
                else:
                    result["ambiguous" if candidates else "missing"] += 1
        return result

    def reconnect_asset(self, aid, target_id):
        with self.lock, self.db:
            rows = self.rows("SELECT * FROM assets WHERE id=? AND status='missing' AND archived=0", (aid,))
            if not rows or Path(rows[0]["path"]).exists():
                raise ValueError("此文件已恢复，请刷新")
            old = rows[0]
            if old["folder_id"] in self.active:
                raise ValueError("目录正在扫描，请完成后再恢复")
            candidates = self.recovery_candidates(old)
            target = next((a for a in candidates if a["id"] == target_id), None)
            if not target:
                raise ValueError("候选文件已变动，请重新扫描后选择")
            self.archive_relocation(old, [target], "user_reconnected")
        return self.get_asset(target_id)

    def get_asset(self, aid):
        aid = self.resolve_asset_id(aid)
        rows = self.rows("SELECT * FROM assets WHERE id=?", (aid,))
        if not rows:
            raise ValueError("素材不存在")
        item = self.public(rows[0])
        with self.lock:
            item["collections"] = self.rows("""SELECT c.id,c.name,c.parent_id FROM collections c JOIN collection_assets ca
                ON ca.collection_id=c.id WHERE ca.asset_id=? ORDER BY c.name""", (aid,))
            if item["collections"]:
                collection_paths = {c["id"]: c["path"] for c in self.collection_records()}
                for collection in item["collections"]:
                    collection["path"] = collection_paths[collection["id"]]
        item["owners"] = self.rows("""SELECT a.id,a.name,a.kind,r.relation FROM model_resources r JOIN assets a ON a.id=r.model_id
            WHERE r.path=? AND a.status!='missing' AND a.excluded=0 AND a.archived=0""", (item["path"],))
        if item["kind"] == "model":
            counts = self.rows("""SELECT count(*) resource_count,
                coalesce(sum(r.relation='bound'),0) bound_count,coalesce(sum(r.relation='auxiliary'),0) auxiliary_count
                FROM model_resources r JOIN assets child ON child.path=r.path
                WHERE r.model_id=? AND child.excluded=0 AND child.archived=0 AND child.status!='missing'""", (aid,))[0]
            item.update(counts)
        item["history"] = self.rows("""SELECT old_path,action,created FROM relocation_history
            WHERE EXISTS(SELECT 1 FROM json_each(replacements) WHERE value=?) ORDER BY created DESC""", (aid,))
        if item["status"] == "missing" and not item["archived"]:
            item["recovery_candidates"] = [self.public(a) for a in self.recovery_candidates(rows[0])]
        return item

    def copies(self, aid):
        asset = self.get_asset(aid)
        if not asset["hash"] or asset["status"] != "ready":
            return [asset]
        return [self.public(a) for a in self.rows("""SELECT * FROM assets WHERE hash=?
            AND status='ready' AND excluded=0 AND archived=0 ORDER BY path,id""", (asset["hash"],))]

    def asset_filters(self, filters):
        clauses, params = ["a.excluded=0", "a.archived=0"], []
        if filters.get("motion_package"):
            # Exact indexed parent only; descendants and same-named folders are separate packages.
            clauses.append("a.kind='motion' AND " + MOTION_DIRECTORY_SQL + "=?")
            params.append(filters["motion_package"])
        if filters.get("kind") in ("image", "model", "material", "motion"):
            clauses.append("a.kind=?")
            params.append(filters["kind"])
        if filters.get("kind") == "texture":
            clauses.append("a.kind='image' AND " + self.owned_sql())
        elif not filters.get("include_components") and not any(filters.get(k) for k in ("favorite", "collection_id", "tag", "status")) and filters.get("kind") != "image":
            clauses.append("NOT " + self.owned_sql())
        if filters.get("exclude_components"):
            clauses.append("NOT " + self.owned_sql())
        for key in ("folder_id", "status"):
            if filters.get(key):
                clauses.append(f"a.{key}=?")
                params.append(filters[key])
        if not filters.get("status"):
            clauses.append("a.status!='missing'")
        if filters.get("favorite"):
            clauses.append("a.favorite=1")
        if filters.get("ext"):
            exts = ("jpg", "jpeg") if filters["ext"] == "jpg" else (filters["ext"],)
            clauses.append("a.ext IN (" + ",".join("?" for _ in exts) + ")")
            params.extend(exts)
        if filters.get("name"):
            clauses.append("instr(lower(a.name),lower(?))>0")
            params.append(filters["name"])
        if filters.get("tag"):
            clauses.append("EXISTS(SELECT 1 FROM json_each(a.tags) WHERE value=?)")
            params.append(filters["tag"])
        if filters.get("collection_id"):
            clauses.append("EXISTS(SELECT 1 FROM collection_assets ca WHERE ca.asset_id=a.id AND ca.collection_id=?)")
            params.append(filters["collection_id"])
        if filters.get("model_id"):
            resource_clause = """EXISTS(SELECT 1 FROM model_resources r JOIN assets parent ON parent.id=r.model_id
                WHERE r.path=a.path AND r.model_id=? AND parent.excluded=0 AND parent.archived=0
                AND parent.status!='missing'""" + (" AND r.relation=?" if filters.get("relation") else "") + ")"
            if filters.get("include_model"):
                resource_clause = "(a.id=? OR " + resource_clause + ")"
                params.append(filters["model_id"])
            clauses.append(resource_clause)
            params.append(filters["model_id"])
            if filters.get("relation"):
                params.append(filters["relation"])
        if filters.get("min_width", 0):
            clauses.append("a.width>=?")
            params.append(filters["min_width"])
        return clauses, params

    def resource_groups(self, filters):
        clauses, params = self.asset_filters({**filters, "kind": "texture", "include_components": True})
        source = """FROM assets a JOIN model_resources r ON r.path=a.path JOIN assets parent ON parent.id=r.model_id
            WHERE parent.kind='model' AND parent.excluded=0 AND parent.archived=0 AND parent.status!='missing' AND """ + " AND ".join(clauses)
        rows = self.rows("""SELECT parent.id,count(*) count,
            sum(r.relation='bound') bound,sum(r.relation='auxiliary') auxiliary """
            + source + " GROUP BY parent.id ORDER BY parent.name COLLATE NOCASE,parent.id", params)
        return {"items": [{**self.get_asset(row["id"]), "resource_count": row["count"],
                          "bound_count": row["bound"], "auxiliary_count": row["auxiliary"]} for row in rows],
                "total": len(rows), "scope_total": sum(r["count"] for r in rows),
                "resource_total": self.rows("SELECT count(DISTINCT a.id) count " + source, params)[0]["count"]}

    def refresh_model_groups(self, fid):
        """Rebuild ownership from cached metadata, without rendering or embedding again."""
        models = self.rows("SELECT * FROM assets WHERE folder_id=? AND kind='model' AND status='ready' AND archived=0", (fid,))
        counts = {}
        for row in models:
            parent = Path(row["path"]).parent
            if parent not in counts:
                counts[parent] = sum(p.suffix.lower() in MODEL_EXTENSIONS for p in parent.rglob("*") if p.is_file())
            metadata = json.loads(row["model_data"] or "{}")
            if not metadata:
                continue
            with self.lock, self.db:
                self.db.execute("DELETE FROM model_resources WHERE model_id=?", (row["id"],))
                self.db.executemany("INSERT OR IGNORE INTO model_resources VALUES(?,?,?)",
                    [(row["id"], r["path"], r["relation"]) for r in metadata.get("resources", [])
                     if r["path"] and r["kind"] == "texture" and (r["relation"] == "bound" or counts[parent] == 1)])

    def text_assets(self, text, filters, vector=None, strategy="hybrid"):
        """Merge metadata hits and semantic candidates before Top-K, selecting the best matching copy."""
        matcher = KeywordMatcher(text)
        clauses, params = self.asset_filters(filters)
        where = " AND ".join(clauses)
        offset = max(0, int(filters.get("offset", 0)))
        limit = min(1000, max(1, int(filters.get("limit", 200))))
        top_k = min(200, max(1, int(filters.get("top_k", 50))))
        grouped = filters.get("group_duplicates", True)
        with self.lock:
            owners = {}
            for row in self.rows("""SELECT r.path,parent.name,json_extract(parent.model_data,'$.name') model_name
                FROM model_resources r JOIN assets parent ON parent.id=r.model_id
                WHERE parent.excluded=0 AND parent.archived=0 AND parent.status!='missing'"""):
                owners.setdefault(row["path"], []).extend([row["name"], row["model_name"] or ""])
            collections = {}
            collection_paths = {c["id"]: c["path"] for c in self.collection_records()}
            for row in self.rows("""SELECT ca.asset_id,c.id FROM collection_assets ca
                JOIN collections c ON c.id=ca.collection_id"""):
                collections.setdefault(row["asset_id"], []).append(collection_paths[row["id"]])
            groups, by_id = {}, {}
            rows = self.rows("""SELECT a.id,a.path,a.name,a.kind,a.tags,a.hash,a.status,a.added,
                json_extract(a.model_data,'$.name') model_name,f.path linked_root
                FROM assets a LEFT JOIN folders f ON f.id=a.folder_id WHERE """ + where, params)
            for asset in rows:
                path = Path(asset["path"])
                try:
                    directory = str(path.parent.relative_to(asset["linked_root"])) if asset["linked_root"] else path.parent.name
                except ValueError:
                    directory = path.parent.name
                fields = [("文件名", path.stem, 60), ("文件名", asset["name"], 55),
                          ("模型名称", asset["model_name"], 50), ("目录", directory, 20)]
                fields.extend(("标签", tag, 45) for tag in json.loads(asset["tags"]))
                fields.extend(("所属模型", name, 30) for name in owners.get(asset["path"], []))
                fields.extend(("集合", name, 15) for name in collections.get(asset["id"], []))
                strength, reasons = matcher.match(fields)
                key = "hash:" + asset["hash"] if grouped and asset["status"] == "ready" and asset["hash"] else "id:" + asset["id"]
                candidate = {**asset, "strength": strength, "keyword_fields": reasons, "score": None}
                group = groups.setdefault(key, {"members": [], "candidates": []})
                group["members"].append(asset["id"])
                group["candidates"].append(candidate)
                by_id[asset["id"]] = candidate
            # Keep vector memory bounded; metadata ranking does not depend on embedding availability.
            if vector is not None and strategy != "keyword":
                cursor = self.db.execute("SELECT a.id,a.vector FROM assets a WHERE " + where +
                    " AND a.status='ready' AND a.vector IS NOT NULL", params)
                while batch := cursor.fetchmany(512):
                    matrix = np.stack([np.frombuffer(r["vector"], dtype=np.float32) for r in batch])
                    for row, score in zip(batch, matrix @ vector):
                        by_id[row["id"]]["score"] = float(score)
            candidates = []
            keyword_total = 0
            for key, group in groups.items():
                keyword = [a for a in group["candidates"] if a["strength"]]
                semantic = [a for a in group["candidates"] if a["score"] is not None]
                keyword_total += bool(keyword)
                eligible = keyword if strategy == "keyword" else semantic if strategy == "semantic" else keyword or semantic
                if not eligible:
                    continue
                def rank(a):
                    strength = 0 if strategy == "semantic" else a["strength"]
                    score = a["score"] if a["score"] is not None else -2
                    return (-strength, -score, a["name"].casefold(), a["id"])
                best = min(eligible, key=rank)
                candidates.append((rank(best), key, best))
            if not keyword_total and strategy == "hybrid" and vector is not None:
                result = self.list_assets(filters, vector)
                for item in result["items"]:
                    item.update(match_kind="semantic", keyword_fields=[])
                return {**result, "keyword_total": 0, "returned_keyword": 0,
                        "strategy": "hybrid", "mode": "text", "semantic_available": True}
            candidates.sort(key=lambda row: row[0])
            total = min(top_k, len(candidates))
            items = []
            for _, key, chosen in candidates[offset:min(total, offset + limit)]:
                item = self.get_asset(chosen["id"])
                item["member_ids"] = sorted(groups[key]["members"])
                item["copy_count"] = len(item["member_ids"])
                item["keyword_fields"] = chosen["keyword_fields"] if strategy != "semantic" else []
                item["match_kind"] = ("semantic" if strategy == "semantic" else "both" if chosen["strength"] and chosen["score"] is not None
                                      else "keyword" if chosen["strength"] else "semantic")
                if chosen["score"] is not None:
                    item["score"] = round(chosen["score"], 4)
                items.append(item)
        return {"items": items, "total": total, "scope_total": len(rows), "unique_total": len(groups),
                "collapsed_count": len(rows) - len(groups), "offset": offset, "limit": limit, "top_k": top_k,
                "keyword_total": keyword_total, "returned_keyword": sum(bool(a["keyword_fields"]) for a in items),
                "strategy": strategy, "mode": "text", "semantic_available": vector is not None}

    def list_assets(self, filters, vector=None):
        clauses, params = self.asset_filters(filters)
        if vector is not None:
            clauses.append("a.status='ready' AND a.vector IS NOT NULL")
        where = " AND ".join(clauses)
        offset, limit = max(0, int(filters.get("offset", 0))), min(1000, max(1, int(filters.get("limit", 200))))
        order = {"name": "name COLLATE NOCASE ASC", "oldest": "added ASC",
                 "newest": "added DESC"}.get(filters.get("sort"), "added DESC")
        if filters.get("include_model"):
            order = "CASE WHEN kind='model' THEN 0 ELSE 1 END," + order
        group_key = ("CASE WHEN a.status='ready' AND a.hash IS NOT NULL THEN 'hash:'||a.hash ELSE 'id:'||a.id END"
                     if filters.get("group_duplicates", True) else "'id:'||a.id")
        cte = f"""WITH eligible AS (SELECT a.*,{group_key} AS group_key FROM assets a WHERE {where}),
            ranked AS (SELECT *,ROW_NUMBER() OVER (PARTITION BY group_key ORDER BY {order},id) rn,
                COUNT(*) OVER (PARTITION BY group_key) copy_count FROM eligible)"""
        with self.lock:
            counts = self.rows(cte + " SELECT count(*) scope_total,count(DISTINCT group_key) unique_total FROM eligible", params)[0]
            total = counts["unique_total"]
            if vector is not None:
                total = min(total, int(filters.get("top_k", 50)))
                limit = min(limit, max(0, total - offset))
                # Score one representative per exact-content group, retaining only Top-K.
                top = []
                cursor = self.db.execute(cte + " SELECT id,vector,group_key,copy_count FROM ranked WHERE rn=1", params)
                while batch := cursor.fetchmany(512):
                    matrix = np.stack([np.frombuffer(r["vector"], dtype=np.float32) for r in batch])
                    scores = matrix @ vector
                    top.extend((float(score), row["id"], row["group_key"], row["copy_count"])
                               for score, row in zip(scores, batch))
                    top = sorted(top, key=lambda r: (-r[0], r[1]))[:total]
                chosen = [{"id": aid, "group_key": group, "copy_count": count, "score": round(score, 4)}
                          for score, aid, group, count in top[offset:offset + limit]]
            else:
                chosen = self.rows(cte + f" SELECT id,group_key,copy_count FROM ranked WHERE rn=1 ORDER BY {order},id LIMIT ? OFFSET ?",
                                   (*params, limit, offset))
            items = []
            for row in chosen:
                item = self.get_asset(row["id"])
                item["copy_count"] = row["copy_count"]
                item["member_ids"] = [a["id"] for a in self.rows(
                    cte + " SELECT id FROM eligible WHERE group_key=? ORDER BY id", (*params, row["group_key"]))]
                if "score" in row:
                    item["score"] = row["score"]
                items.append(item)
        return {"items": items, "total": total, "offset": offset, "limit": limit, **counts,
                "collapsed_count": counts["scope_total"] - counts["unique_total"],
                "top_k": int(filters.get("top_k", 50)) if vector is not None else None}

    @staticmethod
    def valid_tags(tags):
        tags = list(dict.fromkeys(t.strip() for t in tags if t.strip()))
        if len(tags) > 30 or any(len(t) > 64 for t in tags):
            raise ValueError("最多 30 个标签，每个不超过 64 字")
        return tags

    def bulk_update(self, ids, changes):
        ids = list(dict.fromkeys(self.resolve_asset_id(aid) for aid in ids))
        if not ids or len(ids) > 5000:
            raise ValueError("每次请选择 1–5000 个文件")
        with self.lock, self.db:
            rows = self.rows("SELECT id,tags FROM assets WHERE excluded=0 AND archived=0 AND id IN (" +
                             ",".join("?" for _ in ids) + ")", ids)
            if len(rows) != len(ids):
                raise ValueError("部分素材已移除或被排除，请刷新后重新选择")
            cid = changes.get("collection_id")
            if cid and not self.rows("SELECT id FROM collections WHERE id=?", (cid,)):
                raise ValueError("集合不存在")
            updates = []
            for row in rows:
                tags = json.loads(row["tags"])
                removed = {t.strip() for t in changes.get("remove_tags", [])}
                tags = self.valid_tags([t for t in tags if t not in removed] + changes.get("add_tags", []))
                updates.append((json.dumps(tags, ensure_ascii=False), row["id"]))
            self.db.executemany("UPDATE assets SET tags=? WHERE id=?", updates)
            if changes.get("favorite") is not None:
                self.db.executemany("UPDATE assets SET favorite=? WHERE id=?",
                                    [(int(changes["favorite"]), aid) for aid in ids])
            if cid:
                if changes.get("collection_action", "add") == "remove":
                    self.db.executemany("DELETE FROM collection_assets WHERE collection_id=? AND asset_id=?",
                                        [(cid, aid) for aid in ids])
                else:
                    self.db.executemany("INSERT OR IGNORE INTO collection_assets VALUES(?,?)",
                                        [(cid, aid) for aid in ids])
        return {"updated": len(ids)}

    def migrate_collections(self):
        """Rebuild the legacy global-name constraint without cascading memberships."""
        if "parent_id" not in {r["name"] for r in self.rows("PRAGMA table_info(collections)")}:
            backup_path = self.root / "catalog-before-collection-tree.sqlite3"
            if not backup_path.exists():
                with sqlite3.connect(backup_path) as backup:
                    self.db.backup(backup)
            self.db.commit()
            self.db.execute("PRAGMA foreign_keys=OFF")
            try:
                self.db.executescript("""
                    BEGIN IMMEDIATE;
                    CREATE TABLE collections_tree(
                        id TEXT PRIMARY KEY,name TEXT NOT NULL COLLATE NOCASE,created REAL,
                        parent_id TEXT REFERENCES collections_tree(id) ON DELETE RESTRICT);
                    INSERT INTO collections_tree(id,name,created) SELECT id,name,created FROM collections;
                    DROP TABLE collections;
                    ALTER TABLE collections_tree RENAME TO collections;
                    COMMIT;
                """)
            except Exception:
                self.db.rollback()
                raise
            finally:
                self.db.execute("PRAGMA foreign_keys=ON")
        self.execute("""CREATE UNIQUE INDEX IF NOT EXISTS collection_sibling_name
            ON collections(coalesce(parent_id,''),name COLLATE NOCASE)""")
        self.execute("CREATE INDEX IF NOT EXISTS collection_parent ON collections(parent_id)")

    def collection_records(self, counts=False):
        """Return flat records with complete paths; membership counts are direct only."""
        with self.lock:
            if counts:
                records = self.rows("""SELECT c.*,count(a.id) count FROM collections c
                    LEFT JOIN collection_assets ca ON ca.collection_id=c.id
                    LEFT JOIN assets a ON a.id=ca.asset_id AND a.excluded=0 AND a.archived=0 AND a.status!='missing'
                    GROUP BY c.id ORDER BY c.name COLLATE NOCASE,c.id""")
            else:
                records = self.rows("SELECT * FROM collections ORDER BY name COLLATE NOCASE,id")
            by_id = {c["id"]: c for c in records}
            children = {}
            for record in records:
                children[record["parent_id"]] = children.get(record["parent_id"], 0) + 1
            paths = {}
            for record in records:
                trail, seen, current = [], set(), record
                while current and current["id"] not in paths:
                    if current["id"] in seen:
                        raise ValueError("集合层级存在循环")
                    seen.add(current["id"])
                    trail.append(current)
                    current = by_id.get(current["parent_id"])
                prefix = paths[current["id"]] if current else []
                for ancestor in reversed(trail):
                    prefix = prefix + [ancestor["id"]]
                    paths[ancestor["id"]] = prefix
                record["ancestor_ids"] = paths[record["id"]][:-1]
                record["path"] = " / ".join(by_id[aid]["name"] for aid in paths[record["id"]])
                record["child_count"] = children.get(record["id"], 0)
            return records

    def save_collection(self, name, cid=None, parent_id=None, *, change_parent=False):
        name = name.strip()
        if not name or len(name) > 64:
            raise ValueError("集合名称需要 1–64 个字符")
        with self.lock, self.db:
            records = {c["id"]: c for c in self.collection_records()}
            if cid and cid not in records:
                raise ValueError("集合不存在")
            if cid and not change_parent:
                parent_id = records[cid]["parent_id"]
            parent_id = parent_id or None
            if parent_id and parent_id not in records:
                raise ValueError("父集合不存在")
            if cid and parent_id and (parent_id == cid or cid in records[parent_id]["ancestor_ids"]):
                raise ValueError("不能将集合放入自身或其子集合")
            try:
                if cid:
                    self.db.execute("UPDATE collections SET name=?,parent_id=? WHERE id=?", (name, parent_id, cid))
                else:
                    cid = uuid.uuid4().hex
                    self.db.execute("INSERT INTO collections(id,name,created,parent_id) VALUES(?,?,?,?)",
                                    (cid, name, time.time(), parent_id))
            except sqlite3.IntegrityError as exc:
                raise ValueError("同一父集合下已存在同名集合") from exc
            return next(c for c in self.collection_records() if c["id"] == cid)

    def remove_collection(self, cid):
        with self.lock, self.db:
            if self.rows("SELECT id FROM collections WHERE parent_id=? LIMIT 1", (cid,)):
                raise ValueError("此集合包含子集合，请先移出或删除子集合")
            if not self.db.execute("DELETE FROM collections WHERE id=?", (cid,)).rowcount:
                raise ValueError("集合不存在")

    def update_asset(self, aid, changes):
        with self.lock, self.db:
            aid = self.resolve_asset_id(aid)
            if self.get_asset(aid)["archived"]:
                raise ValueError("此旧位置已归档，请打开现存副本后整理")
            if "tags" in changes:
                tags = self.valid_tags(changes["tags"])
                self.db.execute("UPDATE assets SET tags=? WHERE id=?", (json.dumps(tags, ensure_ascii=False), aid))
            if "favorite" in changes:
                self.db.execute("UPDATE assets SET favorite=? WHERE id=?", (int(changes["favorite"]), aid))
            return self.get_asset(aid)

    def summary(self):
        counts = {r["status"]: r["n"] for r in self.rows("SELECT status,count(*) n FROM assets WHERE excluded=0 AND archived=0 GROUP BY status")}
        folders = self.rows("""SELECT f.*,count(a.id) AS count FROM folders f LEFT JOIN assets a
            ON a.folder_id=f.id AND a.status!='missing' AND a.excluded=0 AND a.archived=0 GROUP BY f.id ORDER BY f.name""")
        for folder in folders:
            folder["exclusions"] = json.loads(folder["exclusions"])
            folder["excluded_count"] = self.rows("SELECT count(*) n FROM assets WHERE folder_id=? AND excluded=1 AND archived=0", (folder["id"],))[0]["n"]
        tags = self.rows("""SELECT j.value AS name,count(*) AS count FROM assets a,json_each(a.tags) j
            WHERE a.status!='missing' AND a.excluded=0 AND a.archived=0 GROUP BY j.value ORDER BY count DESC,j.value LIMIT 100""")
        collections = self.collection_records(counts=True)
        return {"counts": counts, "total": sum(v for k, v in counts.items() if k != "missing"),
                "models": self.rows("SELECT count(*) n FROM assets WHERE kind='model' AND excluded=0 AND archived=0 AND status!='missing'")[0]["n"],
                "materials": self.rows("SELECT count(*) n FROM assets WHERE kind='material' AND excluded=0 AND archived=0 AND status!='missing'")[0]["n"],
                "motions": self.rows("SELECT count(*) n FROM assets WHERE kind='motion' AND excluded=0 AND archived=0 AND status!='missing'")[0]["n"],
                "motion_packages": self.rows("SELECT count(DISTINCT " + MOTION_DIRECTORY_SQL + ") n FROM assets a WHERE kind='motion' AND excluded=0 AND archived=0 AND status!='missing'")[0]["n"],
                "components": self.rows("SELECT count(*) n FROM assets a WHERE a.excluded=0 AND a.archived=0 AND a.status!='missing' AND " + self.owned_sql())[0]["n"],
                "independent_images": self.rows("""SELECT count(*) n FROM assets a WHERE a.kind='image'
                    AND a.excluded=0 AND a.archived=0 AND a.status!='missing' AND NOT """ + self.owned_sql())[0]["n"],
                "blender_available": bool(blender_executable()),
                "favorites": self.rows("SELECT count(*) n FROM assets WHERE favorite=1 AND status!='missing' AND excluded=0 AND archived=0")[0]["n"],
                "recovery": self.rows("""SELECT action,count(*) count FROM relocation_history GROUP BY action"""),
                "collections": collections,
                "folders": folders, "tags": tags, "model": self.inference.status,
                "model_error": self.inference.error, "data_dir": str(self.root),
                "jobs": self.rows("SELECT * FROM jobs ORDER BY created DESC LIMIT 20")}

    @staticmethod
    def owned_sql():
        return """EXISTS(SELECT 1 FROM model_resources r JOIN assets parent ON parent.id=r.model_id
            WHERE r.path=a.path AND parent.excluded=0 AND parent.archived=0 AND parent.status!='missing')"""

    def close(self):
        self.stopping.set()
        if self.observer:
            self.observer.stop()
            self.observer.join(timeout=2)
        # Interrupted jobs are reconciled on the next launch, not marked complete.
