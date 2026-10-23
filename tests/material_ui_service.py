"""Test-only controlled inference; all SQLite, file/PNG and Blender work is real."""
import concurrent.futures
from pathlib import Path
import sys
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import catalog


class Inference:
    status, error = "ready", None
    def submit(self, kind, value, priority=0):
        future = concurrent.futures.Future()
        future.set_result(np.array([1, 0, 0], dtype=np.float32))
        return future


catalog.Inference = Inference
import app_server
app_server.main()
