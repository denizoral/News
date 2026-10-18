// Runtime settings, edited from the admin dashboard and stored in SQLite.
//
// Every key is declared here with its type, limits and the role allowed to
// change it. Writes are validated against this schema (unknown keys are
// rejected), so nothing the dashboard sends can put the system in a state the
// code doesn't expect. Changes apply live: subscribers get a 'change' event.

import { EventEmitter } from 'node:events';
import { q, tx } from './db.js';
import { SCHEDULE, SPIDER, RETENTION_HOURS } from './config.js';

const env = (k, d) => (process.env[k] != null && process.env[k] !== '' ? process.env[k] : d);
const envNum = (k, d) => (Number.isFinite(Number(process.env[k])) && process.env[k] !== '' && process.env[k] != null ? Number(process.env[k]) : d);

const HOST_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const SOURCE_LABELS = {
  x: 'X', polymarket: 'Polymarket', hackernews: 'Hacker News', reddit: 'Reddit', bluesky: 'Bluesky', googlenews: 'Google News',
  rss: 'Lab blogs, press and newsletters', scraped: 'Lab news pages', openrouter: 'OpenRouter models', huggingface: 'Hugging Face',
  github: 'GitHub', producthunt: 'Product Hunt', showhn: 'Show HN',
};

const DEFAULT_ROBOTS = `# Robots policy for this site. Edit it in the admin dashboard.
User-agent: *
Disallow: /api/
`;

