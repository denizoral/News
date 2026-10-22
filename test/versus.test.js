import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { computeVersus, distinctiveWords } from '../src/index/versus.js';

const H = 3600e3;
const now = Date.parse('2026-10-22T12:00:00Z');

test('distinctive words: what one side says and the other does not', () => {
  const shared = ['New model released', 'Model tops leaderboard', 'Model card published', 'Agents get memory'];
  const a = [...['Lab files for IPO', 'IPO roadshow begins', 'IPO pricing set', 'IPO date leaks', 'Bankers line up IPO', 'IPO could be largest', 'Retail investors eye IPO', 'IPO delayed a week'], ...shared];
  const b = [...['Chip export rules tighten', 'Export ban widened', 'Export curbs hit chips', 'Export licence denied', 'Export rules eased', 'New export controls', 'Export limits on GPUs', 'Export fight escalates'], ...shared];
  const w = distinctiveWords(a, b, [...a, ...b], { min: 3 });
  assert.equal(w.a[0].word, 'IPO');
  assert.equal(w.b[0].word.toLowerCase(), 'export');
  assert.ok(!w.a.some((x) => /model/i.test(x.word)), 'shared words are not distinctive');
});

test('head to head: counts, overlap, outlet lean, peaks and the picker', () => {
  resetDb();
  let n = 0;
  const add = (title, site, hoursAgo) => upsertDoc({ url: `https://${site}/${n++}`, type: 'article', title, description: '', site, source: site, published_at: now - hoursAgo * H });
  for (let i = 0; i < 24; i++) add(`OpenAI prepares IPO filing ${i}`, 'a.com', 2 + i / 2);
  for (let i = 0; i < 12; i++) add(`Google ships Gemini feature ${i}`, 'g.com', 70 + i);
  for (let i = 0; i < 6; i++) add(`Anthropic ships Claude update ${i}`, 'b.com', 30 + i);
  for (let i = 0; i < 4; i++) add(`OpenAI and Anthropic sign safety pact ${i}`, 'c.com', 50 + i);
  const d = computeVersus(getDb(), { a: 'openai', b: 'anthropic', days: 7, now });
  assert.equal(d.a.n, 28);
  assert.equal(d.b.n, 10);
  assert.equal(d.both.n, 4);
  assert.equal(d.series.a.length, 7);
  assert.equal(d.series.a.reduce((s, v) => s + v, 0), 28);
  assert.equal(d.a.peak.n, 24);
  const la = d.outlets.find((o) => o.name === 'a.com');
  assert.ok(la.lean > 0 && d.outlets.find((o) => o.name === 'b.com').lean < 0);
  assert.ok(d.a.words.some((w) => w.word === 'IPO'));
  assert.ok(d.a.headlines.every((h) => !/Anthropic/.test(h.title)), 'one-side headlines leave out the other');
  assert.ok(d.names.some((x) => x.key === 'openai'));
  assert.equal(computeVersus(getDb(), { a: 'openai', b: 'openai', days: 7, now }).missing, true);
});
