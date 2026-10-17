// X (Twitter) has no free public feed, so this source tries several strategies
// in order and remembers which one works:
//   1. Official API v2 recent search   (X_BEARER_TOKEN)
//   2. RSSHub instance                  (RSSHUB_URL, e.g. self-hosted with X cookies)
//   3. Nitter instances                 (NITTER_INSTANCES, comma separated)
//   4. Public embed syndication endpoint (no setup; rate limited, best effort)
// Whatever succeeds, posts come out in the same shape.

import { getJSON, getText, pool } from '../http.js';
import { X_ACCOUNTS } from '../config.js';
import { clip, decodeEntities, stripHtml } from '../pipeline/text.js';
import { isAiRelated } from '../pipeline/classify.js';
import { parseFeed } from './rss.js';

const byHandle = new Map(X_ACCOUNTS.map((a) => [a.handle.toLowerCase(), a]));
export const xStatus = { strategy: null, lastError: null };

function toItem({ id, handle, name, avatar, text, createdAt, likes = 0, reposts = 0, replies = 0, link = null, image = null }) {
  const acct = byHandle.get(handle.toLowerCase());
  const clean = decodeEntities(text).replace(/https:\/\/t\.co\/\w+$/g, '').replace(/\s+/g, ' ').trim();
  return {
    id: `x:${id}`,
    url: `https://x.com/${handle}/status/${id}`,
    linkUrl: link,
    title: clip(clean, 260),
    summary: clean.length > 260 ? clean : '',
    author: name || handle,
    handle,
    avatar,
    image,
    publishedAt: createdAt,
    source: 'X',
    kind: 'social',
    platform: 'x',
    group: acct?.group || 'people',
    weight: acct?.group === 'lab' ? 1.5 : acct?.group === 'scoops' ? 1.2 : 1.1,
    engagement: { score: likes + 3 * reposts, comments: replies },
  };
}

function keep(item) {
  const acct = byHandle.get(item.handle.toLowerCase());
  if (acct?.aiOnly && !isAiRelated(item.title)) return false;
  // Skip bare replies and one-word posts; they read as noise out of context.
  if (/^@\w+/.test(item.title) || item.title.length < 25) return false;
  return true;
}

async function viaApi(token) {
  // Pack as many from: clauses as fit in a 512-char query.
  const chunks = [];
  let cur = [];
  for (const a of X_ACCOUNTS) {
    const next = [...cur, `from:${a.handle}`];
    if (`(${next.join(' OR ')}) -is:retweet -is:reply`.length > 500) {
      chunks.push(cur);
      cur = [`from:${a.handle}`];
    } else cur = next;
  }
  if (cur.length) chunks.push(cur);

  const { results, errors } = await pool(chunks, 3, async (chunk) => {
    const q = encodeURIComponent(`(${chunk.join(' OR ')}) -is:retweet -is:reply`);
    const json = await getJSON(
      `https://api.x.com/2/tweets/search/recent?query=${q}&max_results=100&tweet.fields=created_at,public_metrics,entities,attachments&expansions=author_id,attachments.media_keys&user.fields=username,name,profile_image_url&media.fields=url,preview_image_url`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const users = new Map((json.includes?.users || []).map((u) => [u.id, u]));
    const media = new Map((json.includes?.media || []).map((m) => [m.media_key, m]));
    return (json.data || []).map((t) => {
      const u = users.get(t.author_id) || {};
      const m = t.attachments?.media_keys?.map((k) => media.get(k)).find(Boolean);
      const link = t.entities?.urls?.find((x) => !/x\.com|twitter\.com/.test(x.expanded_url || ''))?.expanded_url;
      return toItem({
        id: t.id, handle: u.username, name: u.name, avatar: u.profile_image_url, text: t.text,
        createdAt: Date.parse(t.created_at), likes: t.public_metrics?.like_count, reposts: t.public_metrics?.retweet_count,
        replies: t.public_metrics?.reply_count, link, image: m?.url || m?.preview_image_url,
      });
    });
  });
  if (!results.length && errors.length) throw new Error(errors[0].error);
  return results.flat();
}

async function viaFeeds(urlFor) {
  const { results, errors } = await pool(X_ACCOUNTS, 4, async (a) => {
    const entries = parseFeed(await getText(urlFor(a.handle), { timeout: 12000, retries: 0 }));
    return entries.map((e) => {
      const id = (e.url.match(/status\/(\d+)/) || [])[1];
      if (!id || /^RT by|^R to/.test(e.title)) return null;
      const img = e.summaryHtml?.match(/<img[^>]+src="([^"]+)"/)?.[1];
      return toItem({ id, handle: a.handle, name: e.author?.replace(/^@/, '') || a.handle, text: e.title || stripHtml(e.summaryHtml), createdAt: e.publishedAt, image: img });
    }).filter(Boolean);
  });
  if (results.length < X_ACCOUNTS.length / 4) throw new Error(errors[0]?.error || 'too few feeds responded');
  return results.flat();
}

async function viaSyndication() {
  const { results, errors } = await pool(X_ACCOUNTS, 2, async (a) => {
    const html = await getText(`https://syndication.twitter.com/srv/timeline-profile/screen-name/${a.handle}`, { timeout: 10000, retries: 0 });
    const json = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)?.[1];
    if (!json) return [];
    const entries = JSON.parse(json)?.props?.pageProps?.timeline?.entries || [];
    return entries
      .map((e) => e.content?.tweet)
      .filter((t) => t && !t.retweeted_status && !t.in_reply_to_status_id_str)
      .map((t) => toItem({
        id: t.id_str, handle: t.user?.screen_name || a.handle, name: t.user?.name, avatar: t.user?.profile_image_url_https,
        text: t.full_text || t.text, createdAt: Date.parse(t.created_at), likes: t.favorite_count, reposts: t.retweet_count,
        replies: t.reply_count, link: t.entities?.urls?.[0]?.expanded_url, image: t.entities?.media?.[0]?.media_url_https,
      }));
  });
  if (!results.flat().length) throw new Error(errors[0]?.error || 'syndication returned nothing');
  return results.flat();
}

export async function fetchX() {
  const strategies = [];
  if (process.env.X_BEARER_TOKEN) strategies.push(['api', () => viaApi(process.env.X_BEARER_TOKEN)]);
  if (process.env.RSSHUB_URL) strategies.push(['rsshub', () => viaFeeds((h) => `${process.env.RSSHUB_URL.replace(/\/$/, '')}/twitter/user/${h}`)]);
  for (const inst of (process.env.NITTER_INSTANCES || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    strategies.push([`nitter:${inst}`, () => viaFeeds((h) => `${inst.replace(/\/$/, '')}/${h}/rss`)]);
  }
  strategies.push(['syndication', viaSyndication]);

  // Try the last strategy that worked first.
  strategies.sort(([a], [b]) => (a === xStatus.strategy ? -1 : b === xStatus.strategy ? 1 : 0));

  const errors = [];
  for (const [name, run] of strategies) {
    try {
      const items = (await run()).filter((i) => i.handle && i.publishedAt && keep(i));
      xStatus.strategy = name;
      xStatus.lastError = null;
      return { items, errors };
    } catch (err) {
      errors.push({ item: name, error: err.message });
    }
  }
  xStatus.lastError = errors.map((e) => `${e.item}: ${e.error}`).join('; ');
  return { items: [], errors };
}
