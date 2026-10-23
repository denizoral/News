// Stands in for the history worker: answers each job with its kind after a
// short wait, so tests can see the order jobs ran in.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', ({ id, job }) => {
  setTimeout(() => parentPort.postMessage({ id, data: job.kind }), 30);
});
