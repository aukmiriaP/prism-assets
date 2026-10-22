"""Download a pinned MLX BF16 conversion of Google's EmbeddingGemma 2."""

import os
import tempfile
from pathlib import Path

os.environ.setdefault("HF_HOME", str(Path(tempfile.gettempdir()) / "asset-search-hf"))
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
os.environ.setdefault("HF_HUB_DISABLE_IMPLICIT_TOKEN", "1")

import json
from huggingface_hub import snapshot_download

ROOT = Path(__file__).resolve().parent
REPO = "mlx-community/embeddinggemma-2-bf16"
REVISION = "1a4ffddb7905d3f63486748deabe091a01fb6201"
MODEL_DIR = ROOT / "models" / "embeddinggemma-2-bf16"


def main():
    snapshot_download(
        repo_id=REPO,
        revision=REVISION,
        local_dir=MODEL_DIR,
        allow_patterns=["*.json", "*.safetensors", "*.jinja", "*.md"],
        max_workers=2,
        token=False,
    )
    manifest = {
        "base_model": "google/embeddinggemma-2",
        "download_repo": REPO,
        "revision": REVISION,
        "precision": "bfloat16",
        "license": "Apache-2.0",
        "runtime": "MLX on Apple Silicon",
        "enabled_modalities": ["text", "image"],
    }
    (ROOT / "model_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"Downloaded model to {MODEL_DIR}")


if __name__ == "__main__":
    main()