// role: minimum role that may change the key (editor < admin < owner).
const DEFS = [
  // Site
  { key: 'site.name', group: 'site', label: 'Site name', type: 'string', min: 2, max: 40, default: 'Frontier Wire', role: 'editor' },
  { key: 'site.tagline', group: 'site', label: 'Tagline', help: 'Shown under the masthead. Leave empty to hide.', type: 'string', max: 140, default: '', role: 'editor' },
  { key: 'site.banner', group: 'site', label: 'Announcement banner', help: 'Plain text across the top of every page. Leave empty to hide.', type: 'string', max: 280, default: '', role: 'editor' },
  { key: 'site.bannerLink', group: 'site', label: 'Banner link', help: 'Optional https:// link for the banner.', type: 'url', default: '', role: 'editor' },
  { key: 'site.showBuilds', group: 'site', label: 'Show "Built with AI"', type: 'bool', default: true, role: 'editor' },
  { key: 'site.showMarkets', group: 'site', label: 'Show Markets', type: 'bool', default: true, role: 'editor' },
  { key: 'site.robotsTxt', group: 'site', label: 'robots.txt for this site', help: 'Served at /robots.txt. Tells other crawlers what they may fetch here.', type: 'text', max: 20000, default: DEFAULT_ROBOTS, role: 'admin', validate: validateRobots },

  // Crawler
  { key: 'crawler.enabled', group: 'crawler', label: 'Crawler running', help: 'Pause to stop all page and image fetches. The queue is kept.', type: 'bool', default: env('SPIDER', 'on') !== 'off', role: 'admin' },
  { key: 'crawler.concurrency', group: 'crawler', label: 'Parallel fetches', help: 'Across all sites. Each site still gets one request at a time.', type: 'int', min: 1, max: 64, default: envNum('SPIDER_CONCURRENCY', SPIDER.concurrency), role: 'admin' },
  { key: 'crawler.hostDelayMs', group: 'crawler', label: 'Minimum gap per site (ms)', help: "A site's robots.txt Crawl-delay wins when it's longer.", type: 'int', min: 500, max: 120000, default: envNum('SPIDER_HOST_DELAY_MS', SPIDER.hostDelayMs), role: 'admin' },
  { key: 'crawler.hostDailyBudget', group: 'crawler', label: 'Pages per site per day', type: 'int', min: 10, max: 200000, default: envNum('SPIDER_HOST_BUDGET', SPIDER.hostDailyBudget), role: 'admin' },
  { key: 'crawler.maxDepth', group: 'crawler', label: 'Link depth', help: 'How many links away from a starting page the crawler may go.', type: 'int', min: 0, max: 8, default: SPIDER.maxDepth, role: 'admin' },
  { key: 'crawler.followExternal', group: 'crawler', label: 'Follow links to other sites', help: 'One hop out, only when the link is about AI.', type: 'bool', default: true, role: 'admin' },
  { key: 'crawler.hubRecrawlMin', group: 'crawler', label: 'Recheck starting pages every (min)', type: 'int', min: 1, max: 1440, default: SPIDER.hubRecrawlMin, role: 'admin' },
  { key: 'crawler.sitemapRecrawlMin', group: 'crawler', label: 'Recheck sitemaps every (min)', type: 'int', min: 5, max: 1440, default: SPIDER.sitemapRecrawlMin, role: 'admin' },
  { key: 'crawler.imagesPerPage', group: 'crawler', label: 'Images kept per page', type: 'int', min: 0, max: 12, default: SPIDER.imagesPerPage, role: 'admin' },
  { key: 'crawler.imageConcurrency', group: 'crawler', label: 'Parallel image downloads', type: 'int', min: 0, max: 16, default: SPIDER.imageConcurrency, role: 'admin' },
  { key: 'crawler.hubs', group: 'crawler', label: 'Starting pages', help: 'One URL per line. Their sites are trusted: the crawler follows any link inside them.', type: 'urls', maxItems: 500, default: SPIDER.hubs, role: 'admin' },
  { key: 'crawler.skipHosts', group: 'crawler', label: 'Never crawl', help: 'One host per line (subdomains included), or host/path.', type: 'hosts', maxItems: 2000, allowPath: true, default: SPIDER.skipHosts, role: 'admin' },
  { key: 'crawler.hostRules', group: 'crawler', label: 'Per-site rules', help: 'Stricter rules for specific sites, on top of their robots.txt.', type: 'hostRules', maxItems: 2000, default: [], role: 'admin' },

  // Sources (aggregator)
  ...Object.entries(SCHEDULE).flatMap(([name, sec]) => [
    { key: `sources.${name}.enabled`, group: 'sources', source: name, label: `${SOURCE_LABELS[name] || name}: enabled`, type: 'bool', default: true, role: 'admin' },
    { key: `sources.${name}.intervalSec`, group: 'sources', source: name, label: `${SOURCE_LABELS[name] || name}: every (seconds)`, type: 'int', min: 30, max: 86400, default: sec, role: 'admin' },
  ]),

  // Storage
  { key: 'storage.feedRetentionHours', group: 'storage', label: 'Keep feed items for (hours)', help: 'How far back the live feed goes. The search index keeps its own copy.', type: 'int', min: 6, max: 2160, default: RETENTION_HOURS, role: 'admin' },
  { key: 'storage.docRetentionDays', group: 'storage', label: 'Keep indexed documents for (days)', help: '0 keeps everything forever. Pinned and edited documents are never deleted.', type: 'int', min: 0, max: 36500, default: 0, role: 'admin' },
  { key: 'storage.maxDocs', group: 'storage', label: 'Maximum documents', help: '0 for no limit. Past it, the oldest are deleted first.', type: 'int', min: 0, max: 100000000, default: 0, role: 'admin' },
  { key: 'storage.mediaMaxGb', group: 'storage', label: 'Image storage budget (GB)', help: 'Past it, the oldest images are deleted first.', type: 'number', min: 0.1, max: 100000, default: envNum('MEDIA_MAX_GB', 5), role: 'admin' },
  { key: 'storage.maxImageMb', group: 'storage', label: 'Largest image stored (MB)', type: 'number', min: 0.1, max: 50, default: envNum('MEDIA_MAX_IMAGE_MB', 2), role: 'admin' },
  { key: 'storage.cachedCopies', group: 'storage', label: 'Show stored copies', help: "Lets visitors read the stored full text of crawled pages. Republishing other sites' articles raises copyright issues; keep off on a public site.", type: 'bool', default: env('CACHED_COPIES', 'off') === 'on', role: 'owner' },

  // Public API protection
  { key: 'limits.searchPerMinute', group: 'limits', label: 'Searches per visitor per minute', type: 'int', min: 10, max: 100000, default: 120, role: 'admin' },
  { key: 'limits.streamPerIp', group: 'limits', label: 'Live connections per visitor', type: 'int', min: 1, max: 50, default: 4, role: 'admin' },
  { key: 'limits.streamTotal', group: 'limits', label: 'Live connections in total', type: 'int', min: 10, max: 1000000, default: 20000, role: 'admin' },
];

export const SCHEMA = new Map(DEFS.map((d) => [d.key, d]));
const ROLE_RANK = { viewer: 0, editor: 1, admin: 2, owner: 3 };
export const roleAtLeast = (role, min) => (ROLE_RANK[role] ?? -1) >= (ROLE_RANK[min] ?? 99);

