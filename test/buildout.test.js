import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { parseBuildout, capacityOf, placeOf, computeBuildout } from '../src/index/buildout.js';

const DAY = 86400e3;
const now = Date.parse('2026-10-22T12:00:00Z');

test('buildout headlines: builder, place, size, money, power and pushback', () => {
  const a = parseBuildout('Planned 10-gigawatt Softbank data center in Ohio might be the largest in the world, will require a $33 billion natural gas plant');
  assert.deepEqual([a.kind, a.builder.key, a.place.key, a.gw, a.amount], ['project', 'softbank', 'OH', 10, 33e9]);
  assert.ok(a.power.includes('gas'));
  const b = parseBuildout('KT Cloud Breaks Ground on 50-MW AI Data Center in Ansan');
  assert.deepEqual([b.builder.label, b.place.key, b.gw, b.status], ['KT Cloud', 'korea', 0.05, 'construction'], 'a builder from the headline subject, a city we can place');
  const c = parseBuildout('Pittsburg moves toward 45-day moratorium on new AI data center development');
  assert.deepEqual([c.kind, c.push, c.place.key], ['pushback', ['moratorium'], 'CA']);
  assert.equal(parseBuildout('Amazon abandons $427 million campus data center plan after backlash').status, 'cancelled');
  // Fleet goals and chip deals aren't a site's size; market reports aren't news.
  assert.equal(parseBuildout('Musk projects at least 13 gigawatts of AI compute by end of next year')?.gw ?? null, null);
  assert.equal(parseBuildout('Data Center Power Cable Market to Reach USD 4.72 Billion by 2035'), null);
  assert.equal(parseBuildout('D-Matrix Connects Raptor XPUs to NVIDIA AI Factories via NVLink Fusion')?.power.includes('fusion'), false);
  assert.equal(capacityOf('a 1.2 GW campus and 300MW more'), 1.2);
  assert.equal(placeOf('West Virginia data center').key, 'WV');
  assert.equal(placeOf('Northern Virginia data center alley').key, 'VA');
});

test('buildout: projects merge by builder and place, places collect pushback, months and share', () => {
  resetDb();
  let n = 0;
  const add = (title, source, daysAgo) => upsertDoc({ url: `https://${source}.com/${n++}`, type: 'article', title, description: '', body: '', site: `${source}.com`, source, published_at: now - daysAgo * DAY });
  add('Meta plans $10 billion AI data center in Louisiana', 'cnbc', 200);
  add('Meta plans $10 billion data center in Louisiana, its largest', 'verge', 200);
  add('Meta boosts Louisiana data center to 5 GW and $27 billion', 'fortune', 60);
  add('Louisiana approves gas plants for Meta data center', 'reuters', 30);
  add('Memphis council votes down new data center after protests', 'ap', 10);
  add('Memphis residents protest xAI data center turbines', 'guardian', 5);
  add('Denver weighs one-year data center moratorium', 'denverpost', 3);
  add('Best data center stocks to buy now', 'fool', 2);
  const d = computeBuildout(getDb(), now);
  const meta = d.projects.find((p) => p.id === 'meta--LA');
  assert.ok(meta, 'Meta in Louisiana is one project');
  assert.equal(meta.gw, 5);
  assert.equal(meta.amount, 27e9);
  assert.equal(meta.status, 'approved');
  assert.ok(meta.power.includes('gas'));
  assert.equal(meta.outlets, 4);
  const tn = d.places.find((p) => p.key === 'TN');
  assert.equal(tn.pushback, 2);
  assert.equal(tn.kinds.rejected, 1);
  assert.equal(d.stats.placesSayingNo, 2, 'Memphis rejected, Denver paused');
  assert.equal(d.months.length, 12);
  assert.equal(d.months.reduce((s, m) => s + m.pushback, 0), 3);
  assert.ok(!d.pushback.some((e) => /stocks/.test(e.title)));
});
