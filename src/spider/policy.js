// Crawl policy as pure functions: which URLs to queue, how to normalize them,
// and whether a fetched page gets indexed. Kept apart from the engine so the
// rules are easy to read, test and reuse ("Test a URL" runs the same code).

import { hostOf } from '../pipeline/text.js';
import { isAiRelated, countAiTerms } from '../pipeline/classify.js';

export const bare = (h) => String(h || '').replace(/^www\./, '');

// Tracking parameters that never change what a page shows.
// Includes consent-manager parameters (cmpscreencustom) that some sites add to every link.
const ALWAYS_STRIPPED = /^(utm_|fbclid$|gclid$|dclid$|msclkid$|mc_cid$|mc_eid$|igshid$|ref_src$|_hsenc$|_hsmi$|mkt_tok$|cmpscreencustom$|cmpscreen$)/i;

export function cleanUrl(u, strip = []) {
  const url = new URL(u);
  if (strip.includes('*')) url.search = '';
  else for (const k of [...url.searchParams.keys()]) if (ALWAYS_STRIPPED.test(k) || strip.includes(k.toLowerCase())) url.searchParams.delete(k);
  return url.toString().replace(/\?$/, '');
}

// skipHosts entries are hosts (subdomains included) or host/path prefixes.
export function isSkipped(url, skipHosts = []) {
  const h = bare(hostOf(url));
  return skipHosts.some((s) => (s.includes('/') ? url.includes(s) : h === s || h.endsWith(`.${s}`)));
}

export function allowedByPatterns(u, { includePatterns = [], excludePatterns = [] } = {}) {
  if (excludePatterns.some((m) => m(u))) return false;
  return !includePatterns.length || includePatterns.some((m) => m(u));
}

// A feed worth following: the site's main feed, or one about AI. Skips
// per-article comment feeds (/some-long-post-slug/feed) and off-topic sections.
export function isUsefulFeed(feedUrl, pageUrl) {
  let u;
  try {
    u = new URL(feedUrl);
  } catch {
    return false;
  }
  if (/comments?|replies|reviews/i.test(u.pathname + u.search)) return false;
  const segs = u.pathname.split('/').filter(Boolean);
  const content = segs.filter((s) => !/^(feed|feeds|rss|atom|index\.xml|rss\.xml|feed\.xml|atom\.xml|xml|all)$/i.test(s));
  if (content.some((s) => s.split('-').length >= 4)) return false; // a post's own feed
  if (pageUrl && feedUrl.startsWith(pageUrl.replace(/\/$/, '') + '/') && looksLikePost(pageUrl)) return false;
  if (content.length <= 1 && !content.some((s) => s.length > 30)) return true; // site-wide: /feed, /blog/rss, /news/feed.xml
  return isAiSlug(content.join('/'));
}

// Of the sitemaps robots.txt lists, the ones likely to hold recent articles:
// all of a short list, or the news/post/dated ones of a long one. Image,
// video, tag and author sitemaps never hold news.
const NEWSY_SITEMAP = /news|post|article|\d{4}|\/sitemaps?([-_]index)?\.xml(\.gz)?$/i;
const OFF_TOPIC_SITEMAP = /(^|[/_-])(images?|videos?|tags?|topics?|categor(y|ies)|authors?|pages?|products?|sections?|hubs?|stores?|locations?)([/_.-]|\d|$)/i;
export function pickSitemaps(listed = [], opts = {}) {
  const useful = listed.filter((sm) => isWantedSitemap(sm, opts));
  return useful.length <= 3 ? useful : useful.filter((sm) => NEWSY_SITEMAP.test(sm)).slice(0, 6);
}

// A sitemap worth rechecking: one that lists articles (not tags, authors or
// images), not a translation the crawler won't index, and not a monthly or
// yearly archive (Sitemap_Index_Feb_2022.xml.gz).
export function isWantedSitemap(url, { languages = [], now = Date.now() } = {}) {
  try {
    return !OFF_TOPIC_SITEMAP.test(new URL(url).pathname) && !isOtherLanguage(url, languages) && !isArchiveSitemap(url, now);
  } catch {
    return false;
  }
}

