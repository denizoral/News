// The weekly digest: the AI stories of the last seven days that the most
// sources covered, each day's top story, and which companies and themes got
// more or less coverage than the week before.
//
// Built from the permanent index, not the live feed (which keeps three days):
// every item the aggregator stored in the last two weeks is clustered into
// stories the same way the front page does. About 4k items a week cluster in
// ~200 ms, so it runs in the history worker and is cached for 30 minutes.

import { clusterItems } from '../pipeline/cluster.js';
import { isAiRelated } from '../pipeline/classify.js';
import { splitOutlet } from '../pipeline/text.js';
import { topicLabel } from './topics.js';
import { cachedJob } from './offload.js';

const DAY = 86400e3;
const TTL_MS = 30 * 60e3;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

// "Title - Engadget" -> "Title", when the suffix is the item's own outlet.
const norm = (s = '') => s.toLowerCase().replace(/[^a-z0-9]/g, '');
function cleanTitle(title, source, site) {
  const { title: t, outlet } = splitOutlet(title);
  const o = outlet && norm(outlet);
  return o && (o === norm(source) || norm(site).includes(o)) ? t : title;
}

// Aggregator items (they carry a platform; spidered pages don't) in [from, to).
function weekItems(db, from, to) {
  const rows = db.prepare(`SELECT id, url, title, description, site, source, image_url, published_at, engagement, meta FROM docs
    WHERE published_at >= ? AND published_at < ? AND hidden = 0 AND type IN ('article', 'post') AND meta LIKE '%"platform"%'
      AND (lang IS NULL OR lang = '' OR lang LIKE 'en%')`).all(from, to);
  const items = [];
  for (const r of rows) {
    let m;
    try {
      m = JSON.parse(r.meta);
    } catch {
      continue;
    }
    if (!m.platform || !r.title || !isAiRelated(`${r.title} ${r.description}`)) continue;
    items.push({
      id: String(r.id),
      title: cleanTitle(r.title, r.source, r.site),
      summary: r.description,
      url: r.url,
      linkUrl: m.linkUrl,
      platform: m.platform,
      handle: m.handle,
      source: r.source || r.site,
      sourceHost: r.site,
      publishedAt: r.published_at,
      engagement: { score: r.engagement },
      image: r.image_url,
    });
  }
  return items;
}

const weight = (s) => new Set(s.sources.map((x) => x.name)).size;
const engagement = (s) => s._group.reduce((n, it) => n + (it.engagement.score || 0), 0);
const rank = (a, b) => b.n - a.n || b.eng - a.eng || b.publishedAt - a.publishedAt;

function storiesIn(db, from, to) {
  return clusterItems(weekItems(db, from, to)).map((s) => Object.assign(s, { n: weight(s), eng: engagement(s) }));
}

const brief = (s) => ({
  id: s.id,
  title: s.title,
  url: s.url,
  image: s.image,
  source: s.lead.source,
  host: s.lead.sourceHost || s.lead.host,
  at: s.publishedAt,
  sources: s.n,
  names: s.sources.map((x) => x.name).filter((v, i, a) => a.indexOf(v) === i).slice(0, 4),
  entities: s.entities,
});

// Stories per company/theme (a story counts once however many articles it has).
function topicCounts(stories) {
  const counts = new Map();
  for (const s of stories) for (const e of s.entities) counts.set(e, (counts.get(e) || 0) + 1);
  return counts;
}

export function computeDigest(db, { now = Date.now(), days = 7, top = 12 } = {}) {
  const from = now - days * DAY;
  const stories = storiesIn(db, from, now + 5 * 60e3);
  const previous = storiesIn(db, from - days * DAY, from);
  stories.sort(rank);

  const lead = stories.filter((s) => s.n >= 2).slice(0, top);
  const shown = new Set(lead.map((s) => s.id));
  const byDay = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = dayOf(now - i * DAY);
    const best = stories.find((s) => !shown.has(s.id) && dayOf(s.publishedAt) === day);
    const count = stories.filter((s) => dayOf(s.publishedAt) === day).length;
    if (count) byDay.push({ day, stories: count, top: best ? brief(best) : null });
  }

  // Change against last week is in share of stories, so a busier crawl
  // doesn't read as more news; it's left out while the index holds too
  // little of last week to compare.
  const cur = topicCounts(stories);
  const prev = previous.length >= stories.length * 0.4 ? topicCounts(previous) : null;
  const topics = [...cur.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([key, n]) => {
      const t = { key, label: topicLabel(key), n, share: +(n / stories.length).toFixed(4) };
      if (prev) t.prevShare = +((prev.get(key) || 0) / previous.length).toFixed(4);
      return t;
    });

  const items = stories.reduce((n, s) => n + s._group.length, 0);
  const outlets = new Set(stories.flatMap((s) => s.sources.map((x) => x.name))).size;
  return { from, to: now, days, generatedAt: now, totals: { stories: stories.length, items, outlets }, top: lead.map(brief), byDay, topics };
}

export const weeklyDigest = () => cachedJob('digest', { kind: 'digest' }, TTL_MS);

const xml = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

// RSS 2.0: the week's biggest stories, one item each.
export function digestRss(d, { origin, name }) {
  const items = d.top.map((s) => `    <item>
      <title>${xml(s.title)}</title>
      <link>${xml(s.url)}</link>
      <guid isPermaLink="false">${xml(`${s.url}#digest`)}</guid>
      <pubDate>${new Date(s.at).toUTCString()}</pubDate>
      <source url="${xml(`${origin}/digest.xml`)}">${xml(name)}</source>
      <description>${xml(`Covered by ${s.sources} sources, first by ${s.source}${s.names.length > 1 ? `. Also: ${s.names.filter((n) => n !== s.source).slice(0, 3).join(', ')}` : ''}.`)}</description>
    </item>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xml(`${name}: the week in AI`)}</title>
    <link>${xml(`${origin}/#week`)}</link>
    <atom:link href="${xml(`${origin}/digest.xml`)}" rel="self" type="application/rss+xml"/>
    <description>The AI stories the most sources covered in the last seven days.</description>
    <lastBuildDate>${new Date(d.generatedAt).toUTCString()}</lastBuildDate>
    <ttl>60</ttl>
${items}
  </channel>
</rss>
`;
}
