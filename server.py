"""Loopback-only embedding service. Run one worker to serialize Metal inference."""

import io
import time
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field

from embed import DIMENSIONS, Embedder

Dimensions = Literal[128, 256, 512, 768]


@asynccontextmanager
async def lifespan(app):
    app.state.embedder = Embedder()
    yield
    del app.state.embedder


app = FastAPI(
    title="本地美术素材 Embedding 服务",
    description="EmbeddingGemma 2 / MLX / BF16，文字与图片共享向量空间。",
    version="0.1.0",
    lifespan=lifespan,
)


class TextRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=8)
    task: Literal["query", "document", "similarity"] = "query"
    dimensions: Dimensions = 768


@app.get("/health")
async def health():
    return {
        "status": "ready",
        "model": "google/embeddinggemma-2",
        "runtime": "mlx",
        "device": "metal",
        "precision": "bfloat16",
        "modalities": ["text", "image"],
        "offline": True,
        "dimensions": [128, 256, 512, 768],
    }


def response(vectors, started):
    return {
        "model": "google/embeddinggemma-2",
        "dimensions": vectors.shape[1],
        "normalized": True,
        "embeddings": vectors.tolist(),
        "elapsed_seconds": round(time.perf_counter() - started, 4),
    }


@app.post("/embed/text")
async def embed_text(request: TextRequest):
    started = time.perf_counter()
    try:
        vectors = app.state.embedder.text(
            request.texts, task=request.task, dimensions=request.dimensions
        )
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return response(vectors, started)


@app.post("/embed/image")
async def embed_image(
    file: UploadFile = File(...),
    dimensions: int = Query(768, description="支持 128、256、512、768"),
):
    started = time.perf_counter()
    if dimensions not in DIMENSIONS:
        await file.close()
        raise HTTPException(422, "dimensions 必须为 128、256、512 或 768")
    try:
        raw = await file.read(20 * 1024 * 1024 + 1)
    finally:
        await file.close()
    if len(raw) > 20 * 1024 * 1024:
        raise HTTPException(413, "图片不可超过 20 MB")
    try:
        with Image.open(io.BytesIO(raw)) as image:
            if image.width * image.height > 40_000_000:
                raise HTTPException(413, "图片不可超过 4000 万像素")
            vectors = app.state.embedder.image(image, dimensions=dimensions)
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError) as exc:
        raise HTTPException(422, "无法解码图片，请上传有效的 PNG/JPEG/WebP 图片") from exc
    return response(vectors, started)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8765, workers=1)
