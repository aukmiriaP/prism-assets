"""Prism desktop API: authenticated loopback service with an OS-assigned port."""
import io
import json
import os
from pathlib import Path
import secrets
import socket
import sys
import tempfile
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from catalog import Catalog

TOKEN = os.environ.get("PRISM_TOKEN") or secrets.token_urlsafe(32)
ROOT = Path(os.environ.get("PRISM_DATA_DIR", Path.home() / "Library/Application Support/Prism Assets/library"))


@asynccontextmanager
async def lifespan(app):
    app.state.catalog = Catalog(ROOT)
    yield
    app.state.catalog.close()


app = FastAPI(title="Prism Assets", version="0.3.0", lifespan=lifespan, docs_url=None, redoc_url=None)


@app.middleware("http")
async def authenticate(request: Request, call_next):
    header = request.headers.get("authorization", "").removeprefix("Bearer ")
    # Query tokens are only accepted on image GET routes for browser <img>.
    token = header or (request.query_params.get("token", "") if
                       request.method == "GET" and request.url.path.endswith(("/thumbnail", "/preview")) else "")
    if not secrets.compare_digest(token, TOKEN):
        return JSONResponse({"detail": "需要本地应用认证"}, status_code=401)
    try:
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        return response
    except Exception:
        raise


@app.exception_handler(ValueError)
async def value_error(request, exc):
    return JSONResponse({"detail": str(exc)}, status_code=400)


@app.exception_handler(FileNotFoundError)
async def missing_file(request, exc):
    return JSONResponse({"detail": "文件或目录不存在，请检查磁盘连接"}, status_code=404)


@app.get("/health")
def health():
    return {"status": "ready", "version": "0.3.0", "model": app.state.catalog.inference.status}


@app.get("/summary")
def summary():
    return app.state.catalog.summary()


class FolderRequest(BaseModel):
    path: str = Field(min_length=1, max_length=8192)


@app.post("/folders")
def add_folder(body: FolderRequest):
    return app.state.catalog.add_folder(body.path)


@app.delete("/folders/{fid}")
def remove_folder(fid: str):
    app.state.catalog.remove_folder(fid)
    return {"ok": True}


class ScanRequest(BaseModel):
    retry: bool = False


@app.post("/folders/{fid}/scan")
def scan_folder(fid: str, body: ScanRequest):
    return app.state.catalog.rescan(fid, retry=body.retry)

class ExclusionsRequest(BaseModel):
    rules: list[str] = Field(max_length=100)
    preview: bool = False


@app.post("/folders/{fid}/exclusions")
def exclusions(fid: str, body: ExclusionsRequest):
    return app.state.catalog.folder_exclusions(fid, body.rules, body.preview)


class CollectionRequest(BaseModel):
    name: str = Field(min_length=1, max_length=64)


@app.post("/collections")
def create_collection(body: CollectionRequest):
    return app.state.catalog.save_collection(body.name)


@app.patch("/collections/{cid}")
def rename_collection(cid: str, body: CollectionRequest):
    return app.state.catalog.save_collection(body.name, cid)


@app.delete("/collections/{cid}")
def remove_collection(cid: str):
    app.state.catalog.remove_collection(cid)
    return {"ok": True}


class Filters(BaseModel):
    kind: Literal["", "image", "model", "texture"] = ""
    include_components: bool = False
    exclude_components: bool = False
    folder_id: str = ""
    collection_id: str = ""
    model_id: str = ""
    include_model: bool = False
    relation: Literal["", "bound", "auxiliary"] = ""
    status: str = ""
    favorite: bool = False
    ext: str = ""
    name: str = Field(default="", max_length=1000)
    tag: str = Field(default="", max_length=64)
    min_width: int = Field(default=0, ge=0)
    sort: str = "newest"
    offset: int = Field(default=0, ge=0, le=1000000)
    limit: int = Field(default=200, ge=1, le=1000)
    top_k: int = Field(default=50, ge=1, le=200)
    group_duplicates: bool = True


class RetryRequest(BaseModel):
    ids: list[str] = Field(default_factory=list, max_length=5000)
    filters: Filters = Field(default_factory=Filters)


@app.post("/assets/retry")
def retry_assets(body: RetryRequest):
    return app.state.catalog.retry_assets(body.ids, body.filters.model_dump())


@app.post("/assets/list")
def assets(body: Filters):
    return app.state.catalog.list_assets(body.model_dump())


@app.post("/assets/resource-groups")
def resource_groups(body: Filters):
    return app.state.catalog.resource_groups(body.model_dump())


@app.post("/assets/recover")
def recover_missing():
    return app.state.catalog.recover_missing()


class ReconnectRequest(BaseModel):
    target_id: str = Field(min_length=1, max_length=64)


@app.post("/assets/{aid}/reconnect")
def reconnect_asset(aid: str, body: ReconnectRequest):
    return app.state.catalog.reconnect_asset(aid, body.target_id)


class BulkRequest(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=5000)
    add_tags: list[str] = Field(default_factory=list, max_length=30)
    remove_tags: list[str] = Field(default_factory=list, max_length=30)
    favorite: bool | None = None
    collection_id: str = ""
    collection_action: Literal["add", "remove"] = "add"


@app.post("/assets/bulk")
def bulk_assets(body: BulkRequest):
    return app.state.catalog.bulk_update(body.ids, body.model_dump(exclude={"ids"}))


class SearchRequest(BaseModel):
    text: str = Field(default="", max_length=4000)
    image_path: str = ""
    asset_id: str = ""
    strategy: Literal["hybrid", "keyword", "semantic"] = "hybrid"
    filters: Filters = Field(default_factory=Filters)


