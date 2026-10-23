"""Read-only snapshot of locally indexed character fixtures into an isolated test DB."""
from pathlib import Path
import os
import shutil
import sqlite3
import sys

repo = Path(__file__).resolve().parents[1]
source = Path(os.environ.get("PRISM_FIXTURE_LIBRARY", Path.home() / "Library/Application Support/Prism Assets/library"))
characters = (repo.parent / "datasets/character_model").resolve()
output = Path(sys.argv[1])
output.mkdir(parents=True, exist_ok=True)
db = sqlite3.connect(output / "catalog.sqlite3")
with sqlite3.connect(f"file:{source / 'catalog.sqlite3'}?mode=ro", uri=True) as original:
    original.backup(db)
db.row_factory = sqlite3.Row
db.execute("PRAGMA foreign_keys=ON")
db.execute("DELETE FROM assets WHERE path NOT LIKE ?", (str(characters) + "/%",))
fid = db.execute("SELECT folder_id FROM assets LIMIT 1").fetchone()[0]
db.execute("UPDATE assets SET folder_id=?", (fid,))
db.execute("DELETE FROM folders WHERE id!=?", (fid,))
db.execute("UPDATE folders SET path=?,name='角色样本',exclusions='[]' WHERE id=?", (str(characters), fid))
db.execute("DELETE FROM jobs")
db.execute("UPDATE collections SET parent_id=NULL")
db.execute("DELETE FROM collections")
db.commit()
(output / "thumbnails").mkdir(exist_ok=True)
for row in db.execute("SELECT thumbnail FROM assets WHERE thumbnail IS NOT NULL"):
    image = source / "thumbnails" / row[0]
    if image.exists():
        shutil.copyfile(image, output / "thumbnails" / row[0])
print("Isolated character fixture:", db.execute("SELECT count(*) FROM assets WHERE kind='model'").fetchone()[0])
db.close()
