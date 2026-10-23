// Worker threads for slow read-only queries over the permanent index, and a
// cache in front of it. node:sqlite is synchronous, so a second-long query on
// the main thread would stall every request; the worker has its own
// read-only connection instead.

import fs from 'node:fs';
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

// Results of the default views (no typed parameters: 'rumors', 'deals:1y',
// 'forecasts::0:') are also kept on disk, so the first visitor after a
// restart gets the last result at once while it refreshes, instead of
// waiting seconds for a cold job. Off under the test runner.
const DISK_KEY = /^[a-zA-Z]+(?::(?:1y|0|7|14|30|90|))*$/;
const DISK_MAX = 4e6;
let diskDir = process.env.NODE_TEST_CONTEXT ? null : path.resolve(process.env.DATA_DIR || 'data', 'jobcache');
export function setJobCacheDir(dir) {
  diskDir = dir;
}
const diskFile = (key) => (diskDir && DISK_KEY.test(key) ? path.join(diskDir, `${key.replace(/:/g, '_')}.json`) : null);

function fromDisk(key) {
  const file = diskFile(key);
  if (!file) return null;
  try {
    const at = fs.statSync(file).mtimeMs;
    return { at, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    return null;
  }
}

function toDisk(key, data) {
  const file = diskFile(key);
  if (!file) return;
  const text = JSON.stringify(data);
  if (text.length > DISK_MAX) return;
  const tmp = `${file}.${process.pid}.tmp`;
  fs.promises.mkdir(diskDir, { recursive: true })
    .then(() => fs.promises.writeFile(tmp, text))
    .then(() => fs.promises.rename(tmp, file))
    .catch(() => {});
}

// Runs `job` in the worker, cached under `key` for `ttlMs`; a stale entry is
// served while it refreshes.
export function cachedJob(key, job, ttlMs) {
  let hit = cache.get(key);
  if (!hit) {
    hit = fromDisk(key);
    if (hit) cache.set(key, hit);
  }
  if (hit?.data && Date.now() - hit.at < ttlMs) return Promise.resolve(hit.data);
  if (!hit?.pending) {
    const pending = runJob(job)
      .then((data) => {
        cache.set(key, { at: Date.now(), data });
        toDisk(key, data);
      })
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
