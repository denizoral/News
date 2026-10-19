// Crawler coverage and robustness: feeds, backoff, rate limits, circuit
// breaker, discovered starting sites, charset handling, extraction fallbacks.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, q } from '../src/db.js';
import { settings } from '../src/settings.js';
import { Spider, sniffXml } from '../src/spider/engine.js';
import { cleanUrl } from '../src/spider/policy.js';
import { sniffCharset, decode } from '../src/spider/body.js';
import { extractPage } from '../src/spider/extract.js';
import { upsertDoc } from '../src/index/documents.js';
import { HttpError, parseRetryAfter } from '../src/http.js';

resetDb();
settings.load();
const spider = new Spider();
const row = (url, kind = 'article', extra = {}) => ({ url, host: new URL(url).hostname, kind, depth: 1, attempts: 0, ...extra });
const frontier = (url) => q('SELECT * FROM frontier WHERE url = ?').get(url);

test('tracking parameters are always stripped', () => {
  assert.equal(cleanUrl('https://e.com/a?utm_source=x&fbclid=1&gclid=2&id=3&mkt_tok=z'), 'https://e.com/a?id=3');
  assert.equal(cleanUrl('https://e.com/a?utm_medium=y'), 'https://e.com/a');
});

test('enqueue reports only genuinely new URLs', () => {
  assert.equal(spider.enqueue('https://news.example/2026/01/01/a-new-story'), true);
  assert.equal(spider.enqueue('https://news.example/2026/01/01/a-new-story'), false, 'second sighting is not new');
});

