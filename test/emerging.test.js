import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, getDb, q } from '../src/db.js';
import { upsertDoc } from '../src/index/documents.js';
import { DIM, quantize } from '../src/index/vectors.js';
import { computeEmerging, groupVectors, themeName } from '../src/index/emerging.js';

const H = 3600e3;
const now = Date.parse('2026-10-22T00:00:00Z');
// Unit vectors near one axis; `wobble` tilts toward a second.
const vec = (axis, wobble = 0, other = axis + 1) => {
  const v = new Array(DIM).fill(0);
  v[axis] = 1;
  v[other % DIM] = wobble;
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
};

test('grouping: close stories join, a broad drift does not chain', () => {
  const items = [vec(0), vec(0, 0.2), vec(0, 0.35), vec(5), vec(5, 0.1)].map((v, i) => ({ v: Float32Array.from(v), i }));
  const groups = groupVectors(items);
  assert.deepEqual(groups.map((g) => g.members.map((m) => m.i)), [[0, 1, 2], [3, 4]]);
  // A chain where each step is close to the last but far from the start.
  const chain = [0, 0.5, 1, 1.6, 2.5].map((w, i) => ({ v: Float32Array.from(vec(0, w, 1)), i }));
  assert.ok(groupVectors(chain).length >= 2, 'the end of the chain starts its own theme');
});

test('theme names: the shared name, in its own capitalisation', () => {
  const titles = ['Anthropic launches Claude Duet, a proactive agent', 'Claude Duet is here', 'Hands on with Claude Duet'];
  const all = [...titles, 'OpenAI ships a model', 'Google launches Gemini', 'Anthropic raises money'];
  assert.equal(themeName(titles, all)[0], 'Claude Duet');
});

test('emerging themes: accelerating groups of stories, ranked, with a spark', () => {
  resetDb();
  const stories = [];
  const add = (sid, axis, wobble, hoursAgo, sources) => {
    const url = `https://${sid}.com/a`;
    const { id } = upsertDoc({ url, type: 'article', title: `${sid} story`, published_at: now - hoursAgo * H });
    q('INSERT INTO doc_vecs (doc_id, v) VALUES (?, ?)').run(id, quantize(vec(axis, wobble)));
    q('INSERT INTO story_ids (item_url, sid, at) VALUES (?, ?, ?)').run(url, sid, now);
    stories.push({ sid, title: `Nova Agent ${sid}`, url, source: sid, sources, publishedAt: now - hoursAgo * H, entities: [] });
  };
  // New: three stories in the last hours, nothing before.
  add('n1', 0, 0, 1, ['A', 'B']);
  add('n2', 0, 0.1, 2, ['C']);
  add('n3', 0, 0.2, 3, ['D']);
  // Old and steady: as much coverage before as now.
  add('o1', 9, 0, 2, ['E', 'F']);
  add('o2', 9, 0.1, 20, ['G']);
  add('o3', 9, 0.2, 30, ['H']);
  add('o4', 9, 0.15, 5, ['I']);
  add('o5', 9, 0.05, 4, ['I']);
  // Too small to be a theme.
  add('s1', 20, 0, 1, ['J', 'K', 'L']);
  const d = computeEmerging(getDb(), stories, { now });
  assert.equal(d.themes.length, 2);
  const [first, second] = d.themes;
  assert.equal(first.id, 'n1');
  assert.equal(first.isNew, true);
  assert.equal(first.recent, 3);
  assert.equal(second.id, 'o1');
  assert.equal(second.isNew, false);
  assert.equal(first.spark.length, 48);
  assert.equal(first.spark.reduce((a, b) => a + b, 0), 3);
  assert.equal(first.outlets, 4);
});
