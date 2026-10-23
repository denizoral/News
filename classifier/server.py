"""Zero-shot topic classifier for Frontier Wire.

A small local HTTP service around a GLiClass model (CPU). The Node crawler
POSTs batches of headlines to /classify and gets each one's best label back.

It also embeds short texts (a headline and the start of its summary) with a
small sentence-embedding model for semantic search and related coverage.

  POST /classify  {"texts": [...], "labels": [...]}  ->  {"results": [{"label", "score", "top": [3 best]}], "ms"}
  POST /embed     {"texts": [...]}                    ->  {"vectors": [[384 floats, unit length]], "ms"}
  GET  /health                                        ->  {"ok", "model", "classified", "avgMs", "embedModel", "embedded"}

Run: venv/bin/python classifier/server.py  (CLASSIFIER_PORT, CLASSIFIER_MODEL, CLASSIFIER_THREADS, EMBED_MODEL)
"""

import json
import sys
import os
import threading
import time
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

warnings.filterwarnings("ignore")

import torch  # noqa: E402
from gliclass import GLiClassModel, ZeroShotClassificationPipeline  # noqa: E402
from transformers import AutoModel, AutoTokenizer  # noqa: E402

MODEL = os.environ.get("CLASSIFIER_MODEL", "knowledgator/gliclass-large-v3.0")
PORT = int(os.environ.get("CLASSIFIER_PORT", "8765"))
MAX_TEXTS = 64
MAX_CHARS = 400

torch.set_num_threads(int(os.environ.get("CLASSIFIER_THREADS", "4")))
model = GLiClassModel.from_pretrained(MODEL)
tokenizer = AutoTokenizer.from_pretrained(MODEL, add_prefix_space=True)
pipe = ZeroShotClassificationPipeline(model, tokenizer, classification_type="multi-label", device="cpu")
lock = threading.Lock()  # one batch through the model at a time
stats = {"classified": 0, "ms": 0.0, "embedded": 0}

# Embeddings: bge-small (384 dimensions, CLS pooling). Texts are cut at 64
# tokens: headlines are short, and it is twice as fast as 128.
EMBED_MODEL = os.environ.get("EMBED_MODEL", "BAAI/bge-small-en-v1.5")
EMBED_MAX = 128
embed_tok = AutoTokenizer.from_pretrained(EMBED_MODEL)
embed_model = AutoModel.from_pretrained(EMBED_MODEL).eval()
embed_lock = threading.Lock()  # separate from the classifier: they don't block each other


def embed(texts):
    order = sorted(range(len(texts)), key=lambda i: len(texts[i]))  # less padding per batch
    out = [None] * len(texts)
    # The lock is taken per batch of 16, so a search query waiting behind the
    # background backfill gets the model within ~0.2 s instead of ~1 s.
    for i in range(0, len(order), 16):
        idx = order[i : i + 16]
        x = embed_tok([clean(texts[j][:MAX_CHARS]) for j in idx], padding=True, truncation=True, max_length=64, return_tensors="pt")
        with embed_lock, torch.inference_mode():
            v = torch.nn.functional.normalize(embed_model(**x).last_hidden_state[:, 0], dim=-1)
        for j, row in zip(idx, v.tolist()):
            out[j] = [round(f, 5) for f in row]
    stats["embedded"] += len(texts)
    return out


def clean(t):
    # A lone UTF-16 surrogate (half an emoji cut by a client) can't be
    # tokenized; replace any such character.
    return t.encode("utf-8", "replace").decode("utf-8")


def run_pipe(texts, labels):
    with lock, torch.inference_mode():
        return pipe([clean(t[:MAX_CHARS]) for t in texts], labels, threshold=0.0, batch_size=16)


def classify(texts, labels):
    # One text the tokenizer can't take used to fail the whole batch, and the
    # labeler retried that same batch every minute. Now the batch is retried
    # one text at a time and only the bad text goes unscored (null), with
    # what it was logged so the cause can be found.
    try:
        out = run_pipe(texts, labels)
    except Exception as e:
        out = []
        for t in texts:
            try:
                out.extend(run_pipe([t], labels))
            except Exception as e1:
                print(f"classify: skipped a text ({type(e1).__name__}: {e1}): {t[:300]!r}", file=sys.stderr, flush=True)
                out.append([])
        print(f"classify: batch of {len(texts)} failed ({type(e).__name__}), scored one by one", file=sys.stderr, flush=True)
    best = []
    for r in out:
        ranked = sorted(r, key=lambda x: -x["score"])[:3]
        top = [{"label": x["label"], "score": round(float(x["score"]), 4)} for x in ranked]
        best.append({**top[0], "top": top} if top else None)
    return best


class Handler(BaseHTTPRequestHandler):
    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the client gave up waiting; nothing to deliver

    def do_GET(self):
        if self.path != "/health":
            return self.reply(404, {"error": "not found"})
        n = stats["classified"]
        self.reply(200, {"ok": True, "model": MODEL, "classified": n, "avgMs": round(stats["ms"] / n, 1) if n else None, "embedModel": EMBED_MODEL, "embedded": stats["embedded"]})

    def do_POST(self):
        if self.path == "/embed":
            return self.do_embed()
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

    def do_embed(self):
        try:
            body = json.loads(self.rfile.read(min(int(self.headers.get("content-length", 0)), 1_000_000)))
            texts = body["texts"]
            if not (isinstance(texts, list) and 0 < len(texts) <= EMBED_MAX):
                raise ValueError(f"need 1-{EMBED_MAX} texts")
        except (ValueError, KeyError, TypeError) as e:
            return self.reply(400, {"error": str(e)})
        t0 = time.time()
        vectors = embed([str(t) for t in texts])
        self.reply(200, {"vectors": vectors, "ms": round((time.time() - t0) * 1000)})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    classify(["warm up"], ["technology", "sports"])
    embed(["warm up"])
    print(f"[classifier] {MODEL} ready on 127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
