import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, q } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { DIM, quantize, embedTick, VectorIndex } from '../src/index/vectors.js';
import { similarDocs } from '../src/index/semantic.js';

// Unit vectors pointing mostly along one axis, so similarity is predictable.
const unit = (axis, wobble = 0) => {
  const v = new Array(DIM).fill(0);
  v[axis] = 1;
  v[(axis + 1) % DIM] = wobble;
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};

test('quantized vectors keep cosine similarity', () => {
  const db = resetDb();
  const a = unit(0, 0.3), b = unit(0, 0.5), c = unit(7);
  db.prepare('INSERT INTO doc_vecs (doc_id, v) VALUES (?, ?)').run(1, quantize(a));
  db.prepare('INSERT INTO doc_vecs (doc_id, v) VALUES (?, ?)').run(2, quantize(b));
  db.prepare('INSERT INTO doc_vecs (doc_id, v) VALUES (?, ?)').run(3, quantize(c));
  const idx = new VectorIndex(db);
  assert.equal(idx.refresh(), 3);
  const hits = idx.search(a, 3);
  assert.deepEqual(hits.map((h) => h.id), [1, 2, 3]);
  assert.ok(Math.abs(hits[0].score - 1) < 0.02, `self-similarity ${hits[0].score}`);
  const exact = a.reduce((s, x, i) => s + x * b[i], 0);
  assert.ok(Math.abs(hits[1].score - exact) < 0.02);
  assert.ok(Math.abs(hits[2].score) < 0.02);
  // Only new rows are read on the next refresh; a re-embedded doc keeps its row.
  db.prepare('INSERT OR REPLACE INTO doc_vecs (doc_id, v) VALUES (?, ?)').run(3, quantize(a));
  assert.equal(idx.refresh(), 1);
  assert.equal(idx.n, 3);
});

test('the embedder does new documents first, then works back through old ones', async () => {
  resetDb();
  for (let i = 1; i <= 3; i++) upsertDoc({ url: `https://a.com/${i}`, type: 'article', title: `Old story ${i}` });
  upsertDoc({ url: 'https://a.com/m', type: 'market', title: 'A market, not embedded' });
  const seen = [];
  const fake = async (texts) => { seen.push(texts); return texts.map((_, i) => unit(i)); };
  assert.equal(await embedTick(fake), 3);
  upsertDoc({ url: 'https://a.com/new', type: 'post', title: 'New post', description: 'with a summary' });
  assert.equal(await embedTick(fake), 1);
  assert.deepEqual(seen[1], ['New post. with a summary']);
  assert.equal(await embedTick(fake), 0, 'caught up');
  assert.equal(q('SELECT COUNT(*) AS n FROM doc_vecs').get().n, 4);
});

test('similar documents skip the story itself, its copies and duplicates', () => {
  const db = resetDb();
  const add = (url, title, vec) => {
    upsertDoc({ url, type: 'article', title, published_at: Date.now() });
    db.prepare('INSERT INTO doc_vecs (doc_id, v) VALUES (?, ?)').run(q('SELECT id FROM docs WHERE url = ?').get(url).id, quantize(vec));
  };
  add('https://a.com/story', 'Nvidia unveils a new AI chip for data centers', unit(0));
  add('https://b.com/copy', 'Nvidia unveils new AI chip for data centers', unit(0, 0.05));
  add('https://c.com/bg', 'Why data center chips are in short supply', unit(0, 0.4));
  add('https://d.com/bg', 'Why data center chips are in short supply', unit(0, 0.45));
  add('https://e.com/far', 'A recipe for soup', unit(9));
  add('https://f.com/hidden', 'Hidden chip story', unit(0, 0.2));
  db.prepare('UPDATE docs SET hidden = 1 WHERE url = ?').run('https://f.com/hidden');
  const r = similarDocs(db, { vec: unit(0), excludeUrls: ['https://a.com/story'], excludeTitle: 'Nvidia unveils a new AI chip for data centers', minScore: 0.5 });
  assert.deepEqual(r.results.map((x) => x.url), ['https://c.com/bg']);
});
