import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { scanOutlets, computeOutlets, computeOutlet, siteKey } from '../src/index/outlets.js';

const DAY = 86400e3;
const now = Date.parse('2026-10-22T12:00:00Z');

test('outlets: beats, similar outlets, publishing hours and the directory', () => {
  resetDb();
  let n = 0;
  const doc = (site, title, at, extra = {}) => upsertDoc({ url: `https://${site}/${n++}`, type: 'article', title, description: 'AI coverage.', site, source: site.split('.')[0].toUpperCase(), published_at: at, ...extra });
  for (let i = 0; i < 30; i++) {
    const at = Date.UTC(2026, 9, 21 - i, 14);
    doc('chips.com', i % 3 ? `Nvidia GPU supply for AI ${i}` : `OpenAI buys chips ${i}`, at, { author: 'Ada Byte' });
    doc('silicon.com', i % 3 ? `Nvidia and AMD AI accelerators ${i}` : `OpenAI model ${i}`, at + 3600e3);
    doc('labs.com', `OpenAI and Anthropic ship AI models ${i}`, Date.UTC(2026, 9, 21 - i));
  }
  doc('tiny.com', 'Nvidia AI news', now - DAY);
  doc('github.com', 'Nvidia AI repo', now - DAY);
  const db = getDb();
  const scan = scanOutlets(db, { now });
  const dir = computeOutlets(db, { now, scan });
  assert.deepEqual(dir.outlets.map((o) => o.site).sort(), ['chips.com', 'labs.com', 'silicon.com'], 'small outlets and repos are left out');
  assert.equal(dir.outlets[0].ai, 30);

  const chips = computeOutlet(db, { site: 'chips.com', now, scan });
  assert.equal(chips.beat[0].key, 'nvidia');
  assert.equal(chips.similar[0].site, 'silicon.com', 'the other chip outlet');
  assert.equal(chips.hours[14], 30);
  assert.deepEqual(chips.authors, [{ name: 'Ada Byte', n: 30 }]);
  assert.equal(chips.year.weeks.reduce((a, b) => a + b, 0), 30);
  assert.equal(chips.latest.length, 10);
  assert.equal(computeOutlet(db, { site: 'labs.com', now, scan }).hours, null, 'date-only feeds have no hours');
  assert.equal(computeOutlet(db, { site: 'tiny.com', now, scan }), null);
  assert.equal(siteKey('https://www.TheVerge.com/ai'), 'theverge.com');
});
