import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb } from '../src/db.js';
import { buildIndex, jumpSearch, savedStatus } from '../src/index/jump.js';

const index = buildIndex({
  stories: [
    { sid: 'duet000001', title: 'Anthropic unveils Claude Duet, a personal agent', lead: { source: 'CNBC' }, sources: [{}, {}, {}], publishedAt: 1 },
    { sid: 'chips00001', title: 'Nvidia chip orders from China top $35 billion', lead: { source: 'Reuters' }, sources: [{}], publishedAt: 1 },
  ],
  releases: [{ id: 'r1', name: 'GPT-6 Sol', provider: 'OpenAI', url: 'https://openrouter.ai/x', story: { sid: 'sol0000001' } }, { id: 'r2', name: 'Flint', provider: 'Recursive', url: 'https://openrouter.ai/flint' }],
  markets: [{ title: 'Anthropic IPO by 2027?', url: 'https://polymarket.com/e/1', volume: 2e6 }],
  posts: [{ handle: 'Kalshi', author: 'Kalshi', platform: 'x' }, { handle: 'Kalshi', author: 'Kalshi' }, { handle: 'sama', author: 'Sam Altman' }],
  graph: { days: 30, nodes: [{ key: 'claude-duet', label: 'Claude Duet', n: 56 }] },
  themes: [{ id: 'theme00001', name: ['Personal agents', 'Muse'], headline: 'Agents everywhere' }],
  breaking: [{ sid: 'chips00001' }],
});

test('jump: every word must start a word of the entry; names and topics lead', () => {
  const r = jumpSearch(index, 'cl du');
  assert.equal(r[0].type, 'name');
  assert.equal(r[0].href, '#graph/claude-duet');
  assert.ok(r.some((e) => e.href === '#story/duet000001'));
  assert.equal(jumpSearch(index, 'anthropic')[0].type, 'topic');
  assert.deepEqual(jumpSearch(index, 'duet xyz'), [], 'all words must match');
  assert.deepEqual(jumpSearch(index, '   '), []);
});

test('jump: accounts by @handle or name, releases link to their story, markets are external', () => {
  assert.equal(jumpSearch(index, '@sama')[0].handle, 'sama');
  assert.equal(jumpSearch(index, 'sam alt')[0].handle, 'sama');
  const sol = jumpSearch(index, 'gpt-6 sol')[0];
  assert.equal(sol.href, '#story/sol0000001');
  assert.equal(sol.external, false);
  assert.equal(jumpSearch(index, 'flint')[0].external, true);
  const ipo = jumpSearch(index, 'ipo');
  assert.equal(ipo[0].href, '#topic/ipo', 'the topic page first');
  assert.ok(ipo.find((e) => e.type === 'market').external);
  assert.equal(jumpSearch(index, 'nvidia chip')[0].breaking, true);
  const theme = jumpSearch(index, 'personal')[0];
  assert.equal(theme.type, 'theme');
  assert.equal(theme.label, 'Personal agents · Muse');
});

test('saved status: live stories now, logged ones after they leave, unknown ones gone', () => {
  resetDb();
  const store = { snapshot: { stories: [{ sid: 'live000001', title: 'Live', url: 'https://e.com', sources: [{}, {}], updatedAt: 5, lead: { source: 'E' } }], breaking: [{ sid: 'live000001' }] } };
  const [a, b] = savedStatus(store, ['live000001', 'nothere01']);
  assert.equal(a.sources, 2);
  assert.equal(a.live, true);
  assert.equal(a.breaking, true);
  assert.equal(b.gone, true);
});