// /es/, /de-de/ and similar locale prefixes, when only some languages are
// wanted. Used for sitemaps and feeds, where /es/sitemap.xml is reliably a
// translation. Pages are judged by their declared language instead: a path
// like theverge.com/cs/features/… is English.
const LOCALES = new Set('ar bg cs da de el es et fa fi fr he hi hr hu id it ja ko lt lv ms nb nl no pl pt ro ru sk sl sr sv th tr uk vi zh'.split(' '));
export const localeOf = (url) => new URL(url).pathname.match(/^\/([a-z]{2})(?:[-_][a-z]{2})?\//i)?.[1].toLowerCase() || null;
export function isOtherLanguage(url, languages = []) {
  if (!languages.length) return false;
  const code = localeOf(url);
  return !!code && LOCALES.has(code) && !languages.includes(code);
}

// Dated sitemaps older than two months only list old articles.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function isArchiveSitemap(url, now = Date.now()) {
  const path = new URL(url).pathname.toLowerCase();
  const ym = path.match(/(?<!\d)(20\d\d)[-_/]?(0[1-9]|1[0-2])(?!\d)/);
  const my = path.match(new RegExp(`(${MONTHS.join('|')})[a-z]*[-_]?(20\\d\\d)(?!\\d)`));
  const y = path.match(/(?<!\d)(20\d\d)(?!\d)/);
  // The first moment after the period the sitemap covers.
  const end = ym ? Date.UTC(+ym[1], +ym[2], 1) : my ? Date.UTC(+my[2], MONTHS.indexOf(my[1]) + 1, 1) : y ? Date.UTC(+y[1] + 1, 0, 1) : null;
  return end != null && end < now - 62 * 86400e3;
}

// Editorial and research sections hold articles and papers even when a page
// carries no date; generated pages live elsewhere (/compare, /models, /skills).
export const isEditorialSection = (url) => /^\/(blogs?|news|newsroom|press|articles?|stories|posts?|abs|pdf|papers?|pubs|publications|research|\d{4})(\/|$)/i.test(new URL(url).pathname);

