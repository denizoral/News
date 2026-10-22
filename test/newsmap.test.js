import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb, q } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { DIM, quantize } from '../src/index/vectors.js';
import { computeNewsMap, normalise, tsne } from '../src/index/newsmap.js';

const H = 3600e3;
const now = Date.parse('2026-10-22T12:00:00Z');
const vec = (axis, wobble = 0, other = axis + 1) => {
  const v = new Array(DIM).fill(0);
  v[axis] = 1;
  v[other % DIM] = wobble;
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};
const dist = (p, r) => Math.hypot(p[0] - r[0], p[1] - r[1]);

test('t-SNE: two groups land apart, and the layout is the same every time', () => {
  const X = [];
  for (let i = 0; i < 12; i++) X.push(Float32Array.from(vec(0, (i % 6) * 0.05, 1 + (i % 3))));
  for (let i = 0; i < 12; i++) X.push(Float32Array.from(vec(40, (i % 6) * 0.05, 41 + (i % 3))));
  const pts = normalise(tsne(X, { iters: 300 }));
  // Every point's nearest neighbour is in its own group.
  pts.forEach((p, i) => {
    let best = -1;
    pts.forEach((r, j) => { if (j !== i && (best < 0 || dist(p, r) < dist(p, pts[best]))) best = j; });
    assert.equal(best < 12, i < 12, `point ${i}`);
  });
  for (const [x, y] of pts) assert.ok(x >= 0 && x <= 1 && y >= 0 && y <= 1);
  assert.deepEqual(normalise(tsne(X, { iters: 300 })), pts, 'deterministic');
});

test('news map: stories become points with named, growing regions', () => {
  resetDb();
  let n = 0;
  const add = (title, axis, wobble, hoursAgo, site) => {
    const url = `https://${site}/${n++}`;
    const { id } = upsertDoc({ url, type: 'article', title, description: 'An AI model story.', site, source: site, published_at: now - hoursAgo * H });
    q('INSERT INTO doc_vecs (doc_id, v) VALUES (?, ?)').run(id, quantize(vec(axis, wobble)));
  };
  const chips = ['Nvidia Rubin GPU sampling begins', 'TSMC packaging capacity doubles', 'HBM memory prices climb', 'Blackwell supply eases for buyers', 'AMD MI500 benchmark leaks', 'Broadcom custom ASIC orders'];
  const law = ['EU regulation of AI delayed', 'California regulation of AI signed', 'Senate hearing grills AI executives', 'FTC probe into AI chatbots', 'UK AISI publishes AI evaluation', 'Copyright ruling against AI startup'];
  chips.forEach((t, i) => add(`${t} for AI`, 0, i * 0.04, 60 - i * 10, `c${i}.com`));
  law.forEach((t, i) => add(t, 50, i * 0.04, i + 1, `l${i}.com`));
  const d = computeNewsMap(getDb(), { days: 3, now });
  assert.equal(d.stories, 12);
  assert.equal(d.points.length, 12);
  assert.equal(d.regions.length, 2);
  const lawRegion = d.regions.find((r) => r.top.some((t) => /FTC|Senate|regulation/.test(t)));
  assert.ok(lawRegion.name, 'named');
  assert.ok(lawRegion.growth > 1, 'all of it recent');
  assert.ok(d.regions.find((r) => r !== lawRegion).growth < 1);
  for (const p of d.points) assert.ok(p.r === 0 || p.r === 1);
});
