"""Draw the app's geometric aperture icon with Pillow; no external image assets."""
from pathlib import Path
import math
import subprocess
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1]
iconset = root / "build/Prism.iconset"
iconset.mkdir(parents=True, exist_ok=True)
image = Image.new("RGBA", (1024, 1024))
d = ImageDraw.Draw(image)
d.rounded_rectangle((40, 40, 984, 984), radius=212, fill="#222a20", outline="#62714c", width=6)
d.rounded_rectangle((66, 66, 958, 958), radius=190, outline="#343f2d", width=3)
cx = cy = 512
for i in range(6):
    angle = math.radians(i * 60 - 90)
    points = []
    for radius, delta in [(307, 0), (307, 60), (143, 60), (143, 0)]:
        a = angle + math.radians(delta)
        points.append((cx + radius * math.cos(a), cy + radius * math.sin(a)))
    d.polygon(points, fill="#d4e8a1")
    d.line([points[0], points[2]], fill="#222a20", width=22)
for size in (16, 32, 128, 256, 512):
    for scale in (1, 2):
        output = iconset / f"icon_{size}x{size}{'@2x' if scale == 2 else ''}.png"
        image.resize((size * scale, size * scale), Image.Resampling.LANCZOS).save(output)
subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(root / "build/Prism.icns")], check=True)
