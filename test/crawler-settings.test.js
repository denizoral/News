// Power-user crawler settings: validation, permissions, and how the engine applies them.

import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, q } from '../src/db.js';
import { settings, compileGlob } from '../src/settings.js';
import { Spider, inQuietHours } from '../src/spider/engine.js';

resetDb();
settings.load();
const spider = new Spider();
const set = (patch, role = 'owner') => settings.update(patch, { role, actor: 'test' });

test('ignoring robots.txt for a site is owner-only', () => {
  const r = set({ 'crawler.hostRules': [{ host: 'mysite.example', ignoreRobots: true }] }, 'admin');
  assert.match(r.errors['crawler.hostRules'], /Only owners/);
  assert.ok(!set({ 'crawler.hostRules': [{ host: 'mysite.example', ignoreRobots: true }] }, 'owner').errors);
  // Admins can still edit other parts of the rules while leaving the owner's choice alone.
  assert.ok(!set({ 'crawler.hostRules': [{ host: 'mysite.example', ignoreRobots: true, minDelayMs: 5000 }] }, 'admin').errors);
  assert.match(set({ 'crawler.hostRules': [] }, 'admin').errors['crawler.hostRules'], /Only owners/);
  assert.equal(spider.rule('www.mysite.example').ignoreRobots, true);
  set({ 'crawler.hostRules': [] });
});

test('settings reject bad values', () => {
  const r = set({ 'crawler.quietHours': '9-5', 'crawler.botName': 'bad name!', 'crawler.relevance': 'some', 'crawler.languages': ['english'], 'crawler.excludePatterns': ['*a*a*a*a*a*a*a*a*a*'] });
  for (const k of ['crawler.quietHours', 'crawler.botName', 'crawler.relevance', 'crawler.languages', 'crawler.excludePatterns']) assert.ok(r.errors[k], k);
});

test('quiet hours, including windows past midnight', () => {
  const at = (hh, mm) => Date.UTC(2026, 0, 1, hh, mm);
  assert.equal(inQuietHours('01:00-06:00', at(3, 0)), true);
  assert.equal(inQuietHours('01:00-06:00', at(6, 0)), false);
  assert.equal(inQuietHours('22:00-05:00', at(23, 30)), true);
  assert.equal(inQuietHours('22:00-05:00', at(4, 59)), true);
  assert.equal(inQuietHours('22:00-05:00', at(12, 0)), false);
  assert.equal(inQuietHours('', at(3, 0)), false);
});

test('identity settings change the User-Agent', () => {
  set({ 'crawler.botName': 'AcmeNewsBot', 'crawler.contactUrl': 'https://acme.example/bot' });
  assert.equal(spider.userAgent(), 'Mozilla/5.0 (compatible; AcmeNewsBot/0.3; +https://acme.example/bot)');
  set({ 'crawler.botName': 'FrontierWireBot', 'crawler.contactUrl': 'https://github.com/denizoral/News' });
});

test('URL patterns, query stripping and the queue cap', () => {
  assert.equal(compileGlob('*/tag/*')('https://e.com/tag/ai'), true);
  set({ 'crawler.excludePatterns': ['*/tag/*'], 'crawler.stripQueryParams': ['page'] });
  assert.equal(spider.enqueue('https://news.example/tag/ai-stuff-here-now'), false);
  assert.equal(spider.enqueue('https://news.example/2026/01/02/story-one?page=2&utm_source=x&id=7'), true);
  assert.ok(q("SELECT 1 FROM frontier WHERE url = 'https://news.example/2026/01/02/story-one?id=7'").get(), 'page and utm_ removed, id kept');
  set({ 'crawler.includePatterns': ['https://allowed.example/*'] });
  assert.equal(spider.enqueue('https://news.example/2026/01/03/another-story-here'), false);
  assert.equal(spider.enqueue('https://allowed.example/2026/01/03/another-story-here'), true);
  set({ 'crawler.stripQueryParams': ['*'] });
  spider.enqueue('https://allowed.example/a-b-c-d?x=1');
  assert.ok(q("SELECT 1 FROM frontier WHERE url = 'https://allowed.example/a-b-c-d'").get(), '* strips every query');
  set({ 'crawler.excludePatterns': [], 'crawler.includePatterns': [], 'crawler.stripQueryParams': [] });
});

