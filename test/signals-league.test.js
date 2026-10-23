import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { computeSignals } from '../src/index/signals.js';
import { computeLeague } from '../src/index/league.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;

// A fake vector index: documents with the same "topic" are identical, others orthogonal.
function fakeIndex(topics) {
  return { rowOf: (id) => (topics.has(id) ? id : null), dot: (a, b) => (topics.get(a) === topics.get(b) ? 1 : 0) };
}

test('signals: posts no article is close to, grouped by meaning; the press catching up', () => {
  resetDb();
  const now = Date.now();
  const topics = new Map();
  let n = 0;
  const add = (type, title, topic, hoursAgo, handle = 'someone') => {
    const id = upsertDoc({ url: type === 'post' ? `https://x.com/${handle}/status/${n++}` : `https://news.com/${n++}`, type, title, description: '', body: '', site: type === 'post' ? 'x.com' : 'news.com', source: type === 'post' ? `@${handle}` : 'News', published_at: now - hoursAgo * HOUR, meta: type === 'post' ? { platform: 'x', handle } : null });
    const row = getDb().prepare('SELECT id FROM docs WHERE url = ?').get(type === 'post' ? `https://x.com/${handle}/status/${n - 1}` : `https://news.com/${n - 1}`);
    topics.set(row.id, topic);
  };
  add('post', 'New AI model spotted in testing', 'spotted', 5, 'testingcatalog');
  add('post', 'Spotted: a new AI model in testing', 'spotted', 4, 'kimmonismus');
  add('post', 'OpenAI ships an AI agent', 'agent', 10, 'ai_for_success');
  add('article', 'OpenAI ships an AI agent for everyone', 'agent', 6);
  add('post', 'Wolves roam Finnish villages', 'wolves', 3, 'Polymarket');
  const d = computeSignals(getDb(), { vi: fakeIndex(topics), now });
  assert.equal(d.signals.length, 1, 'non-AI posts are left out');
  assert.equal(d.signals[0].accounts, 2);
  assert.equal(d.caught.length, 1);
  assert.equal(d.caught[0].lead, 240);
});

test('league: labs ranked by share of the news, with last week’s rank, mood and odds', () => {
  resetDb();
  const now = Date.now();
  let n = 0;
  const add = (title, daysAgo, type = 'article') => upsertDoc({ url: `https://news.com/${n++}`, type, title, description: '', body: '', site: 'news.com', source: 'News', published_at: now - daysAgo * DAY });
  for (let i = 0; i < 6; i++) add(`Anthropic releases Claude update number ${i}`, 2);
  for (let i = 0; i < 2; i++) add(`OpenAI sued over ChatGPT privacy ${i}`, 3);
  for (let i = 0; i < 5; i++) add(`OpenAI launches ChatGPT feature ${i}`, 9);
  for (let i = 0; i < 4; i++) add(`Weather report ${i}`, 1);
  const markets = [{ id: 'pm:1', title: 'Which company has best AI model end of 2026?', url: 'u', outcomes: [{ label: 'Anthropic', yes: 0.5 }, { label: 'Google', yes: 0.4 }] }];
  const d = computeLeague(getDb(), { now, markets, shipped: { entries: [] } });
  assert.equal(d.table[0].key, 'anthropic');
  assert.equal(d.table[0].rank, 1);
  assert.equal(d.table.find((x) => x.key === 'openai').prevRank, 1, 'OpenAI led last week');
  assert.equal(d.table[0].odds.yes, 0.5);
  assert.equal(d.table[0].days.length, 14);
  assert.ok(Math.abs(d.table[0].share - 6 / 12) < 1e-9);
});
