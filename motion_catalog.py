"""Motion indexing and scoped, local-only playback resources."""
import hashlib
import json
from pathlib import Path

from motion_assets import read_vmd
from model_assets import resolve_reference
from search_matching import KeywordMatcher

AUDIO = {".wav": "audio/wav", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".m4a": "audio/mp4"}
MOTION_DIRECTORY_SQL = "substr(a.path,1,length(a.path)-length(a.name)-1)"


class MotionCatalog:
    def motion_packages(self, filters, text=""):
        """Group indexed VMD siblings by full directory, before pagination or deduplication."""
        clauses, params = self.asset_filters({**filters, "kind": "motion", "name": ""})
        rows = self.rows("SELECT a.* FROM assets a WHERE " + " AND ".join(clauses), params)
        groups = {}
        for row in rows:
            groups.setdefault(str(Path(row["path"]).parent), []).append(row)
        matcher = KeywordMatcher(text) if text.strip() else None
        items = []
        for directory, members in groups.items():
            name = Path(directory).name
            if filters.get("name") and not any(filters["name"].casefold() in value.casefold()
                                               for value in [name, *(r["name"] for r in members)]):
                continue
            if matcher and not any(matcher.match([
                ("动作包", name, 60), ("目录", directory, 20), ("文件名", row["name"], 50),
                *(("标签", tag, 45) for tag in json.loads(row["tags"])),
            ])[0] for row in members):
                continue
            types, duration = {}, 0
            for row in members:
                info = json.loads(row["motion_data"] or "{}") if row["status"] == "ready" else {}
                kind = info.get("type", "other")
                types[kind] = types.get(kind, 0) + 1
                duration = max(duration, info.get("duration", 0))
            types = {kind: types[kind] for kind in ("body", "facial", "camera", "other") if kind in types}
            # Package cards are navigation records; source files keep their original IDs/metadata.
            item = self.public(members[0])
            item.update(id="motion-package-" + hashlib.sha256(directory.encode()).hexdigest()[:24],
                        name=name, path=directory, added=max(r["added"] for r in members),
                        thumbnail=None, favorite=False, tags=[], size=sum(r["size"] for r in members))
            item["motion_package"] = dict(path=directory, name=name, count=len(members),
                                           types=types, duration=duration,
                                           errors=sum(r["status"] == "error" for r in members))
            items.append(item)
        order = filters.get("sort", "newest")
        items.sort(key=(lambda a: (a["name"].casefold(), a["path"])) if order == "name"
                   else lambda a: (a["added"], a["path"]), reverse=order == "newest")
        offset, limit = max(0, filters.get("offset", 0)), min(1000, max(1, filters.get("limit", 200)))
        return dict(items=items[offset:offset + limit], total=len(items),
                    scope_total=sum(a["motion_package"]["count"] for a in items), offset=offset, limit=limit)

    def index_motion(self, aid, path, mtime, size):
        info = read_vmd(path)["info"]
        stat = path.stat()
        if stat.st_mtime_ns != mtime or stat.st_size != size:
            self.execute("UPDATE assets SET status='pending',vector=NULL WHERE id=?", (aid,))
            return
        self.execute("""UPDATE assets SET motion_data=?,hash=?,vector=NULL,thumbnail=NULL,
            width=0,height=0,status='ready',error=NULL WHERE id=?""",
                     (json.dumps(info, ensure_ascii=False), info["hash"], aid))

    def playback_source(self, aid, kind, ext):
        asset = self.get_asset(aid)
        if asset["kind"] != kind or asset["ext"] not in ext or asset["excluded"] or asset["archived"]:
            raise ValueError("此素材不能用于动作预览")
        folders = self.rows("SELECT * FROM folders WHERE id=?", (asset["folder_id"],))
        path = Path(asset["path"])
        if not folders or path.is_symlink() or not path.resolve().is_relative_to(Path(folders[0]["path"]).resolve()):
            raise ValueError("素材已离开关联目录")
        if self.excluded_path(path, folders[0]["path"], json.loads(folders[0]["exclusions"])):
            raise ValueError("素材已被排除")
        if not path.is_file():
            raise FileNotFoundError(path)
        limit = 128 if kind == "model" else 32
        if path.stat().st_size > limit * 1024**2:
            raise ValueError(f"动作预览的此类源文件上限为 {limit} MB")
        return asset, path

    def motion_payload(self, aid):
        _, path = self.playback_source(aid, "motion", {"vmd"})
        return read_vmd(path)

    def motion_companions(self, aid):
        asset, source = self.playback_source(aid, "motion", {"vmd"})
        motions = [self.public(row) for row in self.rows("""SELECT * FROM assets WHERE
            folder_id=? AND kind='motion' AND status='ready' AND excluded=0 AND archived=0""", (asset["folder_id"],))
                   if Path(row["path"]).parent == source.parent]
        files = []
        for path in sorted(source.parent.iterdir()):
            if path.name.startswith(".") or path.is_symlink() or not path.is_file():
                continue
            ext = path.suffix.lower()
            if ext not in AUDIO and ext != ".txt":
                continue
            if path.stat().st_size > (256 * 1024**2 if ext in AUDIO else 256 * 1024):
                continue
            files.append(dict(id=hashlib.sha256(path.name.encode()).hexdigest()[:24], name=path.name,
                              kind="audio" if ext in AUDIO else "document"))
        return dict(motions=motions, files=files)

    def motion_companion_file(self, aid, key):
        _, source = self.playback_source(aid, "motion", {"vmd"})
        item = next((f for f in self.motion_companions(aid)["files"] if f["id"] == key), None)
        if not item:
            raise ValueError("动作附件不存在")
        return source.parent / item["name"], item

    def motion_texture(self, aid, index):
        asset, source = self.playback_source(aid, "model", {"pmx"})
        resources = (asset.get("model") or {}).get("resources", [])
        if not 0 <= index < len(resources):
            raise ValueError("模型纹理不存在")
        resource = resources[index]
        path = Path(resource["path"]) if resource["path"] else None
        # Reference must still resolve to the indexed resource; never serve arbitrary renderer paths.
        if (not path or resource["kind"] != "texture" or not resource["exists"]
                or resolve_reference(source.parent, resource["reference"]) != path
                or path.is_symlink() or not path.resolve().is_relative_to(source.parent.resolve())):
            raise ValueError("纹理不在模型包内，请重新索引或检查路径")
        return path
