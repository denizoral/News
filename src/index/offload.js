// A worker thread for slow read-only queries over the permanent index, and a
// cache in front of it. node:sqlite is synchronous, so a second-long query on
// the main thread would stall every request; the worker has its own
// read-only connection instead.

import path from 'node:path';
import { Worker } from 'node:worker_threads';

const cache = new Map(); // cache key -> { at, data, pending }
let worker = null;
let seq = 0;
const waiting = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./history-worker.js', import.meta.url), {
    workerData: { file: path.resolve(process.env.DATA_DIR || 'data', 'wire.db') },
  });
  worker.unref();
  worker.on('message', ({ id, data, error }) => {
    const w = waiting.get(id);
    waiting.delete(id);
    if (w) (error ? w.reject(new Error(error)) : w.resolve(data));
  });
  const fail = (err) => {
    for (const w of waiting.values()) w.reject(err);
    waiting.clear();
    worker = null;
  };
  worker.on('error', fail);
  worker.on('exit', (code) => code && fail(new Error(`history worker exited with ${code}`)));
  return worker;
}

function run(job) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    getWorker().postMessage({ id, job });
  });
}

// Runs `job` in the worker, cached under `key` for `ttlMs`; a stale entry is
// served while it refreshes.
export function cachedJob(key, job, ttlMs) {
  const hit = cache.get(key);
  if (hit?.data && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.data);
  if (!hit?.pending) {
    const pending = run(job)
      .then((data) => cache.set(key, { at: Date.now(), data }))
      .catch((err) => {
        if (hit?.data) cache.set(key, hit);
        else cache.delete(key);
        throw err;
      });
    cache.set(key, { ...hit, pending });
  }
  const entry = cache.get(key);
  return entry.data ? Promise.resolve(entry.data) : entry.pending.then(() => cache.get(key).data);
}
