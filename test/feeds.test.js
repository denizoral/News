// Feeds (RSS 2.0 and JSON Feed) and the API index.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb } from '../src/db.js';
import { settings } from '../src/settings.js';
import { upsertDoc } from '../src/index/documents.js';
import { Store } from '../src/store.js';
import { Spider } from '../src/spider/engine.js';
import { createApp } from '../src/server.js';
import { renderRss, renderJsonFeed, etagOf, storyItem } from '../src/feeds.js';
import { API, FEEDS } from '../src/apicatalog.js';
import { stopWorkers } from '../src/index/offload.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Worker jobs open the database by path: point them at an empty directory, not data/.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-feeds-'));

resetDb();
settings.load();
const now = Date.now();

test('feeds: RSS escapes, JSON Feed links the story page, the ETag follows the items', () => {
  const s = { sid: 'abc123defg', title: 'Nvidia & AMD <chips>', url: 'https://news.example/a?x=1&y=2', summary: 'Q3 "beat"', publishedAt: now, lead: { source: 'Reuters' }, sources: [{ name: 'Reuters' }, { name: 'Bloomberg' }], topics: ['Chips'] };
  const feed = { title: 'Nvidia', description: 'd', home: 'https://w.example/#topic/nvidia', items: [storyItem(s, 'https://w.example')] };
  const rss = renderRss(feed, 'https://w.example/feeds/topic/nvidia.xml');
  assert.match(rss, /<title>Nvidia &amp; AMD &lt;chips&gt;<\/title>/);
  assert.match(rss, /<link>https:\/\/news.example\/a\?x=1&amp;y=2<\/link>/);
  assert.match(rss, /<category>Chips<\/category>/);
  assert.doesNotMatch(rss, /<chips>/);
  const jf = renderJsonFeed(feed, 'https://w.example/feeds/topic/nvidia.json');
  assert.equal(jf.version, 'https://jsonfeed.org/version/1.1');
  assert.equal(jf.items[0].url, 'https://w.example/#story/abc123defg');
  assert.equal(jf.items[0].external_url, s.url);
  assert.match(jf.items[0].content_text, /Also: Bloomberg/);
  const tag = etagOf(feed);
  assert.equal(etagOf({ ...feed }), tag);
  assert.notEqual(etagOf({ ...feed, items: [{ ...feed.items[0], title: 'changed' }] }), tag);
});

test('feeds and /api over HTTP: topic, account, search, follows; 304 on a repeat', async () => {
  const store = new Store();
  store.ingest('rss', [
    { id: 't:1', title: 'Anthropic ships a new model', summary: 'It is fast.', url: 'https://news.example/1', publishedAt: now - 3600e3, source: 'Reuters' },
    { id: 't:2', title: 'Anthropic raises money', summary: '', url: 'https://news.example/2', publishedAt: now - 7200e3, source: 'Bloomberg' },
  ]);
  store.rebuild();
  upsertDoc({ url: 'https://x.com/scoopy/status/1', type: 'post', title: 'big news soon', description: 'big news soon', site: 'x.com', author: 'Scoopy', published_at: now - 600e3, meta: { platform: 'x', handle: 'scoopy' } });
  upsertDoc({ url: 'https://news.example/fts', type: 'article', title: 'Open weights win again', description: 'open weights', site: 'news.example', published_at: now - 600e3 });
  const server = createApp({ store, spider: new Spider() });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const topic = await fetch(`${base}/feeds/topic/anthropic.xml`);
    assert.equal(topic.status, 200);
    assert.match(topic.headers.get('content-type'), /rss\+xml/);
    const body = await topic.text();
    assert.equal((body.match(/<item>/g) || []).length, 2);
    assert.match(body, /Anthropic ships a new model/);
    const again = await fetch(`${base}/feeds/topic/anthropic.xml`, { headers: { 'if-none-match': topic.headers.get('etag') } });
    assert.equal(again.status, 304);
    const tj = await fetch(`${base}/feeds/topic/anthropic.json`);
    assert.match(tj.headers.get('content-type'), /feed\+json/);
    assert.notEqual(tj.headers.get('etag'), topic.headers.get('etag'), 'RSS and JSON are separate representations');
    assert.equal((await tj.json()).items.length, 2);
    assert.equal((await fetch(`${base}/feeds/topic/not-a-topic.xml`)).status, 404);

    const acct = await (await fetch(`${base}/feeds/account/scoopy.json`)).json();
    assert.equal(acct.items[0].url, 'https://x.com/scoopy/status/1');
    assert.equal(acct.items[0].authors[0].name, '@scoopy');
    assert.equal((await fetch(`${base}/feeds/account/nobody.xml`)).status, 404);

    const search = await (await fetch(`${base}/feeds/search.json?q=open%20weights`)).json();
    assert.equal(search.items[0].url, 'https://news.example/fts');
    assert.equal((await fetch(`${base}/feeds/search.xml`)).status, 400);

    const fy = await (await fetch(`${base}/feeds/foryou.json?t=anthropic`)).json();
    assert.equal(fy.items.length, 2);
    assert.deepEqual(fy.items[0].tags, ['Anthropic']);
    assert.equal((await fetch(`${base}/feeds/foryou.xml`)).status, 400);
    assert.equal((await fetch(`${base}/feeds/breaking.xml`)).status, 200);

    const idx = await (await fetch(`${base}/api`)).json();
    assert.equal(idx.endpoints.length, API.length);
    assert.equal(idx.feeds.length, FEEDS.length);
    assert.ok(idx.endpoints.every((e) => e.example.startsWith(base)));
    // Every documented endpoint is routed (an example may 404 on a missing id, never as an unknown path).
    for (const e of API) {
      const r = await fetch(`${base}${e.example.replace(/\{\w+\}/, 'x')}`);
      const t = await r.text();
      assert.ok(!(r.status === 404 && /"Not found\."/.test(t)), `${e.path} is routed`);
    }
  } finally {
    server.close();
    await stopWorkers();
  }
});
