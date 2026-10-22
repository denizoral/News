import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { windowOf, bucketOf, computeCatchup, withLive } from '../src/index/catchup.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const now = Date.parse('2026-10-22T12:07:00Z');

test('catch-up: the window is clamped and snapped; buckets widen with it', () => {
  assert.equal(windowOf(now - 10 * DAY, now).since, now - 7 * DAY - (7 * 60e3), 'at most a week, on a quarter hour');
  assert.equal(windowOf(now - 60e3, now).since % (15 * 60e3), 0);
  assert.ok(now - windowOf(now - 60e3, now).since >= HOUR, 'at least an hour');
  assert.equal(windowOf('junk', now).since, Math.floor((now - DAY) / (15 * 60e3)) * 15 * 60e3);
  assert.equal(bucketOf(12 * HOUR), HOUR);
  assert.equal(bucketOf(3 * DAY), 3 * HOUR);
  assert.equal(bucketOf(7 * DAY), 6 * HOUR);
});

test('catch-up: stories ranked by outlets, activity, and live extras cut to the window', () => {
  resetDb();
  const since = now - 12 * HOUR;
  let n = 0;
  for (const site of ['a.com', 'b.com', 'c.com']) {
    upsertDoc({ url: `https://${site}/${n++}`, type: 'article', title: 'OpenAI launches GPT-7 model with new reasoning features', description: 'OpenAI released a new AI model.', site, source: site, published_at: now - (n + 1) * HOUR });
  }
  upsertDoc({ url: 'https://d.com/x', type: 'article', title: 'Anthropic opens Claude office in Tokyo', description: 'AI lab expands.', site: 'd.com', source: 'd.com', published_at: now - 2 * HOUR });
  upsertDoc({ url: 'https://e.com/old', type: 'article', title: 'Google DeepMind AI weather model', description: 'AI forecasts.', site: 'e.com', source: 'e.com', published_at: now - 2 * DAY });
  const d = computeCatchup(getDb(), { since, now });
  assert.equal(d.totals.articles, 4, 'only the window');
  assert.equal(d.stories[0].outlets, 3);
  assert.match(d.stories[0].title, /GPT-7/);
  assert.equal(d.stories[0].times.length, 3);
  assert.equal(d.activity.bucket, HOUR);
  assert.equal(d.activity.points.reduce((s, p) => s + p.articles, 0), 4);

  const live = withLive(d, {
    breaking: [{ sid: 'a', title: 'New', startedAt: now - HOUR }, { sid: 'b', title: 'Old', startedAt: since - HOUR }],
    moves: { moves: [{ market: 'm', title: 'M', explained: true, end: now - HOUR, after: [], path: [] }, { market: 'n', explained: false, end: now - HOUR, after: [] }] },
    releases: [{ id: 'r', name: 'R', date: now - HOUR }, { id: 's', name: 'S', date: since - DAY }],
    storylines: { storylines: [{ id: 'x', title: 'X', chapters: [{ at: since - DAY, title: 'a' }, { at: now - HOUR, title: 'b', url: 'u', source: 's' }] }, { id: 'y', title: 'Y', chapters: [{ at: now - HOUR }] }] },
  });
  assert.deepEqual(live.breaking.map((b) => b.sid), ['a']);
  assert.deepEqual(live.moves.map((m) => m.market), ['m'], 'only moves with the news behind them');
  assert.deepEqual(live.releases.map((r) => r.id), ['r']);
  assert.deepEqual(live.storylines.map((s) => [s.id, s.fresh]), [['x', 1]], 'a storyline that moved on, not one that started');
});
