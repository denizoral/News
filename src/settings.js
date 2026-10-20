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
  github: 'GitHub', producthunt: 'Product Hunt', showhn: 'Show HN', tech: 'Tech (classified)',
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
  { key: 'crawler.obeyRobots', group: 'crawler', section: 'robots', label: 'Obey robots.txt on every site', help: 'When off, the crawler fetches pages even where a site\'s robots.txt says no, and ignores Crawl-delay. Per-site rules, the minimum gap per site, daily page limits and the private-address guard still apply. Owner-only.', type: 'bool', default: true, role: 'owner' },
  { key: 'crawler.enabled', group: 'crawler', section: 'status', label: 'Crawler running', help: 'Pause to stop all page and image fetches. The queue is kept.', type: 'bool', default: env('SPIDER', 'on') !== 'off', role: 'admin' },
  { key: 'crawler.concurrency', group: 'crawler', section: 'pace', label: 'Parallel fetches', help: 'Across all sites. Each site still gets one request at a time.', type: 'int', min: 1, max: 64, default: envNum('SPIDER_CONCURRENCY', SPIDER.concurrency), role: 'admin' },
  { key: 'crawler.hostDelayMs', group: 'crawler', section: 'pace', label: 'Minimum gap per site (ms)', help: "A site's robots.txt Crawl-delay wins when it's longer.", type: 'int', min: 500, max: 120000, default: envNum('SPIDER_HOST_DELAY_MS', SPIDER.hostDelayMs), role: 'admin' },
  { key: 'crawler.hostDailyBudget', group: 'crawler', section: 'pace', label: 'Pages per site per day', type: 'int', min: 10, max: 200000, default: envNum('SPIDER_HOST_BUDGET', SPIDER.hostDailyBudget), role: 'admin' },
  { key: 'crawler.maxDepth', group: 'crawler', section: 'discovery', label: 'Link depth', help: 'How many links away from a starting page the crawler may go.', type: 'int', min: 0, max: 8, default: SPIDER.maxDepth, role: 'admin' },
  { key: 'crawler.followExternal', group: 'crawler', section: 'discovery', label: 'Follow links to other sites', help: 'One hop out, only when the link is about AI.', type: 'bool', default: true, role: 'admin' },
  { key: 'crawler.hubRecrawlMin', group: 'crawler', section: 'pace', label: 'Recheck starting pages every (min)', type: 'int', min: 1, max: 1440, default: SPIDER.hubRecrawlMin, role: 'admin' },
  { key: 'crawler.sitemapRecrawlMin', group: 'crawler', section: 'pace', label: 'Recheck sitemaps every (min)', type: 'int', min: 5, max: 1440, default: SPIDER.sitemapRecrawlMin, role: 'admin' },
  { key: 'crawler.imagesPerPage', group: 'crawler', section: 'indexing', label: 'Images kept per page', type: 'int', min: 0, max: 12, default: SPIDER.imagesPerPage, role: 'admin' },
  { key: 'crawler.imageConcurrency', group: 'crawler', section: 'fetch', label: 'Parallel image downloads', type: 'int', min: 0, max: 16, default: SPIDER.imageConcurrency, role: 'admin' },
  { key: 'crawler.hubs', group: 'crawler', section: 'where', label: 'Starting pages', help: 'One URL per line. Their sites are trusted: the crawler follows any link inside them.', type: 'urls', maxItems: 500, default: SPIDER.hubs, role: 'admin' },
  { key: 'crawler.skipHosts', group: 'crawler', section: 'where', label: 'Never crawl', help: 'One host per line (subdomains included), or host/path.', type: 'hosts', maxItems: 2000, allowPath: true, default: SPIDER.skipHosts, role: 'admin' },
  { key: 'crawler.hostRules', group: 'crawler', section: 'rules', label: 'Per-site rules', help: 'Rules for specific sites. Blocking, slowing down, page caps and extra blocked paths are on top of robots.txt. Ignoring robots.txt is owner-only and logged.', type: 'hostRules', maxItems: 2000, default: [], role: 'admin', checkRole: hostRulesRole },

  // Crawler: identity
  { key: 'crawler.botName', group: 'crawler', section: 'identity', label: 'Bot name', help: 'Sent in the User-Agent and matched against robots.txt groups. Letters, digits and dashes.', type: 'string', min: 3, max: 40, default: 'FrontierWireBot', role: 'admin', validate: (v) => (/^[A-Za-z][A-Za-z0-9-]{2,39}$/.test(v) ? null : 'Use 3 to 40 letters, digits or dashes, starting with a letter.') },
  { key: 'crawler.contactUrl', group: 'crawler', section: 'identity', label: 'Contact URL', help: "Where site owners can learn about the bot or ask you to stop. Shown in the User-Agent.", type: 'url', default: 'https://github.com/denizoral/News', role: 'admin' },
  { key: 'crawler.acceptLanguage', group: 'crawler', section: 'identity', label: 'Accept-Language header', type: 'string', min: 2, max: 100, default: 'en-US,en;q=0.9', role: 'admin', validate: (v) => (/^[A-Za-z0-9,;=.\- *]+$/.test(v) ? null : 'Use language tags like en-US,en;q=0.9.') },

  // Crawler: fetching
  { key: 'crawler.timeoutSec', group: 'crawler', section: 'fetch', label: 'Request timeout (seconds)', type: 'int', min: 3, max: 120, default: 20, role: 'admin' },
  { key: 'crawler.maxPageKb', group: 'crawler', section: 'fetch', label: 'Largest page read (KB)', help: 'Anything longer is cut off at this size.', type: 'int', min: 64, max: 32768, default: 4096, role: 'admin' },
  { key: 'crawler.maxRedirects', group: 'crawler', section: 'fetch', label: 'Redirects followed', type: 'int', min: 0, max: 10, default: 5, role: 'admin' },
  { key: 'crawler.hostFailureLimit', group: 'crawler', section: 'fetch', label: 'Pause a site after this many failures in a row', help: 'Timeouts, connection errors and server errors. The pause starts at 15 minutes and doubles, up to 6 hours. Rate limits (HTTP 429) are always honored separately.', type: 'int', min: 2, max: 100, default: 8, role: 'admin' },
  { key: 'crawler.maxAttempts', group: 'crawler', section: 'fetch', label: 'Attempts before giving up', help: 'For timeouts and server errors. 404s and 403s are never retried.', type: 'int', min: 1, max: 10, default: 3, role: 'admin' },

  // Crawler: pace and schedule
  { key: 'crawler.maxPagesPerMinute', group: 'crawler', section: 'pace', label: 'Pages per minute, all sites (0 = no cap)', type: 'int', min: 0, max: 100000, default: 0, role: 'admin' },
  { key: 'crawler.quietHours', group: 'crawler', section: 'pace', label: 'Quiet hours (UTC)', help: 'No crawling in this window, e.g. 01:00-06:00. Leave empty to crawl around the clock.', type: 'string', max: 11, default: '', role: 'admin', validate: (v) => (!v || /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(v) ? null : 'Use HH:MM-HH:MM in 24-hour UTC, e.g. 01:00-06:00.') },
  { key: 'crawler.queueMaxAgeHours', group: 'crawler', section: 'pace', label: 'Drop unfetched articles after (hours)', help: "News goes stale: articles still waiting after this long leave the queue, so it doesn't grow forever. 0 keeps them.", type: 'int', min: 0, max: 2160, default: 72, role: 'admin' },
  { key: 'crawler.hostQueueCap', group: 'crawler', section: 'pace', label: 'Queued articles per site', help: 'Beyond this, the lowest-priority, oldest ones are dropped.', type: 'int', min: 100, max: 1000000, default: 3000, role: 'admin' },
  { key: 'crawler.undatedPerSection', group: 'crawler', section: 'indexing', label: 'Undated pages per section per day', help: 'Generated pages (comparisons, directories) usually have no date. A site section (example.com/compare/…) indexes at most this many undated pages a day. Starting sites and AI publishers are exempt. 0 turns the limit off.', type: 'int', min: 0, max: 100000, default: 20, role: 'admin' },
  { key: 'crawler.feedRecrawlMin', group: 'crawler', section: 'pace', label: 'Recheck feeds every (min)', type: 'int', min: 2, max: 1440, default: 20, role: 'admin' },
  { key: 'crawler.adaptiveRecrawl', group: 'crawler', section: 'pace', label: 'Adapt recheck intervals', help: 'Starting pages, sitemaps and feeds that keep yielding nothing new are checked less often (up to 8 times the interval) and go back to normal as soon as they have news.', type: 'bool', default: true, role: 'admin' },
  { key: 'crawler.honorCrawlDelay', group: 'crawler', section: 'pace', label: 'Honor Crawl-delay from robots.txt', help: 'When off, only the minimum gap per site applies.', type: 'bool', default: true, role: 'admin' },

  // Crawler: discovery
  { key: 'crawler.discoverFeeds', group: 'crawler', section: 'discovery', label: 'Discover and read RSS/Atom feeds', help: 'Feeds advertised by crawled pages are checked regularly for new articles, often faster than sitemaps.', type: 'bool', default: true, role: 'admin' },
  { key: 'crawler.feedsPerSite', group: 'crawler', section: 'discovery', label: 'Feeds followed per site', type: 'int', min: 0, max: 20, default: 3, role: 'admin' },
  { key: 'crawler.autoHubs', group: 'crawler', section: 'where', label: 'Discovered starting sites (0 = off)', help: 'Sites that keep producing indexed articles get their homepage added as a starting page, up to this many. Review them under Sites.', type: 'int', min: 0, max: 500, default: 25, role: 'admin' },
  { key: 'crawler.useSitemaps', group: 'crawler', section: 'discovery', label: 'Read sitemaps', help: 'Sitemaps listed in robots.txt of starting sites.', type: 'bool', default: true, role: 'admin' },
  { key: 'crawler.sitemapMaxAgeDays', group: 'crawler', section: 'discovery', label: 'Sitemap entries newer than (days)', type: 'int', min: 1, max: 3650, default: 7, role: 'admin' },
  { key: 'crawler.sitemapMaxUrls', group: 'crawler', section: 'discovery', label: 'URLs taken per sitemap', type: 'int', min: 10, max: 50000, default: 300, role: 'admin' },
  { key: 'crawler.respectNofollow', group: 'crawler', section: 'discovery', label: 'Respect nofollow', help: 'Skip links marked rel=nofollow, sponsored or ugc, and pages with a nofollow meta tag.', type: 'bool', default: true, role: 'admin' },
  { key: 'crawler.includePatterns', group: 'crawler', section: 'discovery', label: 'Only crawl URLs matching', help: 'One pattern per line, * matches anything, e.g. https://*.example.com/news/*. Empty means everything.', type: 'patterns', maxItems: 500, default: [], role: 'admin' },
  { key: 'crawler.excludePatterns', group: 'crawler', section: 'discovery', label: 'Never crawl URLs matching', help: 'One pattern per line, e.g. */tag/* or *?page=*.', type: 'patterns', maxItems: 500, default: ['https://job-boards.*', 'https://jobs.*', '*/careers/*', '*/jobs/*', '*/job/*'], role: 'admin' },
  { key: 'crawler.stripQueryParams', group: 'crawler', section: 'discovery', label: 'Remove these query parameters', help: 'One name per line; * removes every query string. Tracking parameters (utm_*, fbclid…) are always removed.', type: 'words', maxItems: 200, default: [], role: 'admin' },
  { key: 'crawler.maxQueue', group: 'crawler', section: 'discovery', label: 'Largest queue', help: 'Past this, low-priority links are dropped instead of queued.', type: 'int', min: 1000, max: 50000000, default: 250000, role: 'admin' },

  // Crawler: what gets indexed
  { key: 'crawler.relevance', group: 'crawler', section: 'indexing', label: 'Index which pages', type: 'enum', options: [['ai', 'Only pages about AI'], ['keywords', 'Only pages with one of the keywords below'], ['all', 'Every article the crawler finds']], default: 'ai', role: 'admin' },
  { key: 'crawler.includeKeywords', group: 'crawler', section: 'indexing', label: 'Keywords', help: 'One per line. Used when indexing by keywords; otherwise they count as AI terms too.', type: 'words', maxItems: 500, default: [], role: 'admin' },
  { key: 'crawler.excludeKeywords', group: 'crawler', section: 'indexing', label: 'Skip pages mentioning', help: 'One per line, matched in the title and description.', type: 'words', maxItems: 500, default: [], role: 'admin' },
  { key: 'crawler.minWords', group: 'crawler', section: 'indexing', label: 'Minimum words', help: 'Shorter pages are not indexed.', type: 'int', min: 0, max: 10000, default: 100, role: 'admin' },
  { key: 'crawler.maxArticleAgeDays', group: 'crawler', section: 'indexing', label: 'Skip articles older than (days, 0 = any age)', type: 'int', min: 0, max: 36500, default: 0, role: 'admin' },
  { key: 'crawler.languages', group: 'crawler', section: 'indexing', label: 'Languages', help: 'Two-letter codes, one per line (en, de…). Pages, sitemaps and feeds in other languages are skipped. Empty means any language.', type: 'words', maxItems: 50, default: ['en'], role: 'admin', validate: (list) => list.find((l) => !/^[a-z]{2}$/.test(l)) ? 'Use two-letter language codes like en or de.' : null },
  { key: 'crawler.recrawlHours', group: 'crawler', section: 'indexing', label: 'Recheck fresh articles after (hours, 0 = never)', help: 'Articles from the last 3 days are fetched again to pick up updates and corrections.', type: 'int', min: 0, max: 168, default: 0, role: 'admin' },

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

