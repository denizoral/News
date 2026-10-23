import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { parseChip, computeChips } from '../src/index/chips.js';

const DAY = 86400e3;
const now = Date.parse('2026-10-22T12:00:00Z');

test('chip headlines: what happened, which camp, GPU counts and buyers', () => {
  const a = parseChip('California tech CEO arrested for smuggling $300 million in Nvidia AI servers to China');
  assert.deepEqual([a.kind, a.camp], ['export', 'nvidia']);
  const b = parseChip('Tencent is renting 100,000 AI chips from Oracle for $7 billion');
  assert.deepEqual([b.kind, b.units, b.buyer], ['deal', 100000, 'Tencent']);
  assert.equal(parseChip('xAI Colossus Hits 2 GW: 555,000 GPUs, $18B, Largest AI Site').buyer, 'xAI');
  assert.equal(parseChip('ASML Cannot Fill AI Chip-Tool Orders Through 2028').kind, 'shortage');
  assert.equal(parseChip('Cambricon targets 500,000 AI chips in 2026 as China accelerates domestic hardware push').camp, 'china');
  assert.deepEqual(parseChip('Google unveils Ironwood, its seventh-generation TPU').camps, ['custom']);
  // Stock tips, gaming cards and models aren't chip news.
  assert.equal(parseChip('$4,000 in These 4 Non-Nvidia Chip Stocks Could Be Worth This Much by 2030'), null);
  assert.equal(parseChip('NVIDIA DLSS 5 Gets 2x Performance Boost with 20% Less VRAM Usage'), null);
});

test('chips: one story across outlets, camp shares, GPU deals, export timeline', () => {
  resetDb();
  let n = 0;
  const add = (title, source, daysAgo) => upsertDoc({ url: `https://${source}.com/${n++}`, type: 'article', title, description: '', body: '', site: `${source}.com`, source, published_at: now - daysAgo * DAY });
  add('ByteDance, Alibaba, Tencent place over $35 billion worth of Nvidia chip orders', 'reuters', 4);
  add('ByteDance, Alibaba and Tencent place $35 billion of Nvidia AI chip orders', 'ft', 3);
  add('US tightens export controls on AI chips to China', 'ap', 20);
  add('Tencent is renting 100,000 AI chips from Oracle for $7 billion', 'verge', 10);
  add('AMD unveils MI450 accelerator for AI data centers', 'amd', 30);
  add('$4,000 in These 4 Chip Stocks Could Be Worth This Much by 2030', 'fool', 2);
  const d = computeChips(getDb(), now);
  const orders = d.events.filter((x) => /\$35 billion/.test(x.title));
  assert.equal(orders.length, 1, 'one story');
  assert.equal(orders[0].outlets, 2);
  assert.equal(d.exports.length, 1);
  assert.equal(d.units[0].units, 100000);
  assert.equal(d.camps.find((c) => c.key === 'nvidia').n90, 2);
  assert.ok(d.camps.find((c) => c.key === 'amd').share90 > 0);
  assert.equal(d.months.length, 12);
  assert.ok(!d.events.some((x) => /Stocks/.test(x.title)));
});
