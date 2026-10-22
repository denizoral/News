import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { extractForecasts, targetYear, whoOf, createForecastIndex, refreshForecasts, computeForecasts } from '../src/index/forecasts.js';

const DAY = 86400e3;
const now = Date.parse('2026-10-22T12:00:00Z');

test('forecasts: horizons, who made them, and what is not a forecast', () => {
  assert.equal(targetYear('Gartner expects spending to hit $2 trillion by 2027.', 2026).year, 2027);
  assert.equal(targetYear('The company will hire 500 engineers within five years.', 2026).year, 2031);
  assert.equal(targetYear('It could happen by the end of the decade.', 2026).year, 2029);
  assert.equal(targetYear('Revenue grew in 2024.', 2026), null, 'past years are not horizons');
  assert.deepEqual(whoOf('Gartner expects worldwide AI spending to reach $2.7 trillion in 2026.'), { name: 'Gartner', person: false, role: null });
  assert.equal(whoOf('Data center demand will hit 80 GW by 2030, according to McKinsey.').name, 'McKinsey');
  assert.equal(whoOf('Leveraging OpenAI expects to bring Helios online in 2027.').name, 'OpenAI', 'a heading run into the sentence is dropped');
  assert.equal(whoOf('Analysts expect the market to double by 2028.'), null, 'nobody in particular');

  const body = [
    'Tesla held its earnings call on Wednesday and Elon Musk talked about robots for most of it.',
    'Musk expects Tesla to start delivering Optimus humanoid robots to outside customers by the end of 2027.',
    '“We will have systems smarter than any human by 2029, and that changes everything,” said Jane Roe, chief scientist at Acme.',
    'OpenAI plans to bring its Helios data center online in the fourth quarter of 2026, the company said in a filing.',
    'Revenue rose 40% in 2025 and the company was founded in 2021, which made it one of the fastest growing.',
    'The conference will take place in 2027 in Lisbon, with tickets available now for everyone interested.',
  ].join('\n');
  const f = extractForecasts(body, now);
  assert.deepEqual(f.map((x) => [x.name, x.year, x.kind]), [
    ['Jane Roe', 2029, 'forecast'],
    ['Elon Musk', 2027, 'forecast'],
    ['OpenAI', 2026, 'plan'],
  ]);
  assert.equal(f[0].quoted, true);
  assert.equal(f[1].person, true, 'a surname takes the full name used earlier in the piece');
});

test('forecasts: the ledger groups outlets, counts years and themes, filters', () => {
  resetDb();
  const line = 'Gartner expects worldwide AI data center electricity demand to reach 1,200 TWh by 2030.';
  let n = 0;
  for (const site of ['a.com', 'b.com', 'c.com']) {
    upsertDoc({ url: `https://${site}/${n++}`, type: 'article', title: 'AI data centers keep growing', description: 'AI power demand.', site, source: site, published_at: now - n * DAY, body: `Intro about the AI build-out and the grid.\n${line}\n${'Filler words here. '.repeat(30)}` });
  }
  upsertDoc({ url: 'https://d.com/1', type: 'article', title: 'Robots for hire: AI humanoids', description: 'AI robotics.', site: 'd.com', source: 'd.com', published_at: now - DAY, body: `Intro about robots and AI.\nMorgan Stanley predicts the market for humanoid robots will reach $5 trillion by 2050.\n${'Filler words here. '.repeat(30)}` });
  const idx = refreshForecasts(getDb(), createForecastIndex(), { now });
  assert.equal(idx.items.length, 4);
  const all = computeForecasts(idx, { now });
  assert.equal(all.forecasts.length, 2);
  assert.equal(all.forecasts[0].outlets, 3, 'the same line across outlets is one forecast');
  assert.equal(all.forecasts[0].theme, 'energy');
  assert.equal(all.years[0].year, 2026, 'the year axis starts this year');
  assert.equal(all.years.find((y) => y.year === 2030).n, 1);
  assert.equal(all.themes.find((t) => t.key === 'robots').n, 1);
  assert.equal(computeForecasts(idx, { now, year: 2050 }).forecasts[0].name, 'Morgan Stanley');
  assert.equal(computeForecasts(idx, { now, theme: 'robots' }).forecasts.length, 1);
  assert.equal(computeForecasts(idx, { now, who: 'gartner' }).forecasts.length, 1);
});
