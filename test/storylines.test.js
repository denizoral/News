import test from 'node:test';
import assert from 'node:assert/strict';
import { chainChapters, shapeStorylines, storylineList, storylineOf } from '../src/index/storylines.js';

const now = Date.parse('2026-10-22T12:00:00Z');
const unit = (v) => { const n = Math.hypot(...v); return v.map((x) => x / n); };
const ch = (day, title, vec, outlets = 3, entities = ['openai']) => ({ day, title, url: `https://x.com/${title.replace(/\W+/g, '-')}`, source: 'X', at: Date.parse(`${day}T10:00:00Z`), outlets, entities, items: [], vec: unit(vec) });

test('storylines: chapters chain by meaning and shared words, and lines close after a gap', () => {
  const chapters = [
    ch('2026-10-10', 'Alfozan arrested over bugging device', [1, 0.1, 0]),
    ch('2026-10-10', 'OpenAI ships a browser', [0.2, 1, 0]),
    ch('2026-10-12', 'Court hears Alfozan bugging case', [1, 0.2, 0.05]),
    ch('2026-10-13', 'OpenAI pricing changes', [0.95, 0.3, 0.1]), // close, but no word in common
    ch('2026-10-15', 'Alfozan held without bail', [0.97, 0.15, 0]),
    ch('2026-10-30', 'Alfozan trial date set', [1, 0.1, 0]), // after the gap: a new line
  ];
  const lines = chainChapters(chapters, (c) => c.vec, { join: 0.78, sure: 0.999 });
  const saga = lines.find((l) => l.chapters[0].title.startsWith('Alfozan arrested'));
  assert.deepEqual(saga.chapters.map((c) => c.day), ['2026-10-10', '2026-10-12', '2026-10-15']);
  assert.equal(lines.length, 4);

  const d = shapeStorylines(lines, { now: Date.parse('2026-10-16T12:00:00Z'), days: 60 });
  assert.equal(d.total, 1, 'three days make a storyline');
  const s = d.storylines[0];
  assert.equal(s.dayCount, 3);
  assert.equal(s.from, '2026-10-10');
  assert.equal(s.latest.title, 'Alfozan held without bail');
  assert.equal(s.active, true);
  assert.deepEqual(s.entities.map((e) => e.key), ['openai']);
  assert.equal(storylineOf(d, { url: s.chapters[1].url, title: '' }).id, s.id);
  assert.equal(storylineOf(d, { url: 'https://nope', title: 'nope' }), null);
  assert.ok(!('chapters' in storylineList(d).storylines[0]));
});
