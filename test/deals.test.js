import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { parseDeal, parseMoney, nameBefore, stageOf, groupDeals, computeDeals, companyDeals, companyKey } from '../src/index/deals.js';

const DAY = 86400e3;
const now = Date.parse('2026-10-22T12:00:00Z');

test('deals: headlines read as rounds, valuations and acquisitions', () => {
  assert.equal(parseMoney('$', '27', 'M'), 27e6);
  assert.equal(parseMoney('€', '10', 'million'), 10.8e6);
  assert.equal(parseMoney('$', '576,000', undefined), 576000);
  assert.equal(parseMoney('$', '5', undefined), null, 'a price, not a deal');

  const a = parseDeal('Legal AI startup Harvey raises $300M Series D at $3B valuation led by Sequoia | TechCrunch');
  assert.deepEqual([a.kind, a.company, a.amount, a.valuation, a.round, a.talks], ['funding', 'Harvey', 300e6, 3e9, 'Series D', false]);
  assert.deepEqual(a.investors, ['Sequoia']);
  assert.equal(stageOf(a.round), 'late');

  const b = parseDeal('OpenAI Is Racing to Raise $30 Billion Before Anthropic Goes Public');
  assert.deepEqual([b.company, b.amount, b.talks], ['OpenAI', 30e9, false]);
  assert.equal(parseDeal('OpenAI seeks to raise $30 billion at $1.4 trillion valuation').talks, true);

  const c = parseDeal('Salesforce to Acquire Braze for $5.66 Billion in All-Cash Deal');
  assert.deepEqual([c.kind, c.acquirer, c.company, c.amount], ['acquisition', 'Salesforce', 'Braze', 5.66e9]);
  assert.equal(parseDeal('CoreWeave Acquires Weights & Biases').company, 'Weights & Biases');
  assert.equal(parseDeal('Apple Buys AI Audio Editing App Samplab').company, 'Samplab');

  const v = parseDeal('Open source agentic startup LangChain hits $1.25B valuation');
  assert.deepEqual([v.kind, v.company, v.valuation], ['valuation', 'LangChain', 1.25e9]);

  assert.equal(nameBefore('Berlin-based YGO'), 'YGO');
  assert.equal(nameBefore('AI piano-learning startup ArtMaster, previously backed by Robert Kyncl,'), 'ArtMaster');
  assert.equal(parseDeal('Anthropic raises Series E at $61.5B post-money valuation'), null, 'the amount is the valuation');

  // Not deals.
  for (const t of [
    '3 Stocks to Buy Before Wall Street Catches On',
    'Gecko Robotics secures $300M contract with the U.S. Navy',
    'Anthropic lands deal in $31bn datacentre in western Queensland',
    'TeraWulf Drops 8% Even as Analysts Raise Price Targets on $19B Anthropic Deal',
    'Can Britain chip away at Nvidia? Start-ups raise $1.6bn',
    'a16z raises $7B fund for AI',
    'NVIDIA-Acquired Groq Is Moving Its Next-Gen LPUs To DRAM',
  ]) assert.equal(parseDeal(t), null, t);
});

test('deals: one deal per company and round, valuations join their round, misprints drop', () => {
  const m = (title, at, site) => ({ ...parseDeal(title), title, url: `https://${site}/${at}`, site, at });
  const deals = groupDeals([
    m('Legora raises $550M at an $8.8B valuation', now - 2 * DAY, 'a.com'),
    m('Legal AI startup Legora valued at $8.8 billion in new round', now - DAY, 'b.com'),
    m('Legora lands $550 million Series E', now, 'c.com'),
    m('Legora raises $80M Series B', now - 300 * DAY, 'a.com'),
    m('Anthropic raises $65B Series H at $965B valuation', now - 5 * DAY, 'a.com'),
    m('[AINews] Anthropic raises $965B Series H', now - 4 * DAY, 'news.ai'),
  ]);
  const legora = deals.filter((d) => d.companyKey === 'legora');
  assert.equal(legora.length, 2);
  const e = legora.find((d) => d.amount === 550e6);
  assert.deepEqual([e.outlets, e.valuation, e.round, e.first.site], [3, 8.8e9, 'Series E', 'a.com']);
  const anth = deals.filter((d) => d.companyKey === 'anthropic');
  assert.equal(anth.length, 1);
  assert.equal(anth[0].amount, 65e9);
  assert.equal(companyKey('Mistral AI'), companyKey('Mistral'));
});

test('deals: totals by stage, top raisers, company history, undated pages skipped', () => {
  resetDb();
  let n = 0;
  const doc = (title, daysAgo, extra = {}) => upsertDoc({ url: `https://n.example/${n++}`, type: 'article', title, description: 'An AI company.', site: 'n.example', source: 'N', published_at: now - daysAgo * DAY, ...extra });
  doc('Harvey raises $100M Series C for legal AI', 40);
  doc('Harvey raises $300M Series D at $3B valuation', 5);
  doc('Tiny raises $2M seed for AI agents', 3);
  doc('Acme AI in talks to raise $50M', 2);
  doc('Salesforce to acquire Braze for $5.66 billion to push AI agents', 1);
  doc('NVIDIA to Acquire Mellanox for $6.9 Billion', 0, { published_at: null });
  doc('Bakery raises $5M for bread', 1, { description: 'Sourdough.' });
  const db = getDb();
  const r = computeDeals(db, { range: '90d', now });
  assert.equal(r.unit, 'week');
  assert.equal(r.totals.rounds, 3);
  assert.equal(r.totals.raised, 402e6);
  assert.equal(r.totals.talks, 1);
  assert.equal(r.totals.acquisitions, 1, 'the undated archive page is skipped');
  assert.equal(r.totals.biggest.company, 'Harvey');
  assert.equal(r.top[0].company, 'Harvey');
  assert.equal(r.top[0].rounds, 2);
  assert.equal(r.raised.late.reduce((a, b) => a + b, 0), 400e6);
  assert.equal(r.raised.seed.reduce((a, b) => a + b, 0), 2e6);
  assert.ok(!r.deals.some((d) => d.company === 'Bakery'), 'not about AI');
  const h = companyDeals(db, { key: 'harvey', now });
  assert.equal(h.deals.length, 2);
  assert.equal(h.raised, 400e6);
  assert.deepEqual(h.valuations.map((x) => x.valuation), [3e9]);
  assert.equal(companyDeals(db, { key: 'salesforce', now }).deals[0].company, 'Braze', 'a buyer sees its purchases');
  assert.equal(companyDeals(db, { key: 'nobody', now }), null);
});
