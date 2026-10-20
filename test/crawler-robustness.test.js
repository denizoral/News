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

test('JSON Feed is read like RSS', async () => {
  const { parseFeed } = await import('../src/sources/rss.js');
  const body = JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'Blog', items: [{ id: '1', url: 'https://json.example/2026/new-llm-agent-release', title: 'A new LLM agent', content_text: 'An agent built on a new model.', date_published: new Date().toISOString(), authors: [{ name: 'Ada' }] }] });
  assert.equal(sniffXml(body, 'application/feed+json'), 'feed');
  const [e] = parseFeed(body);
  assert.equal(e.url, 'https://json.example/2026/new-llm-agent-release');
  assert.equal(e.author, 'Ada');
  assert.equal(spider.handleFeed(row('https://json.example/feed.json', 'feed'), body), 1);
});

test('gzip sitemaps are inflated, under the size cap', async () => {
  const zlib = await import('node:zlib');
  const { readText, gunzipCapped } = await import('../src/spider/body.js');
  const xml = '<?xml version="1.0"?><urlset><url><loc>https://gz.example/a</loc></url></urlset>';
  const res = new Response(zlib.gzipSync(xml), { headers: { 'content-type': 'application/x-gzip' } });
  const out = await readText(res, 1 << 20);
  assert.equal(out.text, xml);
  assert.equal(sniffXml(out.text), 'sitemap');
  // A gzip bomb stops at the cap.
  const bomb = zlib.gzipSync(Buffer.alloc(50 << 20));
  const capped = await gunzipCapped(bomb, 1 << 20);
  assert.equal(capped.buf.length, 1 << 20);
  assert.equal(capped.truncated, true);
});

test('a sitemap cut off at the size cap keeps its complete entries', async () => {
  const { parseSitemap } = await import('../src/spider/sitemaps.js');
  const xml = '<urlset><url><loc>https://cut.example/1</loc></url><url><loc>https://cut.example/2</loc></url><url><loc>https://cut.ex';
  assert.deepEqual(parseSitemap(xml).urls.map((u) => u.url), ['https://cut.example/1', 'https://cut.example/2']);
});

test('robots.txt sitemaps: short lists kept, long lists filtered to news', async () => {
  const { pickSitemaps } = await import('../src/spider/policy.js');
  assert.deepEqual(pickSitemaps(['https://a.example/sitemap-index.xml', 'https://a.example/image-sitemap.xml']), ['https://a.example/sitemap-index.xml']);
  const long = ['tags', 'authors', 'news', 'post-2026', 'video', 'misc', 'legal', 'events'].map((n) => `https://b.example/${n}-sitemap.xml`);
  assert.deepEqual(pickSitemaps(long), ['https://b.example/news-sitemap.xml', 'https://b.example/post-2026-sitemap.xml']);
});

test('guessed feeds are tried once per starting site and dropped when missing', () => {
  const host = 'guess.example';
  settings.update({ 'crawler.hubs': [...settings.get('crawler.hubs'), `https://${host}/`] }, { role: 'owner', actor: 't' });
  const h = spider.host(host);
  spider.guessFeeds(row(`https://${host}/`, 'hub'), { feeds: [] }, h);
  const guesses = q("SELECT url FROM frontier WHERE host = ? AND kind = 'feed'").all(host).map((r) => r.url);
  assert.ok(guesses.includes(`https://${host}/feed`) && guesses.includes(`https://${host}/rss.xml`));
  spider.guessFeeds(row('https://blogpath.example/blog/', 'hub'), { feeds: [] }, spider.host('blogpath.example'));
  // (blogpath.example isn't a starting site, so nothing is guessed there.)
  assert.equal(q("SELECT COUNT(*) n FROM frontier WHERE host = 'blogpath.example'").get().n, 0);
  spider.fail(row(`https://${host}/atom.xml`, 'feed', { via: 'guess' }), h, new HttpError(404, 'x'));
  assert.equal(frontier(`https://${host}/atom.xml`).status, 'skipped', 'a missing guess is dropped, not retried');
  spider.keepOneGuessedFeed(row(`https://${host}/feed`, 'feed', { via: 'guess' }));
  assert.equal(frontier(`https://${host}/rss.xml`).status, 'skipped', 'one working guess is enough');
  assert.equal(frontier(`https://${host}/feed`).status, 'queued');
  // Not again once the site has feed rows.
  const before = q('SELECT COUNT(*) n FROM frontier').get().n;
  spider.guessFeeds(row(`https://${host}/`, 'hub'), { feeds: [] }, h);
  assert.equal(q('SELECT COUNT(*) n FROM frontier').get().n, before);
});

test('feeds that keep answering 404 are retired; starting pages are not', () => {
  const h = spider.host('dead.example');
  const feed = 'https://dead.example/feed';
  spider.enqueue(feed, { kind: 'feed' });
  for (let a = 0; a < 3; a++) spider.fail(row(feed, 'feed', { attempts: a }), h, new HttpError(404, feed));
  assert.equal(frontier(feed).status, 'error');
  const hub = 'https://dead.example/';
  spider.enqueue(hub, { kind: 'hub' });
  spider.fail(row(hub, 'hub', { attempts: 5 }), h, new HttpError(404, hub));
  assert.equal(frontier(hub).status, 'queued');
});

