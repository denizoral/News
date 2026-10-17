// One full crawl, no server. With --static it writes public/data/snapshot.json so
// the site can be hosted as plain files (GitHub Pages, Netlify, S3) and refreshed
// by a scheduled job.

import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';
import { crawlAll } from '../src/crawler.js';

const store = new Store();
store.load();
await crawlAll(store);
store.save();

const snap = store.snapshot;
console.log(`\n${snap.stories.length} stories · ${snap.builds.length} builds · ${snap.markets.length} markets · ${snap.social.length} social posts`);
console.log(`stories with markets: ${snap.stories.filter((s) => s.markets?.length).length}`);

if (process.argv.includes('--static')) {
  const out = path.resolve('public/data/snapshot.json');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(snap));
  console.log(`wrote ${out}`);
}
process.exit(0);
