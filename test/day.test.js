import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { computeDay, dayCalendar, centralHeadline, standouts, withMarkets, withReleases, isDay } from '../src/index/day.js';

const DAY = 86400e3;
const day0 = Date.parse('2026-09-15T00:00:00Z');
const now = Date.parse('2026-10-22T12:00:00Z');

test('day: the headline that says what the others say leads its story', () => {
  const g = [
    { type: 'article', title: 'ChatGPT Ads Reach 89 Countries: The 26 New Markets' },
    { type: 'article', title: 'OpenAI expands ChatGPT ads to 26 more countries' },
    { type: 'article', title: 'OpenAI expands ChatGPT Ads to 26 new countries as push accelerates' },
    { type: 'article', title: 'OpenAI expands ChatGPT ads to new countries, bringing total to 63' },
  ];
  assert.equal(centralHeadline(g).title, 'OpenAI expands ChatGPT ads to 26 more countries');
  assert.equal(centralHeadline([{ type: 'post', title: 'x' }, { type: 'article', title: 'y' }]).title, 'y', 'articles before posts');
  assert.ok(isDay('2026-02-28'));
  assert.ok(!isDay('2026-02-30'));
  assert.ok(!isDay('2026-2-3'));
});

test('day: names far above their usual share stand out; steady ones do not', () => {
  const today = { n: 100, counts: new Map([['anthropic', 20], ['openai', 15], ['nvidia', 2]]) };
  const before = { n: 2000, counts: new Map([['anthropic', 100], ['openai', 300], ['nvidia', 10]]) };
  const s = standouts(today, before);
  assert.deepEqual(s.map((x) => x.key), ['anthropic'], 'openai is at its usual share, nvidia too rare');
  assert.ok(s[0].lift > 3);
});

test('day: a past day rebuilt with stories ranked by outlets, posts, deals, names and neighbours', () => {
  resetDb();
  let n = 0;
  const doc = (title, at, extra = {}) => upsertDoc({ url: `https://${extra.site || 'n.example'}/${n++}`, type: 'article', title, description: 'An AI story.', site: 'n.example', source: 'N', published_at: at, ...extra });
  const t = day0 + 10 * 3600e3;
  doc('Anthropic launches Claude Nova model for coding agents', t, { site: 'a.com', source: 'A' });
  doc('Anthropic launches Claude Nova, a model for coding agents', t + 600e3, { site: 'b.com', source: 'B' });
  doc('Anthropic launches Claude Nova model to rival OpenAI coding agents', t + 1200e3, { site: 'c.com', source: 'C' });
  doc('Anthropic Nova review: hands on with the coding agent model', t + 3000e3, { site: 'd.com', source: 'D' });
  doc('Harvey raises $300M Series D at $3B valuation for legal AI', t + 2000e3, { site: 'e.com', source: 'E' });
  doc('Robots fold laundry in a new AI demo', t + 4000e3, { site: 'f.com', source: 'F' });
  doc('Bakery opens second shop', t, { site: 'g.com', source: 'G', description: 'Bread.' });
  doc('Anthropic opens Tokyo office as AI demand grows', day0 - 3 * DAY, { site: 'a.com', source: 'A' });
  for (let i = 0; i < 30; i++) doc(`OpenAI ships update ${i} to ChatGPT models`, day0 - (i % 20 + 1) * DAY, { site: 'h.com', source: 'H' });
  upsertDoc({ url: 'https://x.com/claudeai/status/1', type: 'post', title: 'Claude Nova is here for AI coding agents', site: 'x.com', author: 'claudeai', engagement: 900, published_at: t + 60e3, meta: { platform: 'x', handle: 'claudeai' } });
  doc('Anthropic Nova follow-up on AI agents', day0 + 3 * DAY, { site: 'a.com', source: 'A' });
  const db = getDb();
  db.prepare('INSERT INTO odds (market, outcome, ts, yes) VALUES (?, ?, ?, ?)').run('pm:1', 'Anthropic', t - 3600e3, 0.3);
  db.prepare('INSERT INTO odds (market, outcome, ts, yes) VALUES (?, ?, ?, ?)').run('pm:1', 'Anthropic', t + 3600e3, 0.55);

  const d = computeDay(db, { day: '2026-09-15', now });
  assert.equal(d.partial, false);
  assert.ok(d.top[0].outlets >= 3, 'the outlets that ran the launch');
  assert.match(d.top[0].title, /Claude Nova/);
  assert.ok(d.top[0].items.length >= 2);
  assert.ok(!d.top.some((s) => /Bakery/.test(s.title)), 'not about AI');
  assert.equal(d.posts[0].handle, 'claudeai');
  assert.equal(d.deals[0].company, 'Harvey');
  assert.ok(d.names.some((x) => x.key === 'anthropic'), 'Anthropic is named far more than in the weeks before');
  assert.deepEqual([d.prev, d.next], ['2026-09-14', '2026-09-18']);
  assert.equal(d.moves[0].delta, 0.25);

  const shown = withReleases(withMarkets(d, [{ id: 'pm:1', title: 'Best model?', url: 'https://polymarket.com/e', binary: false }]), [{ id: 'r1', name: 'Nova', provider: 'Anthropic', date: t, url: 'https://x' }, { id: 'r2', name: 'Old', date: t - 5 * DAY }]);
  assert.equal(shown.moves[0].title, 'Best model?');
  assert.deepEqual(shown.releases.map((r) => r.id), ['r1']);
  assert.equal(withMarkets(d, []).moves.length, 0, 'closed markets drop out');

  const cal = dayCalendar(db, { now, days: 60 });
  assert.equal(cal.days.length, 60);
  assert.equal(cal.to, '2026-10-22');
  assert.equal(cal.days.find((x) => x.day === '2026-09-15').n, 8);
});