test('archive and other-language sitemaps are not rechecked', async () => {
  const { isWantedSitemap, pickSitemaps } = await import('../src/spider/policy.js');
  const now = Date.UTC(2026, 9, 20);
  const en = { languages: ['en'], now };
  assert.equal(isWantedSitemap('https://p.example/sv/Sitemap_Index_Feb_2022.xml.gz', { now }), false, 'old month');
  assert.equal(isWantedSitemap('https://p.example/sitemap-2026-07.xml', en), false);
  assert.equal(isWantedSitemap('https://p.example/sitemap-2026-10.xml', en), true, 'this month');
  assert.equal(isWantedSitemap('https://p.example/sitemaps/2025/sitemap.xml', en), false, 'last year');
  assert.equal(isWantedSitemap('https://p.example/es/sitemap-news.xml', en), false, 'Spanish');
  assert.equal(isWantedSitemap('https://p.example/es/sitemap-news.xml', { now }), true, 'any language allowed');
  assert.equal(isWantedSitemap('https://p.example/ai/sitemap.xml', en), true, '/ai/ is not a language');
  assert.deepEqual(pickSitemaps(['https://p.example/sitemap-news.xml', 'https://p.example/de/sitemap-news.xml'], en), ['https://p.example/sitemap-news.xml']);
});

test('untitled sitemap entries are judged by a descriptive slug', () => {
  const xml = `<urlset>
    <url><loc>https://slug.example/local/charlotte/2026/10/19/early-voting-turnout-record</loc></url>
    <url><loc>https://slug.example/2026/10/19/tenstorrent-ai-compute-deal</loc></url>
    <url><loc>https://slug.example/p/48213</loc></url>
    <url><loc>https://slug.example/fr/2026/10/19/nouvelle-ia-generative-lancee</loc></url>
    <url><loc>https://slug.example/tag/artificial-intelligence/</loc></url>
  </urlset>`;
  assert.equal(spider.handleSitemap(row('https://slug.example/sitemap.xml', 'sitemap'), xml), 2);
  assert.ok(frontier('https://slug.example/2026/10/19/tenstorrent-ai-compute-deal'));
  assert.ok(frontier('https://slug.example/p/48213'), 'opaque URLs are kept: no way to tell');
  assert.equal(frontier('https://slug.example/local/charlotte/2026/10/19/early-voting-turnout-record'), undefined);
  assert.equal(frontier('https://slug.example/tag/artificial-intelligence/'), undefined, 'tag pages are listings, not articles');
});

test('docs and help sections are skipped even on news sites', () => {
  const page = { title: 'Claude Tag for Claude Code users', description: '', lang: 'en', isArticle: true, url: 'https://claude.com/docs/claude-tag/for-claude-code-users', site: 'claude.com', text: 'Claude Code users can tag Claude. '.repeat(80) };
  assert.match(spider.decide(page).reason, /not news/);
  assert.equal(spider.decide({ ...page, url: 'https://claude.com/blog/claude-tag-launch' }).ok, true);
});

test('tag, author and image sitemaps are not followed', async () => {
  const { isWantedSitemap } = await import('../src/spider/policy.js');
  for (const u of ['https://f.example/hubs/tags-1.xml', 'https://f.example/author/authors-14.xml', 'https://f.example/image-sitemap.xml', 'https://f.example/page-sitemap.xml']) assert.equal(isWantedSitemap(u), false, u);
  for (const u of ['https://f.example/news-sitemap.xml', 'https://f.example/post-sitemap.xml', 'https://f.example/sitemap.xml']) assert.equal(isWantedSitemap(u), true, u);
});

test('empty and text-only responses do not crash extraction', () => {
  assert.equal(extractPage('', 'https://empty.example/').text, '');
  assert.equal(extractPage('plain text body', 'https://empty.example/').text, 'plain text body');
});

test('a web page where a feed should be: guesses dropped at once, known feeds after three', () => {
  const h = spider.host('page.example');
  const notFeed = () => Object.assign(new Error('Not a feed: the address returns text/html'), { permanent: true });
  const guess = 'https://page.example/rss.xml';
  spider.enqueue(guess, { kind: 'feed', via: 'guess' });
  spider.fail(row(guess, 'feed', { via: 'guess' }), h, notFeed());
  assert.equal(frontier(guess).status, 'skipped');
  const known = 'https://page.example/feed';
  spider.enqueue(known, { kind: 'feed' });
  spider.fail(row(known, 'feed'), h, notFeed());
  assert.equal(frontier(known).status, 'queued', 'one maintenance page is not enough');
  spider.fail(row(known, 'feed', { attempts: 2 }), h, notFeed());
  assert.equal(frontier(known).status, 'error');
  assert.equal(h.pausedUntil, 0, "the site isn't rested for it");
});
