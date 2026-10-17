import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { RETENTION_HOURS } from './config.js';
import { clusterItems, scoreStory, matchMarkets } from './pipeline/cluster.js';

const STATE_FILE = path.resolve(process.env.DATA_DIR || 'data', 'state.json');

export class Store extends EventEmitter {
  constructor() {
    super();
    this.items = new Map(); // id -> item
    this.markets = [];
    this.sourceStatus = {}; // name -> { ok, count, error, lastRun, ms }
    this.bootstrapped = new Set(); // sources that completed at least one run
    this.snapshot = { stories: [], builds: [], markets: [], social: [], models: [], generatedAt: 0 };
    this.version = 0;
    this._timer = null;
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      for (const it of raw.items || []) this.items.set(it.id, it);
      this.markets = raw.markets || [];
      this.bootstrapped = new Set(raw.bootstrapped || []);
      this.prune();
      this.rebuild();
      console.log(`[store] restored ${this.items.size} items from disk`);
    } catch {
      /* first run */
    }
  }

  save() {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ items: [...this.items.values()], markets: this.markets, bootstrapped: [...this.bootstrapped] }));
    fs.renameSync(tmp, STATE_FILE);
  }

  ingest(sourceName, items) {
    const now = Date.now();
    const firstRun = !this.bootstrapped.has(sourceName);
    let added = 0;
    for (const it of items) {
      if (!it?.id || !it.title) continue;
      const prev = this.items.get(it.id);
      if (prev) {
        // Keep the first-seen time; refresh engagement and text.
        this.items.set(it.id, { ...prev, ...it, firstSeen: prev.firstSeen, lastSeen: now, publishedAt: prev.publishedAt || it.publishedAt });
        continue;
      }
      let publishedAt = it.publishedAt;
      if (!publishedAt || it.undated) {
        // Undated pages: on the very first crawl we can't tell new from old, so
        // they sink; afterwards, first sight is a good proxy for publish time.
        publishedAt = publishedAt || (firstRun ? now - 30 * 3600e3 : now);
      }
      if (publishedAt > now + 5 * 60e3) publishedAt = now;
      this.items.set(it.id, { ...it, publishedAt, firstSeen: now, lastSeen: now });
      added++;
    }
    this.bootstrapped.add(sourceName);
    return added;
  }

  setMarkets(markets) {
    this.markets = markets;
  }

  prune() {
    const now = Date.now();
    const cutoff = now - RETENTION_HOURS * 3600e3;
    for (const [id, it] of this.items) {
      // Trending lists (models, demos, repos) stay while their source still lists them.
      const stillListed = (it.lastSeen || it.firstSeen || 0) > now - 3 * 3600e3;
      if (it.section === 'models') {
        if (!stillListed) this.items.delete(id);
      } else if (it.section === 'builds') {
        if (it.publishedAt < now - 10 * 86400e3 && !stillListed) this.items.delete(id);
      } else if (it.publishedAt < cutoff) {
        this.items.delete(id);
      }
    }
  }

  scheduleRebuild() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.rebuild(), 400);
  }

  rebuild() {
    const now = Date.now();
    const all = [...this.items.values()];
    const newsItems = all.filter((i) => (i.section || 'news') === 'news');

    const stories = clusterItems(newsItems);
    matchMarkets(stories, this.markets);
    for (const s of stories) s.score = scoreStory(s, now);
    stories.sort((a, b) => b.score - a.score);
    const topStories = stories.slice(0, 400).map(({ _group, weakEntities, ...s }) => s);

    // Markets: attach the stories that point at each one.
    const marketStories = new Map();
    for (const s of topStories) for (const m of s.markets || []) {
      if (!marketStories.has(m.id)) marketStories.set(m.id, []);
      marketStories.get(m.id).push({ id: s.id, title: s.title });
    }
    const markets = this.markets
      .map(({ text, ...m }) => ({ ...m, stories: (marketStories.get(m.id) || []).slice(0, 3) }))
      .sort((a, b) => b.volume24h - a.volume24h);

    const builds = dedupeBuilds(all.filter((i) => i.section === 'builds'), now);
    const models = all
      .filter((i) => i.section === 'models')
      .sort((a, b) => (b.engagement?.trending || 0) - (a.engagement?.trending || 0))
      .slice(0, 20);
    const social = all
      .filter((i) => i.platform === 'x' || i.platform === 'bluesky')
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .slice(0, 80);

    this.version++;
    this.snapshot = { version: this.version, generatedAt: now, stories: topStories, builds, markets, social, models, status: this.status() };
    this.emit('update', this.snapshot);
  }

  status() {
    return { sources: this.sourceStatus, items: this.items.size, markets: this.markets.length };
  }
}

function dedupeBuilds(items, now) {
  const seen = new Map();
  for (const it of items) {
    const key = (it.linkUrl || it.url).replace(/[?#].*$/, '').replace(/\/$/, '').toLowerCase();
    const prev = seen.get(key);
    if (!prev || (it.engagement?.score || 0) > (prev.engagement?.score || 0)) seen.set(key, it);
  }
  return [...seen.values()]
    .map((it) => {
      const ageH = Math.max(1, (now - it.publishedAt) / 3600e3);
      const e = it.engagement || {};
      const signal = it.platform === 'huggingface' ? (e.trending || 0) * 4 : it.platform === 'github' ? (e.starsToday || e.score || 0) : (e.score || 0) + (e.comments || 0);
      return { ...it, score: +(Math.log1p(signal) + 1.5) / Math.pow(ageH + 2, 0.35) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 240);
}
