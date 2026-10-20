// The spider: a polite, focused web crawler.
//
//  frontier (SQLite) ──► scheduler ──► fetch ──► extract ──► index (FTS5)
//        ▲                  │  robots.txt, per-host gap, Retry-After,  │
//        └── links ◄────────┘  circuit breaker, daily host budget      └─► images ──► media store
//
// Five kinds of URL live in the frontier:
//   hub      starting pages, rechecked on a timer to discover articles
//   sitemap  XML sitemaps (from robots.txt), rechecked on a timer
//   feed     RSS/Atom feeds advertised by pages, rechecked on a timer
//   article  pages that may be indexed; fetched once (or rechecked if fresh)
//   page     listing pages worth one visit for their links
// Recurring kinds back off when they keep yielding nothing new. Everything is
// persisted, so a restart picks up exactly where it left off.
//
// Policy (what to queue, what to index) lives in policy.js; this file is the
// machinery that schedules, fetches and records.

import { EventEmitter } from 'node:events';
import { get } from '../http.js';
import { BlockedUrlError } from '../security/ssrf.js';
import { q, tx } from '../db.js';
import { settings } from '../settings.js';
import { canonicalUrl, hostOf } from '../pipeline/text.js';
import { isAiRelated } from '../pipeline/classify.js';
import { parseRobots, isAllowed, crawlDelay } from './robots.js';
import { extractPage, looksLikeArticleUrl } from './extract.js';
import { parseSitemap } from './sitemaps.js';
import { parseFeed } from '../sources/rss.js';
import { readText } from './body.js';
import { downloadImage, enforceBudget } from './media.js';
import { upsertDoc, findByContentHash, addInlinks } from '../index/documents.js';
import { bare, cleanUrl, isSkipped, allowedByPatterns, isAiHost, isRelevantText, decide, inQuietHours, isUsefulFeed, isNonNewsHost, pickSitemaps, isWantedSitemap, slugRelevance, isListingUrl, sectionOf, localeOf, isNonNewsPath } from './policy.js';

export { inQuietHours };

const LOG_RING = 500;
const RECURRING = new Set(['hub', 'sitemap', 'feed']);

// Where sites usually keep sitemaps and feeds they don't advertise. Guessed
// addresses are tried once and dropped if nothing is there.
const GUESS = 'guess';
const REFUSAL_LIMIT = 10;
const SITEMAP_GUESSES = ['/sitemap.xml', '/sitemap_index.xml', '/news-sitemap.xml'];
const FEED_GUESSES = ['/feed', '/feed.xml', '/rss.xml', '/atom.xml', '/index.xml'];
const MAX_BACKOFF = 8; // recurring URLs are checked at most 8x less often
const AUTO_HUB_EVERY_MS = 30 * 60e3;
const today = () => new Date().toISOString().slice(0, 10);

