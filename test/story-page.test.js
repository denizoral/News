import test from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, q } from '../src/db.js';
import { StoryIds, loggedStory, sidOf } from '../src/index/stories.js';
import { extractiveBrief, sentences } from '../src/pipeline/brief.js';
import { timelineOf, growthOf, marketMove } from '../src/index/storypage.js';

const H = 3600e3;
const t0 = Date.parse('2026-10-20T12:00:00Z');
const item = (id, url, source, at, extra = {}) => ({ id, url, source, title: `t ${id}`, publishedAt: at, platform: 'web', ...extra });
const story = (group) => ({ id: group[0].id, title: 'A story', url: group[0].url, summary: '', sources: group.map((g) => ({ name: g.source })), publishedAt: group[0].publishedAt, updatedAt: group.at(-1).publishedAt, topics: [], entities: [], markets: [], _group: group });

test('a story keeps its id as sources arrive, its lead changes and it merges', () => {
  resetDb();
  const ids = new StoryIds();
  const a = item('rss:a', 'https://a.com/1', 'A', t0);
  const s1 = story([a]);
  ids.assign([s1], { now: t0 });
  assert.equal(s1.sid, sidOf('rss:a'));

  // A bigger outlet arrives and becomes the lead; the id stays.
  const b = item('rss:b', 'https://b.com/1', 'B', t0 + H);
  const s2 = story([b, a]);
  s2.id = 'rss:b';
  ids.assign([s2], { now: t0 + H });
  assert.equal(s2.sid, s1.sid);

  // Another story (its own id) merges in: the id most items carry wins.
  const c = item('rss:c', 'https://c.com/1', 'C', t0 + 2 * H);
  const other = story([c]);
  ids.assign([other], { now: t0 + 2 * H });
  const merged = story([b, a, c]);
  ids.assign([merged], { now: t0 + 3 * H });
  assert.equal(merged.sid, s1.sid);

  // A fresh process reads the links back from the database.
  const again = new StoryIds();
  const s3 = story([c]);
  again.assign([s3], { now: t0 + 4 * H });
  assert.equal(s3.sid, sidOf('rss:c'), 'c was linked to its own story first');
  const log = loggedStory(s1.sid);
  assert.equal(log.title, 'A story');
  assert.deepEqual(log.urls.sort(), ['https://a.com/1', 'https://b.com/1'], 'links never move; c stays with its first story');
  assert.ok(loggedStory(sidOf('rss:c')), 'which can still be opened, and resolves to the merged story while it is live');
  assert.equal(q('SELECT COUNT(*) AS n FROM story_ids').get().n, 3);
});

test('timeline: first report per outlet, X posts kept out; growth counts outlets', () => {
  const e = (name, at, platform = 'web') => ({ name, at, platform });
  const entries = [e('B', t0 + 2 * H), e('A', t0), e('A', t0 + H), e('@lab', t0 + 30e3, 'x'), e('C', t0 + 3 * H)];
  assert.deepEqual(timelineOf(entries).map((x) => x.name), ['A', 'B', 'C']);
  assert.deepEqual(growthOf(entries).map(([, n]) => n), [1, 2, 3, 4]);
});

test('market move: the price when the story broke against now', () => {
  const hist = [{ label: 'Yes', yes: 0.62, points: [[t0 - 2 * H, 0.4], [t0 - H, 0.41], [t0 + H, 0.55]] }];
  assert.deepEqual(marketMove(hist, t0), { label: 'Yes', from: 0.41, to: 0.62, change: 0.21 });
  assert.equal(marketMove([{ label: 'Yes', yes: 0.5, points: [[t0 + 2 * DAYS, 0.5]] }], t0), null, 'no price from before the story');
});
const DAYS = 86400e3;

test('extractive brief: central, agreed-on sentences, credited, not repeated', () => {
  const docs = [
    { source: 'Wire', url: 'u1', text: 'Homeland Security banned DeepSeek software from federal civilian agency systems on Monday. The decision follows a long review. Subscribe to our newsletter for more stories like this one every day.' },
    { source: 'Daily', url: 'u2', text: 'The US Homeland Security department has banned DeepSeek from federal civilian agency systems. Officials said the models could contain malware or other security vulnerabilities in agency networks.' },
    { source: 'Blog', url: 'u3', text: 'Federal civilian agencies must remove DeepSeek software within thirty days, according to the Homeland Security order. Weather in Paris was mild this week and the trains ran on time all day.' },
  ];
  const b = extractiveBrief(docs, { max: 3 });
  assert.equal(b.length, 3);
  assert.ok(b.every((x) => /DeepSeek|malware/.test(x.text)), JSON.stringify(b));
  assert.ok(!b.some((x) => /Subscribe|Weather/.test(x.text)));
  assert.equal(b.filter((x) => /banned DeepSeek/.test(x.text)).length, 1, 'two near-identical lead sentences: one kept');
  assert.ok(b.every((x) => x.source && x.url));
  assert.deepEqual(sentences('Too short. Visit https://x.com/a for this long sentence that has a link in it now.'), []);
});
