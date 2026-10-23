"""Build the installable add-on from its entry point and shared node builder."""
from pathlib import Path
import sys
import zipfile

root = Path(__file__).resolve().parents[1]
output = Path(sys.argv[1]) if len(sys.argv) > 1 else root.parent / "prism-blender-pbr-addon.zip"
with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED) as archive:
    archive.write(root / "blender_addon/prism_pbr/__init__.py", "prism_pbr/__init__.py")
    archive.write(root / "blender_material.py", "prism_pbr/blender_material.py")
print(output)