function validateRobots(text) {
  // Not a full linter: catch obvious mistakes that would block all crawlers by accident or break parsing.
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    if (!/^(user-agent|disallow|allow|crawl-delay|sitemap|host|clean-param|request-rate|visit-time)\s*:/i.test(line)) {
      return `Line ${i + 1} isn't a robots.txt directive: "${raw.slice(0, 60)}"`;
    }
  }
  return null;
}

function checkUrl(v) {
  try {
    const u = new URL(v);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password) return null;
    return u.toString();
  } catch {
    return null;
  }
}

// Returns { value } or { error } with a message a person can act on.
export function validate(def, input) {
  const t = def.type;
  if (t === 'bool') {
    if (typeof input !== 'boolean') return { error: `${def.label} must be on or off.` };
    return { value: input };
  }
  if (t === 'int' || t === 'number') {
    const n = typeof input === 'string' && input.trim() !== '' ? Number(input) : input;
    if (typeof n !== 'number' || !Number.isFinite(n) || (t === 'int' && !Number.isInteger(n))) return { error: `${def.label} must be a ${t === 'int' ? 'whole ' : ''}number.` };
    if (n < def.min || n > def.max) return { error: `${def.label} must be between ${def.min} and ${def.max}.` };
    return { value: n };
  }
  if (t === 'string' || t === 'text') {
    if (typeof input !== 'string') return { error: `${def.label} must be text.` };
    const v = t === 'string' ? input.replace(/[\u0000-\u001f\u007f]/g, '').trim() : input.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    if (def.min && v.length < def.min) return { error: `${def.label} needs at least ${def.min} characters.` };
    if (def.max && v.length > def.max) return { error: `${def.label} can be at most ${def.max} characters.` };
    const custom = def.validate?.(v);
    if (custom) return { error: custom };
    return { value: v };
  }
  if (t === 'url') {
    if (typeof input !== 'string') return { error: `${def.label} must be a link.` };
    if (!input.trim()) return { value: '' };
    const u = checkUrl(input.trim());
    if (!u || !u.startsWith('https://')) return { error: `${def.label} must start with https://.` };
    return { value: u };
  }
  if (t === 'urls') {
    const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/\r?\n/) : null;
    if (!list) return { error: `${def.label} must be a list of links.` };
    const out = [];
    for (const raw of list.map((x) => String(x).trim()).filter(Boolean)) {
      const u = checkUrl(raw);
      if (!u) return { error: `"${raw.slice(0, 80)}" isn't a valid http(s) link.` };
      if (!out.includes(u)) out.push(u);
    }
    if (out.length > def.maxItems) return { error: `${def.label} can hold at most ${def.maxItems} links.` };
    return { value: out };
  }
  if (t === 'hosts') {
    const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/\r?\n/) : null;
    if (!list) return { error: `${def.label} must be a list of hosts.` };
    const out = [];
    for (const raw of list.map((x) => String(x).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '')).filter(Boolean)) {
      const [host, ...path] = raw.split('/');
      if (!HOST_RE.test(host) || (path.length && !def.allowPath)) return { error: `"${raw.slice(0, 80)}" isn't a valid host name.` };
      const v = path.length ? `${host}/${path.join('/')}` : host;
      if (!out.includes(v)) out.push(v);
    }
    if (out.length > def.maxItems) return { error: `${def.label} can hold at most ${def.maxItems} entries.` };
    return { value: out };
  }
  if (t === 'hostRules') {
    if (!Array.isArray(input)) return { error: `${def.label} must be a list.` };
    if (input.length > def.maxItems) return { error: `${def.label} can hold at most ${def.maxItems} rules.` };
    const out = [];
    const seen = new Set();
    for (const r of input) {
      if (!r || typeof r !== 'object') return { error: 'Each site rule needs a host.' };
      const host = String(r.host || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
      if (!HOST_RE.test(host)) return { error: `"${String(r.host).slice(0, 80)}" isn't a valid host name.` };
      if (seen.has(host)) return { error: `There are two rules for ${host}. Merge them into one.` };
      seen.add(host);
      const minDelayMs = r.minDelayMs == null || r.minDelayMs === '' ? null : Number(r.minDelayMs);
      if (minDelayMs != null && (!Number.isInteger(minDelayMs) || minDelayMs < 500 || minDelayMs > 600000)) return { error: `Minimum gap for ${host} must be between 500 and 600000 ms.` };
      const dailyBudget = r.dailyBudget == null || r.dailyBudget === '' ? null : Number(r.dailyBudget);
      if (dailyBudget != null && (!Number.isInteger(dailyBudget) || dailyBudget < 0 || dailyBudget > 200000)) return { error: `Daily page limit for ${host} must be between 0 and 200000.` };
      const disallow = (Array.isArray(r.disallow) ? r.disallow : String(r.disallow || '').split(/\r?\n/)).map((p) => String(p).trim()).filter(Boolean);
      if (disallow.length > 200) return { error: `${host} can have at most 200 blocked paths.` };
      for (const p of disallow) if (!p.startsWith('/') || p.length > 300) return { error: `Blocked paths for ${host} must start with / (got "${p.slice(0, 60)}").` };
      out.push({ host, blocked: r.blocked === true, minDelayMs, dailyBudget, disallow });
    }
    return { value: out };
  }
  return { error: `Unknown setting type for ${def.label}.` };
}

