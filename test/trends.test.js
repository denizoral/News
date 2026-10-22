import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { parseTerms, bucketOf, pickPeaks, computeTrends, trendMoment } from '../src/index/trends.js';
import { recordRun, sampleVitals, statusHistory, pruneStatus, noteRequest, quantile } from '../src/status.js';

const DAY = 86400e3;
const now = Date.parse('2026-10-22T12:00:00Z');

test('trends: terms, weeks start on Monday, peaks stay apart', () => {
  assert.deepEqual(parseTerms(' OpenAI , anthropic,openai, "open weights", , a,b,c').map((t) => t.label), ['OpenAI', 'anthropic', '"open weights"', 'a']);
  assert.match(parseTerms('open weights')[0].match, /^\{title description body\} : \("open" "weights"\)$/);
  assert.deepEqual(parseTerms('  ,  '), []);
  const mon = Date.parse('2026-10-19T00:00:00Z');
  assert.equal(bucketOf(Date.parse('2026-10-22T15:00:00Z'), 'week') * DAY, mon);
  assert.equal(bucketOf(Date.parse('2026-10-25T23:59:00Z'), 'week') * DAY, mon);
  assert.equal(bucketOf(mon, 'day') * DAY, mon);
  const pts = [1, 9, 8, 2, 2, 2, 7, 1].map((share, i) => ({ share, count: i === 7 ? 1 : 5 }));
  assert.deepEqual(pickPeaks(pts, 3, 4).map((p) => p.i), [1, 6], 'index 2 is too close to 1');
});

test('trends: share of everything stored per day, peaks with their headline, moments', () => {
  resetDb();
  let n = 0;
  const doc = (title, daysAgo, body = '') => upsertDoc({ url: `https://n.example/${n++}`, type: 'article', title, body, site: 'n.example', source: 'N', published_at: now - daysAgo * DAY });
  for (let d = 0; d < 30; d++) { doc(`Filler story ${d}`, d); doc(`Another filler ${d}`, d); }
  doc('Anthropic ships a model', 3);
  doc('Anthropic raises money', 3, 'Anthropic said so.');
  doc('Anthropic opens an office', 3);
  doc('OpenAI and Anthropic sign a pact', 10);
  upsertDoc({ url: 'https://m.example/1', type: 'market', title: 'Will Anthropic IPO?', site: 'm.example', published_at: now - 3 * DAY });
  const db = getDb();
  const r = computeTrends(db, { q: 'anthropic, openai, nothinghere', range: '30d', now });
  assert.equal(r.bucket, 'day');
  const [a, o, none] = r.terms;
  assert.equal(a.total, 4, 'markets are not coverage');
  const peak = a.points.find(([t]) => t === bucketOf(now - 3 * DAY, 'day') * DAY);
  assert.equal(peak[2], 3);
  assert.equal(peak[1], 600, '3 of 5 stories that day = 600 per 1,000');
  assert.equal(a.peaks.length, 1, 'the day with one mention is below the floor');
  assert.match(a.peaks[0].doc.title, /^Anthropic/);
  assert.equal(o.total, 1);
  assert.equal(none.total, 0);
  assert.equal(r.totals.length, a.points.length);
  const m = trendMoment(db, { q: 'anthropic', from: peak[0], to: peak[0] + DAY });
  assert.equal(m.docs.length, 3);
  assert.ok(m.docs.every((d) => d.title.startsWith('Anthropic')));
});

test('status: runs and vitals fold into hourly slots; quiet X accounts first', () => {
  resetDb();
  const t = now - 2 * 3600e3;
  recordRun('rss', { ok: true, count: 40, added: 3, ms: 900, lastRun: t });
  recordRun('rss', { ok: false, count: 0, error: 'HTTP 503', ms: 120, lastRun: t + 60e3 });
  recordRun('rss', { ok: true, count: 41, added: 1, ms: 1100, lastRun: now - 60e3 });
  recordRun('x', { ok: true, count: 400, added: 0, ms: 8000, lastRun: now - 30e3 });
  upsertDoc({ url: 'https://x.com/Kalshi/status/1', type: 'post', title: 'Odds moved', site: 'x.com', published_at: now - 3600e3, meta: { handle: 'Kalshi' } });
  noteRequest(10); noteRequest(30); noteRequest(500);
  const v = sampleVitals(() => ({ embeddings: { backlog: 7 }, labeler: { pending: 2 }, sources: { x: { accountsCached: 46 } } }), now - 5 * 60e3);
  assert.equal(v.api_p95, 500);
  assert.equal(v.api_n, 3);
  assert.equal(quantile([], 0.5), null);
  const h = statusHistory({ hours: 24, now, live: { rss: { ok: true, lastRun: now - 60e3, count: 41 }, bluesky: { ok: true, paused: true } } });
  assert.equal(h.slots, 24);
  const rss = h.sources.find((s) => s.name === 'rss');
  assert.equal(rss.runs, 3);
  assert.equal(rss.uptime, 66.7);
  assert.equal(rss.lastError, 'HTTP 503');
  const slot = rss.slots[h.slots - 2];
  assert.deepEqual([slot[0], slot[1], slot[3]], [2, 1, 3], 'two runs, one failed, three added in that hour');
  assert.equal(h.sources.find((s) => s.name === 'bluesky').paused, true);
  assert.deepEqual(h.vitals.embed_backlog, [[now - 5 * 60e3, 7]]);
  assert.ok(h.ingest.reduce((a, b) => a + b, 0) >= 1);
  const kalshi = h.x.find((a) => a.handle === 'Kalshi');
  assert.equal(kalshi.week, 1);
  assert.equal(h.x[0].last, null, 'accounts that never posted come first');
  assert.equal(pruneStatus(now + 40 * DAY) > 0, true);
});
