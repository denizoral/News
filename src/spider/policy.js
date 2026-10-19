// Crawl policy as pure functions: which URLs to queue, how to normalize them,
// and whether a fetched page gets indexed. Kept apart from the engine so the
// rules are easy to read, test and reuse ("Test a URL" runs the same code).

import { hostOf } from '../pipeline/text.js';
import { isAiRelated, countAiTerms } from '../pipeline/classify.js';

export const bare = (h) => String(h || '').replace(/^www\./, '');

// Tracking parameters that never change what a page shows.
const ALWAYS_STRIPPED = /^(utm_|fbclid$|gclid$|dclid$|msclkid$|mc_cid$|mc_eid$|igshid$|ref_src$|_hsenc$|_hsmi$|mkt_tok$)/i;

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

// URL paths often run words together ("artificialintelligenceai") or abbreviate ("/ai/").
const isAiSlug = (path) => isAiRelated(path.replace(/[-_/]/g, ' ')) || /artificial-?intelligence|machine-?learning|generative-?ai|(^|\/)(ai|ml|llms?|genai)(\/|$)/i.test(path);

const looksLikePost = (u) => /\/[^/]*-[^/]*-[^/]*-[^/]*\/?$/.test(new URL(u).pathname);

// Hosts that publish help pages and docs, not news; never promoted to starting sites.
export const isNonNewsHost = (host) => /^(support|help|docs|developer-docs|status|community|forum|forums|accounts?|login|shop|store|careers|jobs)\./i.test(host);

// Hosts whose whole output is about AI; everything they publish is relevant.
const AI_HOSTS = /(openai|anthropic|deepmind|huggingface|mistral|x\.ai|the-decoder|marktechpost|unite\.ai|simonwillison|latent\.space|interconnects|jack-clark|epoch\.ai|machinelearning\.apple)/;
export const isAiHost = (host) => AI_HOSTS.test(host || '');

export function isRelevantText(text, keywords = []) {
  if (isAiRelated(text)) return true;
  const t = text.toLowerCase();
  return keywords.some((k) => t.includes(k));
}

// A page is about AI when its headline or summary says so, or the body keeps
// coming back to it. One stray mention in a long unrelated page isn't enough.
export function isAboutAi(page, keywords = []) {
  if (isRelevantText(`${page.title} ${page.description}`, keywords)) return true;
  const body = (page.text || '').slice(0, 8000);
  const lower = body.toLowerCase();
  return countAiTerms(body, 3) >= 3 || keywords.filter((k) => lower.includes(k)).length >= 2;
}

// Whether a page should be indexed, and why not. `findDuplicate(hash)` returns
// an existing document with the same text, if any; `trusted` holds the
// starting sites, whose pages skip the help-site check.
export function decide(page, cfg, { findDuplicate = () => null, now = Date.now(), trusted = new Set() } = {}) {
  const text = page.text || '';
  if (page.noindex) return { ok: false, outcome: 'skipped', reason: 'Page asks not to be indexed (noindex)' };
  const host = bare(hostOf(page.url || ''));
  if (host && isNonNewsHost(host) && !trusted.has(host)) return { ok: false, outcome: 'skipped', reason: 'Help, docs or store page, not news' };
  if (!page.title) return { ok: false, outcome: 'skipped', reason: 'No title' };
  const head = `${page.title} ${page.description}`.toLowerCase();
  const bad = cfg.excludeKeywords.find((k) => head.includes(k));
  if (bad) return { ok: false, outcome: 'skipped', reason: `Mentions excluded keyword "${bad}"` };
  if (cfg.languages.length && page.lang && !cfg.languages.includes(page.lang)) return { ok: false, outcome: 'skipped', reason: `Language ${page.lang} isn't in the allowed list` };
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
