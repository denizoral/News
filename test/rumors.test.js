import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { HEDGE, amounts, claimWords, computeRumors } from '../src/index/rumors.js';

const DAY = 86400e3;
const now = Date.parse('2026-10-22T12:00:00Z');

test('hedges: reports and talks are claims, announcements and roundups are not', () => {
  for (const t of ['Nvidia reportedly in talks to buy Hugging Face', 'DeepSeek wrapping up $15 billion fundraising, sources say', 'Meta weighs a sale of its VR unit', 'Report: Apple preps a cheaper headset', 'OpenAI eyes $30B raise', 'Anthropic is said to be planning an IPO']) assert.ok(HEDGE.test(t), t);
  for (const t of ['Nvidia confirms it will buy Hugging Face', 'Google announces Gemini 3.7 Flash', 'LG Innotek teams with Nvidia on robot eyes and hands', 'Fireblocks CSO weighs in on token use cases']) assert.ok(!HEDGE.test(t), t);
});

test('amounts are one token whichever way they are written', () => {
  assert.deepEqual(amounts('raises $15B'), ['$15b']);
  assert.deepEqual(amounts('a $15 billion round'), ['$15b']);
  assert.deepEqual(amounts('€2.5bn deal'), ['€2.5b']);
  const w = claimWords('Nvidia reportedly in talks to buy Hugging Face for $12.9 billion', new Set(['nvidia']));
  assert.ok(w.has('$12.9b') && w.has('hugg') && !w.has('nvidia') && !w.has('reportedly'));
});

test('rumor tracker: claims grouped across outlets, settled by later coverage, outlet record', () => {
  resetDb();
  let n = 0;
  const add = (title, source, daysAgo) => upsertDoc({ url: `https://${source.toLowerCase().replace(/\W/g, '')}.com/${n++}`, type: 'article', title, description: '', site: `${source.toLowerCase().replace(/\W/g, '')}.com`, source, published_at: now - daysAgo * DAY });
  // Confirmed: reported by three outlets, announced nine days later.
  add('Nvidia reportedly in talks to buy Hugging Face for $12.9 billion', 'Scoopy', 20);
  add('Nvidia nears deal to acquire Hugging Face, sources say', 'Wires', 19.5);
  add('Nvidia in advanced talks over $12.9 billion Hugging Face takeover', 'Daily Chip', 19);
  add('Nvidia confirms it will buy Hugging Face for $12.9 billion', 'Wires', 11);
  // Denied.
  add('Nvidia reportedly ending the RTX 5090 to save GB202 silicon', 'Scoopy', 30);
  add('Nvidia denies RTX 5090 is being discontinued, GB202 supply tight', 'Hardware Hub', 27);
  // Went quiet: nothing for weeks.
  add('Meta weighs selling its Reality Labs headset unit', 'Scoopy', 60);
  // Open: last week, nothing yet.
  add('Anthropic reportedly in talks with Nscale over $45 billion compute deal', 'Wires', 3);
  // Not about the same thing, though it names Nvidia: doesn't settle anything.
  add('Nvidia announces quarterly earnings date', 'Wires', 25);
  // Speculation repeated without a hedge word doesn't settle it either.
  add('Anthropic could sign $45 billion Nscale compute deal this week', 'Daily Chip', 1);

  const r = computeRumors(getDb(), { now });
  const by = (re) => r.claims.find((c) => re.test(c.title));
  const hf = by(/Hugging Face/);
  assert.equal(hf.status, 'confirmed');
  assert.equal(hf.outlets, 3, 'three outlets carried one claim');
  assert.match(hf.settled.title, /confirms/);
  assert.equal(hf.leadDays, 9);
  assert.equal(by(/RTX 5090/).status, 'denied');
  assert.equal(by(/Reality Labs/).status, 'quiet');
  assert.equal(by(/Nscale/).status, 'open');
  assert.equal(r.totals.claims, 4);
  assert.equal(r.totals.rate, +(1 / 3).toFixed(3));
  assert.equal(r.ahead.find((b) => b.label === '1–2 weeks').n, 1);
  const scoopy = r.outlets.find((o) => o.name === 'Scoopy');
  assert.deepEqual([scoopy.claims, scoopy.confirmed, scoopy.denied, scoopy.quiet, scoopy.firstOn], [3, 1, 1, 1, 3]);
});