test('charset detection: BOM, header, meta tag, XML declaration', () => {
  assert.equal(sniffCharset(Buffer.from([0xef, 0xbb, 0xbf, 0x41])), 'utf-8');
  assert.equal(sniffCharset(Buffer.from('<html>'), 'text/html; charset=ISO-8859-1'), 'iso-8859-1');
  assert.equal(sniffCharset(Buffer.from('<html><head><meta charset="windows-1252">')), 'windows-1252');
  assert.equal(sniffCharset(Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=shift_jis">')), 'shift_jis');
  assert.equal(sniffCharset(Buffer.from('<?xml version="1.0" encoding="ISO-8859-15"?><rss>')), 'iso-8859-15');
  // Windows-1252 curly quotes decode correctly instead of turning into U+FFFD.
  const bytes = Buffer.concat([Buffer.from('<meta charset="windows-1252"><p>'), Buffer.from([0x93, 0x41, 0x49, 0x94]), Buffer.from('</p>')]);
  assert.match(decode(bytes, 'text/html'), /“AI”/);
  assert.equal(sniffCharset(Buffer.from('<meta charset="no-such-charset">')), 'no-such-charset');
  assert.equal(decode(Buffer.from('<meta charset="no-such-charset">ok'), ''), '<meta charset="no-such-charset">ok', 'unknown labels fall back to UTF-8');
});

test('feeds and sitemaps are told apart', () => {
  assert.equal(sniffXml('<?xml version="1.0"?><rss version="2.0"><channel>'), 'feed');
  assert.equal(sniffXml('<feed xmlns="http://www.w3.org/2005/Atom"><title>x</title>'), 'feed');
  assert.equal(sniffXml('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'), 'sitemap');
  assert.equal(sniffXml('<sitemapindex>'), 'sitemap');
  assert.equal(sniffXml('<!doctype html><html>'), null);
});

test('pages advertise feeds; JSON-LD body is used when HTML text is thin', () => {
  const html = `<html><head><title>T</title>
    <link rel="alternate" type="application/rss+xml" href="/feed.xml">
    <link rel="alternate" type="application/atom+xml" href="https://e.com/atom">
    <link rel="alternate" type="application/rss+xml" href="/comments/feed">
    <script type="application/ld+json">${JSON.stringify({ '@type': 'NewsArticle', headline: 'OpenAI ships a model', articleBody: 'A long article body about a new language model. '.repeat(30) })}</script>
  </head><body><div id="app"></div></body></html>`;
  const p = extractPage(html, 'https://e.com/2026/01/01/openai-ships-a-model');
  assert.deepEqual(p.feeds, ['https://e.com/feed.xml', 'https://e.com/atom'], 'comment feeds are skipped');
  assert.ok(p.text.length > 1000, 'falls back to JSON-LD articleBody');
});

test('feeds queue their recent, relevant entries', () => {
  const now = new Date().toUTCString();
  const old = new Date(Date.now() - 40 * 86400e3).toUTCString();
  const xml = `<rss><channel>
    <item><title>Anthropic releases a new Claude model</title><link>https://feeds.example/2026/claude-model-release</link><pubDate>${now}</pubDate></item>
    <item><title>Local bakery wins award</title><link>https://feeds.example/2026/bakery-award-story</link><pubDate>${now}</pubDate></item>
    <item><title>An old GPT story</title><link>https://feeds.example/2025/old-gpt-story</link><pubDate>${old}</pubDate></item>
  </channel></rss>`;
  const n = spider.handleFeed(row('https://feeds.example/feed', 'feed'), xml);
  assert.equal(n, 1);
  assert.ok(frontier('https://feeds.example/2026/claude-model-release'));
  assert.equal(frontier('https://feeds.example/2026/bakery-award-story'), undefined, 'irrelevant entries skipped');
  assert.equal(frontier('https://feeds.example/2025/old-gpt-story'), undefined, 'old entries skipped');
});

test('feed discovery is capped per site', () => {
  settings.update({ 'crawler.feedsPerSite': 2 }, { role: 'owner', actor: 't' });
  const page = { url: 'https://many.example/ai', title: 'AI news', description: 'Latest on large language models', feeds: ['https://many.example/a.xml', 'https://many.example/b.xml', 'https://many.example/c.xml'] };
  assert.equal(spider.discoverFeeds(row('https://many.example/ai'), page), 2);
  assert.equal(spider.discoverFeeds(row('https://many.example/ai'), page), 0, 'already at the cap');
  settings.update({ 'crawler.feedsPerSite': 3 }, { role: 'owner', actor: 't' });
});

test('recurring URLs back off when idle and reset when they find news', () => {
  const r = row('https://hub.example/', 'hub');
  const base = settings.get('crawler.hubRecrawlMin') * 60e3;
  assert.equal(spider.recurringDelay(r, 0), base * 2);
  assert.equal(spider.recurringDelay(r, 0), base * 4);
  for (let i = 0; i < 5; i++) spider.recurringDelay(r, 0);
  assert.equal(spider.recurringDelay(r, 0), base * 8, 'capped at 8x');
  assert.equal(spider.recurringDelay(r, 3), base, 'news resets it');
  settings.update({ 'crawler.adaptiveRecrawl': false }, { role: 'owner', actor: 't' });
  assert.equal(spider.recurringDelay(r, 0), base);
  settings.update({ 'crawler.adaptiveRecrawl': true }, { role: 'owner', actor: 't' });
});

test('Retry-After parsing', () => {
  assert.equal(parseRetryAfter('120'), 120);
  assert.ok(Math.abs(parseRetryAfter(new Date(Date.now() + 60e3).toUTCString()) - 60) <= 2);
  assert.equal(parseRetryAfter('soon'), null);
  assert.equal(parseRetryAfter(null), null);
});

test('rate limits defer the whole site without counting as errors', () => {
  const url = 'https://limited.example/2026/01/01/some-story-here';
  spider.enqueue(url);
  const h = spider.host('limited.example');
  const before = spider.stats.errors;
  spider.fail(row(url), h, new HttpError(429, url, 600));
  assert.equal(spider.stats.errors, before, 'not an error');
  assert.equal(frontier(url).status, 'queued');
  assert.ok(h.next_allowed_at >= Date.now() + 590e3, 'the whole host waits for Retry-After');
  assert.equal(spider.logEntries({ outcome: 'deferred' })[0].url, url);
});

test('repeated server failures rest the site (circuit breaker)', () => {
  settings.update({ 'crawler.hostFailureLimit': 3 }, { role: 'owner', actor: 't' });
  const h = spider.host('flaky.example');
  for (let i = 0; i < 2; i++) spider.fail(row(`https://flaky.example/p${i}-a-b-c-d`), h, new Error('connect ETIMEDOUT'));
  assert.equal(h.pausedUntil, 0);
  spider.fail(row('https://flaky.example/p2-a-b-c-d'), h, new Error('connect ETIMEDOUT'));
  assert.ok(h.pausedUntil > Date.now() + 14 * 60e3, 'rests 15 minutes after the 3rd failure in a row');
  assert.equal(spider.resting()[0].host, 'flaky.example');
  // 404s are the page's fault, not the site's.
  const h2 = spider.host('fine.example');
  for (let i = 0; i < 5; i++) spider.fail(row(`https://fine.example/missing-${i}-a-b-c`), h2, new HttpError(404, 'x'));
  assert.equal(h2.pausedUntil, 0);
  // A success closes the breaker.
  spider.hostOk(h);
  assert.equal(h.failStreak, 0);
  settings.update({ 'crawler.hostFailureLimit': 8 }, { role: 'owner', actor: 't' });
});

test('articles retry with capped backoff; recurring URLs keep their schedule', () => {
  const url = 'https://retry.example/2026/01/01/retry-me-please';
  spider.enqueue(url);
  const h = spider.host('retry.example');
  spider.fail(row(url, 'article', { attempts: 9 }), h, new Error('socket hang up'));
  const f = frontier(url);
  assert.equal(f.status, 'error', 'gives up after the configured attempts');
  const sm = 'https://retry.example/sitemap.xml';
  spider.enqueue(sm, { kind: 'sitemap' });
  spider.fail(row(sm, 'sitemap', { attempts: 50 }), h, new Error('socket hang up'));
  const s = frontier(sm);
  assert.equal(s.status, 'queued', 'sitemaps are never dropped');
  assert.ok(s.next_at < Date.now() + 9 * settings.get('crawler.sitemapRecrawlMin') * 60e3 + 6 * 3600e3, 'and their next check stays bounded');
});

test('productive sites become starting pages; dismissed ones stay out', () => {
  for (let i = 0; i < 6; i++) {
    upsertDoc({ url: `https://prolific.example/2026/01/0${i}/story-${i}`, type: 'article', title: `AI story ${i}`, body: 'text', site: 'prolific.example', fetched_at: Date.now() });
    upsertDoc({ url: `https://other.example/2026/01/0${i}/story-${i}`, type: 'article', title: `AI story ${i}`, body: 'text', site: 'other.example', fetched_at: Date.now() });
  }
  const added = spider.discoverHubs();
  assert.deepEqual(added.map((a) => a.host).sort(), ['other.example', 'prolific.example']);
  assert.equal(frontier('https://prolific.example').kind, 'hub');
  assert.ok(spider.trusted.has('prolific.example'));
  spider.dismissHub('other.example');
  assert.equal(spider.autoHubs().some((a) => a.host === 'other.example'), false);
  assert.equal(frontier('https://other.example').kind, 'page', 'no longer rechecked');
  assert.equal(spider.discoverHubs().length, 0, 'a dismissed site is not added again');
  settings.update({ 'crawler.autoHubs': 0 }, { role: 'owner', actor: 't' });
  spider.discoverHubs();
  assert.equal(spider.autoHubs().length, 0, 'turning the feature off removes them');
  settings.update({ 'crawler.autoHubs': 25 }, { role: 'owner', actor: 't' });
});

test('only useful feeds are followed', async () => {
  const { isUsefulFeed, isNonNewsHost } = await import('../src/spider/policy.js');
  const page = 'https://developer.nvidia.com/blog/nvidia-accelerates-apache-spark-analytics/';
  assert.equal(isUsefulFeed('https://theverge.com/rss/index.xml', page), true);
  assert.equal(isUsefulFeed('https://huggingface.co/blog/feed.xml', page), true);
  assert.equal(isUsefulFeed('https://zdnet.com/topic/artificial-intelligence/feed', page), true);
  assert.equal(isUsefulFeed('https://developer.nvidia.com/blog/nvidia-accelerates-apache-spark-analytics/feed', page), false, "a post's own feed");
  assert.equal(isUsefulFeed('https://theguardian.com/artanddesign/series/design-a-better-world/rss', page), false, 'off-topic section');
  assert.equal(isUsefulFeed('https://theguardian.com/technology/artificialintelligenceai/rss', page), true, 'AI section');
  assert.equal(isUsefulFeed('https://example.com/comments/feed', page), false);
  assert.equal(isNonNewsHost('support.claude.com'), true);
  assert.equal(isNonNewsHost('thenewstack.io'), false);
});

test('one stray AI mention in an unrelated page is not enough', () => {
  const base = { description: '', lang: 'en', isArticle: true, site: 'wire.example', url: 'https://wire.example/x', published_at: Date.now() };
  const filler = 'Property prices in the region rose again this quarter. '.repeat(60);
  assert.match(spider.decide({ ...base, title: 'Overseas real estate list', text: `${filler} Some agents use AI tools. ${filler}` }).reason, /Not about AI/);
  assert.equal(spider.decide({ ...base, title: 'How OpenAI trains its models', text: filler }).ok, true, 'a headline about AI is enough');
  assert.equal(spider.decide({ ...base, title: 'Quarterly results', text: `${filler} The company's AI chips, its GPU roadmap and new inference servers drove growth. ${filler}` }).ok, true, 'repeated mentions are enough');
});

test('help and docs pages are not news unless the site is a starting page', async () => {
  const { decide } = await import('../src/spider/policy.js');
  const page = { title: 'How SCIM sync works in Claude', description: '', lang: 'en', isArticle: true, url: 'https://support.claude.com/en/articles/1', site: 'support.claude.com', text: 'Claude admins can sync users. '.repeat(80) };
  assert.match(spider.decide(page).reason, /not news/);
  assert.equal(decide(page, spider.cfg, { trusted: new Set(['support.claude.com']) }).ok, true);
});
