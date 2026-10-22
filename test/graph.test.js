import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { discoverNames, nameMatcher, computeGraph, graphDetail } from '../src/index/graph.js';

const DAY = 86400e3;
const now = Date.parse('2026-10-22T12:00:00Z');

test('name matching: longest name wins, word boundaries, case-sensitive', () => {
  const nodes = [
    { key: 'claude', aliases: ['Claude'] },
    { key: 'claude-code', aliases: ['Claude Code'] },
    { key: 'meta', aliases: ['Meta'] },
    { key: 'openai', aliases: ['OpenAI'] },
  ];
  const names = nameMatcher(nodes);
  const match = (t) => names(t).map((i) => nodes[i].key);
  assert.deepEqual(match('Claude Code ships agents, and OpenAI responds').sort(), ['claude-code', 'openai']);
  assert.deepEqual(match('Claude and Claude Code'), ['claude', 'claude-code']);
  assert.deepEqual(match('A metadata leak; Metaverse news'), [], 'no partial words');
  assert.deepEqual(match('meta is lower case here'), []);
});

test('discovered names: proper nouns used often, not common words or outlets', () => {
  const texts = [];
  for (let i = 0; i < 20; i++) texts.push(`Anthropic said on Tuesday that Claude Duet will ship. Readers can follow the Link below.`);
  for (let i = 0; i < 20; i++) texts.push(`The link between them is clear, per TechWire reporting on Nscale and its data plans.`);
  for (let i = 0; i < 20; i++) texts.push(`Investors back Nscale again, TechWire says.`);
  const names = discoverNames(texts, { known: ['Anthropic', 'Claude'], sources: new Set(['techwire']), min: 10 }).map((n) => n.label);
  assert.ok(names.includes('Claude Duet'), 'a known name plus a word is a product of its own');
  assert.ok(names.includes('Nscale'));
  assert.ok(!names.includes('Link'), 'also written in lower case');
  assert.ok(!names.includes('TechWire'), 'an outlet');
  assert.ok(!names.includes('Anthropic') && !names.includes('Tuesday'));
});

test('entity graph: co-mentions with lift, trends, and detail for a name or a pair', () => {
  resetDb();
  let k = 0;
  const add = (title, daysAgo, site = 'example.com') => upsertDoc({ url: `https://${site}/${k++}`, type: 'article', title, description: '', site, source: site, lang: 'en', published_at: now - daysAgo * DAY });
  for (let i = 0; i < 12; i++) add(`OpenAI and Microsoft renegotiate their deal ${i}`, i % 6);
  for (let i = 0; i < 6; i++) add(`Microsoft ships Copilot update ${i}`, i % 6);
  for (let i = 0; i < 8; i++) add(`OpenAI launches ChatGPT feature ${i}`, i % 6);
  for (let i = 0; i < 6; i++) add(`Nvidia and AMD race on chips ${i}`, 1);
  for (let i = 0; i < 2; i++) add(`Nvidia earnings preview ${i}`, 10); // the week before
  for (let i = 0; i < 30; i++) add(`Weather and sports roundup ${i}`, i % 7);
  add('OpenAI and Microsoft on a model page', 1, 'huggingface.co'); // not coverage
  const g = computeGraph(getDb(), { days: 7, now });
  const node = (key) => g.nodes.find((n) => n.key === key);
  assert.equal(node('openai').n, 20);
  assert.equal(node('microsoft').n, 18);
  assert.equal(node('openai').type, 'org');
  assert.equal(node('chatgpt').type, 'product');
  assert.equal(node('nvidia').prev, 2, 'the window before');
  assert.equal(node('openai').series.reduce((a, b) => a + b, 0), 20);
  const edge = g.edges.find((e) => [e.a, e.b].sort().join() === 'microsoft,openai');
  assert.equal(edge.n, 12);
  assert.ok(edge.lift > 1);
  assert.ok(g.edges.some((e) => [e.a, e.b].sort().join() === 'amd,nvidia'));
  assert.ok(!g.edges.some((e) => [e.a, e.b].sort().join() === 'chatgpt,microsoft'), 'never together');

  const pair = graphDetail(getDb(), { days: 7, a: 'openai', b: 'microsoft', now });
  assert.equal(pair.n, 12);
  assert.equal(pair.items.length, 12);
  assert.equal(pair.series.length, 7);
  assert.ok(pair.items[0].at >= pair.items.at(-1).at, 'newest first');
  const one = graphDetail(getDb(), { days: 7, a: 'openai', now });
  assert.equal(one.with[0].key, 'microsoft');
  assert.equal(graphDetail(getDb(), { days: 7, a: 'nobody', now }), null);
});