export class Spider extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.overrides = opts; // tests pass fixed values here
    this.inflight = new Set(); // hosts with a request in progress
    this.active = 0;
    this.imgActive = 0;
    this.hostCache = new Map();
    this.running = false;
    this.stats = { fetched: 0, indexed: 0, duplicates: 0, blocked: 0, errors: 0, deferred: 0, images: 0, feeds: 0, startedAt: Date.now(), recent: [] };
    this.inflightUrls = new Map(); // url -> { host, kind, started }
    this.misses = new Map(); // "lang:host", "empty:host/section" -> unindexed pages in a row
    this.ring = []; // newest crawl-log entries, for the live view
    this.minutes = new Map(); // minute -> fetches, last hour
    this.backoff = new Map(); // recurring url -> interval multiplier
    this.idleReason = null;
    this.autoHubsAt = 0;
  }

  // ---------- configuration ----------

  // Live configuration from the admin dashboard, rebuilt when settings change.
  get cfg() {
    if (this._cfgVersion !== settings.version) {
      this._cfg = { ...settings.spider(), ...this.overrides };
      if (!(this._cfg.hostRules instanceof Map)) this._cfg.hostRules = new Map();
      this._cfgVersion = settings.version;
      this._trusted = null;
    }
    return this._cfg;
  }

  // Hosts whose links are followed freely: configured starting sites plus discovered ones.
  get trusted() {
    const cfg = this.cfg;
    if (!this._trusted) this._trusted = new Set([...cfg.hubs, ...this.autoHubs().map((a) => a.url)].map((u) => bare(new URL(u).hostname)));
    return this._trusted;
  }

  get botName() {
    return this.cfg.botName || 'FrontierWireBot';
  }

  userAgent() {
    return `Mozilla/5.0 (compatible; ${this.botName}/0.3; +${this.cfg.contactUrl || 'https://github.com/denizoral/News'})`;
  }

  rule(host) {
    return this.cfg.hostRules.get(bare(host)) || null;
  }

  // Thin wrappers over policy.js with this crawler's settings.
  cleanUrl(u) { return cleanUrl(u, this.cfg.stripQueryParams || []); }
  isSkipped(u) { return isSkipped(u, this.cfg.skipHosts); }
  urlAllowedByPatterns(u) { return allowedByPatterns(u, this.cfg); }
  isAiHost(h) { return isAiHost(h); }
  isRelevantText(t) { return isRelevantText(t, this.cfg.includeKeywords); }
  decide(page) { return decide(page, this.cfg, { findDuplicate: findByContentHash, undatedInSection, trusted: this.trusted }); }

  // ---------- frontier ----------

  // Returns true only when the URL is new to the frontier.
  enqueue(url, { kind = 'article', priority = 5, depth = 0, via = null, nextAt = Date.now() } = {}) {
    let u;
    try {
      u = this.cleanUrl(canonicalUrl(url));
      if (!/^https?:\/\//.test(u) || this.isSkipped(u) || this.isDeadEnd(u)) return false;
    } catch {
      return false;
    }
    // Recurring sources are configured or discovered explicitly; patterns filter what they lead to.
    if (!RECURRING.has(kind)) {
      if (!this.urlAllowedByPatterns(u)) return false;
      // Pages that would only be skipped after fetching: docs, help and forum
      // sections, job boards, stock photos, login-walled social sites.
      const host = bare(new URL(u).hostname);
      if (isNonNewsPath(u) || (isNonNewsHost(host) && !this.trusted.has(host))) return false;
    }
    if (priority < 4 && this.queuedCount() > this.cfg.maxQueue) return false;
    const inserted = q(`INSERT INTO frontier (url, host, kind, priority, depth, status, next_at, discovered_at, via) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)
       ON CONFLICT(url) DO NOTHING`).run(u, new URL(u).hostname, kind, priority, depth, nextAt, Date.now(), via).changes > 0;
    // Rediscovery nudges priority up: things many pages link to get crawled sooner.
    if (!inserted) q("UPDATE frontier SET priority = MAX(priority, ?) + 0.2, depth = MIN(depth, ?) WHERE url = ? AND status = 'queued'").run(priority, depth, u);
    return inserted;
  }

  queuedCount() {
    const now = Date.now();
    if (!this._qc || now - this._qc.at > 10e3) this._qc = { at: now, n: q("SELECT COUNT(*) AS n FROM frontier WHERE status = 'queued'").get().n };
    return this._qc.n;
  }

  seed() {
    const hubs = [...this.cfg.hubs, ...this.autoHubs().map((a) => a.url)];
    tx(() => {
      // Feeds queued under older rules that the current rules wouldn't follow.
      for (const r of q("SELECT url FROM frontier WHERE kind = 'feed' AND status = 'queued'").all()) {
        if (!isUsefulFeed(r.url)) q("UPDATE frontier SET status = 'skipped', error = 'Not a site-wide or AI feed' WHERE url = ?").run(r.url);
      }
      for (const r of q("SELECT url FROM frontier WHERE kind = 'sitemap' AND status = 'queued'").all()) {
        if (!isWantedSitemap(r.url, { languages: this.cfg.languages })) q("UPDATE frontier SET status = 'skipped', error = 'Archive or other-language sitemap' WHERE url = ?").run(r.url);
      }
      // Queued pages today's rules would not queue: docs/help/forum pages,
      // job boards and stock photos, learned dead ends, sitemap listings, and
      // links whose URL slug says they're off-topic.
      const sitemaps = new Set(q("SELECT url FROM frontier WHERE kind = 'sitemap'").all().map((r) => r.url));
      const feeds = new Set(q("SELECT url FROM frontier WHERE kind = 'feed'").all().map((r) => r.url));
      const skip = q("UPDATE frontier SET status = 'skipped', error = ? WHERE url = ?");
      for (const r of q("SELECT url, host, via, fetched_at FROM frontier WHERE kind IN ('article', 'page') AND status = 'queued'").all()) {
        const host = bare(r.host);
        let why = null;
        try {
          if (isNonNewsPath(r.url) || (isNonNewsHost(host) && !this.trusted.has(host))) why = 'Not a news page';
          else if (this.isDeadEnd(r.url)) why = 'Learned dead end';
          // The URL-slug rules only for pages never fetched (not retries or recrawls).
          else if (r.fetched_at) why = null;
          else if ((r.via === 'sitemap' || sitemaps.has(r.via)) && isListingUrl(r.url)) why = 'Off-topic by its URL';
          // Feed entries were already judged by their titles.
          else if (!feeds.has(r.via) && this.cfg.relevance !== 'all' && !isAiHost(host) && slugRelevance(r.url) === false) why = 'Off-topic by its URL';
        } catch {
          why = 'Unparseable URL';
        }
        if (why) skip.run(why, r.url);
      }
      // Starting pages removed in the dashboard stop being rechecked.
      const current = new Set(hubs.map((u) => canonicalUrl(u)));
      for (const r of q("SELECT url FROM frontier WHERE kind = 'hub'").all()) {
        if (!current.has(r.url)) q("UPDATE frontier SET kind = 'page', status = 'done' WHERE url = ?").run(r.url);
      }
      for (const u of hubs) {
        const url = canonicalUrl(u);
        q(`INSERT INTO frontier (url, host, kind, priority, depth, status, next_at, discovered_at, via) VALUES (?, ?, 'hub', 10, 0, 'queued', ?, ?, 'seed')
           ON CONFLICT(url) DO UPDATE SET kind = 'hub', status = 'queued', depth = 0`).run(url, new URL(url).hostname, Date.now(), Date.now());
      }
    });
    this._trusted = null;
  }

  // URLs found by the aggregator (news feeds, HN, Reddit links…) get fetched in full.
  enqueueFromItems(items) {
    tx(() => {
      for (const it of items) {
        for (const u of [it.url, it.linkUrl]) {
          if (!u) continue;
          const boost = Math.min(3, Math.log10(1 + (it.engagement?.score || 0)));
          this.enqueue(u, { kind: 'article', priority: 7 + boost, depth: 1, via: it.source || 'aggregator' });
        }
      }
    });
  }

  // ---------- discovered starting sites ----------

  // Sites that keep producing indexed articles become starting pages too.
  autoHubs() {
    try {
      return JSON.parse(q("SELECT v FROM kv WHERE k = 'spider.autoHubs'").get()?.v || '[]');
    } catch {
      return [];
    }
  }

  dismissedHubs() {
    try {
      return new Set(JSON.parse(q("SELECT v FROM kv WHERE k = 'spider.autoHubsDismissed'").get()?.v || '[]'));
    } catch {
      return new Set();
    }
  }

  // Dead ends, learned from fetched pages, so the rest isn't queued:
  //   example.com/cs  a section in a language the crawler doesn't index
  //   example.com/*   a whole site in one (the-decoder.de beside the-decoder.com)
  //   example.com/partners  a section whose pages all come back empty (JS apps)
  // Stored as key -> { reason, at, examples }; the dashboard can forget one.
  deadEnds() {
    if (!this._deadEnds) {
      let map = {};
      try {
        map = JSON.parse(q("SELECT v FROM kv WHERE k = 'spider.deadEnds'").get()?.v || '{}');
        // Earlier versions kept translations as a plain list.
        for (const k of JSON.parse(q("SELECT v FROM kv WHERE k = 'spider.translations'").get()?.v || '[]')) map[k] ??= { reason: 'language', at: Date.now() };
      } catch { /* start empty */ }
      this._deadEnds = new Map(Object.entries(map));
    }
    return this._deadEnds;
  }

  learnDeadEnd(key, reason) {
    const known = this.deadEnds();
    if (known.has(key)) return;
    known.set(key, { reason, at: Date.now() });
    this.saveKv('spider.deadEnds', Object.fromEntries([...known].slice(-5000)));
    // What's already queued there goes too.
    const [host, seg] = [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)];
    const where = seg === '*' ? '' : ' AND (url LIKE ? OR url LIKE ?)';
    const args = seg === '*' ? [] : [`https://${host}/${seg}/%`, `https://www.${host}/${seg}/%`];
    const n = q(`UPDATE frontier SET status = 'skipped', error = ? WHERE host IN (?, ?) AND status = 'queued' AND fetched_at IS NULL AND kind IN ('article', 'page')${where}`)
      .run(`Learned dead end: ${reason === 'language' ? 'another language' : 'pages come back empty'}`, host, `www.${host}`, ...args).changes;
    console.log(`[spider] learned dead end ${key} (${reason}); ${n} queued URLs dropped`);
  }

  forgetDeadEnd(key) {
    // Pages it dropped from the queue come back.
    const [host, seg] = [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)];
    if (this.deadEnds().has(key)) {
      q(`UPDATE frontier SET status = 'queued', error = NULL WHERE host IN (?, ?) AND status = 'skipped' AND error LIKE 'Learned dead end%'${seg === '*' ? '' : ' AND (url LIKE ? OR url LIKE ?)'}`)
        .run(host, `www.${host}`, ...(seg === '*' ? [] : [`https://${host}/${seg}/%`, `https://www.${host}/${seg}/%`]));
    }
    const known = this.deadEnds();
    if (!known.delete(key)) return false;
    this.saveKv('spider.deadEnds', Object.fromEntries(known));
    return true;
  }

  isDeadEnd(u) {
    const known = this.deadEnds();
    if (!known.size) return false;
    const url = new URL(u);
    const host = bare(url.hostname);
    const seg = deadEndSection(url);
    const hit = known.get(`${host}/*`) || (seg && (known.get(`${host}/${seg}`) || known.get(`${host}/${seg.split('/')[0]}`)));
    // Language dead ends only apply while languages are restricted.
    return !!hit && (hit.reason !== 'language' || this.cfg.languages.length > 0);
  }

  // Called with every page that wasn't indexed, and with every one that was
  // (`ok`), which resets the counts for its site.
  learnFromPage(page, d) {
    if (!page.url) return;
    const host = bare(new URL(page.url).hostname);
    const seg = deadEndSection(new URL(page.url));
    if (d.ok) {
      this.misses.delete(`lang:${host}`);
      this.misses.delete(`empty:${host}`);
      this.misses.delete(`empty:${host}/${seg}`);
      return;
    }
    const bump = (k) => { const n = (this.misses.get(k) || 0) + 1; this.misses.set(k, n); return n; };
    const hub = this.cfg.hubHosts.includes(host);
    const langs = this.cfg.languages;
    if (langs.length && page.lang && !langs.includes(page.lang)) {
      const code = localeOf(page.url);
      if (code === page.lang) this.learnDeadEnd(`${host}/${code}`, 'language');
      else if (!code && bump(`lang:${host}`) >= 5 && !hub) this.learnDeadEnd(`${host}/*`, 'language');
    } else if (/^Too short \(0 words/.test(d.reason || '')) {
      if (seg && bump(`empty:${host}/${seg}`) >= 10) this.learnDeadEnd(`${host}/${seg}`, 'empty');
      else if (bump(`empty:${host}`) >= 25 && !hub) this.learnDeadEnd(`${host}/*`, 'empty');
    }
  }

  saveKv(k, v) {
    q('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v));
  }

  discoverHubs(now = Date.now()) {
    const limit = this.cfg.autoHubs;
    const current = this.autoHubs();
    if (!limit) {
      if (current.length) {
        this.saveKv('spider.autoHubs', []);
        this.seed();
      }
      return [];
    }
    const configured = new Set(this.cfg.hubs.map((u) => bare(new URL(u).hostname)));
    const dismissed = this.dismissedHubs();
    const eligible = (host) => {
      const home = `https://${host}/`;
      return host && !isNonNewsHost(host) && !this.isDeadEnd(home) && !configured.has(host) && !dismissed.has(host) && !this.isSkipped(home) && this.urlAllowedByPatterns(home) && !this.rule(host)?.blocked;
    };
    // Rules may have changed since a site was added; drop the ones that no longer qualify.
    const kept = current.filter((a) => eligible(a.host)).slice(0, limit);
    const pruned = kept.length !== current.length;
    current.length = 0;
    current.push(...kept);
    const have = new Set(current.map((a) => a.host));
    // At least 5 crawled, indexed articles in the last week.
    const candidates = q(`SELECT site, COUNT(*) AS n FROM docs WHERE fetched_at > ? AND type = 'article' AND hidden = 0 GROUP BY site HAVING n >= 5 ORDER BY n DESC LIMIT 200`).all(now - 7 * 86400e3);
    const added = [];
    for (const c of candidates) {
      if (current.length + added.length >= limit) break;
      const host = bare(c.site);
      if (have.has(host) || !eligible(host)) continue;
      added.push({ host, url: `https://${host}/`, articles: c.n, addedAt: now });
    }
    if (added.length || pruned) {
      this.saveKv('spider.autoHubs', [...current, ...added].slice(0, limit));
      this.seed();
    }
    return added;
  }

  dismissHub(host) {
    const h = bare(String(host).toLowerCase());
    const dismissed = this.dismissedHubs();
    dismissed.add(h);
    this.saveKv('spider.autoHubsDismissed', [...dismissed].slice(-5000));
    this.saveKv('spider.autoHubs', this.autoHubs().filter((a) => a.host !== h));
    this.seed();
  }

  // ---------- hosts ----------

  host(host) {
    let h = this.hostCache.get(host);
    if (!h) {
      const row = q('SELECT * FROM hosts WHERE host = ?').get(host);
      h = row
        ? { ...row, parsed: row.robots != null ? parseRobots(row.robots) : null }
        : { host, robots: null, robots_status: null, robots_fetched_at: 0, crawl_delay_ms: null, next_allowed_at: 0, fetched_today: 0, day: today(), pages: 0, errors: 0, parsed: null };
      h.failStreak = 0;
      h.pausedUntil = 0;
      this.hostCache.set(host, h);
    }
    if (h.day !== today()) {
      h.day = today();
      h.fetched_today = 0;
    }
    return h;
  }

  saveHost(h) {
    q(`INSERT INTO hosts (host, robots, robots_status, robots_fetched_at, crawl_delay_ms, next_allowed_at, fetched_today, day, pages, errors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(host) DO UPDATE SET robots = excluded.robots, robots_status = excluded.robots_status,
       robots_fetched_at = excluded.robots_fetched_at, crawl_delay_ms = excluded.crawl_delay_ms, next_allowed_at = excluded.next_allowed_at,
       fetched_today = excluded.fetched_today, day = excluded.day, pages = excluded.pages, errors = excluded.errors`).run(
      h.host, h.robots, h.robots_status, h.robots_fetched_at, h.crawl_delay_ms, h.next_allowed_at, h.fetched_today, h.day, h.pages, h.errors);
  }

  // Server-side trouble on a host (timeouts, 5xx, connection errors) opens a
  // circuit breaker: after N failures in a row the host rests, 15 min doubling to 6 h.
  hostFailed(h) {
    h.failStreak = (h.failStreak || 0) + 1;
    const limit = this.cfg.hostFailureLimit;
    if (h.failStreak >= limit) {
      const minutes = Math.min(360, 15 * 2 ** (h.failStreak - limit));
      h.pausedUntil = Date.now() + minutes * 60e3;
      h.next_allowed_at = Math.max(h.next_allowed_at, h.pausedUntil);
      return minutes;
    }
    return 0;
  }

  // A site that refuses page after page (403s, or 404s for links that work in
  // a browser) is blocking the crawler: 10 in a row rest it for 6 hours,
  // doubling to 2 days. Returns the minutes, or 0.
  hostRefused(h) {
    h.refuseStreak = (h.refuseStreak || 0) + 1;
    if (h.refuseStreak < REFUSAL_LIMIT) return 0;
    const minutes = Math.min(2880, 360 * 2 ** (h.refuseStreak - REFUSAL_LIMIT));
    h.pausedUntil = Date.now() + minutes * 60e3;
    h.next_allowed_at = Math.max(h.next_allowed_at, h.pausedUntil);
    return minutes;
  }

  hostOk(h) {
    h.failStreak = 0;
    h.refuseStreak = 0;
    h.pausedUntil = 0;
  }

  async ensureRobots(h, scheme) {
    if (h.robots_fetched_at && Date.now() - h.robots_fetched_at < 24 * 3600e3) return;
    let text = '';
    let status = 0;
    try {
      const res = await get(`${scheme}//${h.host}/robots.txt`, { headers: { 'user-agent': this.userAgent() }, timeout: 10000, retries: 0, publicOnly: true, maxRedirects: this.cfg.maxRedirects, cooldown: false });
      status = res.status;
      text = (await readText(res, 512 * 1024)).text;
    } catch (err) {
      if (err instanceof BlockedUrlError) throw err;
      // 4xx means "no robots.txt": everything allowed. 429, 5xx and network
      // trouble mean "unavailable": assume disallowed for now (RFC 9309).
      status = err.status && err.status < 500 && err.status !== 429 ? err.status : 599;
    }
    h.robots_status = status;
    if (status >= 500) {
      h.robots = 'User-agent: *\nDisallow: /';
      h.robots_fetched_at = Date.now() - 23 * 3600e3; // try again in an hour
    } else {
      h.robots = status >= 400 ? '' : text;
      h.robots_fetched_at = Date.now();
    }
    h.parsed = parseRobots(h.robots);
    const d = crawlDelay(h.parsed, this.botName);
    h.crawl_delay_ms = d != null ? Math.min(d * 1000, 60000) : null;
    // Sitemaps of trusted hosts are the fastest way to learn about new articles.
    if (this.cfg.useSitemaps && this.trusted.has(bare(h.host))) {
      for (const sm of pickSitemaps(h.parsed.sitemaps, { languages: this.cfg.languages })) this.enqueue(sm, { kind: 'sitemap', priority: 9, depth: 0, via: 'robots.txt' });
      // Not every site lists its sitemap in robots.txt; try the usual places.
      if (!h.parsed.sitemaps.length) for (const p of SITEMAP_GUESSES) this.enqueue(`${scheme}//${h.host}${p}`, { kind: 'sitemap', priority: 8, depth: 0, via: GUESS });
    }
    this.saveHost(h);
  }

  // robots.txt is obeyed unless an owner switched it off globally or for this site.
  obeysRobots(host) {
    return this.cfg.obeyRobots && !this.rule(host)?.ignoreRobots;
  }

  robotsAllows(h, url) {
    return !this.obeysRobots(h.host) || isAllowed(h.parsed, url, this.botName);
  }

  // Extra paths blocked from the dashboard, using robots.txt pattern syntax.
  ruleDisallows(url) {
    const rule = this.rule(new URL(url).hostname);
    if (!rule?.disallow?.length) return false;
    if (rule._parsed?.src !== rule.disallow) rule._parsed = { src: rule.disallow, robots: parseRobots(`User-agent: *\n${rule.disallow.map((p) => `Disallow: ${p}`).join('\n')}`) };
    return !isAllowed(rule._parsed.robots, url, '*');
  }

  // ---------- scheduling ----------

  start() {
    if (this.running) return;
    this.running = true;
    q("UPDATE frontier SET status = 'queued' WHERE status = 'fetching'").run();
    this.seed();
    this.onSettings = (changes) => {
      if (changes.some((c) => c.key === 'crawler.hubs' || c.key === 'crawler.autoHubs')) this.seed();
      this.cands = null;
    };
    settings.on('change', this.onSettings);
    this.timer = setInterval(() => this.tick(), 500);
    this.imgTimer = setInterval(() => this.imageTick(), 1000);
    this.timer.unref?.();
    this.imgTimer.unref?.();
  }

  stop() {
    this.running = false;
    if (this.onSettings) settings.off('change', this.onSettings);
    clearInterval(this.timer);
    clearInterval(this.imgTimer);
  }

  tick() {
    if (!this.running) return;
    const now = Date.now();
    this.idleReason = !this.cfg.enabled ? 'paused' : inQuietHours(this.cfg.quietHours, now) ? 'quiet hours' : null;
    if (this.idleReason) return;
    if (now - this.autoHubsAt > AUTO_HUB_EVERY_MS) {
      this.autoHubsAt = now;
      try { this.discoverHubs(now); } catch (e) { console.warn('[spider] hub discovery failed', e.message); }
      try { this.expireQueue(now); } catch (e) { console.warn('[spider] queue expiry failed', e.message); }
      try { this.retireBarrenSources(now); } catch (e) { console.warn('[spider] source review failed', e.message); }
    }
    const cap = this.cfg.maxPagesPerMinute;
    if (cap && this.stats.recent.filter((t) => t > now - 60e3).length >= cap) {
      this.idleReason = 'pages-per-minute cap';
      return;
    }
    if (this.active >= this.cfg.concurrency) return;
    // Candidates are the best two ready URLs per host, so one big sitemap
    // can't starve every other site. Refreshed every few seconds.
    if (!this.cands?.length || now - this.candsAt > 3000) {
      this.cands = q(`SELECT url, host, kind, priority, depth, attempts, etag, last_modified, via FROM (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY host ORDER BY priority DESC) AS rn
          FROM frontier WHERE status = 'queued' AND next_at <= ?
        ) WHERE rn <= 2 ORDER BY priority DESC LIMIT 400`).all(now);
      this.candsAt = now;
    }
    for (const row of [...this.cands]) {
      if (this.active >= this.cfg.concurrency) break;
      if (this.inflight.has(row.host)) continue;
      const h = this.host(row.host);
      if (h.next_allowed_at > now) continue;
      const drop = (status, error) => {
        this.cands.splice(this.cands.indexOf(row), 1);
        q('UPDATE frontier SET status = ?, error = ? WHERE url = ?').run(status, error, row.url);
      };
      // Patterns are checked again here so a new exclude pattern also clears what's already queued.
      if (!RECURRING.has(row.kind) && !this.urlAllowedByPatterns(row.url)) { drop('skipped', 'Excluded by a URL pattern'); continue; }
      const rule = this.rule(row.host);
      if (rule?.blocked) { drop('blocked', 'Blocked by a site rule'); continue; }
      if (h.fetched_today >= (rule?.dailyBudget ?? this.cfg.hostDailyBudget) && row.kind !== 'hub') {
        q('UPDATE frontier SET next_at = ? WHERE url = ?').run(now + 3600e3, row.url);
        continue;
      }
      this.cands.splice(this.cands.indexOf(row), 1);
      this.inflight.add(row.host);
      this.inflightUrls.set(row.url, { host: row.host, kind: row.kind, started: now });
      this.active++;
      q("UPDATE frontier SET status = 'fetching' WHERE url = ?").run(row.url);
      row._started = now;
      this.process(row, h)
        .catch((err) => this.fail(row, h, err))
        .finally(() => {
          this.inflight.delete(row.host);
          this.inflightUrls.delete(row.url);
          this.active--;
        });
    }
  }

  // Keeps the queue bounded: articles nobody got to in time are stale news,
  // and one huge sitemap shouldn't hold a site's queue forever. Recrawls and
  // retries (fetched before) are left alone. Returns how many were dropped.
  expireQueue(now = Date.now()) {
    let n = 0;
    const kinds = "kind IN ('article', 'page') AND status = 'queued' AND fetched_at IS NULL";
    if (this.cfg.queueMaxAgeHours) {
      n += q(`UPDATE frontier SET status = 'skipped', error = 'Expired: not fetched in time' WHERE ${kinds} AND discovered_at < ?`).run(now - this.cfg.queueMaxAgeHours * 3600e3).changes;
    }
    const cap = this.cfg.hostQueueCap;
    for (const r of q(`SELECT host FROM frontier WHERE ${kinds} GROUP BY host HAVING COUNT(*) > ?`).all(cap)) {
      n += q(`UPDATE frontier SET status = 'skipped', error = 'Over the per-site queue limit' WHERE url IN (
          SELECT url FROM frontier WHERE host = ? AND ${kinds} ORDER BY priority DESC, discovered_at DESC LIMIT -1 OFFSET ?)`).run(r.host, cap).changes;
    }
    if (n) console.log(`[spider] dropped ${n} stale or excess URLs from the queue`);
    return n;
  }

  // Feeds and sitemaps whose pages never get indexed (a partner directory, a
  // site that blocks every article) are retired with what they queued: 25 or
  // more of their pages fetched in a week and not one indexed. Starting pages
  // are left alone. Returns the retired sources.
  retireBarrenSources(now = Date.now()) {
    const barren = q(`SELECT c.via AS url, COUNT(*) AS n FROM crawl_log c JOIN frontier f ON f.url = c.via
        WHERE c.at > ? AND c.kind = 'article' AND f.kind IN ('feed', 'sitemap') AND f.status = 'queued'
        AND c.outcome IN ('indexed', 'updated', 'duplicate', 'not-modified', 'skipped', 'error')
      GROUP BY c.via HAVING n >= 25 AND SUM(c.outcome IN ('indexed', 'updated', 'duplicate', 'not-modified')) = 0`).all(now - 7 * 86400e3);
    for (const b of barren) {
      tx(() => {
        q("UPDATE frontier SET status = 'skipped', error = ? WHERE url = ?").run(`None of the ${b.n} pages it led to in the last week were indexed`, b.url);
        q("UPDATE frontier SET status = 'skipped', error = 'Its feed or sitemap was retired' WHERE via = ? AND status = 'queued' AND fetched_at IS NULL").run(b.url);
      });
      console.log(`[spider] retired ${b.url}: none of ${b.n} pages indexed`);
    }
    return barren.map((b) => b.url);
  }

  // How long until a recurring URL is checked again, after a run that found `fresh` new URLs.
  recurringDelay(row, fresh) {
    const base = { hub: this.cfg.hubRecrawlMin, sitemap: this.cfg.sitemapRecrawlMin, feed: this.cfg.feedRecrawlMin }[row.kind] * 60e3;
    if (!this.cfg.adaptiveRecrawl) return base;
    const prev = this.backoff.get(row.url) || 1;
    const next = fresh > 0 ? 1 : Math.min(MAX_BACKOFF, prev * 2);
    this.backoff.set(row.url, next);
    return base * next;
  }

  fail(row, h, err) {
    const now = Date.now();
    if (err instanceof BlockedUrlError) {
      this.stats.blocked++;
      q("UPDATE frontier SET status = 'blocked', error = ?, fetched_at = ? WHERE url = ?").run(err.message.slice(0, 300), now, row.url);
      this.log(row, { outcome: 'blocked', reason: err.message });
      return;
    }
    // Rate limited: honor Retry-After for the whole host and try again; not an error.
    if (err.status === 429 || (err.status === 503 && err.retryAfterSec != null)) {
      const wait = Math.min(6 * 3600, Math.max(60, err.retryAfterSec ?? 300)) * 1000;
      h.next_allowed_at = Math.max(h.next_allowed_at, now + wait);
      this.saveHost(h);
      this.stats.deferred++;
      q("UPDATE frontier SET status = 'queued', next_at = ?, error = ? WHERE url = ?").run(now + wait, `Rate limited (HTTP ${err.status})`, row.url);
      this.log(row, { outcome: 'deferred', http: err.status, reason: `Rate limited; this site rests for ${Math.round(wait / 60e3)} min` });
      return;
    }
    const permanent = err.permanent || (err.status >= 400 && err.status < 500);
    // A guessed feed or sitemap address that doesn't exist is simply dropped.
    if (row.via === GUESS && permanent) {
      q("UPDATE frontier SET status = 'skipped', http_status = ?, error = ?, fetched_at = ? WHERE url = ?").run(err.status ?? null, 'Nothing at this address', now, row.url);
      this.log(row, { outcome: 'skipped', http: err.status, reason: `No ${row.kind} at this guessed address${err.permanent ? ` (${err.message})` : ''}` });
      return;
    }
    this.stats.errors++;
    h.errors++;
    const attempts = row.attempts + 1;
    const serverSide = !permanent; // timeouts, connection errors, 5xx
    const refused = [401, 403, 404, 410].includes(err.status);
    const paused = serverSide ? this.hostFailed(h) : refused ? this.hostRefused(h) : 0;
    const retry = !permanent && attempts < this.cfg.maxAttempts;
    // Feeds and sitemaps that fail permanently (4xx) three times in a row are
    // retired; starting pages keep trying, since an admin chose them.
    const recurring = RECURRING.has(row.kind) && !(permanent && row.kind !== 'hub' && attempts >= 3);
    const reason = `${err.message}${retry && !recurring ? ` (attempt ${attempts} of ${this.cfg.maxAttempts}, will retry)` : ''}${paused ? `; ${serverSide ? `${h.failStreak} failures` : `${h.refuseStreak} refusals`} in a row, so this site rests for ${paused >= 120 ? `${Math.round(paused / 60)} h` : `${paused} min`}` : ''}`;
    this.log(row, { outcome: 'error', http: err.status || null, reason });
    // Recurring URLs keep their schedule (with backoff); articles retry 5, 25, 125 min apart.
    const nextAt = recurring ? now + this.recurringDelay(row, 0) : now + 60e3 * 5 ** Math.min(attempts, 4);
    q('UPDATE frontier SET status = ?, attempts = ?, next_at = ?, error = ?, fetched_at = ? WHERE url = ?').run(
      recurring || retry ? 'queued' : 'error', attempts, Math.max(nextAt, h.pausedUntil || 0), err.message.slice(0, 300), now, row.url);
    this.saveHost(h);
  }

  done(row, { status = 'done', httpStatus = 200, etag = null, lastModified = null, recrawlAt = null, fresh = 1, error = null } = {}) {
    const recurring = RECURRING.has(row.kind);
    const next = recurring ? Date.now() + this.recurringDelay(row, fresh) : recrawlAt || Date.now();
    const again = (recurring || recrawlAt) && status === 'done';
    q('UPDATE frontier SET status = ?, http_status = ?, etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified), fetched_at = ?, next_at = ?, attempts = 0, error = ? WHERE url = ?').run(
      again ? 'queued' : status, httpStatus, etag, lastModified, Date.now(), next, error, row.url);
  }

  // ---------- crawl log ----------

  log(row, { outcome, http = null, reason = null, bytes = null }) {
    const now = Date.now();
    const e = { at: now, url: row.url, host: row.host, kind: row.kind, http, outcome, reason: reason ? String(reason).slice(0, 300) : null, ms: row._started ? now - row._started : null, bytes, depth: row.depth, via: row.via || null };
    this.ring.unshift(e);
    if (this.ring.length > LOG_RING) this.ring.length = LOG_RING;
    try {
      q('INSERT INTO crawl_log (at, url, host, kind, http_status, outcome, reason, ms, bytes, depth, via) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(e.at, e.url, e.host, e.kind, e.http, e.outcome, e.reason, e.ms, e.bytes, e.depth, e.via);
    } catch { /* logging must never break crawling */ }
  }

  // ---------- fetch + process ----------

  requestHeaders(row) {
    const headers = {
      'user-agent': this.userAgent(),
      accept: row.kind === 'feed' ? 'application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.5' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5',
      'accept-language': this.cfg.acceptLanguage,
    };
    if (row.etag) headers['if-none-match'] = row.etag;
    if (row.last_modified) headers['if-modified-since'] = row.last_modified;
    return headers;
  }

  async process(row, h) {
    const rule = this.rule(h.host);
    await this.ensureRobots(h, new URL(row.url).protocol);
    const robotsOk = this.robotsAllows(h, row.url);
    if (!robotsOk || this.ruleDisallows(row.url)) {
      this.stats.blocked++;
      const reason = robotsOk ? 'Blocked path in a site rule' : 'Disallowed by robots.txt';
      this.log(row, { outcome: 'blocked', reason });
      return this.done(row, { status: 'blocked', httpStatus: 0, error: reason });
    }

    const robotsDelay = this.cfg.honorCrawlDelay && this.obeysRobots(h.host) ? h.crawl_delay_ms || 0 : 0;
    h.next_allowed_at = Date.now() + Math.max(this.cfg.hostDelayMs, robotsDelay, rule?.minDelayMs || 0);
    h.fetched_today++;

    let res;
    try {
      res = await get(row.url, { timeout: this.cfg.timeoutMs, retries: 0, headers: this.requestHeaders(row), publicOnly: true, maxRedirects: this.cfg.maxRedirects, cooldown: false });
    } catch (err) {
      if (err.status === 304) {
        this.hostOk(h);
        if (row.kind === 'hub') this.guessFeeds(row, { feeds: [] }, h);
        this.log(row, { outcome: 'not-modified', http: 304 });
        return this.done(row, { httpStatus: 304, fresh: 0 });
      }
      throw err;
    }
    const type = res.headers.get('content-type') || '';
    const { text: body, bytes, truncated } = await readText(res, this.cfg.maxPageBytes);
    this.hostOk(h);
    this.stats.fetched++;
    h.pages++;
    this.saveHost(h);
    this.countFetch();
    const http = res.status;
    const meta = { etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), httpStatus: http };
    const xmlKind = sniffXml(body, type);

    if (!body.trim()) {
      this.log(row, { outcome: 'skipped', http, bytes, reason: 'Empty response' });
      return this.done(row, { ...meta, status: RECURRING.has(row.kind) ? 'done' : 'skipped', fresh: 0 });
    }
    // A web page where a feed or sitemap should be: a permanent failure, so a
    // guess is dropped and a known feed retired after three in a row (one
    // maintenance page doesn't lose it).
    if ((row.kind === 'feed' || row.kind === 'sitemap') && !xmlKind) {
      throw Object.assign(new Error(`Not a ${row.kind}: the address returns ${type.split(';')[0] || 'an unknown type'}`), { permanent: true });
    }
    if (row.via === GUESS && xmlKind === 'feed') this.keepOneGuessedFeed(row);
    if (row.kind === 'feed' || xmlKind === 'feed') {
      const n = this.handleFeed(row, body);
      this.log(row, { outcome: 'feed', http, bytes, reason: `${n} new URLs` });
      return this.done(row, { ...meta, fresh: n });
    }
    if (row.kind === 'sitemap' || xmlKind === 'sitemap') {
      const n = this.handleSitemap(row, body);
      this.log(row, { outcome: 'sitemap', http, bytes, reason: `${n} new URLs` });
      return this.done(row, { ...meta, fresh: n });
    }
    if (!/html/.test(type) && !/^\s*<(!doctype html|html)/i.test(body.slice(0, 200))) {
      this.log(row, { outcome: 'skipped', http, bytes, reason: `Not HTML (${type.split(';')[0] || 'unknown type'})` });
      return this.done(row, { ...meta, status: 'skipped' });
    }
    if (/noindex/i.test(res.headers.get('x-robots-tag') || '')) {
      this.log(row, { outcome: 'skipped', http, bytes, reason: 'X-Robots-Tag: noindex' });
      return this.done(row, { ...meta, status: 'skipped' });
    }

    const page = extractPage(body, res.url || row.url, { respectNofollow: this.cfg.respectNofollow });
    const cut = truncated ? `cut at ${Math.round(bytes / 1024)} KB` : null;
    const linksAndFeeds = () => {
      const queued = this.followLinks(row, page);
      const feeds = this.discoverFeeds(row, page);
      return { queued, feeds, notes: [queued ? `${queued} new links` : null, feeds ? `${feeds} feeds found` : null, cut] };
    };
    if (row.kind === 'hub') {
      const { queued, feeds, notes } = linksAndFeeds();
      this.guessFeeds(row, page, h);
      this.log(row, { outcome: 'hub', http, bytes, reason: notes.filter(Boolean).join('; ') || 'nothing new' });
      return this.done(row, { ...meta, fresh: queued + feeds });
    }
    // Links are followed from starting pages and from pages worth indexing;
    // an off-topic page's links lead further off-topic.
    const r = this.indexPage(row, page);
    const { notes } = r.indexedOk || r.outcome === 'duplicate' || this.cfg.relevance === 'all' ? linksAndFeeds() : { notes: [cut] };
    this.log(row, { outcome: r.outcome, http, bytes, reason: [r.reason, ...notes].filter(Boolean).join('; ') || null });
    // Fresh articles are fetched again later to catch updates.
    const fresh = page.published_at && Date.now() - page.published_at < 3 * 86400e3;
    const recrawlAt = this.cfg.recrawlHours && r.indexedOk && fresh ? Date.now() + this.cfg.recrawlHours * 3600e3 : null;
    return this.done(row, { ...meta, recrawlAt });
  }

  handleSitemap(row, xml) {
    let parsed;
    try {
      parsed = parseSitemap(xml, { maxAgeDays: this.cfg.sitemapMaxAgeDays, maxUrls: this.cfg.sitemapMaxUrls });
    } catch {
      return 0;
    }
    let n = 0;
    tx(() => {
      for (const sm of parsed.sitemaps) {
        if (isWantedSitemap(sm.url, { languages: this.cfg.languages }) && this.enqueue(sm.url, { kind: 'sitemap', priority: 8.5, depth: 0, via: row.url })) n++;
      }
      const filtering = this.cfg.relevance !== 'all' && !isAiHost(row.host);
      for (const u of parsed.urls) {
        const ageH = u.lastmod ? (Date.now() - u.lastmod) / 3600e3 : 72;
        if (this.isDeadEnd(u.url) || isListingUrl(u.url)) continue;
        // Judge by the Google News title when there is one, else by a descriptive slug.
        if (filtering && (u.title ? !this.isRelevantText(u.title) : slugRelevance(u.url) === false)) continue;
        if (this.enqueue(u.url, { kind: 'article', priority: 6 + Math.max(0, 3 - ageH / 12), depth: 1, via: row.url })) n++;
      }
    });
    return n;
  }

  // RSS/Atom: newest entries first, filtered by title like sitemap entries.
  handleFeed(row, xml) {
    let entries;
    try {
      entries = parseFeed(xml);
    } catch {
      return 0;
    }
    const cutoff = Date.now() - this.cfg.sitemapMaxAgeDays * 86400e3;
    let n = 0;
    tx(() => {
      for (const e of entries.slice(0, this.cfg.sitemapMaxUrls)) {
        if (!e.url || (e.publishedAt && e.publishedAt < cutoff)) continue;
        if (this.cfg.relevance !== 'all' && !this.isRelevantText(`${e.title} ${e.summary}`) && !isAiHost(hostOf(e.url))) continue;
        const ageH = e.publishedAt ? (Date.now() - e.publishedAt) / 3600e3 : 48;
        if (this.enqueue(e.url, { kind: 'article', priority: 7 + Math.max(0, 3 - ageH / 12), depth: 1, via: row.url })) n++;
      }
    });
    this.stats.feeds++;
    return n;
  }

  // A starting site that advertises no feed often still has one at a usual
  // address. Tried once per site: the guesses stay in the frontier afterwards.
  guessFeeds(row, page, h) {
    if (!this.cfg.discoverFeeds || page.feeds?.length || !this.trusted.has(bare(h.host))) return;
    if (q("SELECT 1 FROM frontier WHERE host = ? AND kind = 'feed' LIMIT 1").get(row.host)) return;
    // At the site root, and under the starting page's folder (example.com/blog/feed).
    const u = new URL(row.url);
    const folder = u.pathname.replace(/\/[^/]*\.[a-z]+$/i, '/').replace(/\/$/, '');
    for (const base of new Set([u.origin, u.origin + folder])) {
      for (const p of FEED_GUESSES) this.enqueue(base + p, { kind: 'feed', priority: 8, depth: 0, via: GUESS });
    }
  }

  // One working guessed feed per site is enough: /feed, /feed.xml and
  // /rss.xml are usually the same feed. (Guessed sitemaps differ, so all stay.)
  keepOneGuessedFeed(row) {
    q("UPDATE frontier SET status = 'skipped', error = 'Another feed address for this site works' WHERE host = ? AND kind = 'feed' AND via = ? AND status = 'queued' AND url != ?")
      .run(row.host, GUESS, row.url);
  }

  // Feeds advertised by pages on trusted sites (or pages that are about AI) are followed, a few per site.
  discoverFeeds(row, page) {
    if (!this.cfg.discoverFeeds || !page.feeds?.length) return 0;
    const host = bare(hostOf(page.url));
    if (!this.trusted.has(host) && !isAiHost(host) && !this.isRelevantText(`${page.title} ${page.description}`)) return 0;
    const have = q("SELECT COUNT(*) AS n FROM frontier WHERE kind = 'feed' AND (host = ? OR host = ?)").get(host, `www.${host}`).n;
    let n = 0;
    for (const f of page.feeds.filter((x) => isUsefulFeed(x, page.url)).slice(0, Math.max(0, this.cfg.feedsPerSite - have))) {
      if (this.enqueue(f, { kind: 'feed', priority: 8.5, depth: 0, via: row.url })) n++;
    }
    return n;
  }

  followLinks(row, page) {
    const fromHost = bare(hostOf(page.url));
    const fromTrusted = this.trusted.has(fromHost);
    const external = [];
    let queued = 0;
    const enq = (u, o) => { if (this.enqueue(u, o)) queued++; };
    tx(() => {
      for (const link of page.links) {
        const toHost = bare(hostOf(link.url));
        const sameHost = toHost === fromHost;
        const aiAnchor = isAiRelated(`${link.text} ${link.url.replace(/[-_/]/g, ' ')}`);
        const article = looksLikeArticleUrl(link.url);
        const depth = row.depth + 1;
        if (!sameHost) external.push(link.url);
        if (depth > this.cfg.maxDepth) continue;
        // On general news sites, a descriptive slug that isn't about AI (and an
        // anchor that isn't either) means an off-topic story: not worth a fetch.
        const offTopic = !aiAnchor && this.cfg.relevance !== 'all' && !isAiHost(toHost) && slugRelevance(link.url) === false;
        if (sameHost && fromTrusted) {
          if (offTopic) continue;
          if (article) enq(link.url, { kind: 'article', priority: 6 + (aiAnchor ? 2 : 0) - row.depth * 0.5 + (isAiHost(toHost) ? 1 : 0), depth, via: row.url });
          else if (aiAnchor && depth <= 2) enq(link.url, { kind: 'page', priority: 3.5, depth, via: row.url });
        } else if (sameHost) {
          if (article && aiAnchor && depth <= 2) enq(link.url, { kind: 'article', priority: 4.5, depth, via: row.url });
        } else if (fromTrusted && article && aiAnchor && this.cfg.followExternal) {
          // One hop off the trusted set, and no further.
          enq(link.url, { kind: 'article', priority: 5 + (this.trusted.has(toHost) ? 1 : 0), depth: this.cfg.maxDepth, via: row.url });
        }
      }
      if (external.length) addInlinks(external.slice(0, 200));
    });
    return queued;
  }

  indexPage(row, page) {
    const d = this.decide(page);
    if (!d.ok) {
      if (d.outcome === 'duplicate') this.stats.duplicates++;
      this.learnFromPage(page, d);
      return d;
    }
    this.learnFromPage(page, d);
    const existed = !!q('SELECT 1 FROM docs WHERE url = ? AND fetched_at IS NOT NULL').get(page.url);
    const { id } = upsertDoc({
      url: page.url, type: 'article', title: page.title, description: page.description, body: page.text || '',
      site: page.site, source: page.siteName, author: page.author, lang: page.lang, image_url: page.images[0]?.url || null,
      published_at: page.published_at, fetched_at: Date.now(), content_hash: page.contentHash, noarchive: page.noarchive,
    });
    if (row.url !== page.url) {
      // The page declared another canonical URL; mark it so we don't fetch it again.
      q("INSERT INTO frontier (url, host, kind, priority, depth, status, next_at, discovered_at, via) VALUES (?, ?, 'article', 0, ?, 'done', ?, ?, 'canonical') ON CONFLICT(url) DO UPDATE SET status = 'done'")
        .run(page.url, new URL(page.url).hostname, row.depth, Date.now(), Date.now());
    }
    const ins = q(`INSERT INTO images (url, page_url, doc_id, alt, caption, page_title, site, published_at, discovered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET alt = CASE WHEN length(excluded.alt) > length(alt) THEN excluded.alt ELSE alt END`);
    tx(() => {
      const keep = page.images.filter((img, i) => i === 0 || (img.alt || img.caption).length >= 12).slice(0, this.cfg.imagesPerPage);
      for (const img of keep) ins.run(img.url, page.url, id, img.alt || '', img.caption || '', page.title, page.site, page.published_at || Date.now(), Date.now());
    });
    this.stats.indexed++;
    this.emit('indexed', { id, url: page.url, title: page.title });
    return { ok: true, indexedOk: true, outcome: existed ? 'updated' : 'indexed', reason: `${d.words} words` };
  }

  // ---------- "Test a URL": fetch and evaluate without saving anything ----------

  async inspect(url) {
    const report = { url, steps: [] };
    const step = (label, ok, detail) => report.steps.push({ label, ok, detail });
    let u;
    try {
      u = new URL(this.cleanUrl(canonicalUrl(url)));
    } catch {
      step('URL', false, "That isn't a valid http(s) URL.");
      return report;
    }
    report.url = u.toString();
    step('Never-crawl list', !this.isSkipped(report.url), this.isSkipped(report.url) ? 'This host is on the never-crawl list.' : 'Not listed.');
    const patternsOk = this.urlAllowedByPatterns(report.url);
    step('URL patterns', patternsOk, patternsOk ? 'Allowed by the include/exclude patterns.' : 'Excluded by the include/exclude patterns.');
    const rule = this.rule(u.hostname);
    if (rule?.blocked) step('Site rule', false, 'Blocked by a per-site rule.');
    const h = this.host(u.hostname);
    if (h.pausedUntil > Date.now()) step('Site health', false, `This site is resting after ${Math.max(h.failStreak || 0, h.refuseStreak || 0)} ${h.refuseStreak >= REFUSAL_LIMIT ? 'refusals' : 'failures'} in a row, until ${new Date(h.pausedUntil).toISOString().slice(11, 16)} UTC.`);
    try {
      await this.ensureRobots(h, u.protocol);
    } catch (err) {
      step('Address check', false, err.message);
      return report;
    }
    const allowed = isAllowed(h.parsed, report.url, this.botName);
    const why = !this.cfg.obeyRobots ? 'robots.txt is switched off for every site' : rule?.ignoreRobots ? 'robots.txt is ignored for this site by an owner rule' : null;
    step('robots.txt', allowed || !!why, why ? `${why} (it would ${allowed ? 'allow' : 'block'} this URL).` : allowed ? `Allowed for ${this.botName} (HTTP ${h.robots_status}).` : `Disallowed for ${this.botName}.`);
    if (this.ruleDisallows(report.url)) step('Site rule paths', false, 'This path is blocked by a per-site rule.');
    const started = Date.now();
    let res;
    try {
      res = await get(report.url, { timeout: this.cfg.timeoutMs, retries: 0, publicOnly: true, maxRedirects: this.cfg.maxRedirects, cooldown: false, headers: this.requestHeaders({ kind: 'article' }) });
    } catch (err) {
      step('Fetch', false, err.message);
      return report;
    }
    const type = res.headers.get('content-type') || '';
    const { text: body, bytes, truncated } = await readText(res, this.cfg.maxPageBytes);
    step('Fetch', true, `HTTP ${res.status}, ${type.split(';')[0]}, ${Math.round(bytes / 1024)} KB${truncated ? ' (cut off at the size limit)' : ''} in ${Date.now() - started} ms${res.url && res.url !== report.url ? `, final URL ${res.url}` : ''}.`);
    const xmlKind = sniffXml(body, type);
    if (xmlKind) {
      const n = xmlKind === 'feed' ? parseFeed(body).length : (() => { const s = parseSitemap(body, { maxAgeDays: this.cfg.sitemapMaxAgeDays, maxUrls: 100000 }); return s.urls.length + s.sitemaps.length; })();
      step('Content type', true, `This is ${xmlKind === 'feed' ? 'an RSS/Atom feed' : 'a sitemap'} with ${n} recent entries. The crawler reads it for links rather than indexing it.`);
      return report;
    }
    if (!/html/.test(type)) {
      step('Content type', false, 'Not HTML, so it would not be indexed.');
      return report;
    }
    const page = extractPage(body, res.url || report.url, { respectNofollow: this.cfg.respectNofollow });
    report.extracted = {
      title: page.title, description: page.description, author: page.author, publishedAt: page.published_at, lang: page.lang,
      canonical: page.url, words: page.text ? page.text.split(/\s+/).length : 0, isArticle: page.isArticle, links: page.links.length,
      feeds: page.feeds, images: page.images.slice(0, 6).map((i) => ({ url: i.url, alt: i.alt })), textPreview: (page.text || '').slice(0, 600),
    };
    const d = this.decide(page);
    step('Would be indexed', d.ok, d.ok ? `Yes (${d.words} words).` : d.reason);
    report.wouldIndex = d.ok;
    return report;
  }

  // ---------- images ----------

  imageTick() {
    if (!this.running || !this.cfg.enabled) return;
    const slots = this.cfg.imageConcurrency - this.imgActive;
    if (slots <= 0) return;
    const rows = q("SELECT * FROM images WHERE status = 'queued' ORDER BY discovered_at DESC LIMIT ?").all(slots);
    for (const row of rows) {
      this.imgActive++;
      q("UPDATE images SET status = 'fetching' WHERE id = ?").run(row.id);
      downloadImage(row)
        .then((r) => {
          q('UPDATE images SET status = ?, hash = ?, ext = ?, mime = ?, width = COALESCE(?, width), height = COALESCE(?, height), bytes = ?, fetched_at = ? WHERE id = ?').run(
            r.status, r.hash || null, r.ext || null, r.mime || null, r.width || null, r.height || null, r.bytes || null, Date.now(), row.id);
          if (r.status === 'stored') {
            this.stats.images++;
            if (row.doc_id) q('UPDATE docs SET image_hash = ? WHERE id = ? AND (image_hash IS NULL) AND (image_url = ? OR image_url IS NULL)').run(`${r.hash}.${r.ext}`, row.doc_id, row.url);
            if (this.stats.images % 50 === 0) enforceBudget();
          }
        })
        .catch(() => q("UPDATE images SET status = 'error', fetched_at = ? WHERE id = ?").run(Date.now(), row.id))
        .finally(() => this.imgActive--);
    }
  }

  // ---------- admin operations ----------

  // Add a URL at top priority (it still goes through robots.txt and the SSRF guard).
  crawlNow(url, via) {
    const u = canonicalUrl(url);
    q(`INSERT INTO frontier (url, host, kind, priority, depth, status, next_at, discovered_at, via) VALUES (?, ?, 'article', 100, 0, 'queued', ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET status = 'queued', priority = 100, next_at = excluded.next_at, attempts = 0, error = NULL`).run(u, new URL(u).hostname, Date.now(), Date.now(), via);
    this.cands = null;
    return u;
  }

  purgeHost(host) {
    const h = bare(String(host).toLowerCase());
    const r = q("DELETE FROM frontier WHERE (host = ? OR host = ?) AND status = 'queued' AND kind != 'hub'").run(h, `www.${h}`);
    this.cands = null;
    return Number(r.changes);
  }

  requeueErrors(host = null) {
    const r = host
      ? q("UPDATE frontier SET status = 'queued', attempts = 0, error = NULL, next_at = ? WHERE status = 'error' AND (host = ? OR host = ?)").run(Date.now(), bare(host), `www.${bare(host)}`)
      : q("UPDATE frontier SET status = 'queued', attempts = 0, error = NULL, next_at = ? WHERE status = 'error'").run(Date.now());
    this.cands = null;
    return Number(r.changes);
  }

  // Forget a host's cached robots.txt and any rest period, so it's fetched again now.
  refreshRobots(host) {
    const h = this.host(host);
    h.robots_fetched_at = 0;
    h.next_allowed_at = 0;
    this.hostOk(h);
    this.saveHost(h);
  }

  queueSummary() {
    const now = Date.now();
    return {
      byStatus: Object.fromEntries(q('SELECT status, COUNT(*) AS n FROM frontier GROUP BY status').all().map((r) => [r.status, r.n])),
      byKind: Object.fromEntries(q("SELECT kind, COUNT(*) AS n FROM frontier WHERE status = 'queued' GROUP BY kind").all().map((r) => [r.kind, r.n])),
      readyNow: q("SELECT COUNT(*) AS n FROM frontier WHERE status = 'queued' AND next_at <= ?").get(now).n,
      topHosts: q("SELECT host, COUNT(*) AS n FROM frontier WHERE status = 'queued' GROUP BY host ORDER BY n DESC LIMIT 15").all(),
      next: q("SELECT url, kind, priority, depth, via FROM frontier WHERE status = 'queued' AND next_at <= ? ORDER BY priority DESC LIMIT 25").all(now),
      recentErrors: q("SELECT url, error, http_status, fetched_at FROM frontier WHERE status IN ('error', 'blocked') AND fetched_at IS NOT NULL ORDER BY fetched_at DESC LIMIT 25").all(),
    };
  }

  hosts({ search = '', limit = 100 } = {}) {
    const like = `%${search.replace(/[%_]/g, '')}%`;
    return q(`SELECT h.host, h.pages, h.errors, h.fetched_today, h.day, h.robots_status, h.robots_fetched_at, h.crawl_delay_ms, h.next_allowed_at,
        (SELECT COUNT(*) FROM frontier f WHERE f.host = h.host AND f.status = 'queued') AS queued
      FROM hosts h WHERE h.host LIKE ? ORDER BY h.pages DESC LIMIT ?`).all(like, Math.min(500, limit))
      .map((r) => {
        const live = this.hostCache.get(r.host);
        return { ...r, rule: this.rule(r.host), trusted: this.trusted.has(bare(r.host)), restingUntil: live?.pausedUntil > Date.now() ? live.pausedUntil : null, failStreak: live?.failStreak || 0 };
      });
  }

  robotsFor(host) {
    return q('SELECT robots, robots_status, robots_fetched_at FROM hosts WHERE host = ?').get(host) || null;
  }

  // Sites currently resting after repeated failures.
  resting() {
    const now = Date.now();
    return [...this.hostCache.values()].filter((h) => h.pausedUntil > now).map((h) => ({ host: h.host, until: h.pausedUntil, failures: Math.max(h.failStreak || 0, h.refuseStreak || 0), refused: (h.refuseStreak || 0) >= REFUSAL_LIMIT }));
  }

  // ---------- stats ----------

  countFetch() {
    const now = Date.now();
    this.stats.recent.push(now);
    if (this.stats.recent.length > 6000) this.stats.recent.splice(0, 3000);
    const m = Math.floor(now / 60e3);
    this.minutes.set(m, (this.minutes.get(m) || 0) + 1);
    for (const k of this.minutes.keys()) if (k < m - 60) this.minutes.delete(k);
  }

  live() {
    const now = Date.now();
    const m = Math.floor(now / 60e3);
    return {
      running: this.running,
      state: !this.running ? 'stopped' : this.idleReason || (this.active ? 'crawling' : 'idle'),
      quietHours: this.cfg.quietHours || null,
      utcTime: new Date(now).toISOString().slice(11, 16),
      active: this.active,
      concurrency: this.cfg.concurrency,
      inflight: [...this.inflightUrls].map(([url, v]) => ({ url, host: v.host, kind: v.kind, seconds: Math.round((now - v.started) / 1000) })),
      perMinute: Array.from({ length: 60 }, (_, i) => this.minutes.get(m - 59 + i) || 0),
      userAgent: this.userAgent(),
      obeyRobots: this.cfg.obeyRobots,
      ignoringRobots: [...this.cfg.hostRules.values()].filter((r) => r.ignoreRobots).map((r) => r.host),
      resting: this.resting(),
      autoHubs: this.autoHubs(),
      deadEnds: [...this.deadEnds()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.at - a.at).slice(0, 200),
      session: { ...this.stats, recent: undefined },
      recent: this.ring.slice(0, 40),
    };
  }

  logEntries({ host = '', outcome = '', before = null, limit = 100 } = {}) {
    const where = [];
    const args = [];
    if (host) { where.push('host LIKE ?'); args.push(`%${host.replace(/[%_]/g, '')}%`); }
    if (outcome) { where.push('outcome = ?'); args.push(outcome); }
    if (before) { where.push('id < ?'); args.push(Number(before)); }
    return q(`SELECT * FROM crawl_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).all(...args, Math.min(500, Number(limit) || 100));
  }

  status() {
    const now = Date.now();
    if (this._st && now - this._st.at < 5000) return this._st.v;
    const f = Object.fromEntries(q('SELECT status, COUNT(*) AS n FROM frontier GROUP BY status').all().map((r) => [r.status, r.n]));
    const docs = Object.fromEntries(q('SELECT type, COUNT(*) AS n FROM docs GROUP BY type').all().map((r) => [r.type, r.n]));
    const crawled = q('SELECT COUNT(*) AS n FROM docs WHERE fetched_at IS NOT NULL').get().n;
    const img = q("SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM images WHERE status = 'stored'").get();
    const hosts = q('SELECT COUNT(*) AS n FROM hosts').get().n;
    const perMin = this.stats.recent.filter((t) => t > now - 60e3).length;
    const v = { running: this.running, paused: !this.cfg.enabled, frontier: f, docs, crawledPages: crawled, images: { stored: img.n, bytes: img.b }, hosts, pagesPerMinute: perMin, session: { ...this.stats, recent: undefined } };
    this._st = { at: now, v };
    return v;
  }
}

// The section a dead end covers: the first path segment, or the first two
// when the first is a locale (nvidia.com/en-us/geforce, not all of /en-us).
function deadEndSection(url) {
  const segs = url.pathname.toLowerCase().split('/').filter(Boolean);
  if (/^[a-z]{2}([-_][a-z]{2})?$/.test(segs[0] || '') && segs[1]) return `${segs[0]}/${segs[1]}`;
  return segs[0] || '';
}

// Undated pages its site section indexed in the last day (see decide()).
function undatedInSection(page) {
  const { site, prefix } = sectionOf(page.url);
  return q("SELECT COUNT(*) AS n FROM docs WHERE site = ? AND published_at IS NULL AND fetched_at > ? AND url LIKE ?").get(site, Date.now() - 86400e3, `${prefix}/%`).n;
}

// Feeds and sitemaps mostly arrive as XML; tell them apart by their root
// element. JSON Feed is recognised by its version URL.
export function sniffXml(body, type = '') {
  const head = body.slice(0, 2000);
  if (/^\s*\{/.test(head) && /jsonfeed\.org\/version/i.test(head)) return 'feed';
  if (/<(rss|rdf:RDF)[\s>]|<feed[\s>][^]*xmlns=["']http:\/\/www\.w3\.org\/2005\/Atom/i.test(head) || /<feed[\s>]/i.test(head) && /atom/i.test(type)) return 'feed';
  if (/<(urlset|sitemapindex)[\s>]/i.test(head)) return 'sitemap';
  if (/(rss|atom)\+xml/i.test(type)) return 'feed';
  return null;
}
