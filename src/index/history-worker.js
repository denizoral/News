// Runs history queries (topic pages, the weekly digest, release coverage, vector search) off the main thread
// with its own read-only connection (see offload.js).

import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { computeTopic } from './topics.js';
import { computeDigest } from './digest.js';
import { similarDocs } from './semantic.js';
import { computeReleaseCoverage } from './releases.js';

const db = new DatabaseSync(workerData.file, { readOnly: true });
db.exec('PRAGMA busy_timeout = 5000; PRAGMA cache_size = -32000;');

const JOBS = {
  topic: ({ key }) => computeTopic(db, key),
  digest: () => computeDigest(db),
  similar: (job) => similarDocs(db, job),
  releases: ({ releases }) => computeReleaseCoverage(db, releases),
};

parentPort.on('message', ({ id, job }) => {
  try {
    parentPort.postMessage({ id, data: JOBS[job.kind](job) });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});
