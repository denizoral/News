// Worker threads for slow read-only queries over the permanent index, and a
// cache in front of it. node:sqlite is synchronous, so a second-long query on
// the main thread would stall every request; the worker has its own
// read-only connection instead.

import path from 'node:path';
import { Worker } from 'node:worker_threads';

const cache = new Map(); // cache key -> { at, data, pending }
let seq = 0;
const waiting = new Map(); // job id -> { resolve, reject, lane }

// Two workers ("lanes"): vector search answers people typing, so it gets its
// own and never queues behind a multi-second topic or digest job. Jobs that
// read the vectors (accounts, For you) share that lane and its one copy.
const workers = new Map();
const VECTOR_JOBS = new Set(['similar', 'askPassages', 'account', 'accounts', 'compare', 'taste', 'storylines']);
const laneOf = (job) => (VECTOR_JOBS.has(job.kind) ? 'vectors' : 'history');

function getWorker(lane) {
  let worker = workers.get(lane);
  if (worker) return worker;
  worker = new Worker(new URL('./history-worker.js', import.meta.url), {
    workerData: { file: path.resolve(process.env.DATA_DIR || 'data', 'wire.db') },
  });
  workers.set(lane, worker);
  worker.unref();
  worker.on('message', ({ id, data, error }) => {
    const w = waiting.get(id);
    waiting.delete(id);
    if (w) (error ? w.reject(new Error(error)) : w.resolve(data));
  });
  const fail = (err) => {
    for (const [id, w] of waiting) if (w.lane === lane) { w.reject(err); waiting.delete(id); }
    workers.delete(lane);
  };
  worker.on('error', fail);
  worker.on('exit', (code) => code && fail(new Error(`${lane} worker exited with ${code}`)));
  return worker;
}

// Runs `job` in the worker, uncached.
export function runJob(job) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const lane = laneOf(job);
    waiting.set(id, { resolve, reject, lane });
    getWorker(lane).postMessage({ id, job });
  });
}

// Runs `job` in the worker, cached under `key` for `ttlMs`; a stale entry is
// served while it refreshes.
export function cachedJob(key, job, ttlMs) {
  const hit = cache.get(key);
  if (hit?.data && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.data);
  if (!hit?.pending) {
    const pending = runJob(job)
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

// Marks a cached result stale: the next call still gets it, and refreshes it.
export function expireJob(key) {
  const hit = cache.get(key);
  if (hit) hit.at = 0;
}

// Stops the workers (tests, shutdown); jobs still waiting fail.
export async function stopWorkers() {
  const all = [...workers.values()];
  workers.clear();
  for (const [id, w] of waiting) {
    waiting.delete(id);
    w.reject(new Error('Workers stopped.'));
  }
  await Promise.all(all.map((w) => w.terminate()));
}
