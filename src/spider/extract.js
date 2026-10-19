// Turns a fetched HTML page into a document: metadata (Open Graph, JSON-LD,
// meta tags), the main article text (Mozilla Readability), outbound links with
// anchor text, and candidate images with alt text and captions.

import crypto from 'node:crypto';
import { parseHTML } from 'linkedom';
import { Readability } from '@mozilla/readability';
import { canonicalUrl, hostOf, clip } from '../pipeline/text.js';

const SKIP_EXT = /\.(jpe?g|png|gif|webp|svg|ico|pdf|zip|gz|tar|mp[34]|m4a|mov|avi|webm|wav|exe|dmg|apk|css|js|json|xml|rss|woff2?|ttf)(\?|$)/i;
const SKIP_PATH = /\/(login|signin|signup|register|account|cart|checkout|share|subscribe|newsletter|privacy|terms|cookie|cdn-cgi|wp-admin|wp-login|feed|profile|users?|members?|tag\/page|author\/[^/]+\/page)\b|[?&](replytocom|share|utm_|output=amp)/i;

export function normalizeLink(href, base) {
  href = href?.trim();
  if (!href || /^(javascript|mailto|tel|data):/i.test(href) || href.startsWith('#')) return null;
  try {
    const u = new URL(href, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    if (SKIP_EXT.test(u.pathname) || SKIP_PATH.test(u.pathname + u.search)) return null;
    return canonicalUrl(u.toString());
  } catch {
    return null;
  }
}

function meta(document, ...names) {
  for (const n of names) {
    const el = document.querySelector(`meta[property="${n}"], meta[name="${n}"], meta[itemprop="${n}"]`);
    const v = el?.getAttribute('content')?.trim();
    if (v) return v;
  }
  return null;
}

function jsonLd(document) {
  const out = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(s.textContent);
      const stack = Array.isArray(data) ? [...data] : [data];
      while (stack.length) {
        const n = stack.shift();
        if (!n || typeof n !== 'object') continue;
        if (Array.isArray(n)) { stack.push(...n); continue; }
        if (n['@graph']) stack.push(...[].concat(n['@graph']));
        out.push(n);
      }
    } catch { /* malformed JSON-LD is common */ }
  }
  return out;
}

const ARTICLE_TYPES = /^(NewsArticle|Article|BlogPosting|ReportageNewsArticle|TechArticle|AnalysisNewsArticle|ScholarlyArticle|LiveBlogPosting)$/;

function dateFrom(...vals) {
  for (const v of vals) {
    if (!v) continue;
    const t = Date.parse(v);
    if (Number.isFinite(t) && t > Date.parse('1995-01-01') && t < Date.now() + 86400e3) return t;
  }
  return null;
}

function dateInUrl(url) {
  const m = url.match(/\/(20\d{2})[/-](\d{1,2})[/-](\d{1,2})(?:\/|$|-)/) || url.match(/\/(20\d{2})(\d{2})(\d{2})\//);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
}

// Heuristic: does this URL look like an individual article rather than a listing?
export function looksLikeArticleUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/$/, '');
    const segs = path.split('/').filter(Boolean);
    if (!segs.length) return false;
    const last = segs[segs.length - 1];
    if (dateInUrl(url)) return true;
    if (/^(category|tag|topic|section|author|page|search|about|contact|jobs|careers|events|podcasts?|videos?)$/i.test(segs[0]) && segs.length <= 2) return false;
    return last.split('-').length >= 4 || /\d{5,}/.test(last) || (segs.length >= 2 && last.length >= 25);
  } catch {
    return false;
  }
}

