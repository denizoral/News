import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { parseRules, measureName, jurisdictionOf, computeRules } from '../src/index/rules.js';

const DAY = 86400e3;
const now = Date.parse('2026-10-22T12:00:00Z');

test('rules headlines: where, which measure, how far and about what', () => {
  const a = parseRules('New York governor Kathy Hochul signs RAISE Act to regulate AI safety');
  assert.deepEqual([a.where.key, a.name, a.stage, a.topic], ['us-ny', 'RAISE Act', 'signed', 'safety']);
  const b = parseRules('U.S. House passes bill to stop Chinese companies from accessing export-controlled American AI chips');
  assert.deepEqual([b.where.key, b.stage, b.topic], ['us-federal', 'passed', 'chips'], 'a US measure about China is federal');
  assert.equal(parseRules('Maine Gov. Mills Ripped for Veto of Landmark AI Data Center Moratorium').stage, 'blocked');
  assert.equal(parseRules('EU AI Act transparency rules are now in effect').where.key, 'eu');
  assert.equal(parseRules('Newsom signs AI companion chatbot law for minors').where.key, 'us-ca', 'a governor names the state');
  assert.equal(measureName('Colorado Legislature Passes Bill to Repeal and Replace Colorado AI Act'), 'AI Act');
  assert.equal(parseRules('Colorado Legislature Passes Bill to Repeal and Replace Colorado AI Act').where.key, 'us-co', 'Colorado’s AI Act is not the EU’s');
  assert.equal(measureName('California SB 53 heads to governor'), 'SB 53');
  assert.equal(measureName('What the EU AI Act Doesn’t Tell Founders'), 'AI Act');
  for (const t of ['California’s New Workplace AI Laws: 8 Takeaways for HR', 'Chinese AI controls 55% of developer traffic—DeepSeek and Kimi K3 rewrote the rules', 'Etsy bans AI-made crochet patterns', 'Bill Gates thinks AI could make us live like the Amish']) assert.equal(parseRules(t), null, t);
  assert.equal(jurisdictionOf('25 states urge Congress to act on AI').key, 'us-federal');
});

test('rules: measures by name, furthest stage unless blocked since, months and jurisdictions', () => {
  resetDb();
  let n = 0;
  const add = (title, source, daysAgo) => upsertDoc({ url: `https://${source}.com/${n++}`, type: 'article', title, description: '', body: '', site: `${source}.com`, source, published_at: now - daysAgo * DAY });
  add('New York lawmakers pass RAISE Act on frontier AI safety', 'nyt', 120);
  add('New York lawmakers pass the RAISE Act regulating frontier AI', 'verge', 120);
  add('Hochul signs RAISE Act to regulate AI safety', 'ap', 30);
  add('Colorado lawmakers pass AI discrimination law for employers', 'cpr', 200);
  add('Colorado delays its AI law for employers by a year', 'denverpost', 20);
  add('EU AI Act general-purpose rules take effect', 'ft', 80);
  const d = computeRules(getDb(), now);
  const raise = d.measures.find((m) => m.id === 'us-ny--raise-act');
  assert.ok(raise, 'one RAISE Act measure');
  assert.equal(raise.stage, 'signed');
  assert.equal(raise.events.length, 2, 'two outlets on one day are one event');
  const co = d.measures.find((m) => m.where.key === 'us-co');
  assert.equal(co.stage, 'blocked', 'delayed after it passed');
  assert.equal(co.reached, 'passed');
  assert.equal(d.measures.find((m) => m.where.key === 'eu').stage, 'inforce');
  assert.equal(d.stats.enacted, 2);
  assert.equal(d.stats.states, 2);
  assert.equal(d.months.length, 12);
});