test('indexing decisions follow the settings', () => {
  const page = (over = {}) => ({ title: 'A new open-weight LLM from a lab', description: 'Benchmarks for the new model', text: 'word '.repeat(300) + 'large language model', lang: 'en', isArticle: true, published_at: Date.now(), site: 'news.example', url: 'https://news.example/x', contentHash: null, ...over });
  assert.equal(spider.decide(page()).ok, true);
  assert.match(spider.decide(page({ text: 'too short' })).reason, /Too short/);
  assert.match(spider.decide(page({ title: 'Local football results', description: 'Scores', text: 'goal '.repeat(300) })).reason, /Not about AI/);
  assert.match(spider.decide(page({ noindex: true })).reason, /noindex/);
  set({ 'crawler.relevance': 'all' });
  assert.equal(spider.decide(page({ title: 'Local football results', description: 'Scores', text: 'goal '.repeat(300) })).ok, true);
  set({ 'crawler.relevance': 'keywords', 'crawler.includeKeywords': ['robotics'] });
  assert.match(spider.decide(page()).reason, /keywords/);
  assert.equal(spider.decide(page({ text: 'robotics '.repeat(200) })).ok, true);
  set({ 'crawler.relevance': 'ai', 'crawler.includeKeywords': [], 'crawler.excludeKeywords': ['sponsored'], 'crawler.languages': ['de'], 'crawler.maxArticleAgeDays': 7 });
  assert.match(spider.decide(page({ title: 'Sponsored: a new open model' })).reason, /excluded keyword/);
  assert.match(spider.decide(page()).reason, /Language en/);
  assert.match(spider.decide(page({ lang: 'de', published_at: Date.now() - 30 * 86400e3 })).reason, /Older than 7 days/);
  set({ 'crawler.excludeKeywords': [], 'crawler.languages': [], 'crawler.maxArticleAgeDays': 0 });
});

test('the crawl log records outcomes and reads back filtered', () => {
  spider.log({ url: 'https://a.example/1', host: 'a.example', kind: 'article', depth: 1 }, { outcome: 'indexed', http: 200, bytes: 1000 });
  spider.log({ url: 'https://b.example/2', host: 'b.example', kind: 'article', depth: 1 }, { outcome: 'blocked', reason: 'Disallowed by robots.txt' });
  assert.equal(spider.logEntries({ outcome: 'blocked' })[0].url, 'https://b.example/2');
  assert.equal(spider.logEntries({ host: 'a.example' }).length, 1);
  assert.equal(spider.live().recent[0].outcome, 'blocked');
});

test('Test a URL refuses private addresses', async () => {
  const r = await spider.inspect('http://127.0.0.1:6379/');
  const addr = r.steps.find((s) => s.label === 'Address check');
  assert.ok(addr && !addr.ok, 'loopback is never fetched');
});

test('global robots.txt switch: owner-only, and it changes what is allowed', async () => {
  const { parseRobots } = await import('../src/spider/robots.js');
  const h = { host: 'strict.example', parsed: parseRobots('User-agent: *\nDisallow: /private/') };
  assert.equal(spider.robotsAllows(h, 'https://strict.example/private/a'), false);
  assert.match(set({ 'crawler.obeyRobots': false }, 'admin').errors['crawler.obeyRobots'], /owner/);
  assert.equal(settings.get('crawler.obeyRobots'), true);
  assert.ok(!set({ 'crawler.obeyRobots': false }, 'owner').errors);
  assert.equal(spider.robotsAllows(h, 'https://strict.example/private/a'), true);
  assert.equal(spider.obeysRobots('strict.example'), false);
  assert.equal(spider.live().obeyRobots, false);
  set({ 'crawler.obeyRobots': true });
  assert.equal(spider.robotsAllows(h, 'https://strict.example/private/a'), false, 'obeyed again once switched back on');
  // Site rules still apply with robots.txt off.
  set({ 'crawler.obeyRobots': false, 'crawler.hostRules': [{ host: 'strict.example', disallow: ['/also-private/'] }] });
  assert.equal(spider.ruleDisallows('https://strict.example/also-private/x'), true);
  set({ 'crawler.obeyRobots': true, 'crawler.hostRules': [] });
});
