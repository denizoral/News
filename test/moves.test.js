import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb, q } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { DIM, quantize } from '../src/index/vectors.js';
import { detectJumps, marketKeys, computeMoves, pathAround, explainedMoves, movesAfter } from '../src/index/moves.js';

const H = 3600e3;
const now = Date.parse('2026-10-22T12:00:00Z');
const vec = (axis, wobble = 0) => {
  const v = new Array(DIM).fill(0);
  v[axis] = 1;
  v[(axis + 1) % DIM] = wobble;
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};
// Half-hourly prices: `level(t)` gives the price `hoursAgo` hours before now.
const series = (hours, level) => Array.from({ length: hours * 2 + 1 }, (_, i) => {
  const t = now - hours * H + i * H / 2;
  return [t, level((now - t) / H)];
});

test('jumps: a move that holds counts, a spike that snaps back does not', () => {
  const held = series(24, (ago) => (ago > 10 ? 0.4 : ago > 9 ? 0.48 : 0.6));
  const jumps = detectJumps(held, { now });
  assert.equal(jumps.length, 1);
  assert.ok(jumps[0].change >= 0.19 && jumps[0].change <= 0.21);
  assert.ok(jumps[0].start >= now - 11 * H && jumps[0].end <= now - 8.9 * H);

  const spike = series(24, (ago) => (ago > 10.2 && ago < 11.8 ? 0.65 : 0.4));
  assert.deepEqual(detectJumps(spike, { now }), []);

  const drift = series(24, (ago) => 0.6 - ago * 0.01); // 24 points over a day: no 3-hour jump
  assert.deepEqual(detectJumps(drift, { now }), []);

  // Too recent to know whether it held.
  const fresh = series(6, (ago) => (ago > 0.6 ? 0.3 : 0.5));
  assert.deepEqual(detectJumps(fresh, { now }), []);
});

test('market keys: the outcome on a multi-outcome market, else the question', () => {
  assert.deepEqual(marketKeys('Next GPT Sol (6.2+) released by...?', 'October 31', false).need.sort(), ['gpt', 'sol']);
  const k = marketKeys('Who will launch a Muse-like personal agent before 2027?', 'Anthropic', false);
  assert.deepEqual(k.need, ['anthropic']);
  assert.equal(k.byLabel, true);
  assert.ok(k.also.includes('muse-like') || k.also.includes('muse'));
  assert.equal(marketKeys('Grok 5 released by...?', 'Yes', true).byLabel, false);
});

test('market moves: a jump is credited to the close story before it that names the subject', () => {
  resetDb();
  const db = getDb();
  const jumpAgo = 8;
  const ins = q('INSERT INTO odds (market, outcome, ts, yes) VALUES (?, ?, ?, ?)');
  for (const [t, y] of series(48, (ago) => (ago > jumpAgo + 1 ? 0.62 : ago > jumpAgo ? 0.8 : 0.97))) ins.run('pm:1', 'Anthropic', t, y);
  for (const [t, y] of series(48, () => 0.2)) ins.run('pm:1', 'OpenAI', t, y);
  const doc = (url, title, axis, wobble, hoursAgo, lang = 'en') => {
    const { id } = upsertDoc({ url, type: 'article', title, lang, site: new URL(url).hostname, source: new URL(url).hostname, published_at: now - hoursAgo * H });
    q('INSERT INTO doc_vecs (doc_id, v) VALUES (?, ?)').run(id, quantize(vec(axis, wobble)));
  };
  doc('https://cnbc.com/duet', 'Anthropic announces Claude Duet, a personal agent to take on Muse', 0, 0.1, jumpAgo + 2);
  doc('https://verge.com/duet', 'Anthropic takes on Muse with Claude Duet', 0, 0.2, jumpAgo + 2.5);
  doc('https://other.com/x', 'Anthropic raises prices for enterprise plans', 7, 0, jumpAgo + 1); // names it, far in meaning
  doc('https://close.com/y', 'Personal agents are the next platform war', 0, 0, jumpAgo + 1); // close, doesn't name it
  doc('https://old.com/z', 'Anthropic previews an agent for Muse users', 0, 0.1, jumpAgo + 20); // too early
  doc('https://de.com/z', 'Anthropic Muse Agent Claude Duet startet', 0, 0.1, jumpAgo + 1, 'de');
  q('INSERT INTO story_ids (item_url, sid, at) VALUES (?, ?, ?)').run('https://www.cnbc.com/duet', 'duetSid01', now);

  const markets = [{ id: 'pm:1', title: 'Who will launch a Muse-like personal agent before 2027?', url: 'https://polymarket.com/e/1', binary: false, volume: 1e6, outcomes: ['Anthropic', 'OpenAI'] }];
  const d = computeMoves(db, markets, { 'pm:1': vec(0) }, { now });
  assert.equal(d.moves.length, 1);
  const [mv] = d.moves;
  assert.equal(mv.label, 'Anthropic');
  assert.ok(mv.change > 0.3);
  assert.deepEqual(mv.after.map((a) => a.url), ['https://cnbc.com/duet', 'https://verge.com/duet']);
  assert.equal(mv.after[0].sid, 'duetSid01', 'the story id is found through the www. form of the URL');
  assert.ok(mv.after[0].lead > 0, 'published before the jump');
  assert.ok(mv.path.length >= 20 && mv.path[0][1] < mv.path.at(-1)[1]);

  assert.equal(explainedMoves(d).length, 1);
  assert.equal(movesAfter(d, ['https://www.cnbc.com/duet/']).length, 1, 'matched by canonical URL');
  assert.equal(movesAfter(d, ['https://other.com/x']).length, 0);

  // No vector (classifier down): the jump is still reported, unexplained.
  const bare = computeMoves(db, markets, {}, { now });
  assert.equal(bare.moves.length, 1);
  assert.deepEqual(bare.moves[0].after, []);
});

test('path around a jump: carries the last price forward on even steps', () => {
  const pts = [[0, 0.1], [10 * H, 0.5]];
  const p = pathAround(pts, { start: 9 * H, end: 10 * H }, 5);
  assert.equal(p.length, 5);
  assert.equal(p[0][1], 0.1);
  assert.equal(p.at(-1)[1], 0.5);
});
