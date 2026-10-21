import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb } from '../src/db.js';
import { recordOdds, series, resample, attachSparks, marketHistory, resetOdds } from '../src/pipeline/odds.js';

const H = 3600e3;
const market = (yes, yes2 = 0.3) => ({ id: 'pm:1', volume24h: 1, outcomes: [{ label: 'Yes', yes }, { label: 'Other', yes: yes2 }] });

test('odds are recorded when they move, and on a 30-minute heartbeat', () => {
  resetDb();
  resetOdds();
  const t = Date.now() - 10 * H;
  assert.equal(recordOdds([market(0.5)], t), 2);
  assert.equal(recordOdds([market(0.5)], t + 60e3), 0, 'unchanged within the heartbeat');
  assert.equal(recordOdds([market(0.52)], t + 120e3), 1, 'only the outcome that moved');
  assert.equal(recordOdds([market(0.52)], t + 33 * 60e3), 2, 'heartbeat');
  assert.deepEqual(series('pm:1', 'Yes', 0).map((p) => p[1]), [0.5, 0.52, 0.52]);
  // A restart re-reads the last values instead of writing duplicates.
  resetOdds();
  assert.equal(recordOdds([market(0.52)], t + 34 * 60e3), 0);
});

test('resample carries prices forward onto even slots', () => {
  const pts = [[100, 0.2], [300, 0.4]];
  assert.deepEqual(resample(pts, 0, 400, 5), [0.2, 0.2, 0.4, 0.4]);
  assert.equal(resample([[1, 0.5]], 0, 10, 5), null, 'one point is not a line');
});

test('sparks and history come from the stored odds', () => {
  resetDb();
  resetOdds();
  const now = Date.now();
  for (let h = 48; h >= 0; h -= 2) recordOdds([market(0.3 + (48 - h) / 200)], now - h * H);
  const m = market(0.54);
  attachSparks([m], now);
  assert.ok(m.spark.length > 10);
  assert.equal(m.spark.at(-1), 0.54);
  assert.ok(m.spark[0] < m.spark.at(-1));
  const hist = marketHistory(m, { now, max: 10 });
  assert.equal(hist.length, 2);
  assert.ok(hist[0].points.length <= 11);
  assert.equal(hist[0].points.at(-1)[1], 0.54, 'the latest point is always kept');
});