@app.post("/search")
def search(body: SearchRequest):
    catalog = app.state.catalog
    if sum(bool(x) for x in (body.text.strip(), body.image_path, body.asset_id)) != 1:
        raise ValueError("请输入文字或选择一张参考图片")
    if body.text.strip() and body.strategy == "keyword":
        return catalog.text_assets(body.text.strip(), body.filters.model_dump(), strategy="keyword")
    if body.asset_id:
        result = catalog.list_assets(body.filters.model_dump(), catalog.similar_vector(body.asset_id))
        result["mode"] = "asset"
        return result
    else:
        path = body.image_path
    if path:
        path = Path(path).expanduser().resolve(strict=True)
        if not path.is_file() or path.stat().st_size > 100 * 1024**2:
            raise ValueError("请选择 100 MB 以内的本地图片")
        future = catalog.inference.submit("image", str(path))
    else:
        future = catalog.inference.submit("text", body.text.strip())
    try:
        vector = future.result(timeout=300)
    except Exception as exc:
        if body.text.strip() and body.strategy == "hybrid":
            result = catalog.text_assets(body.text.strip(), body.filters.model_dump())
            if result["keyword_total"]:
                result["warning"] = "语义检索暂不可用，仅显示关键词命中"
                return result
        raise HTTPException(503, f"模型编码失败：{exc}") from exc
    if body.text.strip() and body.strategy == "hybrid":
        return catalog.text_assets(body.text.strip(), body.filters.model_dump(), vector)
    result = catalog.list_assets(body.filters.model_dump(), vector)
    result["mode"] = "image" if path else "text"
    result["strategy"] = "semantic"
    return result


@app.get("/assets/{aid}")
def get_asset(aid: str):
    return app.state.catalog.get_asset(aid)

@app.get("/assets/{aid}/copies")
def get_copies(aid: str):
    return {"items": app.state.catalog.copies(aid)}


class Metadata(BaseModel):
    tags: list[str] | None = None
    favorite: bool | None = None


@app.patch("/assets/{aid}")
def update_asset(aid: str, body: Metadata):
    return app.state.catalog.update_asset(aid, body.model_dump(exclude_none=True))


@app.get("/assets/{aid}/thumbnail")
def thumbnail(aid: str):
    catalog = app.state.catalog
    asset = catalog.get_asset(aid)
    path = catalog.thumbs / (asset["thumbnail"] or "not-ready")
    if not path.is_file():
        raise HTTPException(404, "缩略图尚未生成")
    return FileResponse(path, media_type="image/webp", headers={"Cache-Control": "private, max-age=86400"})


@app.get("/assets/{aid}/preview")
def preview(aid: str):
    catalog = app.state.catalog
    asset = catalog.get_asset(aid)
    path = catalog.model_file(aid, "view-0.png") if asset["kind"] == "model" else asset["path"]
    return image_response(path)


def image_response(path):
    from PIL import Image, ImageOps
    from fastapi.responses import Response
    # Decode all supported formats to an in-memory preview; TIFF isn't browser-native.
    try:
        with Image.open(path) as image:
            if image.width * image.height > 40_000_000:
                raise ValueError("图片超过 4000 万像素")
            image = ImageOps.exif_transpose(image)
            image.thumbnail((2400, 2400))
            image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
            output = io.BytesIO()
            image.save(output, "WEBP", quality=92)
        return Response(output.getvalue(), media_type="image/webp")
    except OSError as exc:
        raise HTTPException(404, "原图无法读取，请检查文件是否移动或磁盘是否连接") from exc


@app.get("/assets/{aid}/model")
def model_preview(aid: str):
    return FileResponse(app.state.catalog.model_file(aid, "model.glb"), media_type="model/gltf-binary",
                        headers={"Cache-Control": "private, no-cache"})


@app.get("/assets/{aid}/resources/{index}/preview")
def resource_preview(aid: str, index: int):
    model = app.state.catalog.get_asset(aid).get("model")
    if not model or not 0 <= index < len(model["resources"]):
        raise HTTPException(404, "资源不存在")
    resource = model["resources"][index]
    if resource["kind"] != "texture" or not resource["path"]:
        raise HTTPException(404, "内嵌纹理请在 3D 预览中查看")
    return image_response(resource["path"])


# File-based Electron renderer uses a null origin. Every data GET still requires a token.
# Register outside auth so browser preflights can complete without credentials.
origins = ["null"]
dev_origin = os.environ.get("PRISM_DEV_URL", "").rstrip("/")
if dev_origin:
    from urllib.parse import urlsplit
    parsed = urlsplit(dev_origin)
    if parsed.scheme == "http" and parsed.hostname == "127.0.0.1" and parsed.port:
        origins.append(dev_origin)
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["GET"],
                   allow_headers=["Authorization"])


def main():
    import argparse
    import multiprocessing
    import uvicorn

    multiprocessing.freeze_support()
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        from embed import Embedder
        from PIL import Image
        model = Embedder()
        text = model.text(["红色圆形"])
        image = model.image(Image.new("RGB", (128, 128), "red"))
        print(json.dumps({"text": list(text.shape), "image": list(image.shape), "ok": True}), flush=True)
        return
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", args.port))
    port = sock.getsockname()[1]
    print("PRISM_ENDPOINT=" + json.dumps({"port": port}), flush=True)
    config = uvicorn.Config(app, log_level="warning", access_log=False)
    uvicorn.Server(config).run(sockets=[sock])


if __name__ == "__main__":
    main()
