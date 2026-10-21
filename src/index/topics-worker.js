// Runs topic-page queries off the main thread (see topics.js).

import { parentPort, workerData } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { computeTopic } from './topics.js';

const db = new DatabaseSync(workerData.file, { readOnly: true });
db.exec('PRAGMA busy_timeout = 5000; PRAGMA cache_size = -32000;');

parentPort.on('message', ({ id, key }) => {
  try {
    parentPort.postMessage({ id, data: computeTopic(db, key) });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});
