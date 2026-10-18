// Sitemaps are how news sites announce new URLs. We read sitemap indexes and
// url sets, keep only recent entries, and pick up Google News sitemap titles.

import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, processEntities: true });
const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);

export function parseSitemap(xml, { maxAgeDays = 7, now = Date.now() } = {}) {
  const doc = parser.parse(xml);
  const cutoff = now - maxAgeDays * 86400e3;
  if (doc.sitemapindex) {
    const maps = arr(doc.sitemapindex.sitemap).map((s) => ({ url: String(s.loc || '').trim(), lastmod: Date.parse(s.lastmod) || null }));
    // Child sitemaps without lastmod are kept only if their name hints at recency.
    const year = new Date(now).getUTCFullYear();
    return {
      kind: 'index',
      sitemaps: maps.filter((m) => m.url && (m.lastmod ? m.lastmod >= cutoff : new RegExp(`news|${year}|latest|recent|post`, 'i').test(m.url))).slice(0, 25),
      urls: [],
    };
  }
  const urls = arr(doc.urlset?.url)
    .map((u) => {
      const news = u.news || {};
      const published = Date.parse(news.publication_date) || null;
      const lastmod = Date.parse(u.lastmod) || null;
      return { url: String(u.loc || '').trim(), lastmod: published || lastmod, title: news.title ? String(news.title) : null };
    })
    .filter((u) => u.url && (!u.lastmod || u.lastmod >= cutoff));
  // When most entries are dated, undated ones are usually old evergreen pages.
  const dated = urls.filter((u) => u.lastmod).length;
  const kept = dated >= urls.length / 2 ? urls.filter((u) => u.lastmod) : urls;
  kept.sort((a, b) => (b.lastmod || 0) - (a.lastmod || 0));
  return { kind: 'urlset', sitemaps: [], urls: kept.slice(0, 300) };
}