// Sites sometimes declare the wrong language (bcg.com labels English pages
// "bs"). English text is about a quarter common function words; other
// languages that share a few ("a", "in") come nowhere near.
const EN_WORDS = new Set('the of and to in is that for it with as was on be by are this at from or an have not but which their has its were they been will can more one would also we our you'.split(' '));
export function looksEnglish(text) {
  const words = String(text || '').slice(0, 4000).toLowerCase().match(/[a-z']+/g) || [];
  if (words.length < 50) return false;
  return words.filter((w) => EN_WORDS.has(w)).length / words.length >= 0.15;
}

// The section a page belongs to, for per-section limits: host plus first path segment.
// The first path segment, or the first two when the first is a locale, so
// nvidia.com/en-us/geforce and nvidia.com/en-us/blog are separate sections.
export function sectionPath(url) {
  const segs = (url instanceof URL ? url : new URL(url)).pathname.toLowerCase().split('/').filter(Boolean);
  if (/^[a-z]{2}([-_][a-z]{2})?$/.test(segs[0] || '') && segs[1]) return `${segs[0]}/${segs[1]}`;
  return segs[0] || '';
}

export function sectionOf(url) {
  const u = new URL(url);
  return { site: bare(u.hostname), prefix: `${u.origin}/${sectionPath(u)}` };
}

// Listing pages (a tag, topic or author's page) that sitemaps often include
// alongside articles.
// /tag/ai/, /category/ml/llms/ and /page/3 are listings; /topics/security/a-long-post-slug
// is an article that merely lives under a topic.
export function isListingUrl(url) {
  const segs = new URL(url).pathname.split('/').filter(Boolean);
  if (/^page$/i.test(segs.at(-2) || '') && /^\d+$/.test(segs.at(-1) || '')) return true;
  const i = segs.findIndex((s) => /^(tags?|topics?|authors?|category|categories|section|sections|series|people)$/i.test(s));
  return i >= 0 && segs.slice(i + 1).every((s) => s.split(/[-_]/).length < 4);
}

// Judging an untitled link by its URL: true or false when the slug is
// descriptive (three or more words), null when it's opaque (/p/48213).
export function slugRelevance(url) {
  let path;
  try {
    path = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  const words = path.split(/[^a-z0-9]+/i).filter((w) => /[a-z]/i.test(w));
  const slug = path.split('/').filter(Boolean).pop() || '';
  if (slug.split(/[-_]/).length < 3) return null;
  return isAiSlug(path) || isAiRelated(words.join(' '));
}

// URL paths often run words together ("artificialintelligenceai") or abbreviate ("/ai/").
const isAiSlug = (path) => isAiRelated(path.replace(/[-_/]/g, ' ')) || /artificial-?intelligence|machine-?learning|generative-?ai|(^|\/)(ai|ml|llms?|genai)(\/|$)/i.test(path);

const looksLikePost = (u) => /\/[^/]*-[^/]*-[^/]*-[^/]*\/?$/.test(new URL(u).pathname);

// Hosts that publish help pages and docs, not news; never promoted to starting sites.
export const isNonNewsHost = (host) => /^(support|help|docs|developer-docs|status|community|forum|forums|accounts?|login|signin|auth|console|dashboard|portal|app|shop|store|careers|jobs|job-boards|boards)\./i.test(host) || NON_NEWS_DOMAINS.test(host);
// Job boards, stock-photo libraries (articles link every photo credit),
// social sites and AI apps that show crawlers a login wall, chat invites and
// app-store pages.
const NON_NEWS_DOMAINS = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|gettyimages\.[a-z.]+|shutterstock\.com|alamy\.com|istockphoto\.com|stock\.adobe\.com|unsplash\.com|pexels\.com|flickr\.com|facebook\.com|instagram\.com|linkedin\.com|tiktok\.com|x\.com|twitter\.com|threads\.net|claude\.ai|chatgpt\.com|gemini\.google\.com|discord\.com|discord\.gg|t\.me|wa\.me|apps\.apple\.com|play\.google\.com)$/i;
// The same sections on a news site's own domain (claude.com/docs/…).
export const isNonNewsPath = (url) => { try { return NON_NEWS_PATH.test(new URL(url).pathname); } catch { return false; } };
const NON_NEWS_PATH = /^\/([a-z]{2}(-[a-z]{2})?\/)?(docs|documentation|help|support|kb|knowledge-base|legal|careers|jobs|pricing|login|signup|civis|forums?|community|threads|discussions?)(\/|$)/i;

// Hosts whose whole output is about AI; everything they publish is relevant.
const AI_HOSTS = /(openai|anthropic|deepmind|huggingface|mistral|x\.ai|the-decoder|marktechpost|unite\.ai|simonwillison|latent\.space|interconnects|jack-clark|epoch\.ai|machinelearning\.apple)/;
export const isAiHost = (host) => AI_HOSTS.test(host || '');

export function isRelevantText(text, keywords = []) {
  if (isAiRelated(text)) return true;
  const t = text.toLowerCase();
  return keywords.some((k) => t.includes(k));
}

// A stricter test for headlines from general news (GDELT): words that are AI
// terms only in context ("ICE agents", "token economy", "weights", Transformers
// the film) count only right after "AI".
const AMBIGUOUS = /\b(?<!\bai[- ])(agents?|tokens?|weights|transformers?|diffusion)\b/gi;
export function isAiHeadline(title, keywords = []) {
  return isRelevantText(String(title).replace(AMBIGUOUS, ' '), keywords);
}

// A page is about AI when its headline or summary says so, or the body keeps
// coming back to it. One stray mention in a long unrelated page isn't enough.
// Words that are AI terms only in context ("ICE agents") don't count alone.
export function isAboutAi(page, keywords = []) {
  if (isAiHeadline(`${page.title} ${page.description}`, keywords)) return true;
  const body = (page.text || '').slice(0, 8000).replace(AMBIGUOUS, ' ');
  const lower = body.toLowerCase();
  return countAiTerms(body, 3) >= 3 || keywords.filter((k) => lower.includes(k)).length >= 2;
}

// Whether a page should be indexed, and why not. `findDuplicate(hash)` returns
// an existing document with the same text, if any; `undatedInSection(page)`
// how many undated pages its site section indexed in the last day;
// `sameTitleOnSite(page)` how many other indexed pages there share its title; `trusted`
// holds the starting sites, whose pages skip the help-site check.
export function decide(page, cfg, { findDuplicate = () => null, undatedInSection = () => 0, sameTitleOnSite = () => 0, now = Date.now(), trusted = new Set() } = {}) {
  const text = page.text || '';
  if (page.noindex) return { ok: false, outcome: 'skipped', reason: 'Page asks not to be indexed (noindex)' };
  const host = bare(hostOf(page.url || ''));
  const path = (() => { try { return new URL(page.url).pathname; } catch { return ''; } })();
  if (host && ((isNonNewsHost(host) && !trusted.has(host)) || NON_NEWS_PATH.test(path))) return { ok: false, outcome: 'skipped', reason: 'Help, docs or store page, not news' };
  if (!page.title) return { ok: false, outcome: 'skipped', reason: 'No title' };
  const head = `${page.title} ${page.description}`.toLowerCase();
  const bad = cfg.excludeKeywords.find((k) => head.includes(k));
  if (bad) return { ok: false, outcome: 'skipped', reason: `Mentions excluded keyword "${bad}"` };
  if (cfg.languages.length && page.lang && !cfg.languages.includes(page.lang) && !(cfg.languages.includes('en') && looksEnglish(text))) {
    return { ok: false, outcome: 'skipped', reason: `Language ${page.lang} isn't in the allowed list` };
  }
  const words = text ? text.split(/\s+/).length : 0;
  if (words < cfg.minWords) return { ok: false, outcome: 'skipped', reason: `Too short (${words} words, minimum ${cfg.minWords})` };
  if (!page.isArticle && text.length < 600) return { ok: false, outcome: 'skipped', reason: "Doesn't look like an article" };
  if (cfg.maxArticleAgeDays && page.published_at && now - page.published_at > cfg.maxArticleAgeDays * 86400e3) {
    return { ok: false, outcome: 'skipped', reason: `Older than ${cfg.maxArticleAgeDays} days` };
  }
  const sample = `${page.title} ${page.description} ${text.slice(0, 4000)}`;
  if (cfg.relevance === 'keywords') {
    const hit = cfg.includeKeywords.find((k) => sample.toLowerCase().includes(k));
    if (!hit) return { ok: false, outcome: 'skipped', reason: 'None of the keywords appear' };
  } else if (cfg.relevance === 'ai' && !isAiHost(page.site) && !isAboutAi(page, cfg.includeKeywords)) {
    return { ok: false, outcome: 'skipped', reason: 'Not about AI' };
  }
  // Generated sites flood one section with undated pages. Sites the admin
  // chose, AI publishers and editorial sections are exempt.
  if (!page.published_at && cfg.undatedPerSection && !isAiHost(host) && !(cfg.hubHosts || []).includes(host) && !isEditorialSection(page.url) && undatedInSection(page) >= cfg.undatedPerSection) {
    return { ok: false, outcome: 'skipped', capped: true, reason: `Undated, and this section already had ${cfg.undatedPerSection} undated pages today (looks generated)` };
  }
  // Landing and listing pages often share the site's generic title ("Vector
  // Wire — AI intelligence terminal"). Dated posts that share one (a daily
  // newsletter's "Not much happened today") are kept.
  if (!page.published_at && sameTitleOnSite(page) >= 2) {
    return { ok: false, outcome: 'skipped', reason: 'Undated, with the same title as other pages on this site (a landing or listing page)' };
  }
  const dup = page.contentHash ? findDuplicate(page.contentHash) : null;
  if (dup && dup.url !== page.url) return { ok: false, outcome: 'duplicate', reason: `Same text as ${dup.url}` };
  return { ok: true, words };
}

// "01:00-06:00" in UTC; windows may wrap past midnight ("22:00-05:00").
export function inQuietHours(spec, now = Date.now()) {
  if (!spec) return false;
  const m = spec.match(/^(\d\d):(\d\d)-(\d\d):(\d\d)$/);
  if (!m) return false;
  const start = +m[1] * 60 + +m[2];
  const end = +m[3] * 60 + +m[4];
  if (start === end) return false;
  const d = new Date(now);
  const t = d.getUTCHours() * 60 + d.getUTCMinutes();
  return start < end ? t >= start && t < end : t >= start || t < end;
}