export function extractPage(html, pageUrl, { respectNofollow = true } = {}) {
  const { document } = parseHTML(html);
  const robotsMeta = (meta(document, 'robots') || '') + ' ' + (meta(document, 'googlebot') || '');
  const noindex = /noindex/i.test(robotsMeta);
  const noarchive = /noarchive|nosnippet/i.test(robotsMeta);
  const nofollow = respectNofollow && /nofollow/i.test(robotsMeta);

  const canonicalHref = document.querySelector('link[rel="canonical"]')?.getAttribute('href');
  const canonical = normalizeLink(canonicalHref, pageUrl) || canonicalUrl(pageUrl);
  const ld = jsonLd(document);
  const art = ld.find((n) => [].concat(n['@type'] || []).some((t) => ARTICLE_TYPES.test(t)));

  const title = (meta(document, 'og:title', 'twitter:title') || art?.headline || document.querySelector('title')?.textContent || '').trim().replace(/\s+/g, ' ');
  const description = (meta(document, 'og:description', 'description', 'twitter:description') || art?.description || '').trim();
  const ogImage = meta(document, 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src') || [].concat(art?.image || [])[0]?.url || [].concat(art?.image || [])[0];
  const author = meta(document, 'author', 'article:author', 'parsely-author') || [].concat(art?.author || []).map((a) => a?.name || a).filter((a) => typeof a === 'string').join(', ');
  const published = dateFrom(
    meta(document, 'article:published_time', 'og:article:published_time', 'datePublished', 'pubdate', 'parsely-pub-date', 'sailthru.date', 'date', 'DC.date.issued'),
    art?.datePublished, art?.dateCreated,
    document.querySelector('time[datetime]')?.getAttribute('datetime'),
  ) || dateInUrl(canonical);
  const ogType = meta(document, 'og:type') || '';
  const lang = (document.documentElement?.getAttribute('lang') || meta(document, 'og:locale') || '').slice(0, 2).toLowerCase() || null;
  const siteName = meta(document, 'og:site_name', 'application-name') || null;

  // Feeds the page advertises (<link rel="alternate" type="application/rss+xml">).
  const feeds = [];
  for (const l of document.querySelectorAll('link[rel~="alternate"][href]')) {
    if (!/(rss|atom)\+xml|\/feed\+json/i.test(l.getAttribute('type') || '')) continue;
    const u = normalizeFeedLink(l.getAttribute('href'), pageUrl);
    if (u && !feeds.includes(u) && !/comments?\/feed|\/comments\b/i.test(u)) feeds.push(u);
    if (feeds.length >= 5) break;
  }

  // Links (before Readability, which rewrites the DOM).
  const links = [];
  if (!nofollow) {
    const seen = new Set();
    for (const a of document.querySelectorAll('a[href]')) {
      if (respectNofollow && /nofollow|sponsored|ugc/i.test(a.getAttribute('rel') || '')) continue;
      const url = normalizeLink(a.getAttribute('href'), pageUrl);
      if (!url || seen.has(url) || url === canonical) continue;
      seen.add(url);
      links.push({ url, text: (a.textContent || a.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 200) });
      if (links.length >= 400) break;
    }
  }

  // Images: figure captions and alt text make images searchable.
  const images = [];
  const seenImg = new Set();
  const pushImg = (src, alt, caption, w, h) => {
    const url = src && normalizeImage(src, pageUrl);
    if (!url || seenImg.has(url)) return;
    if ((w && w < 200) || (h && h < 120)) return;
    if (/sprite|logo|icon|avatar|pixel|blank|spacer|placeholder|badge|emoji|1x1/i.test(url)) return;
    seenImg.add(url);
    images.push({ url, alt: (alt || '').trim().slice(0, 300), caption: (caption || '').trim().slice(0, 400), width: w || null, height: h || null });
  };
  if (ogImage) pushImg(String(ogImage), title, '', null, null);
  const scope = document.querySelector('article, main, [role="main"]') || document.body;
  for (const img of scope?.querySelectorAll('img') || []) {
    const src = img.getAttribute('src')?.startsWith('data:') ? null : img.getAttribute('src');
    const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset');
    const best = srcset ? pickSrcset(srcset) : null;
    const figure = img.closest('figure');
    pushImg(best || src || img.getAttribute('data-src'), img.getAttribute('alt'), figure?.querySelector('figcaption')?.textContent, +img.getAttribute('width') || null, +img.getAttribute('height') || null);
    if (images.length >= 12) break;
  }

  // Main text.
  let text = '';
  try {
    const parsed = new Readability(document, { charThreshold: 400 }).parse();
    text = (parsed?.textContent || '').replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
  } catch { /* fall back below */ }
  // Some sites ship the full text in JSON-LD even when the HTML is hard to parse.
  if (text.length < 400 && typeof art?.articleBody === 'string' && art.articleBody.length > text.length) {
    text = art.articleBody.replace(/\s+\n/g, '\n').trim();
  }

  const isArticle = !!art || /article/i.test(ogType) || (looksLikeArticleUrl(canonical) && text.length > 800);
  const contentHash = text.length > 300 ? crypto.createHash('sha1').update(text.slice(0, 5000).toLowerCase().replace(/\s+/g, ' ')).digest('hex') : null;

  return {
    url: canonical,
    title: clip(title, 300),
    description: clip(description, 500),
    text,
    author: clip(author || '', 200),
    published_at: published,
    lang,
    siteName,
    isArticle,
    noindex,
    noarchive,
    links,
    feeds,
    images,
    contentHash,
    site: hostOf(canonical),
  };
}

// The candidate closest to ~1200px wide: sharp on screen without storing
// 4000px originals.
function pickSrcset(srcset) {
  const cands = srcset.split(/,\s+(?=\S)/).map((s) => s.trim().split(/\s+/)).map(([url, d]) => ({ url, w: parseInt(d) || 0 })).filter((c) => c.url);
  if (!cands.length) return null;
  const sized = cands.filter((c) => c.w);
  if (!sized.length) return cands[0].url;
  return sized.sort((a, b) => Math.abs(a.w - 1200) - Math.abs(b.w - 1200))[0].url;
}

// Feed URLs end in .xml/.rss/.atom, which normalizeLink deliberately skips.
function normalizeFeedLink(href, base) {
  try {
    const u = new URL(String(href).trim(), base);
    return /^https?:$/.test(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

function normalizeImage(src, base) {
  try {
    const u = new URL(src.trim(), base);
    return /^https?:$/.test(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}
