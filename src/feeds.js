// Feeds to subscribe to: a topic, an X account, a search, a set of follows
// (the same ones For you uses) and breaking news, each as RSS 2.0 and as
// JSON Feed 1.1. A feed carries an ETag made from its items, so a reader
// polling an unchanged feed gets a 304 and no body.

import crypto from 'node:crypto';
import { topicLabel } from './index/topics.js';

const xml = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
const html = (s = '') => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const MAX_ITEMS = 40;

// A live story -> a feed item. The link is the article; the story page is in
// the body, with who else covered it.
export function storyItem(s, origin) {
  const page = `${origin}/#story/${s.sid}`;
  const others = (s.sources || []).filter((x) => x.name !== s.lead?.source).map((x) => x.name);
  const also = others.length ? ` Also: ${[...new Set(others)].slice(0, 4).join(', ')}${others.length > 4 ? ` and ${others.length - 4} more` : ''}.` : '';
  return {
    id: page,
    url: s.url,
    page,
    title: s.title,
    text: `${s.summary || ''}${also}`.trim(),
    html: `${s.summary ? `<p>${html(s.summary)}</p>` : ''}<p>${html(s.lead?.source || '')}${also ? ` · ${html(also.trim())}` : ''} · <a href="${html(page)}">How it spread</a></p>`,
    date: s.publishedAt || s.updatedAt || Date.now(),
    updated: s.updatedAt || null,
    author: s.lead?.source || null,
    tags: s.topics || [],
    image: /^https?:\/\//.test(s.image || '') ? s.image : null,
  };
}

const postItem = (p) => ({
  id: p.url,
  url: p.url,
  page: null,
  title: (p.text || '').replace(/\s+/g, ' ').slice(0, 120) + ((p.text || '').length > 120 ? '…' : ''),
  text: p.text || '',
  html: `<p>${html(p.text || '')}</p>`,
  date: p.at || p.publishedAt,
  author: p.handle ? `@${p.handle}` : p.author || null,
  tags: [],
  image: null,
});

const docItem = (r) => ({
  id: r.url,
  url: r.url,
  page: null,
  title: r.title || r.url,
  text: (r.snippet || '').replace(/<\/?b>/g, ''),
  html: r.snippet ? `<p>${html(r.snippet.replace(/<\/?b>/g, ''))}</p>` : '',
  date: r.publishedAt || Date.now(),
  author: r.source || r.site || null,
  tags: [],
  image: null,
});

// ---- Builders: each returns { title, description, home, items } ----

export function topicFeed(store, key, origin) {
  const stories = (store.snapshot.stories || []).filter((s) => s.sid && (s.entities || []).includes(key));
  return { title: topicLabel(key), description: `${topicLabel(key)}: new stories as they break.`, home: `${origin}/#topic/${key}`, items: newest(stories.map((s) => storyItem(s, origin))) };
}

export function breakingFeed(store, history, origin) {
  const live = new Map((store.snapshot.stories || []).map((s) => [s.sid, s]));
  const items = history.map((b) => {
    const s = live.get(b.sid);
    if (s) return { ...storyItem(s, origin), date: b.startedAt };
    return { id: `${origin}/#story/${b.sid}`, url: b.url, page: `${origin}/#story/${b.sid}`, title: b.title, text: `${b.voices} sources within the hour.`, html: `<p>${b.voices} sources within the hour. <a href="${html(`${origin}/#story/${b.sid}`)}">How it spread</a></p>`, date: b.startedAt, author: null, tags: b.topics || [], image: null };
  });
  return { title: 'Breaking', description: 'Stories that broke: many outlets and X accounts on one story within the hour.', home: `${origin}/#breaking`, items: newest(items) };
}

export function accountFeed(posts, handle, origin) {
  const name = posts[0]?.author || handle;
  return { title: `${name} (@${handle}) on X`, description: `Posts from @${handle}, as the wire saw them.`, home: `${origin}/#account/${handle}`, items: newest(posts.map(postItem)) };
}

export function searchFeed(result, q, origin) {
  return { title: `Search: ${q}`, description: `Newest results for “${q}”.`, home: `${origin}/#search?q=${encodeURIComponent(q)}&sort=date`, items: newest((result.results || []).map(docItem)) };
}

export function followsFeed(result, follows, origin) {
  const n = follows.topics.length + follows.names.length + follows.accounts.length + follows.outlets.length;
  const items = (result.stories || []).map((s) => {
    const it = storyItem({ ...s, sources: [] }, origin);
    const why = s.why.map((w) => w.label).join(', ');
    return { ...it, text: `${it.text} Matches: ${why}.`, html: `${it.html}<p>Matches: ${html(why)}</p>`, tags: s.why.map((w) => w.label) };
  });
  return { title: 'For you', description: `The wire ranked for ${n} follow${n === 1 ? '' : 's'}.`, home: `${origin}/#foryou`, items: items.slice(0, MAX_ITEMS) };
}

const newest = (items) => items.filter((x) => x.url).sort((a, b) => b.date - a.date).slice(0, MAX_ITEMS);

// ---- Output ----

export function etagOf(feed) {
  const h = crypto.createHash('sha1');
  h.update(feed.title);
  for (const it of feed.items) h.update(`${it.id}|${it.updated || it.date}|${it.title}\n`);
  return `"f${h.digest('base64url').slice(0, 20)}"`;
}

export function renderRss(feed, self) {
  const updated = Math.max(0, ...feed.items.map((i) => i.updated || i.date));
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${xml(feed.title)}</title>
    <link>${xml(feed.home)}</link>
    <atom:link href="${xml(self)}" rel="self" type="application/rss+xml"/>
    <description>${xml(feed.description)}</description>
    <language>en</language>${updated ? `\n    <lastBuildDate>${new Date(updated).toUTCString()}</lastBuildDate>` : ''}
    <ttl>15</ttl>
${feed.items.map((it) => `    <item>
      <title>${xml(it.title)}</title>
      <link>${xml(it.url)}</link>
      <guid isPermaLink="${it.id === it.url}">${xml(it.id)}</guid>
      <pubDate>${new Date(it.date).toUTCString()}</pubDate>${it.author ? `\n      <author>${xml(`noreply@invalid (${it.author})`)}</author>` : ''}${it.tags.map((t) => `\n      <category>${xml(t)}</category>`).join('')}
      <description>${xml(it.html)}</description>${it.image ? `\n      <enclosure url="${xml(it.image)}" type="image/jpeg" length="0"/>` : ''}
    </item>`).join('\n')}
  </channel>
</rss>
`;
}

export function renderJsonFeed(feed, self) {
  return {
    version: 'https://jsonfeed.org/version/1.1',
    title: feed.title,
    home_page_url: feed.home,
    feed_url: self,
    description: feed.description,
    language: 'en',
    items: feed.items.map((it) => ({
      id: it.id,
      url: it.page || it.url,
      ...(it.page ? { external_url: it.url } : {}),
      title: it.title,
      content_html: it.html,
      content_text: it.text,
      date_published: new Date(it.date).toISOString(),
      ...(it.updated ? { date_modified: new Date(it.updated).toISOString() } : {}),
      ...(it.author ? { authors: [{ name: it.author }] } : {}),
      ...(it.tags.length ? { tags: it.tags } : {}),
      ...(it.image ? { image: it.image } : {}),
    })),
  };
}
