import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb, q } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { DIM, quantize, VectorIndex } from '../src/index/vectors.js';
import { computeAccount, computeAccounts, compareAccounts } from '../src/index/accounts.js';
import { parseFollows, matchFollows, nameIndex, forYou, tasteScores } from '../src/index/foryou.js';

const MIN = 60e3;
const HOUR = 60 * MIN;
const now = Date.parse('2026-10-22T12:00:00Z');

// A unit vector mostly along `dir`, a little along `dir + 1` (so `mix`
// moves it away from a pure one).
function vec(dir, mix = 0) {
  const v = new Array(DIM).fill(0);
  v[dir] = 1;
  v[dir + 1] = mix;
  const n = Math.hypot(1, mix);
  return v.map((x) => x / n);
}

function doc(d, v) {
  const { id } = upsertDoc(d);
  q('INSERT INTO doc_vecs (doc_id, v) VALUES (?, ?)').run(id, quantize(v));
  return id;
}
const post = (handle, n, at, text, v, extra = {}) => doc({ url: `https://x.com/${handle}/status/${n}`, type: 'post', title: text, description: text, site: 'x.com', author: handle, published_at: at, meta: { platform: 'x', handle, ...extra } }, v);
const article = (slug, at, source, v, site = 'news.example') => doc({ url: `https://${site}/${slug}`, type: 'article', title: `${source} on ${slug}`, site, source, published_at: at }, v);

function fixture() {
  resetDb();
  const p1 = now - 3 * 24 * HOUR;
  post('scoopy', 1, p1, 'OpenAI to release GPT-7 next week, sources say', vec(0));
  article('gpt7-verge', p1 + 40 * MIN, 'The Verge', vec(0, 0.2));
  article('gpt7-reuters', p1 + 2 * HOUR, 'Reuters', vec(0, 0.3));
  article('gpt7-reddit', p1 + 10 * MIN, 'r/OpenAI', vec(0, 0.1), 'reddit.com'); // a relay, not the press

  const p2 = now - 2 * 24 * HOUR;
  post('scoopy', 2, p2, 'OpenAI confirms the outage is over', vec(10));
  article('outage', p2 - HOUR, 'CNBC', vec(10, 0.2)); // already covered

  const p3 = p2 + HOUR;
  post('scoopy', 3, p3, 'Our new OpenAI paper on agents', vec(20), { linkUrl: 'https://lab.example/paper' });
  article('paper', p3 - 5 * MIN, 'Lab blog', vec(20, 0.1), 'lab.example'); // its own link
  article('paper-coverage', p3 + 30 * MIN, 'Wired', vec(20, 0.2));

  const p4 = now - 30 * HOUR;
  post('scoopy', 4, p4, 'Something about Anthropic', vec(30));
  article('late', p4 + 20 * HOUR, 'Blog', vec(30, 0.2)); // one outlet, a day later: not a lead

  post('other', 1, now - 5 * HOUR, 'OpenAI DevDay recap', vec(40));
  return new VectorIndex(getDb());
}

test('accounts: ahead of the press, not when covered first, own links and relays ignored', () => {
  const idx = fixture();
  idx.refresh();
  const a = computeAccount(getDb(), idx, 'scoopy', { now });
  assert.equal(a.stats.posts, 4);
  assert.equal(a.stats.ahead, 2);
  const [first, second] = a.ahead;
  assert.match(first.text, /GPT-7/);
  assert.equal(first.ahead.leadMin, 40, 'Reddit was earlier but relays links');
  assert.equal(first.ahead.followers, 2);
  assert.equal(first.ahead.first.source, 'The Verge');
  assert.match(second.text, /paper/);
  assert.equal(second.ahead.leadMin, 30);
  assert.equal(a.grid.flat().reduce((s, n) => s + n, 0), 4);
  assert.equal(a.daily.length, 30);
  assert.equal(a.entities[0].key, 'openai');
  assert.match(a.best[0].text, /GPT-7/, 'the widest lead is the best post');
  assert.equal(computeAccount(getDb(), idx, 'nobody', { now }), null);
});

test('accounts: directory ranks by leads; compare finds shared names', () => {
  const idx = fixture();
  idx.refresh();
  const d = computeAccounts(getDb(), idx, { now });
  assert.deepEqual(d.accounts.map((x) => x.handle), ['scoopy']);
  assert.equal(d.accounts[0].ahead, 2);
  assert.equal(d.accounts[0].spark.reduce((s, n) => s + n, 0), 4);
  const c = compareAccounts(getDb(), idx, 'scoopy', 'other', { now });
  assert.equal(c.b.stats.posts, 1);
  assert.deepEqual(c.shared.map((s) => s.key), ['openai']);
});

