import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { computeDigest, digestRss } from '../src/index/digest.js';
import { recordOdds, movers, resetOdds } from '../src/pipeline/odds.js';

const DAY = 86400e3;
const now = Date.parse('2026-10-21T12:00:00Z');
let n = 0;
const item = (title, at, { source = `Outlet ${++n}`, site = `o${n}.com`, platform = 'web', type = 'article', ...extra } = {}) =>
  upsertDoc({ url: `https://${site}/${n}-${at}`, type, title, source, site, published_at: at, meta: { platform }, ...extra });

test('weekly digest: stories ranked by sources, each day\'s top story, topic counts', () => {
  const db = resetDb();
  // One story covered by four outlets (one titled "… - Outlet"), one by two.
  for (let i = 0; i < 4; i++) item(`OpenAI launches GPT-6 with a new reasoning mode${i === 1 ? ' - The Verge' : ''}`, now - 2 * DAY + i * 600e3, i === 1 ? { source: 'The Verge', site: 'theverge.com' } : {});
  item('Anthropic raises $30 billion for Claude compute', now - DAY);
  item('Anthropic raises $30 billion for Claude compute expansion', now - DAY + 900e3);
  item('Nvidia AI chip sales slow in China', now - 3 * DAY);
  // Not AI, not an aggregator item (spidered page: no platform), and too old.
  item('Weather turns cold across Europe', now - DAY);
  upsertDoc({ url: 'https://spider.com/1', type: 'article', title: 'OpenAI launches GPT-6 with a new reasoning mode', site: 'spider.com', published_at: now - 2 * DAY });
  item('OpenAI founded long ago with AI dreams', now - 20 * DAY);

  const d = computeDigest(db, { now });
  assert.deepEqual(d.top.map((s) => [s.title.replace(' - The Verge', ''), s.sources]), [
    ['OpenAI launches GPT-6 with a new reasoning mode', 4],
    ['Anthropic raises $30 billion for Claude compute', 2],
  ]);
  assert.ok(d.top.every((s) => !s.title.endsWith('The Verge')), 'outlet suffix trimmed');
  assert.equal(d.totals.stories, 3);
  assert.equal(d.totals.items, 7);
  // The single-source Nvidia story isn't in the top list, so it leads its day.
  const day = (k) => d.byDay.find((x) => x.day === k);
  assert.equal(day('2026-10-18').top.title, 'Nvidia AI chip sales slow in China');
  assert.equal(day('2026-10-19').top, null, 'its only story is already in the top list');
  assert.deepEqual(d.topics.map((t) => [t.key, t.n]).sort(), [['anthropic', 1], ['funding', 1], ['nvidia', 1], ['openai', 1]]);
  assert.ok(d.topics.every((t) => t.prevShare === undefined), 'no comparison without last week\'s data');

  const rss = digestRss(d, { origin: 'https://wire.test', name: 'Wire & Co' });
  assert.match(rss, /<title>Wire &amp; Co: the week in AI<\/title>/);
  assert.equal(rss.match(/<item>/g).length, 2);
  assert.match(rss, /Covered by 4 sources/);
});

test('market movers: change over the week, biggest first', () => {
  resetDb();
  resetOdds();
  const m = (id, yes) => ({ id, title: id, url: `https://p/${id}`, binary: true, outcomes: [{ label: 'Yes', yes }] });
  recordOdds([m('a', 0.2), m('b', 0.5)], now - 8 * DAY);
  recordOdds([m('a', 0.25), m('b', 0.1)], now - DAY);
  recordOdds([m('young', 0.1)], now - DAY); // only a day of history: not a weekly mover
  const out = movers([m('a', 0.25), m('b', 0.1), m('young', 0.9)], { now, limit: 5 });
  assert.deepEqual(out.map((x) => [x.id, x.from, x.to, x.change]), [['b', 0.5, 0.1, -0.4], ['a', 0.2, 0.25, 0.05]]);
});
