"""Zero-shot topic classifier for Frontier Wire.

A small local HTTP service around a GLiClass model (CPU). The Node crawler
POSTs batches of headlines to /classify and gets each one's best label back.

  POST /classify  {"texts": [...], "labels": [...]}  ->  {"results": [{"label", "score"}], "ms"}
  GET  /health                                        ->  {"ok", "model", "classified", "avgMs"}

Run: venv/bin/python classifier/server.py  (CLASSIFIER_PORT, CLASSIFIER_MODEL, CLASSIFIER_THREADS)
"""

import json
import os
import threading
import time
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

warnings.filterwarnings("ignore")

import torch  # noqa: E402
from gliclass import GLiClassModel, ZeroShotClassificationPipeline  # noqa: E402
from transformers import AutoTokenizer  # noqa: E402

MODEL = os.environ.get("CLASSIFIER_MODEL", "knowledgator/gliclass-base-v3.0")
PORT = int(os.environ.get("CLASSIFIER_PORT", "8765"))
MAX_TEXTS = 64
MAX_CHARS = 400

torch.set_num_threads(int(os.environ.get("CLASSIFIER_THREADS", "4")))
model = GLiClassModel.from_pretrained(MODEL)
tokenizer = AutoTokenizer.from_pretrained(MODEL, add_prefix_space=True)
pipe = ZeroShotClassificationPipeline(model, tokenizer, classification_type="multi-label", device="cpu")
lock = threading.Lock()  # one batch through the model at a time
stats = {"classified": 0, "ms": 0.0}


def classify(texts, labels):
    with lock, torch.inference_mode():
        out = pipe([t[:MAX_CHARS] for t in texts], labels, threshold=0.0, batch_size=16)
    best = []
    for r in out:
        top = max(r, key=lambda x: x["score"], default=None)
        best.append({"label": top["label"], "score": round(float(top["score"]), 4)} if top else None)
    return best


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path != "/health":
            return self.reply(404, {"error": "not found"})
        n = stats["classified"]
        self.reply(200, {"ok": True, "model": MODEL, "classified": n, "avgMs": round(stats["ms"] / n, 1) if n else None})

    def do_POST(self):
        if self.path != "/classify":
            return self.reply(404, {"error": "not found"})
        try:
            body = json.loads(self.rfile.read(min(int(self.headers.get("content-length", 0)), 1_000_000)))
            texts, labels = body["texts"], body["labels"]
            if not (isinstance(texts, list) and isinstance(labels, list) and 0 < len(texts) <= MAX_TEXTS and labels):
                raise ValueError(f"need 1-{MAX_TEXTS} texts and some labels")
        except (ValueError, KeyError, TypeError) as e:
            return self.reply(400, {"error": str(e)})
        t0 = time.time()
        results = classify([str(t) for t in texts], [str(l) for l in labels])
        ms = (time.time() - t0) * 1000
        stats["classified"] += len(texts)
        stats["ms"] += ms
        self.reply(200, {"results": results, "ms": round(ms)})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    classify(["warm up"], ["technology", "sports"])
    print(f"[classifier] {MODEL} ready on 127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
