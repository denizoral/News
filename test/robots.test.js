import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { parseRobot, computeRobots } from '../src/index/robots.js';

const DAY = 86400e3;
const now = Date.parse('2026-10-22T12:00:00Z');

test('robot headlines: what happened, which robot, whose, and the numbers', () => {
  const a = parseRobot('Apptronik raises $520 million to beat Chinese humanoids, Tesla Optimus to market');
  assert.deepEqual([a.kind, a.form, a.company.key, a.usd], ['funding', 'humanoid', 'apptronik', 520e6]);
  // The round, not the valuation.
  assert.equal(parseRobot('Humanoid Raises $152 Million at $1.35 Billion Post-Money Valuation').usd, 152e6);
  assert.equal(parseRobot('Robotics startup FieldAI set to raise new funding round at $10 billion valuation').usd, null);
  const b = parseRobot('Faraday Future Unveils $2,490 Nova and $299 Nova Mini Humanoid Robots');
  assert.deepEqual([b.kind, b.company.key, b.price], ['launch', 'faraday', 2490]);
  const c = parseRobot('Agile Robots unveils Nvidia-powered humanoid, targets up to 2,000 units in 2027');
  assert.deepEqual([c.kind, c.company.region, c.units, c.year], ['production', 'europe', 2000, 2027]);
  assert.equal(parseRobot('Tesla pushes Optimus deliveries to late 2027, says hands still a problem').kind, 'setback');
  assert.equal(parseRobot('Unitree surged as much as 629% in its blockbuster market debut').kind, 'funding');
  // A former employer isn't the company; an unlisted startup is named before its verb.
  assert.equal(parseRobot("Ex-DeepMind founders' robotics startup Generalist hits $3B valuation with $200M funding").company.key, 'generalist');
  assert.equal(parseRobot('Origin raises $20 million to scale construction robots').company.label, 'Origin');
  // Robotaxis, robots.txt and lists aren't robots.
  assert.equal(parseRobot('Uber and Pony.ai plan to launch robotaxis in London'), null);
  assert.equal(parseRobot("Google's Illyes: Robots.txt Covers Crawling, Not AI Training"), null);
});

test('robots: one round across outlets is one event, with regions, rounds and prices', () => {
  resetDb();
  let n = 0;
  const add = (title, source, daysAgo) => upsertDoc({ url: `https://${source}.com/${n++}`, type: 'article', title, description: '', body: '', site: `${source}.com`, source, published_at: now - daysAgo * DAY });
  add('Skild AI Secures $1.4 Billion Series C, Tripling Valuation to Over $14 Billion', 'reuters', 20);
  add('Robotics unicorn Skild AI grabs $1.4B to build a universal brain for every robot', 'techcrunch', 10);
  add('Unitree reveals H2 humanoid robot with 8-hour battery', 'verge', 5);
  add('UBTech opens plant making a humanoid robot every 10 minutes', 'scmp', 40);
  add('Faraday Future launches $2,490 humanoid robot', 'engadget', 3);
  add('Robot vacuum deals on Prime Day', 'deals', 2);
  const d = computeRobots(getDb(), now);
  const skild = d.events.filter((x) => x.company?.key === 'skild');
  assert.equal(skild.length, 1, 'one round');
  assert.equal(skild[0].outlets, 2);
  assert.equal(d.rounds[0].usd, 1.4e9);
  assert.equal(d.prices[0].price, 2490);
  assert.equal(d.regions.find((r) => r.key === 'china').n, 2);
  assert.equal(d.stats.raised, 1.4e9);
  assert.equal(d.months.length, 12);
  assert.ok(!d.events.some((x) => /Prime Day/.test(x.title)));
});
