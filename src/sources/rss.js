import { XMLParser } from 'fast-xml-parser';
import { getText, pool } from '../http.js';
import { RSS_FEEDS, GOOGLE_NEWS_QUERIES, SCRAPED_PAGES } from '../config.js';
import { stripHtml, clip, decodeEntities, splitOutlet } from '../pipeline/text.js';
import { isAiRelated } from '../pipeline/classify.js';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', textNodeName: '#text', processEntities: false });

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const text = (x) => (x == null ? '' : typeof x === 'object' ? (x['#text'] ?? '') : String(x));

function linkOf(entry) {
  if (typeof entry.link === 'string') return entry.link;
  const links = arr(entry.link);
  const alt = links.find((l) => !l['@rel'] || l['@rel'] === 'alternate') || links[0];
  return alt?.['@href'] || text(alt) || entry.guid?.['#text'] || (typeof entry.guid === 'string' ? entry.guid : '');
}

function imageOf(entry, html) {
  const media = arr(entry['media:content']).concat(arr(entry['media:thumbnail']), arr(entry.enclosure));
  const m = media.find((x) => x?.['@url'] && (!x['@type'] || String(x['@type']).startsWith('image') || x['@medium'] === 'image'));
  if (m) return m['@url'];
  const img = html && html.match(/<img[^>]+src="([^"]+)"/i);
  return img ? decodeEntities(img[1]) : null;
}

// JSON Feed (jsonfeed.org) 1.0/1.1, which some blogs publish instead of RSS.
function parseJsonFeed(body) {
  const doc = JSON.parse(body);
  return arr(doc.items).filter((e) => e && typeof e === 'object').map((e) => {
    const rawSummary = String(e.summary || e.content_html || e.content_text || '');
    const author = e.authors?.[0]?.name || e.author?.name || '';
    return {
      title: stripHtml(String(e.title || '')),
      url: String(e.url || e.external_url || '').trim(),
      summaryHtml: rawSummary,
      summary: clip(stripHtml(rawSummary), 320),
      publishedAt: Date.parse(e.date_published || e.date_modified) || null,
      author: stripHtml(String(author)),
      image: e.image || e.banner_image || null,
      source: '',
      sourceUrl: null,
    };
  });
}

// Parse any RSS 2.0 / Atom / RDF / JSON Feed document into plain entries.
export function parseFeed(xml) {
  if (/^\s*\{/.test(xml)) return parseJsonFeed(xml);
  const doc = parser.parse(xml);
  const entries = doc.rss ? arr(doc.rss.channel?.item) : doc.feed ? arr(doc.feed.entry) : arr(doc['rdf:RDF']?.item);
  return entries.map((e) => {
    const rawSummary = text(e['content:encoded']) || text(e.content) || text(e.description) || text(e.summary);
    const date = text(e.pubDate) || text(e.published) || text(e.updated) || text(e['dc:date']);
    return {
      title: stripHtml(text(e.title)),
      url: decodeEntities(linkOf(e)).trim(),
      summaryHtml: decodeEntities(rawSummary),
      summary: clip(stripHtml(decodeEntities(rawSummary)), 320),
      publishedAt: date ? Date.parse(date) || null : null,
      author: stripHtml(text(e['dc:creator']) || text(e.author?.name) || text(e.author)),
      image: imageOf(e, decodeEntities(rawSummary)),
      source: stripHtml(text(e.source)),
      sourceUrl: e.source?.['@url'] || null,
    };
  });
}

export async function fetchFeeds() {
  const { results, errors } = await pool(RSS_FEEDS, 8, async (feed) => {
    const entries = parseFeed(await getText(feed.url));
    return entries
      .filter((e) => e.title && e.url)
      .filter((e) => !feed.aiOnly || isAiRelated(`${e.title} ${e.summary}`))
      .slice(0, 30)
      .map((e) => ({
        id: `rss:${e.url}`,
        url: e.url,
        title: e.title,
        summary: e.summary,
        image: e.image,
        author: e.author,
        publishedAt: e.publishedAt,
        source: feed.name,
        kind: feed.kind,
        platform: 'web',
        weight: feed.weight,
      }));
  });
  return { items: results.flat(), errors };
}

export async function fetchGoogleNews() {
  const { results, errors } = await pool(GOOGLE_NEWS_QUERIES, 4, async (q) => {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:1d')}&hl=en-US&gl=US&ceid=US:en`;
    return parseFeed(await getText(url))
      .slice(0, 25)
      .map((e) => {
        const { title, outlet } = splitOutlet(e.title);
        return {
          id: `gn:${e.url}`,
          url: e.url,
          title,
          summary: '',
          publishedAt: e.publishedAt,
          source: e.source || outlet || 'Google News',
          via: 'Google News',
          sourceHost: e.sourceUrl ? e.sourceUrl.replace(/^https?:\/\/(www\.)?/, '').replace(/\/.*$/, '') : null,
          kind: 'press',
          platform: 'web',
          weight: 0.9,
        };
      })
      .filter((i) => isAiRelated(`${q} ${i.title}`));
  });
  return { items: results.flat(), errors };
}

// Lab pages without feeds: pull article links plus the nearest heading text.
export async function fetchScraped() {
  const { results, errors } = await pool(SCRAPED_PAGES, 4, async (page) => {
    const html = await getText(page.url);
    const seen = new Set();
    const items = [];
    for (const m of html.matchAll(page.link)) {
      const path = m[1];
      if (seen.has(path) || /\/(category|tag|page)\//.test(path)) continue;
      seen.add(path);
      // Find a title: the first heading or text block after the link.
      const after = html.slice(m.index, m.index + 2500);
      const heading = after.match(/<(h[1-6]|span|p|div)[^>]*>([^<]{12,180})<\/\1>/);
      const title = heading ? stripHtml(heading[2]) : null;
      if (!title) continue;
      const dateMatch = after.match(/((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}, \d{4})|(\d{4}-\d{2}-\d{2})/);
      items.push({
        id: `page:${page.base}${path}`,
        url: `${page.base}${path}`,
        title,
        summary: '',
        publishedAt: dateMatch ? Date.parse(dateMatch[0]) || null : null,
        source: page.name,
        kind: page.kind,
        platform: 'web',
        weight: page.weight,
        // Undated items are only trusted when first seen, so they don't flood.
        undated: !dateMatch,
      });
      if (items.length >= 15) break;
    }
    return items;
  });
  return { items: results.flat(), errors };
}
