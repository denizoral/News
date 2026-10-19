// The spider: a polite, focused web crawler.
//
//  frontier (SQLite) ──► scheduler ──► fetch ──► extract ──► index (FTS5)
//        ▲                  │  robots.txt, per-host delay,      │
//        └── links ◄────────┘  daily host budget                └─► images queue ──► media store
//
// Hubs (section pages) and sitemaps are revisited on a timer to discover new
// articles; articles are fetched once. Everything is persisted, so a restart
// picks up exactly where it left off.

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
import { downloadImage, enforceBudget } from './media.js';
import { upsertDoc, findByContentHash, addInlinks } from '../index/documents.js';

const LOG_RING = 500;
const ALWAYS_STRIPPED = /^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|igshid$|ref_src$)/i;

const bare = (h) => h.replace(/^www\./, '');
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
    this.stats = { fetched: 0, indexed: 0, duplicates: 0, blocked: 0, errors: 0, images: 0, startedAt: Date.now(), recent: [] };
    this.inflightUrls = new Map(); // url -> { host, kind, started }
    this.ring = []; // newest crawl-log entries, for the live view
    this.minutes = new Map(); // minute -> fetches, last hour
    this.idleReason = null;
  }

  // Live configuration from the admin dashboard, rebuilt when settings change.
  get cfg() {
    if (this._cfgVersion !== settings.version) {
      this._cfg = { ...settings.spider(), ...this.overrides };
      if (!(this._cfg.hostRules instanceof Map)) this._cfg.hostRules = new Map();
      this._trusted = new Set(this._cfg.hubs.map((u) => bare(new URL(u).hostname)));
      this._cfgVersion = settings.version;
    }
    return this._cfg;
  }

  get trusted() {
    return this.cfg && this._trusted;
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

  // ---------- frontier ----------

  isSkipped(url) {
    const h = bare(hostOf(url));
    return this.cfg.skipHosts.some((s) => (s.includes('/') ? url.includes(s) : h === s || h.endsWith(`.${s}`)));
  }

  enqueue(url, { kind = 'article', priority = 5, depth = 0, via = null, nextAt = Date.now() } = {}) {
    let u;
    try {
      u = this.cleanUrl(canonicalUrl(url));
      if (!/^https?:\/\//.test(u) || this.isSkipped(u)) return false;
    } catch {
      return false;
    }
    // Starting pages and sitemaps are configured explicitly; patterns filter what they lead to.
    if (kind !== 'hub' && kind !== 'sitemap' && !this.urlAllowedByPatterns(u)) return false;
    const host = new URL(u).hostname;
    if (priority < 4 && this.queuedCount() > this.cfg.maxQueue) return false;
    // Rediscovery nudges priority up: things many pages link to get crawled sooner.
    q(`INSERT INTO frontier (url, host, kind, priority, depth, status, next_at, discovered_at, via) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET priority = MAX(priority, excluded.priority) + 0.2, depth = MIN(depth, excluded.depth)
       WHERE status = 'queued'`).run(u, host, kind, priority, depth, nextAt, Date.now(), via);
    return true;
  }

  cleanUrl(u) {
    const strip = this.cfg.stripQueryParams || [];
    const url = new URL(u);
    if (strip.includes('*')) url.search = '';
    else for (const k of [...url.searchParams.keys()]) if (ALWAYS_STRIPPED.test(k) || strip.includes(k.toLowerCase())) url.searchParams.delete(k);
    return url.toString().replace(/\?$/, '');
  }

  urlAllowedByPatterns(u) {
    const { includePatterns: inc = [], excludePatterns: exc = [] } = this.cfg;
    if (exc.some((m) => m(u))) return false;
    return !inc.length || inc.some((m) => m(u));
  }

  queuedCount() {
    const now = Date.now();
    if (!this._qc || now - this._qc.at > 10e3) this._qc = { at: now, n: q("SELECT COUNT(*) AS n FROM frontier WHERE status = 'queued'").get().n };
    return this._qc.n;
  }

  seed() {
    tx(() => {
      // Starting pages removed in the dashboard stop being rechecked.
      const current = new Set(this.cfg.hubs.map((u) => canonicalUrl(u)));
      for (const r of q("SELECT url FROM frontier WHERE kind = 'hub'").all()) {
        if (!current.has(r.url)) q("UPDATE frontier SET kind = 'page', status = 'done' WHERE url = ?").run(r.url);
      }
      for (const u of this.cfg.hubs) {
        const url = canonicalUrl(u);
        q(`INSERT INTO frontier (url, host, kind, priority, depth, status, next_at, discovered_at, via) VALUES (?, ?, 'hub', 10, 0, 'queued', ?, ?, 'seed')
           ON CONFLICT(url) DO UPDATE SET kind = 'hub', status = 'queued', depth = 0`).run(url, new URL(url).hostname, Date.now(), Date.now());
      }
    });
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

  // ---------- hosts ----------

  host(host) {
    let h = this.hostCache.get(host);
    if (!h) {
      const row = q('SELECT * FROM hosts WHERE host = ?').get(host);
      h = row ? { ...row, parsed: row.robots != null ? parseRobots(row.robots) : null } : { host, robots: null, robots_status: null, robots_fetched_at: 0, crawl_delay_ms: null, next_allowed_at: 0, fetched_today: 0, day: today(), pages: 0, errors: 0, parsed: null };
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

  async ensureRobots(h, scheme) {
    if (h.robots_fetched_at && Date.now() - h.robots_fetched_at < 24 * 3600e3) return;
    let text = '';
    let status = 0;
    try {
      const res = await get(`${scheme}//${h.host}/robots.txt`, { headers: { 'user-agent': this.userAgent() }, timeout: 10000, retries: 0, publicOnly: true, maxRedirects: this.cfg.maxRedirects });
      status = res.status;
      text = (await res.text()).slice(0, 500000);
    } catch (err) {
      // A 4xx means "no robots.txt": everything allowed. Network trouble is treated as 5xx.
      status = err.status && err.status < 500 ? err.status : 599;
      if (err instanceof BlockedUrlError) throw err;
    }
    h.robots_status = status;
    if (status >= 500) {
      // Server trouble: per RFC 9309 assume disallowed, and retry in an hour.
      h.robots = 'User-agent: *\nDisallow: /';
      h.robots_fetched_at = Date.now() - 23 * 3600e3;
    } else {
      h.robots = status >= 400 ? '' : text;
      h.robots_fetched_at = Date.now();
    }
    h.parsed = parseRobots(h.robots);
    const d = crawlDelay(h.parsed, this.botName);
    h.crawl_delay_ms = d != null ? Math.min(d * 1000, 60000) : null;
    // Sitemaps of trusted hosts are the fastest way to learn about new articles.
    if (this.cfg.useSitemaps && this.trusted.has(bare(h.host))) {
      for (const sm of h.parsed.sitemaps.slice(0, 6)) {
        if (/news|post|article|\d{4}|sitemap\.xml$|sitemap_index/i.test(sm)) this.enqueue(sm, { kind: 'sitemap', priority: 9, depth: 0, via: 'robots.txt' });
      }
    }
    this.saveHost(h);
  }

  // ---------- scheduling ----------

  start() {
    if (this.running) return;
    this.running = true;
    q("UPDATE frontier SET status = 'queued' WHERE status = 'fetching'").run();
    this.seed();
    this.onSettings = (changes) => {
      if (changes.some((c) => c.key === 'crawler.hubs')) this.seed();
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
    const cap = this.cfg.maxPagesPerMinute;
    if (cap && this.stats.recent.filter((t) => t > now - 60e3).length >= cap) {
      this.idleReason = 'pages-per-minute cap';
      return;
    }
    if (this.active >= this.cfg.concurrency) return;
    // Candidates are the best two ready URLs per host, so one big sitemap
    // can't starve every other site. Refreshed every few seconds.
    if (!this.cands?.length || now - this.candsAt > 3000) {
      this.cands = q(`SELECT url, host, kind, priority, depth, attempts, etag, last_modified FROM (
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
      // Patterns are checked again here so a new exclude pattern also clears what's already queued.
      if (row.kind !== 'hub' && row.kind !== 'sitemap' && !this.urlAllowedByPatterns(row.url)) {
        this.cands.splice(this.cands.indexOf(row), 1);
        q("UPDATE frontier SET status = 'skipped', error = 'Excluded by a URL pattern' WHERE url = ?").run(row.url);
        continue;
      }
      const rule = this.rule(row.host);
      if (rule?.blocked) {
        this.cands.splice(this.cands.indexOf(row), 1);
        q("UPDATE frontier SET status = 'blocked', error = 'Blocked by a site rule' WHERE url = ?").run(row.url);
        continue;
      }
      if (h.fetched_today >= (rule?.dailyBudget ?? this.cfg.hostDailyBudget) && row.kind !== 'hub') {
        q('UPDATE frontier SET next_at = ? WHERE url = ?').run(now + 3600e3, row.url);
        continue;
      }
      this.cands.splice(this.cands.indexOf(row), 1);
      this.inflight.add(row.host);
      this.inflightUrls.set(row.url, { host: row.host, kind: row.kind, started: Date.now() });
      this.active++;
      q("UPDATE frontier SET status = 'fetching' WHERE url = ?").run(row.url);
      row._started = Date.now();
      this.process(row, h)
        .catch((err) => this.fail(row, h, err))
        .finally(() => {
          this.inflight.delete(row.host);
          this.inflightUrls.delete(row.url);
          this.active--;
        });
    }
  }

  fail(row, h, err) {
    if (err instanceof BlockedUrlError) {
      this.stats.blocked++;
      q("UPDATE frontier SET status = 'blocked', error = ?, fetched_at = ? WHERE url = ?").run(err.message.slice(0, 300), Date.now(), row.url);
      this.log(row, { outcome: 'blocked', reason: err.message });
      return;
    }
    this.stats.errors++;
    h.errors++;
    const attempts = row.attempts + 1;
    const permanent = /HTTP (400|401|403|404|410|451)/.test(err.message);
    const retry = !permanent && attempts < this.cfg.maxAttempts;
    this.log(row, { outcome: 'error', http: err.status || null, reason: `${err.message}${retry ? ` (attempt ${attempts} of ${this.cfg.maxAttempts}, will retry)` : ''}` });
    q('UPDATE frontier SET status = ?, attempts = ?, next_at = ?, error = ?, fetched_at = ? WHERE url = ?').run(
      row.kind === 'hub' || row.kind === 'sitemap' ? 'queued' : retry ? 'queued' : 'error',
      attempts,
      Date.now() + (row.kind === 'hub' ? this.cfg.hubRecrawlMin * 60e3 : 60e3 * 5 ** attempts),
      err.message.slice(0, 300),
      Date.now(),
      row.url,
    );
    this.saveHost(h);
  }

  done(row, { status = 'done', httpStatus = 200, etag = null, lastModified = null, recrawlAt = null } = {}) {
    const recurring = row.kind === 'hub' || row.kind === 'sitemap';
    const next = recurring ? Date.now() + (row.kind === 'hub' ? this.cfg.hubRecrawlMin : this.cfg.sitemapRecrawlMin) * 60e3 : recrawlAt || Date.now();
    const again = (recurring || recrawlAt) && status === 'done';
    q('UPDATE frontier SET status = ?, http_status = ?, etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified), fetched_at = ?, next_at = ?, attempts = 0, error = NULL WHERE url = ?').run(
      again ? 'queued' : status, httpStatus, etag, lastModified, Date.now(), next, row.url);
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

  async process(row, h) {
    const scheme = new URL(row.url).protocol;
    const rule = this.rule(h.host);
    await this.ensureRobots(h, scheme);
    // Owners can exempt specific sites from robots.txt (e.g. their own). Site rules still apply.
    const robotsOk = this.robotsAllows(h, row.url);
    if (!robotsOk || this.ruleDisallows(row.url)) {
      this.stats.blocked++;
      this.log(row, { outcome: 'blocked', reason: robotsOk ? 'Blocked path in a site rule' : 'Disallowed by robots.txt' });
      return this.done(row, { status: 'blocked', httpStatus: 0 });
    }

    const robotsDelay = this.cfg.honorCrawlDelay && this.obeysRobots(h.host) ? h.crawl_delay_ms || 0 : 0;
    const delay = Math.max(this.cfg.hostDelayMs, robotsDelay, rule?.minDelayMs || 0);
    h.next_allowed_at = Date.now() + delay;
    h.fetched_today++;

    const headers = { 'user-agent': this.userAgent(), accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5', 'accept-language': this.cfg.acceptLanguage };
    if (row.etag) headers['if-none-match'] = row.etag;
    if (row.last_modified) headers['if-modified-since'] = row.last_modified;

    let res;
    try {
      res = await get(row.url, { timeout: this.cfg.timeoutMs, retries: 0, headers, publicOnly: true, maxRedirects: this.cfg.maxRedirects });
    } catch (err) {
      if (/HTTP 304/.test(err.message)) {
        this.log(row, { outcome: 'not-modified', http: 304 });
        return this.done(row, { httpStatus: 304 });
      }
      throw err;
    }
    const type = res.headers.get('content-type') || '';
    const finalUrl = res.url || row.url;
    const body = await readText(res, this.cfg.maxPageBytes);
    this.stats.fetched++;
    h.pages++;
    this.saveHost(h);
    this.countFetch();
    const bytes = Buffer.byteLength(body);
    const http = res.status;

    const meta = { etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), httpStatus: http };
    if (row.kind === 'sitemap' || /xml/.test(type) && !/html/.test(type)) {
      const n = this.handleSitemap(row, body);
      this.log(row, { outcome: 'sitemap', http, bytes, reason: `${n} URLs queued` });
      return this.done(row, meta);
    }
    if (!/html/.test(type)) {
      this.log(row, { outcome: 'skipped', http, bytes, reason: `Not HTML (${type.split(';')[0] || 'unknown type'})` });
      return this.done(row, { ...meta, status: 'skipped' });
    }
    if (/noindex/i.test(res.headers.get('x-robots-tag') || '')) {
      this.log(row, { outcome: 'skipped', http, bytes, reason: 'X-Robots-Tag: noindex' });
      return this.done(row, { ...meta, status: 'skipped' });
    }

    const page = extractPage(body, finalUrl, { respectNofollow: this.cfg.respectNofollow });
    const queued = this.followLinks(row, page);
    if (row.kind === 'hub') {
      this.log(row, { outcome: 'hub', http, bytes, reason: `${queued} links queued` });
      return this.done(row, meta);
    }
    const r = this.indexPage(row, page);
    this.log(row, { outcome: r.outcome, http, bytes, reason: [r.reason, queued ? `${queued} links queued` : null].filter(Boolean).join('; ') || null });
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
      for (const sm of parsed.sitemaps) this.enqueue(sm.url, { kind: 'sitemap', priority: 8.5, depth: 0, via: row.url });
      for (const u of parsed.urls) {
        const ageH = u.lastmod ? (Date.now() - u.lastmod) / 3600e3 : 72;
        if (u.title && this.cfg.relevance !== 'all' && !this.isRelevantText(u.title) && !this.isAiHost(hostOf(u.url))) continue;
        if (this.enqueue(u.url, { kind: 'article', priority: 6 + Math.max(0, 3 - ageH / 12), depth: 1, via: 'sitemap' })) n++;
      }
    });
    return n;
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

  isAiHost(host) {
    // Hosts whose whole output is about AI; everything they publish is relevant.
    return /(openai|anthropic|deepmind|huggingface|mistral|x\.ai|the-decoder|marktechpost|unite\.ai|simonwillison|latent\.space|interconnects|jack-clark|epoch\.ai|machinelearning\.apple)/.test(host);
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

        if (sameHost && fromTrusted) {
          if (article) enq(link.url, { kind: 'article', priority: 6 + (aiAnchor ? 2 : 0) - row.depth * 0.5 + (this.isAiHost(toHost) ? 1 : 0), depth, via: row.url });
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

  // Whether a page would be indexed, and why not. Shared by crawling and "Test a URL".
  decide(page) {
    const cfg = this.cfg;
    const text = page.text || '';
    if (page.noindex) return { ok: false, outcome: 'skipped', reason: 'Page asks not to be indexed (noindex)' };
    if (!page.title) return { ok: false, outcome: 'skipped', reason: 'No title' };
    const head = `${page.title} ${page.description}`.toLowerCase();
    const bad = cfg.excludeKeywords.find((k) => head.includes(k));
    if (bad) return { ok: false, outcome: 'skipped', reason: `Mentions excluded keyword "${bad}"` };
    if (cfg.languages.length && page.lang && !cfg.languages.includes(page.lang)) return { ok: false, outcome: 'skipped', reason: `Language ${page.lang} isn't in the allowed list` };
    const words = text ? text.split(/\s+/).length : 0;
    if (words < cfg.minWords) return { ok: false, outcome: 'skipped', reason: `Too short (${words} words, minimum ${cfg.minWords})` };
    if (!page.isArticle && text.length < 600) return { ok: false, outcome: 'skipped', reason: "Doesn't look like an article" };
    if (cfg.maxArticleAgeDays && page.published_at && Date.now() - page.published_at > cfg.maxArticleAgeDays * 86400e3) {
      return { ok: false, outcome: 'skipped', reason: `Older than ${cfg.maxArticleAgeDays} days` };
    }
    const sample = `${page.title} ${page.description} ${text.slice(0, 4000)}`;
    if (cfg.relevance === 'keywords') {
      const hit = cfg.includeKeywords.find((k) => sample.toLowerCase().includes(k));
      if (!hit) return { ok: false, outcome: 'skipped', reason: 'None of the keywords appear' };
    } else if (cfg.relevance === 'ai' && !this.isAiHost(page.site) && !this.isRelevantText(sample)) {
      return { ok: false, outcome: 'skipped', reason: 'Not about AI' };
    }
    const dup = findByContentHash(page.contentHash);
    if (dup && dup.url !== page.url) return { ok: false, outcome: 'duplicate', reason: `Same text as ${dup.url}` };
    return { ok: true, words };
  }

  isRelevantText(text) {
    if (isAiRelated(text)) return true;
    const t = text.toLowerCase();
    return this.cfg.includeKeywords.some((k) => t.includes(k));
  }

  indexPage(row, page) {
    const d = this.decide(page);
    if (!d.ok) {
      if (d.outcome === 'duplicate') this.stats.duplicates++;
      return d;
    }
    const text = page.text || '';
    const existed = !!q('SELECT 1 FROM docs WHERE url = ? AND fetched_at IS NOT NULL').get(page.url);
    const first = page.images[0];
    const { id } = upsertDoc({
      url: page.url,
      type: 'article',
      title: page.title,
      description: page.description,
      body: text,
      site: page.site,
      source: page.siteName,
      author: page.author,
      lang: page.lang,
      image_url: first?.url || null,
      published_at: page.published_at,
      fetched_at: Date.now(),
      content_hash: page.contentHash,
      noarchive: page.noarchive,
    });
    if (row.url !== page.url) {
      // The page declared another canonical URL; mark it so we don't fetch it again.
      q("INSERT INTO frontier (url, host, kind, priority, depth, status, next_at, discovered_at, via) VALUES (?, ?, 'article', 0, ?, 'done', ?, ?, 'canonical') ON CONFLICT(url) DO UPDATE SET status = 'done'").run(page.url, new URL(page.url).hostname, row.depth, Date.now(), Date.now());
    }
    const ins = q(`INSERT INTO images (url, page_url, doc_id, alt, caption, page_title, site, published_at, discovered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(url) DO UPDATE SET alt = CASE WHEN length(excluded.alt) > length(alt) THEN excluded.alt ELSE alt END`);
    tx(() => {
      const keep = page.images.filter((img, i) => i === 0 || (img.alt || img.caption).length >= 12).slice(0, this.cfg.imagesPerPage);
      for (const img of keep) {
        ins.run(img.url, page.url, id, img.alt || '', img.caption || '', page.title, page.site, page.published_at || Date.now(), Date.now());
      }
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
    if (this.isSkipped(report.url)) step('Never-crawl list', false, 'This host is on the never-crawl list.');
    else step('Never-crawl list', true, 'Not listed.');
    step('URL patterns', this.urlAllowedByPatterns(report.url), this.urlAllowedByPatterns(report.url) ? 'Allowed by the include/exclude patterns.' : 'Excluded by the include/exclude patterns.');
    const rule = this.rule(u.hostname);
    if (rule?.blocked) step('Site rule', false, 'Blocked by a per-site rule.');
    const h = this.host(u.hostname);
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
      res = await get(report.url, { timeout: this.cfg.timeoutMs, retries: 0, publicOnly: true, maxRedirects: this.cfg.maxRedirects, headers: { 'user-agent': this.userAgent(), 'accept-language': this.cfg.acceptLanguage } });
    } catch (err) {
      step('Fetch', false, err.message);
      return report;
    }
    const type = res.headers.get('content-type') || '';
    const body = await readText(res, this.cfg.maxPageBytes);
    step('Fetch', true, `HTTP ${res.status}, ${type.split(';')[0]}, ${Math.round(Buffer.byteLength(body) / 1024)} KB in ${Date.now() - started} ms${res.url && res.url !== report.url ? `, final URL ${res.url}` : ''}.`);
    if (!/html/.test(type)) {
      step('Content type', false, 'Not HTML, so it would not be indexed.');
      return report;
    }
    const page = extractPage(body, res.url || report.url, { respectNofollow: this.cfg.respectNofollow });
    report.extracted = {
      title: page.title, description: page.description, author: page.author, publishedAt: page.published_at, lang: page.lang,
      canonical: page.url, words: page.text ? page.text.split(/\s+/).length : 0, isArticle: page.isArticle, links: page.links.length,
      images: page.images.slice(0, 6).map((i) => ({ url: i.url, alt: i.alt })), textPreview: (page.text || '').slice(0, 600),
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
    const host = new URL(u).hostname;
    q(`INSERT INTO frontier (url, host, kind, priority, depth, status, next_at, discovered_at, via) VALUES (?, ?, 'article', 100, 0, 'queued', ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET status = 'queued', priority = 100, next_at = excluded.next_at, attempts = 0, error = NULL`).run(u, host, Date.now(), Date.now(), via);
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

  // Forget a host's cached robots.txt so it's fetched again before the next request.
  refreshRobots(host) {
    const h = this.host(host);
    h.robots_fetched_at = 0;
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
    return q(`SELECT h.host, h.pages, h.errors, h.fetched_today, h.day, h.robots_status, h.robots_fetched_at, h.crawl_delay_ms,
        (SELECT COUNT(*) FROM frontier f WHERE f.host = h.host AND f.status = 'queued') AS queued
      FROM hosts h WHERE h.host LIKE ? ORDER BY h.pages DESC LIMIT ?`).all(like, Math.min(500, limit))
      .map((r) => ({ ...r, rule: this.rule(r.host), trusted: this.trusted.has(bare(r.host)) }));
  }

  robotsFor(host) {
    const row = q('SELECT robots, robots_status, robots_fetched_at FROM hosts WHERE host = ?').get(host);
    return row || null;
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

async function readText(res, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > limit) break;
    chunks.push(chunk);
  }
  const buf = Buffer.concat(chunks);
  const charset = (res.headers.get('content-type') || '').match(/charset=([\w-]+)/i)?.[1];
  try {
    return new TextDecoder(charset || 'utf-8').decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

// "01:00-06:00" in UTC; windows may wrap past midnight ("22:00-05:00").
export function inQuietHours(spec, now = Date.now()) {
  if (!spec) return false;
  const m = spec.match(/^(\d\d):(\d\d)-(\d\d):(\d\d)$/);
  if (!m) return false;
  const start = +m[1] * 60 + +m[2];
  const end = +m[3] * 60 + +m[4];
  const d = new Date(now);
  const t = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (start === end) return false;
  return start < end ? t >= start && t < end : t >= start || t < end;
}
