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
import { parseRobots, isAllowed, crawlDelay, BOT_TOKEN } from './robots.js';
import { extractPage, looksLikeArticleUrl } from './extract.js';
import { parseSitemap } from './sitemaps.js';
import { downloadImage, enforceBudget } from './media.js';
import { upsertDoc, findByContentHash, addInlinks } from '../index/documents.js';

export const BOT_UA = `Mozilla/5.0 (compatible; ${BOT_TOKEN}/0.2; +https://github.com/denizoral/News)`;
const MAX_QUEUED = 250000;

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
      u = canonicalUrl(url);
      if (!/^https?:\/\//.test(u) || this.isSkipped(u)) return false;
    } catch {
      return false;
    }
    const host = new URL(u).hostname;
    if (priority < 4 && this.queuedCount() > MAX_QUEUED) return false;
    // Rediscovery nudges priority up: things many pages link to get crawled sooner.
    q(`INSERT INTO frontier (url, host, kind, priority, depth, status, next_at, discovered_at, via) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?)
       ON CONFLICT(url) DO UPDATE SET priority = MAX(priority, excluded.priority) + 0.2, depth = MIN(depth, excluded.depth)
       WHERE status = 'queued'`).run(u, host, kind, priority, depth, nextAt, Date.now(), via);
    return true;
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
      const res = await get(`${scheme}//${h.host}/robots.txt`, { headers: { 'user-agent': BOT_UA }, timeout: 10000, retries: 0, publicOnly: true });
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
    const d = crawlDelay(h.parsed, BOT_TOKEN);
    h.crawl_delay_ms = d != null ? Math.min(d * 1000, 60000) : null;
    // Sitemaps of trusted hosts are the fastest way to learn about new articles.
    if (this.trusted.has(bare(h.host))) {
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
    if (!this.running || !this.cfg.enabled || this.active >= this.cfg.concurrency) return;
    const now = Date.now();
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
      this.active++;
      q("UPDATE frontier SET status = 'fetching' WHERE url = ?").run(row.url);
      this.process(row, h)
        .catch((err) => this.fail(row, h, err))
        .finally(() => {
          this.inflight.delete(row.host);
          this.active--;
        });
    }
  }

  fail(row, h, err) {
    if (err instanceof BlockedUrlError) {
      this.stats.blocked++;
      q("UPDATE frontier SET status = 'blocked', error = ?, fetched_at = ? WHERE url = ?").run(err.message.slice(0, 300), Date.now(), row.url);
      return;
    }
    this.stats.errors++;
    h.errors++;
    const attempts = row.attempts + 1;
    const permanent = /HTTP (400|401|403|404|410|451)/.test(err.message);
    const retry = !permanent && attempts < 3;
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

  done(row, { status = 'done', httpStatus = 200, etag = null, lastModified = null } = {}) {
    const recurring = row.kind === 'hub' || row.kind === 'sitemap';
    const next = recurring ? Date.now() + (row.kind === 'hub' ? this.cfg.hubRecrawlMin : this.cfg.sitemapRecrawlMin) * 60e3 : Date.now();
    q('UPDATE frontier SET status = ?, http_status = ?, etag = COALESCE(?, etag), last_modified = COALESCE(?, last_modified), fetched_at = ?, next_at = ?, attempts = 0, error = NULL WHERE url = ?').run(
      recurring && status === 'done' ? 'queued' : status, httpStatus, etag, lastModified, Date.now(), next, row.url);
  }

  // ---------- fetch + process ----------

  async process(row, h) {
    const scheme = new URL(row.url).protocol;
    await this.ensureRobots(h, scheme);
    if (!isAllowed(h.parsed, row.url, BOT_TOKEN) || this.ruleDisallows(row.url)) {
      this.stats.blocked++;
      return this.done(row, { status: 'blocked', httpStatus: 0 });
    }

    const delay = Math.max(this.cfg.hostDelayMs, h.crawl_delay_ms || 0, this.rule(h.host)?.minDelayMs || 0);
    h.next_allowed_at = Date.now() + delay;
    h.fetched_today++;

    const headers = { 'user-agent': BOT_UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5' };
    if (row.etag) headers['if-none-match'] = row.etag;
    if (row.last_modified) headers['if-modified-since'] = row.last_modified;

    let res;
    try {
      res = await get(row.url, { timeout: 20000, retries: 0, headers, publicOnly: true });
    } catch (err) {
      if (/HTTP 304/.test(err.message)) return this.done(row, { httpStatus: 304 });
      throw err;
    }
    const type = res.headers.get('content-type') || '';
    const finalUrl = res.url || row.url;
    const body = await readText(res, this.cfg.maxPageBytes);
    this.stats.fetched++;
    h.pages++;
    this.saveHost(h);
    this.stats.recent.push(Date.now());
    if (this.stats.recent.length > 600) this.stats.recent.splice(0, 300);

    const meta = { etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified') };
    if (row.kind === 'sitemap' || /xml/.test(type) && !/html/.test(type)) {
      this.handleSitemap(row, body);
      return this.done(row, meta);
    }
    if (!/html/.test(type)) return this.done(row, { ...meta, status: 'skipped' });
    if (/noindex/i.test(res.headers.get('x-robots-tag') || '')) return this.done(row, { ...meta, status: 'skipped' });

    const page = extractPage(body, finalUrl);
    this.followLinks(row, page);
    if (row.kind !== 'hub') this.indexPage(row, page);
    return this.done(row, meta);
  }

  handleSitemap(row, xml) {
    let parsed;
    try {
      parsed = parseSitemap(xml);
    } catch {
      return;
    }
    tx(() => {
      for (const sm of parsed.sitemaps) this.enqueue(sm.url, { kind: 'sitemap', priority: 8.5, depth: 0, via: row.url });
      for (const u of parsed.urls) {
        const ageH = u.lastmod ? (Date.now() - u.lastmod) / 3600e3 : 72;
        if (u.title && !isAiRelated(u.title) && !this.isAiHost(hostOf(u.url))) continue;
        this.enqueue(u.url, { kind: 'article', priority: 6 + Math.max(0, 3 - ageH / 12), depth: 1, via: 'sitemap' });
      }
    });
  }

  // Extra paths blocked from the dashboard, using robots.txt pattern syntax.
  ruleDisallows(url) {
    const rule = this.rule(new URL(url).hostname);
    if (!rule?.disallow?.length) return false;
    if (rule._parsed?.src !== rule.disallow) rule._parsed = { src: rule.disallow, robots: parseRobots(`User-agent: *\n${rule.disallow.map((p) => `Disallow: ${p}`).join('\n')}`) };
    return !isAllowed(rule._parsed.robots, url, BOT_TOKEN);
  }

  isAiHost(host) {
    // Hosts whose whole output is about AI; everything they publish is relevant.
    return /(openai|anthropic|deepmind|huggingface|mistral|x\.ai|the-decoder|marktechpost|unite\.ai|simonwillison|latent\.space|interconnects|jack-clark|epoch\.ai|machinelearning\.apple)/.test(host);
  }

  followLinks(row, page) {
    const fromHost = bare(hostOf(page.url));
    const fromTrusted = this.trusted.has(fromHost);
    const external = [];
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
          if (article) this.enqueue(link.url, { kind: 'article', priority: 6 + (aiAnchor ? 2 : 0) - row.depth * 0.5 + (this.isAiHost(toHost) ? 1 : 0), depth, via: row.url });
          else if (aiAnchor && depth <= 2) this.enqueue(link.url, { kind: 'page', priority: 3.5, depth, via: row.url });
        } else if (sameHost) {
          if (article && aiAnchor && depth <= 2) this.enqueue(link.url, { kind: 'article', priority: 4.5, depth, via: row.url });
        } else if (fromTrusted && article && aiAnchor && this.cfg.followExternal) {
          // One hop off the trusted set, and no further.
          this.enqueue(link.url, { kind: 'article', priority: 5 + (this.trusted.has(toHost) ? 1 : 0), depth: this.cfg.maxDepth, via: row.url });
        }
      }
      if (external.length) addInlinks(external.slice(0, 200));
    });
  }

  indexPage(row, page) {
    if (page.noindex || !page.title) return;
    const text = page.text || '';
    const relevant = this.isAiHost(page.site) || isAiRelated(`${page.title} ${page.description} ${text.slice(0, 4000)}`);
    if (!relevant) return;
    if (!page.isArticle && text.length < 600) return;
    const dup = findByContentHash(page.contentHash);
    if (dup && dup.url !== page.url) {
      this.stats.duplicates++;
      return;
    }
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
