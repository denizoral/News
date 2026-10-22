// Replays the stored feed through breaking-news detection, so the archive
// has the last two days on a fresh install. Safe to re-run: events are keyed
// by story, and replayed ones are marked as pushed so nobody is alerted.
//
//   node scripts/breaking-backfill.js [hours=48]

import { openDb, q } from '../src/db.js';
import { Store } from '../src/store.js';
import { BreakingTracker } from '../src/pipeline/breaking.js';

openDb();
const store = new Store();
store.load(); // rebuild() clusters the feed and gives every live story its id
const hours = Number(process.argv[2]) || 48;
const stories = [...store.live.values()].filter((s) => s._group && !s.topic); // news, not tech
const end = Date.now();
const tracker = new BreakingTracker();
let n = 0;
for (let t = end - hours * 3600e3; t <= end; t += 5 * 60e3) {
  const at = stories.map((s) => ({ ...s, _group: s._group.filter((it) => it.publishedAt && it.publishedAt <= t) })).filter((s) => s._group.length);
  for (const e of tracker.update(at, t)) {
    tracker.markPushed(e.sid);
    n++;
    console.log(new Date(t).toISOString().slice(5, 16), e.peak, e.title.slice(0, 90));
  }
}
q('UPDATE breaking SET pushed = 1').run();
console.log(`${n} breaks in ${hours}h`);
process.exit(0);
