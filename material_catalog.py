"""First-class PBR definitions, versioned caches and portable exports."""
import io
import json
from pathlib import Path
import shutil
import threading
import time
import uuid
import zipfile

import numpy as np
from PIL import Image

from material_assets import (ROLES, normalize_material, prepare_material, render_material,
                             material_stamp, texture_file)


class MaterialCatalog:
    def init_materials(self):
        self.materials = self.root / "materials"
        self.materials.mkdir(exist_ok=True)
        self.material_previews = self.root / "material-previews"
        self.material_previews.mkdir(exist_ok=True)
        self.material_preview_lock = threading.RLock()

    def preview_material(self, config):
        config = normalize_material(config)
        stamp = material_stamp(config)
        with self.material_preview_lock:
            output = self.material_previews / stamp
            if (output / "material.json").is_file():
                metadata = json.loads((output / "material.json").read_text())
                output.touch()
            else:
                try:
                    metadata = prepare_material(config, output)
                    if material_stamp(config) != stamp:
                        raise ValueError("贴图在读取时发生变化，请重新预览")
                except Exception:
                    shutil.rmtree(output, ignore_errors=True)
                    raise
            directories = sorted(self.material_previews.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True)
            total = 0
            for index, directory in enumerate(directories):
                total += sum(p.stat().st_size for p in directory.iterdir() if p.is_file())
                if directory != output and (index >= 24 or total > 256 * 1024**2):
                    shutil.rmtree(directory, ignore_errors=True)
            return {**metadata, "preview_id": stamp}

    def material_preview_file(self, preview_id, role):
        if len(preview_id) != 64 or any(c not in "0123456789abcdef" for c in preview_id) or role not in ROLES:
            raise ValueError("材质预览不存在")
        path = self.material_previews / preview_id / f"{role}.png"
        if not path.is_file():
            raise FileNotFoundError(path)
        return path

    def material_definition(self, aid):
        rows = self.rows("SELECT * FROM assets WHERE id=? AND kind='material'", (aid,))
        if not rows:
            raise ValueError("材质不存在")
        return rows[0], json.loads(rows[0]["material_data"])

    def material_owners(self, aid, config):
        self.db.execute("DELETE FROM model_resources WHERE model_id=?", (aid,))
        self.db.executemany("INSERT OR IGNORE INTO model_resources VALUES(?,?,'bound')",
            [(aid, str(Path(config["source_dir"]) / relative))
             for relative in {b["file"] for b in config["maps"].values()}])

    def save_material(self, config, aid=None):
        config = normalize_material(config)
        base = Path(config["source_dir"])
        with self.lock:
            old, metadata = self.material_definition(aid) if aid else (None, {})
            if old and old["path"] != str(base):
                raise ValueError("编辑材质不能更换源目录，请另行导入")
            if not aid and self.rows("SELECT id FROM assets WHERE path=?", (str(base),)):
                raise ValueError("此目录已有材质，请选择该材质进行编辑")
            if base == self.root or self.root in base.parents or base in self.root.parents:
                raise ValueError("请选择独立的材质目录，避免包含应用数据")
            folders = self.rows("SELECT * FROM folders")
            folder = next((f for f in folders if base == Path(f["path"]) or Path(f["path"]) in base.parents), None)
            if any(base in Path(f["path"]).parents for f in folders):
                raise ValueError("材质目录包含已关联目录，请选择一个独立材质包")
            if folder and folder["id"] in self.active:
                raise ValueError("目录正在索引，请等待任务完成后保存材质")
            new_folder = not folder
            if new_folder:
                folder = {"id": uuid.uuid4().hex, "path": str(base), "name": base.name, "exclusions": "[]"}
            aid = aid or uuid.uuid4().hex
            metadata["config"] = config
            now = time.time()
            excluded = int(self.excluded_path(base / "_", folder["path"], json.loads(folder["exclusions"])))
            with self.db:
                if new_folder:
                    self.db.execute("INSERT INTO folders(id,path,name) VALUES(?,?,?)",
                                    (folder["id"], str(base), base.name))
                self.db.execute("""INSERT INTO assets(id,folder_id,path,name,ext,kind,size,mtime,
                    material_data,excluded,added,updated) VALUES(?,?,?,?,'material','material',0,0,?,?,?,?)
                    ON CONFLICT(id) DO UPDATE SET name=excluded.name,material_data=excluded.material_data,
                    status='pending',error=NULL,vector=NULL,hash=NULL,updated=excluded.updated""",
                    (aid, folder["id"], str(base), config["name"], json.dumps(metadata, ensure_ascii=False), excluded, now, now))
                self.material_owners(aid, config)
            if new_folder:
                self.watch_folder(str(base))
            self.rescan(folder["id"])
            return self.get_asset(aid)

    def remove_material(self, aid):
        with self.lock:
            row, _ = self.material_definition(aid)
            if row["folder_id"] in self.active:
                raise ValueError("目录正在索引，请等待任务完成后移除材质")
            with self.db:
                self.db.execute("DELETE FROM assets WHERE id=?", (aid,))
            shutil.rmtree(self.materials / aid, ignore_errors=True)
            for thumb in self.thumbs.glob(f"{aid}-*.webp"):
                thumb.unlink(missing_ok=True)

    def scan_materials(self, fid, base, rules, retry, pending):
        for row in self.rows("SELECT * FROM assets WHERE folder_id=? AND kind='material'", (fid,)):
            metadata = json.loads(row["material_data"])
            config = metadata["config"]
            if self.excluded_path(Path(row["path"]) / "_", base, rules):
                continue
            if not Path(row["path"]).is_dir():
                self.execute("UPDATE assets SET status='missing',vector=NULL,error='材质目录已失联' WHERE id=?", (row["id"],))
                continue
            stamp = material_stamp(config)
            if (stamp != row["dependency_stamp"] or row["status"] in ("pending", "missing")
                    or retry and row["status"] == "error"):
                self.execute("UPDATE assets SET status='pending',vector=NULL,error=NULL,dependency_stamp=? WHERE id=?",
                             (stamp, row["id"]))
                pending.append((row["id"], Path(row["path"]), 0, 0))

    def index_material(self, aid):
        row, definition = self.material_definition(aid)
        config = definition["config"]
        before = material_stamp(config)
        generation = uuid.uuid4().hex
        output = self.materials / aid / generation
        try:
            metadata = prepare_material(config, output)
            render_material(output)
            vector = self.inference.submit("image", str(output / "view-0.png"), priority=10).result(timeout=300)
            if before != material_stamp(config):
                self.execute("UPDATE assets SET status='pending',vector=NULL WHERE id=?", (aid,))
                self.rescan_again.add(row["folder_id"])
                shutil.rmtree(output, ignore_errors=True)
                return
            thumbnail = f"{aid}-{generation}.webp"
            with Image.open(output / "view-0.png") as image:
                image.save(self.thumbs / thumbnail, "WEBP", quality=88)
            published = {**metadata, "cache": generation}
            # Keep pending config distinct from the previously published channel maps.
            definition = {"config": config, "published": published}
            total = sum(texture_file(Path(config["source_dir"]), name).stat().st_size
                        for name in {b["file"] for b in config["maps"].values()})
            with self.lock, self.db:
                self.db.execute("""UPDATE assets SET material_data=?,dependency_stamp=?,thumbnail=?,hash=?,
                    vector=?,size=?,status='ready',error=NULL WHERE id=?""",
                    (json.dumps(definition, ensure_ascii=False), before, thumbnail, before,
                     vector.astype(np.float32).tobytes(), total, aid))
                self.material_owners(aid, config)
            for other in output.parent.iterdir():
                if other != output:
                    shutil.rmtree(other, ignore_errors=True)
            for old in self.thumbs.glob(f"{aid}-*.webp"):
                if old.name != thumbnail:
                    old.unlink(missing_ok=True)
        except Exception:
            shutil.rmtree(output, ignore_errors=True)
            raise

    def material_file(self, aid, role, generation=""):
        _, definition = self.material_definition(aid)
        published = definition.get("published")
        if not published or role not in published["maps"]:
            raise ValueError("材质通道尚未生成")
        if generation and generation != published["cache"]:
            raise ValueError("材质已更新，请重新打开预览以读取最新版本")
        path = self.materials / aid / published["cache"] / f"{role}.png"
        if not path.is_file():
            raise FileNotFoundError(path)
        return path

    def export_material(self, aid):
        with self.lock:
            row, definition = self.material_definition(aid)
            published = definition.get("published")
            if row["status"] != "ready" or not published or material_stamp(definition["config"]) != row["dependency_stamp"]:
                raise ValueError("请等待最新材质索引完成后导出；贴图变化时请重新扫描")
            config = dict(published["config"])
            config.pop("source_dir", None)
            config["normal_format"] = "opengl"
            maps = {role: {"cache_file": f"textures/{role}.png", "color_space": info["color_space"]}
                    for role, info in published["maps"].items()}
            config["maps"] = {role: {"file": info["cache_file"],
                                   "channel": "rgb" if role in ("base_color", "normal", "emissive") else "r", "invert": False}
                              for role, info in maps.items()}
            stream = io.BytesIO()
            with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
                archive.writestr("material.json", json.dumps({"format": "prism-pbr", "version": 1,
                    "config": config, "maps": maps}, ensure_ascii=False, indent=2))
                archive.writestr("README.txt", "Prism PBR v1. Normalized OpenGL PNG maps (maximum 2048 px). "
                    "Import with the Prism Blender add-on. AO is retained as engine data.\n")
                for role in maps:
                    archive.write(self.material_file(aid, role), maps[role]["cache_file"])
            return stream.getvalue()
