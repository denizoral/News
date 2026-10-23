import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cachedJob, setJobCacheDir } from '../src/index/offload.js';

test('job cache: a default view’s last result comes back from disk after a restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jobcache-'));
  try {
    setJobCacheDir(dir);
    fs.writeFileSync(path.join(dir, 'deals_1y.json'), JSON.stringify({ from: 'disk' }));
    // Fresh by its file time, so no worker runs.
    assert.deepEqual(await cachedJob('deals:1y', { kind: 'deals', range: '1y' }, 3600e3), { from: 'disk' });
  } finally {
    setJobCacheDir(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
