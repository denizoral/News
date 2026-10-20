// Trending now: entity velocity over a window versus its baseline, and the API.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb } from '../src/db.js';
import { settings } from '../src/settings.js';
import { computeTrending } from '../src/pipeline/trending.js';
import { Store } from '../src/store.js';
import { Spider } from '../src/spider/engine.js';
import { createApp } from '../src/server.js';

resetDb();
settings.load();

const now = Date.now();
const H = 3600e3;
const item = (i, title, hoursAgo, source = `Outlet ${i % 5}`) => ({ id: `t:${title}:${i}`, title, summary: '', publishedAt: now - hoursAgo * H, source });

function sample() {
  const items = [];
  // OpenAI: busy all the time, steady pace.
  for (let i = 0; i < 30; i++) items.push(item(i, `OpenAI update number ${i}`, (i * 30) / 30));
  // Mistral: quiet yesterday, a burst in the last hours across several outlets.
  for (let i = 0; i < 6; i++) items.push(item(i, `Mistral releases model ${i}`, 0.5 + i * 0.5));
  items.push(item(0, 'Mistral note', 20));
  // DeepSeek: lots of mentions, all from a single feed (not trending).
  for (let i = 0; i < 6; i++) items.push(item(i, `DeepSeek item ${i}`, 1, 'One Feed'));
  return items;
}

test('a quiet name with a fresh burst outranks a steadily busy one', () => {
  const t = computeTrending(sample(), { now });
  const keys = t.topics.map((x) => x.key);
  assert.equal(keys[0], 'mistral');
  assert.ok(keys.includes('openai'));
  assert.ok(!keys.includes('deepseek'), 'one source is not a trend');
  const mistral = t.topics[0];
  assert.equal(mistral.label, 'Mistral');
  assert.equal(mistral.count, 6);
  assert.equal(mistral.spark.length, 12);
  assert.equal(mistral.spark.reduce((a, b) => a + b), 7, 'sparkline covers the last 24h');
  assert.ok(mistral.lift > 1);
});

test('window size changes what counts as recent', () => {
  const one = computeTrending(sample(), { now, hours: 1 });
  assert.ok(one.topics.every((x) => x.count >= 3));
  assert.equal(one.hours, 1);
  assert.equal(computeTrending([], { now }).topics.length, 0);
});

test('/api/trending serves the snapshot window and others, with ETags', async () => {
  const store = new Store();
  store.ingest('rss', sample());
  store.rebuild();
  assert.ok(store.snapshot.trending.topics.length > 0, 'trending ships in the snapshot');
  const server = createApp({ store, spider: new Spider() });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/api/trending?hours=24`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.hours, 24);
    assert.equal(body.version, store.snapshot.version);
    const again = await fetch(`${base}/api/trending?hours=24`, { headers: { 'if-none-match': res.headers.get('etag') } });
    assert.equal(again.status, 304);
    assert.equal((await fetch(`${base}/api/trending?hours=5`)).status, 400);
    const six = await (await fetch(`${base}/api/trending`)).json();
    assert.deepEqual(six.topics, store.snapshot.trending.topics);
    const snap = await fetch(`${base}/api/snapshot`, { headers: { 'accept-encoding': 'br' } });
    assert.equal(snap.headers.get('content-encoding'), 'br');
    assert.ok((await snap.json()).trending, 'decoded Brotli snapshot');
  } finally {
    server.close();
  }
});
