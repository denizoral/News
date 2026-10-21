import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { computeTopic } from '../src/index/topics.js';

const DAY = 86400e3;

test('topic history: daily share of coverage and a timeline ranked by outlets', () => {
  const db = resetDb();
  const now = Date.parse('2026-10-21T12:00:00Z');
  const doc = (url, title, at, extra = {}) => upsertDoc({ url, type: 'article', title, published_at: at, ...extra });
  // Two days ago: 1 of 4 stories mentions Anthropic.
  doc('https://a.com/1', 'Anthropic ships Claude 6', now - 2 * DAY);
  for (let i = 0; i < 3; i++) doc(`https://a.com/x${i}`, `Weather report ${i}`, now - 2 * DAY);
  // Yesterday: one headline run by three outlets, one by one outlet, and a
  // description-only mention (counted, but not a timeline headline).
  doc('https://b.com/1', 'Anthropic raises $30 billion at a record valuation', now - DAY + 3600e3);
  doc('https://c.com/1', 'Anthropic raises $30 billion at a record valuation', now - DAY + 7200e3);
  doc('https://d.com/1', 'Anthropic raises $30 billion at a record valuation', now - DAY);
  doc('https://e.com/1', 'Claude gets a new coding mode', now - DAY + 600e3);
  doc('https://f.com/1', 'Startups to watch', now - DAY, { description: 'Includes Anthropic alumni' });
  // Outside the window and an X post: neither in the timeline.
  doc('https://g.com/1', 'Anthropic founded', now - 40 * DAY);
  upsertDoc({ url: 'https://x.com/a/status/1', type: 'post', title: 'Anthropic is cooking', published_at: now - DAY });

  const t = computeTopic(db, 'anthropic', { now });
  assert.equal(t.label, 'Anthropic');
  assert.equal(t.series.length, 30);
  const byDay = Object.fromEntries(t.series.map((d) => [d.day, d]));
  assert.deepEqual([byDay['2026-10-19'].n, byDay['2026-10-19'].total, byDay['2026-10-19'].share], [1, 4, 0.25]);
  assert.equal(byDay['2026-10-20'].n, 6, 'headlines, the description mention and the post');
  assert.equal(t.total, 7);

  const [yesterday, before] = t.timeline;
  assert.equal(yesterday.day, '2026-10-20');
  assert.equal(yesterday.items[0].title, 'Anthropic raises $30 billion at a record valuation');
  assert.equal(yesterday.items[0].outlets, 3);
  assert.equal(yesterday.items[0].url, 'https://d.com/1', 'credits the earliest copy');
  assert.deepEqual(yesterday.items.map((i) => i.title).slice(1), ['Claude gets a new coding mode']);
  assert.equal(before.day, '2026-10-19');
  assert.equal(computeTopic(db, 'nonsense', { now }), null);
});
