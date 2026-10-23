import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { computeWatch, watchMatch, normQuery } from '../src/index/watch.js';

const DAY = 86400e3;
const now = Date.now();

test('watches: search syntax, headlines and summaries only, days and newest', () => {
  resetDb();
  let n = 0;
  const add = (title, daysAgo, extra = {}) => upsertDoc({ url: `https://example.com/${n++}`, type: 'article', title, description: extra.description || '', body: extra.body || '', site: extra.site || 'example.com', source: 'Example', published_at: now - daysAgo * DAY });
  add('Meta releases open weights for Muse', 1);
  add('Open weights debate heats up', 3, { site: 'theverge.com' });
  add('Nvidia earnings beat', 2, { body: 'open weights mentioned deep in the body' });
  add('Old open weights story', 20);
  add('Open weights rumor mill', 1);
  const r = computeWatch(getDb(), { q: '"open weights" -rumor', now });
  assert.equal(r.total, 2, 'body-only, old and excluded matches are left out');
  assert.equal(r.days.length, 14);
  assert.equal(r.days.reduce((a, d) => a + d.n, 0), 2);
  assert.equal(r.items[0].title, 'Meta releases open weights for Muse', 'newest first');
  assert.equal(computeWatch(getDb(), { q: 'site:theverge.com "open weights"', now }).total, 1);
  assert.equal(computeWatch(getDb(), { q: '((', now }).error.length > 0, true);
  assert.equal(watchMatch('intitle:Rubin').match.includes('title'), true);
  assert.equal(normQuery(`  a   b ${'x'.repeat(200)}`).length, 100);
});
