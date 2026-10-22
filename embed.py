"""Offline text/image embeddings on Apple Silicon; also usable as a Python module."""

import os
import tempfile
from pathlib import Path

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
os.environ.setdefault("HF_HOME", str(Path(tempfile.gettempdir()) / "asset-search-hf"))

import argparse
import json
import time
import mlx.core as mx
import numpy as np
from PIL import Image, ImageOps
from mlx_vlm.embedding_loader import load_embedding_model
from mlx_vlm.models.embedding_gemma2.processing_embedding_gemma2 import (
    EmbeddingGemma2Processor,
)
from mlx_vlm.utils import load_config

ROOT = Path(__file__).resolve().parent
MODEL_DIR = Path(os.environ.get("PRISM_MODEL_DIR", ROOT / "models" / "embeddinggemma-2-bf16"))
DIMENSIONS = (128, 256, 512, 768)
PREFIXES = {
    "query": "task: search result | query: ",
    "document": "title: none | text: ",
    "similarity": "task: sentence similarity | query: ",
}


class Embedder:
    def __init__(self):
        if not (MODEL_DIR / "model.safetensors").is_file():
            raise FileNotFoundError("模型尚未下载，请先运行 .venv/bin/python download_model.py")
        if not mx.metal.is_available():
            raise RuntimeError("此部署需要 Apple Silicon 与可用的 Metal GPU。")
        mx.set_default_device(mx.gpu)
        started = time.perf_counter()
        config = load_config(MODEL_DIR)
        config["audio_config"] = None
        self.model = load_embedding_model(MODEL_DIR, config=config)
        # Select MLX's processor explicitly: AutoProcessor can pick the upstream
        # Torch video processor even for an image-only workload.
        self.processor = EmbeddingGemma2Processor.from_pretrained(
            MODEL_DIR, local_files_only=True
        )
        self.load_seconds = time.perf_counter() - started

    def _forward(self, inputs, dimensions):
        if dimensions not in DIMENSIONS:
            raise ValueError(f"dimensions 必须为 {DIMENSIONS} 之一")
        embeddings = self.model(**inputs).text_embeds
        embeddings = embeddings[:, :dimensions].astype(mx.float32)
        embeddings = embeddings / mx.maximum(
            mx.linalg.norm(embeddings, axis=-1, keepdims=True), 1e-12
        )
        result = np.array(embeddings)
        if not np.isfinite(result).all() or not np.allclose(
            np.linalg.norm(result, axis=-1), 1.0, atol=1e-4
        ):
            raise RuntimeError("模型返回无效向量，结果未写入索引。")
        return result

    def text(self, texts, task="query", dimensions=768):
        if task not in PREFIXES:
            raise ValueError(f"task 必须为 {tuple(PREFIXES)} 之一")
        if not 1 <= len(texts) <= 8:
            raise ValueError("每次需要 1—8 条文字")
        if any(not isinstance(t, str) or not t.strip() or len(t) > 4000 for t in texts):
            raise ValueError("每条文字必须非空且不超过 4000 个字符")
        inputs = self.processor.tokenizer(
            [PREFIXES[task] + t for t in texts], padding=True, return_tensors="np"
        )
        if inputs["input_ids"].shape[-1] > 8192:
            raise ValueError("文字超出模型的 8192 token 上限")
        return self._forward({k: mx.array(v) for k, v in inputs.items()}, dimensions)

    def image(self, image, dimensions=768):
        image = ImageOps.exif_transpose(image).convert("RGB")
        # Bound preprocessing memory without distorting the aspect ratio.
        image.thumbnail((2048, 2048))
        inputs = self.processor(images=image, return_tensors="mlx")
        return self._forward(inputs, dimensions)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--text", nargs="+", help="一条或多条文字，每条用引号包围")
    mode.add_argument("--image", type=Path, help="本地图片路径")
    parser.add_argument("--task", choices=PREFIXES, default="query")
    parser.add_argument("--dimensions", type=int, choices=DIMENSIONS, default=768)
    parser.add_argument("--output", type=Path, help="可选：保存完整向量为 .npy")
    args = parser.parse_args()
    model = Embedder()
    started = time.perf_counter()
    if args.text:
        vectors = model.text(args.text, args.task, args.dimensions)
    else:
        with Image.open(args.image) as image:
            vectors = model.image(image, args.dimensions)
    seconds = time.perf_counter() - started
    if args.output:
        np.save(args.output, vectors)
    print(json.dumps({
        "shape": list(vectors.shape),
        "norms": np.linalg.norm(vectors, axis=-1).tolist(),
        "preview": vectors[:, :8].tolist(),
        "load_seconds": round(model.load_seconds, 3),
        "encode_seconds": round(seconds, 3),
        "peak_mlx_memory_mb": round(mx.get_peak_memory() / 1024**2, 1),
        "offline": True,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