test('for you: follows parse defensively', () => {
  const f = parseFollows(new URLSearchParams('t=openai,notatopic,anthropic&n=claude-duet,<bad>&a=sama,way_too_long_handle_x&o=Reuters,The Verge&s=abc123defg,x'));
  assert.deepEqual(f.topics, ['openai', 'anthropic']);
  assert.deepEqual(f.names, ['claude-duet']);
  assert.deepEqual(f.accounts, ['sama']);
  assert.deepEqual(f.outlets, ['Reuters', 'The Verge']);
  assert.deepEqual(f.saved, ['abc123defg']);
});

const story = (sid, title, extra = {}) => ({ sid, id: sid, title, url: `https://news.example/${sid}`, summary: '', score: 10, entities: [], sources: [{ name: 'Reuters', platform: 'web', url: `https://news.example/${sid}` }], lead: { source: 'Reuters' }, ...extra });

test('for you: matches say why; saved stories are left out; taste brings in close ones', async () => {
  resetDb();
  const names = nameIndex({ nodes: [{ key: 'claude-duet', label: 'Claude Duet' }, { key: 'nvidia', label: 'Nvidia', topic: 'nvidia' }] });
  const s1 = story('s000000001', 'Anthropic ships Claude Duet', { entities: ['anthropic'], sources: [{ name: '@sama', platform: 'x', url: 'https://x.com/sama/status/1' }, { name: 'Reuters', platform: 'web' }] });
  const f = parseFollows({ t: 'anthropic', n: 'claude-duet', a: 'SAMA', o: 'reuters', s: 's000000003' });
  assert.deepEqual(matchFollows(s1, f, { names }).map((w) => w.kind), ['topic', 'name', 'account', 'outlet']);

  const store = { snapshot: { version: 7, breaking: [], social: [{ platform: 'x', handle: 'sama', title: 'hello', url: 'https://x.com/sama/status/9', publishedAt: now }], stories: [
    s1,
    story('s000000002', 'Unrelated chip story', { sources: [{ name: 'Bloomberg', platform: 'web' }] }),
    story('s000000003', 'A saved story', { entities: ['anthropic'] }),
    story('s000000004', 'Close in meaning', { sources: [{ name: 'Bloomberg', platform: 'web' }] }),
  ] } };
  const jobs = [];
  const taste = async (job) => { jobs.push(job); return { seeds: 2, scores: { s000000002: 0.4, s000000004: 0.81 } }; };
  const r = await forYou(store, f, { graph: { nodes: [{ key: 'claude-duet', label: 'Claude Duet' }] }, taste });
  assert.deepEqual(r.stories.map((s) => s.sid), ['s000000001', 's000000004']);
  assert.equal(r.stories[0].why.length, 3, 'at most three reasons');
  assert.equal(r.stories[1].why[0].kind, 'taste');
  assert.equal(r.posts.length, 1);
  assert.ok(jobs[0].seeds.includes('https://news.example/s000000003'), 'the saved story seeds the taste');
});

test('for you: the taste vector is the mean of the seeds', () => {
  resetDb();
  doc({ url: 'https://a.example/1', type: 'article', title: 'seed one', published_at: now }, vec(0, 0.1));
  doc({ url: 'https://a.example/2', type: 'article', title: 'seed two', published_at: now }, vec(0, 0.3));
  doc({ url: 'https://a.example/3', type: 'article', title: 'close', published_at: now }, vec(0, 0.2));
  doc({ url: 'https://a.example/4', type: 'article', title: 'far', published_at: now }, vec(50));
  const r = tasteScores(getDb(), { seeds: ['https://a.example/1', 'https://a.example/2', 'https://missing.example/'], candidates: [{ sid: 'c', urls: ['https://a.example/3'] }, { sid: 'f', urls: ['https://a.example/4'] }, { sid: 'n', urls: ['https://none.example/'] }] });
  assert.equal(r.seeds, 2);
  assert.ok(r.scores.c > 0.95);
  assert.ok(Math.abs(r.scores.f) < 0.05);
  assert.equal(r.scores.n, undefined);
});
