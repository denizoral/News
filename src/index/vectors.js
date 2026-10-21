// Semantic search over the permanent index. Every article and post gets a
// 384-dimension sentence embedding (bge-small, from the local classifier
// service) of its title and the start of its summary. Vectors are stored
// quantized to int8 with one float scale each (388 bytes per document), and
// searched by brute force: a dot product against every stored vector, which
// for ~200k documents is fast enough off the main thread (history worker).

import { TECH_CLASSIFIER } from '../config.js';
import { q, tx } from '../db.js';

export const DIM = 384;
const BATCH = 64;

export const embedText = (d) => `${d.title}. ${(d.description || '').slice(0, 200)}`.trim();

// Unit-length float vector -> Buffer (float32 dequantize scale, then int8s).
export function quantize(vec) {
  let max = 0;
  for (const x of vec) max = Math.max(max, Math.abs(x));
  const scale = max / 127 || 1;
  const buf = Buffer.alloc(4 + DIM);
  buf.writeFloatLE(scale, 0);
  for (let i = 0; i < DIM; i++) buf.writeInt8(Math.round(vec[i] / scale), 4 + i);
  return buf;
}

export async function embedTexts(texts, { timeoutMs = 60000 } = {}) {
  const res = await fetch(`${TECH_CLASSIFIER.url}/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ texts }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`embed HTTP ${res.status}`);
  return (await res.json()).vectors;
}

// ---- Indexing (main process): new documents first, then older ones ----

export const embedStatus = { ok: null, embedded: 0, total: 0, backlog: null, lastBatchMs: null, error: null };
const ELIGIBLE = "type IN ('article', 'post') AND title != ''";

function nextBatch() {
  const r = q('SELECT MIN(doc_id) AS lo, MAX(doc_id) AS hi FROM doc_vecs').get();
  if (r.hi == null) return q(`SELECT id, title, description FROM docs WHERE ${ELIGIBLE} ORDER BY id DESC LIMIT ${BATCH}`).all();
  const fresh = q(`SELECT id, title, description FROM docs WHERE id > ? AND ${ELIGIBLE} ORDER BY id LIMIT ${BATCH}`).all(r.hi);
  return fresh.length ? fresh : q(`SELECT id, title, description FROM docs WHERE id < ? AND ${ELIGIBLE} ORDER BY id DESC LIMIT ${BATCH}`).all(r.lo);
}

export async function embedTick(embed = embedTexts) {
  const docs = nextBatch();
  if (!docs.length) return 0;
  const started = Date.now();
  const vecs = await embed(docs.map(embedText));
  const ins = q('INSERT OR REPLACE INTO doc_vecs (doc_id, v) VALUES (?, ?)');
  tx(() => docs.forEach((d, i) => vecs[i]?.length === DIM && ins.run(d.id, quantize(vecs[i]))));
  embedStatus.embedded += docs.length;
  embedStatus.lastBatchMs = Date.now() - started;
  return docs.length;
}

function counts() {
  embedStatus.total = q('SELECT COUNT(*) AS n FROM doc_vecs').get().n;
  const r = q('SELECT MIN(doc_id) AS lo FROM doc_vecs').get();
  embedStatus.backlog = r.lo == null ? null : q(`SELECT COUNT(*) AS n FROM docs WHERE id < ? AND ${ELIGIBLE}`).get(r.lo).n;
}

// Drains the backlog in batches with a short rest between them (the model
// shares the CPU with the classifier); when caught up, looks every minute.
export function startEmbedder({ restMs = 300, idleMs = 60e3, errorMs = 120e3 } = {}) {
  let n = 0;
  const loop = async () => {
    let delay = idleMs;
    try {
      if (await embedTick()) delay = restMs;
      if (n++ % 50 === 0 || delay === idleMs) counts();
      embedStatus.ok = true;
      embedStatus.error = null;
    } catch (err) {
      embedStatus.ok = false;
      embedStatus.error = err.message;
      delay = errorMs;
    }
    setTimeout(loop, delay).unref();
  };
  setTimeout(loop, 10e3).unref();
}

// ---- Searching (history worker): all vectors in memory ----

export class VectorIndex {
  constructor(db) {
    this.db = db;
    this.n = 0;
    this.seq = 0;
    this.ids = new Int32Array(1 << 16);
    this.scales = new Float32Array(1 << 16);
    this.data = new Int8Array((1 << 16) * DIM);
    this.slot = new Map(); // doc id -> row (re-embedded docs overwrite their row)
  }

  // Picks up rows added since the last call.
  refresh() {
    const rows = this.db.prepare('SELECT seq, doc_id, v FROM doc_vecs WHERE seq > ? ORDER BY seq').all(this.seq);
    for (const r of rows) {
      let i = this.slot.get(r.doc_id);
      if (i == null) {
        if (this.n === this.ids.length) this.grow();
        i = this.n++;
        this.slot.set(r.doc_id, i);
      }
      const v = r.v;
      this.ids[i] = r.doc_id;
      this.scales[i] = new DataView(v.buffer, v.byteOffset, 4).getFloat32(0, true);
      this.data.set(new Int8Array(v.buffer, v.byteOffset + 4, DIM), i * DIM);
      this.seq = r.seq;
    }
    return rows.length;
  }

  grow() {
    const cap = this.ids.length * 2;
    const ids = new Int32Array(cap); ids.set(this.ids); this.ids = ids;
    const sc = new Float32Array(cap); sc.set(this.scales); this.scales = sc;
    const d = new Int8Array(cap * DIM); d.set(this.data); this.data = d;
  }

  // Top k documents by cosine similarity to a unit-length query vector. The
  // query is quantized too, so the inner loop is integer multiply-adds (four
  // accumulators): ~120 ms for 200k vectors, against ~150 ms in floats.
  search(query, k = 20) {
    let max = 0;
    for (const x of query) max = Math.max(max, Math.abs(x));
    const qs = max / 127 || 1;
    const qi = new Int8Array(DIM);
    for (let j = 0; j < DIM; j++) qi[j] = Math.round(query[j] / qs);
    const { data, scales, n } = this;
    const top = []; // [score, row], sorted descending, length <= k
    let floor = -Infinity;
    for (let i = 0; i < n; i++) {
      const o = i * DIM;
      let a = 0, b = 0, c = 0, d = 0;
      for (let j = 0; j < DIM; j += 4) {
        a = (a + qi[j] * data[o + j]) | 0;
        b = (b + qi[j + 1] * data[o + j + 1]) | 0;
        c = (c + qi[j + 2] * data[o + j + 2]) | 0;
        d = (d + qi[j + 3] * data[o + j + 3]) | 0;
      }
      const score = (a + b + c + d) * scales[i];
      if (score <= floor) continue;
      let at = top.length;
      while (at > 0 && top[at - 1][0] < score) at--;
      top.splice(at, 0, [score, i]);
      if (top.length > k) top.pop();
      if (top.length === k) floor = top[k - 1][0];
    }
    return top.map(([score, i]) => ({ id: this.ids[i], score: +(score * qs).toFixed(4) }));
  }
}