class Settings extends EventEmitter {
  constructor() {
    super();
    this.values = new Map();
    this.version = 0;
    this.loaded = false;
  }

  load() {
    this.values.clear();
    for (const d of DEFS) this.values.set(d.key, structuredClone(d.default));
    for (const row of q('SELECT key, value FROM settings').all()) {
      const def = SCHEMA.get(row.key);
      if (!def) continue; // a key removed in a later version
      try {
        const v = validate(def, JSON.parse(row.value));
        if (!v.error) this.values.set(row.key, v.value);
      } catch { /* corrupt row: keep the default */ }
    }
    this.loaded = true;
    this.version++;
    return this;
  }

  get(key) {
    if (!this.loaded) this.load();
    if (!SCHEMA.has(key)) throw new Error(`Unknown setting ${key}`);
    return this.values.get(key);
  }

  all() {
    if (!this.loaded) this.load();
    return Object.fromEntries(this.values);
  }

  // Validates everything first, then writes all or nothing.
  update(patch, { role, actor }) {
    if (!this.loaded) this.load();
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { errors: { _: 'Send an object of setting names to values.' } };
    const errors = {};
    const changes = [];
    for (const [key, input] of Object.entries(patch)) {
      const def = SCHEMA.get(key);
      if (!def) { errors[key] = 'Unknown setting.'; continue; }
      if (!roleAtLeast(role, def.role)) { errors[key] = `Only ${def.role}s can change this.`; continue; }
      const v = validate(def, input);
      if (v.error) { errors[key] = v.error; continue; }
      const before = this.values.get(key);
      if (JSON.stringify(before) !== JSON.stringify(v.value)) changes.push({ key, before, after: v.value });
    }
    if (Object.keys(errors).length) return { errors };
    if (!changes.length) return { changes };
    tx(() => {
      const s = q('INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by');
      for (const c of changes) s.run(c.key, JSON.stringify(c.after), Date.now(), actor || null);
    });
    for (const c of changes) this.values.set(c.key, c.after);
    this.version++;
    this.emit('change', changes);
    return { changes };
  }

  describe() {
    const updated = Object.fromEntries(q('SELECT key, updated_at, updated_by FROM settings').all().map((r) => [r.key, { at: r.updated_at, by: r.updated_by }]));
    return DEFS.map(({ validate: _v, ...d }) => ({ ...d, value: this.get(d.key), updated: updated[d.key] || null }));
  }

  // Shape used by the spider.
  spider() {
    const g = (k) => this.get(`crawler.${k}`);
    return {
      enabled: g('enabled'), concurrency: g('concurrency'), hostDelayMs: g('hostDelayMs'), hostDailyBudget: g('hostDailyBudget'),
      maxDepth: g('maxDepth'), followExternal: g('followExternal'), hubRecrawlMin: g('hubRecrawlMin'), sitemapRecrawlMin: g('sitemapRecrawlMin'),
      imagesPerPage: g('imagesPerPage'), imageConcurrency: g('imageConcurrency'), hubs: g('hubs'), skipHosts: g('skipHosts'),
      hostRules: new Map(g('hostRules').map((r) => [r.host, r])), maxPageBytes: SPIDER.maxPageBytes,
    };
  }

  // What the public page needs to know.
  publicSite() {
    return {
      name: this.get('site.name'), tagline: this.get('site.tagline'), banner: this.get('site.banner'), bannerLink: this.get('site.bannerLink'),
      showBuilds: this.get('site.showBuilds'), showMarkets: this.get('site.showMarkets'),
    };
  }
}

export const settings = new Settings();
