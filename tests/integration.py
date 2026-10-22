"""End-to-end tests against real HTTP, SQLite, filesystem watcher and MLX.

Images are synthetic fixtures, not an art retrieval quality benchmark.
Run from asset-search: .venv/bin/python tests/integration.py
PRISM_TEST_SERVICE can point to the frozen executable to test a standalone build.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import urllib.request

import httpx
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
TOKEN = "integration-test-token"


def eventually(fn, timeout=120):
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        try:
            last = fn()
            if last:
                return last
        except (httpx.ConnectError, httpx.ReadError):
            pass
        time.sleep(.25)
    raise AssertionError(f"Condition timed out; last={last!r}")


def draw(path, color, shape):
    image = Image.new("RGB", (384, 384), "white")
    d = ImageDraw.Draw(image)
    if shape == "circle":
        d.ellipse((64, 64, 320, 320), fill=color)
    elif shape == "square":
        d.rectangle((64, 64, 320, 320), fill=color)
    else:
        d.polygon([(192, 40), (340, 330), (44, 330)], fill=color)
    image.save(path)


def main():
    with tempfile.TemporaryDirectory(prefix="prism-integration-") as temporary:
        base = Path(temporary)
        fixtures, data = base / "fixtures", base / "data"
        fixtures.mkdir()
        draw(fixtures / "红圆.png", "red", "circle")
        draw(fixtures / "蓝方.jpg", "blue", "square")
        draw(fixtures / "绿三角.webp", "green", "triangle")
        (fixtures / "损坏.png").write_bytes(b"not an image")
        env = {**os.environ, "PRISM_DATA_DIR": str(data), "PRISM_TOKEN": TOKEN,
               "PRISM_MODEL_DIR": str(ROOT / "models/embeddinggemma-2-bf16"), "PYTHONUNBUFFERED": "1"}
        binary = os.environ.get("PRISM_TEST_SERVICE")
        command = [binary] if binary else [sys.executable, str(ROOT / "app_server.py")]
        process = client = None
        logs = (base / "service.log").open("w+")

        def start():
            nonlocal process, client
            process = subprocess.Popen(command, env=env, stdout=subprocess.PIPE, stderr=logs,
                                       text=True, cwd=base)
            line = process.stdout.readline()
            assert line.startswith("PRISM_ENDPOINT="), f"Service failed: {line}"
            port = json.loads(line.split("=", 1)[1])["port"]
            client = httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=120,
                                 headers={"Authorization": f"Bearer {TOKEN}"})
            eventually(lambda: client.get("/health").status_code == 200)

        def stop():
            nonlocal process, client
            if client:
                client.close()
            if process and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()

        def req(method, route, body=None):
            response = client.request(method, route, json=body)
            assert response.is_success, (route, response.status_code, response.text)
            return response.json()

        def summary():
            return req("GET", "/summary")

        def assets(**filters):
            return req("POST", "/assets/list", filters)

        def settled():
            return not any(j["status"] in {"queued", "running"} for j in summary()["jobs"])

        try:
            start()
            assert client.get("/summary", headers={"Authorization": ""}).status_code == 401
            folder = req("POST", "/folders", {"path": str(fixtures)})
            fid = folder["id"]
            eventually(settled)
            counts = summary()["counts"]
            assert counts.get("ready") == 3, counts
            assert counts.get("error") == 1, counts
            all_assets = assets()["items"]
            red = next(a for a in all_assets if a["name"] == "红圆.png")
            assert assets(ext="jpg")["total"] == 1
            assert assets(min_width=500)["total"] == 0
            assert assets(name="红圆")["total"] == 1
            assert assets(name="' OR 1=1 --")["total"] == 0
            assert assets(limit=2)["items"] != assets(limit=2, offset=2)["items"]
            req("PATCH", f"/assets/{red['id']}", {"favorite": True, "tags": ["测试", "形状", "测试"]})
            assert assets(favorite=True)["total"] == 1
            assert assets(tag="测试")["items"][0]["tags"] == ["测试", "形状"]
            for text, expected in [("白色背景上的红色圆形", "红圆.png"), ("白色背景上的蓝色正方形", "蓝方.jpg"),
                                   ("白色背景上的绿色三角形", "绿三角.webp")]:
                hits = req("POST", "/search", {"text": text})["items"]
                assert hits[0]["name"] == expected, [(a["name"], a["score"]) for a in hits]
            image_hits = req("POST", "/search", {"image_path": str(fixtures / "红圆.png")})["items"]
            assert image_hits[0]["id"] == red["id"]
            assert image_hits[0]["score"] > .99
            assert req("POST", "/search", {"text": "红色", "filters": {"ext": "jpg"}})["total"] == 1
            assert client.get(f"/assets/{red['id']}/thumbnail?token={TOKEN}", headers={"Authorization": ""}).status_code == 200
            assert client.get(f"/assets/{red['id']}/preview").headers["content-type"] == "image/webp"
            req("POST", f"/folders/{fid}/scan", {})
            eventually(settled)
            assert summary()["jobs"][0]["total"] == 0, "unchanged files reindexed"
            # Replace an existing file; the real watcher should catch this.
            before_hash = red["hash"]
            draw(fixtures / "红圆.png", "yellow", "circle")
            eventually(lambda: (a := req("GET", f"/assets/{red['id']}"))["status"] == "ready" and a["hash"] != before_hash)
            assert assets(tag="测试")["total"] == 1, "metadata lost during replacement"
            (fixtures / "蓝方.jpg").unlink()
            eventually(lambda: assets(status="missing")["total"] == 1)
            draw(fixtures / "损坏.png", "purple", "square")
            req("POST", f"/folders/{fid}/scan", {"retry": True})
            eventually(lambda: summary()["counts"].get("error", 0) == 0 and settled())
            assert assets()["total"] == 3
            stop()
            start()
            eventually(settled)
            assert assets(tag="测试", favorite=True)["total"] == 1
            assert assets(status="missing")["total"] == 1
            assert req("POST", "/search", {"asset_id": red["id"]})["items"][0]["id"] == red["id"]
            req("DELETE", f"/folders/{fid}")
            assert assets()["total"] == 0
            assert (fixtures / "红圆.png").is_file(), "original was removed"
            print(json.dumps({"ok": True, "runtime": "frozen" if binary else "venv",
                "checks": ["auth", "scan", "corrupt file", "filename/format/resolution filters", "pagination",
                           "tags/favorites", "Chinese text search x3", "image search", "thumbnail/preview",
                           "incremental no-op", "watcher edit/delete", "retry", "restart persistence",
                           "unlink preserves originals"]}, ensure_ascii=False), flush=True)
        except Exception:
            logs.flush()
            logs.seek(0)
            print(logs.read()[-7000:], file=sys.stderr)
            raise
        finally:
            stop()
            logs.close()


if __name__ == "__main__":
    main()