// Turning on "ignore robots.txt" for a site is owner-only; other rule edits need admin.
function hostRulesRole(before, after, role) {
  if (role === 'owner') return null;
  const was = new Set((before || []).filter((r) => r.ignoreRobots).map((r) => r.host));
  const now = new Set(after.filter((r) => r.ignoreRobots).map((r) => r.host));
  const changed = [...now].some((h) => !was.has(h)) || [...was].some((h) => !now.has(h));
  return changed ? 'Only owners can change which sites ignore robots.txt.' : null;
}

// URL patterns: * matches any run of characters; everything else is literal,
// case-insensitive. Matched with the classic two-pointer wildcard algorithm,
// O(pattern x URL) at worst; a regex could backtrack exponentially.
export function compileGlob(pattern) {
  const p = pattern.toLowerCase();
  const fn = (input) => {
    const s = String(input).toLowerCase();
    let i = 0;
    let j = 0;
    let star = -1;
    let mark = 0;
    while (i < s.length) {
      if (j < p.length && p[j] !== '*' && p[j] === s[i]) { i++; j++; }
      else if (j < p.length && p[j] === '*') { star = j++; mark = i; }
      else if (star !== -1) { j = star + 1; i = ++mark; }
      else return false;
    }
    while (j < p.length && p[j] === '*') j++;
    return j === p.length;
  };
  fn.source = pattern;
  return fn;
}

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
  if (t === 'enum') {
    if (!def.options.some(([k]) => k === input)) return { error: `Choose one of: ${def.options.map(([, l]) => l).join('; ')}.` };
    return { value: input };
  }
  if (t === 'words' || t === 'patterns') {
    const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/\r?\n/) : null;
    if (!list) return { error: `${def.label} must be a list, one per line.` };
    const out = [];
    for (const raw of list.map((x) => String(x).trim()).filter(Boolean)) {
      const v = t === 'words' ? raw.toLowerCase() : raw;
      if (v.length > (t === 'words' ? 60 : 300)) return { error: `"${v.slice(0, 40)}…" is too long.` };
      if (/[\u0000-\u001f\u007f]/.test(v)) return { error: `"${v.slice(0, 40)}" contains control characters.` };
      if (t === 'patterns' && (v.match(/\*/g) || []).length > 8) return { error: `"${v.slice(0, 60)}" has too many wildcards (at most 8).` };
      if (!out.includes(v)) out.push(v);
    }
    if (out.length > def.maxItems) return { error: `${def.label} can hold at most ${def.maxItems} entries.` };
    const custom = def.validate?.(out);
    if (custom) return { error: custom };
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
      out.push({ host, blocked: r.blocked === true, ignoreRobots: r.ignoreRobots === true, minDelayMs, dailyBudget, disallow });
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
      const roleError = def.checkRole?.(before, v.value, role);
      if (roleError) { errors[key] = roleError; continue; }
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
      imagesPerPage: g('imagesPerPage'), imageConcurrency: g('imageConcurrency'), hubs: g('hubs'), hubHosts: g('hubs').map((u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }), skipHosts: g('skipHosts'),
      hostRules: new Map(g('hostRules').map((r) => [r.host, r])),
      obeyRobots: g('obeyRobots'),
      discoverFeeds: g('discoverFeeds'), feedsPerSite: g('feedsPerSite'), feedRecrawlMin: g('feedRecrawlMin'), queueMaxAgeHours: g('queueMaxAgeHours'), hostQueueCap: g('hostQueueCap'), undatedPerSection: g('undatedPerSection'), adaptiveRecrawl: g('adaptiveRecrawl'),
      autoHubs: g('autoHubs'), hostFailureLimit: g('hostFailureLimit'),
      botName: g('botName'), contactUrl: g('contactUrl'), acceptLanguage: g('acceptLanguage'),
      timeoutMs: g('timeoutSec') * 1000, maxPageBytes: g('maxPageKb') * 1024, maxRedirects: g('maxRedirects'), maxAttempts: g('maxAttempts'),
      maxPagesPerMinute: g('maxPagesPerMinute'), quietHours: g('quietHours'), honorCrawlDelay: g('honorCrawlDelay'),
      useSitemaps: g('useSitemaps'), sitemapMaxAgeDays: g('sitemapMaxAgeDays'), sitemapMaxUrls: g('sitemapMaxUrls'), respectNofollow: g('respectNofollow'),
      includePatterns: g('includePatterns').map(compileGlob), excludePatterns: g('excludePatterns').map(compileGlob),
      stripQueryParams: g('stripQueryParams'), maxQueue: g('maxQueue'),
      relevance: g('relevance'), includeKeywords: g('includeKeywords'), excludeKeywords: g('excludeKeywords'), minWords: g('minWords'),
      maxArticleAgeDays: g('maxArticleAgeDays'), languages: g('languages'), recrawlHours: g('recrawlHours'),
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
