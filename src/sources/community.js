import { get, getJSON, getText, pool } from '../http.js';
import { SUBREDDITS, BLUESKY_ACCOUNTS } from '../config.js';
import { clip, stripHtml, decodeEntities } from '../pipeline/text.js';
import { isAiRelated, looksLikeBuild } from '../pipeline/classify.js';
import { parseFeed } from './rss.js';

// Hacker News via Algolia: recent AI stories with any traction, plus front page.
export async function fetchHackerNews() {
  const since = Math.floor(Date.now() / 1000) - 36 * 3600;
  const queries = ['AI', 'LLM', 'OpenAI', 'Anthropic', 'Claude', 'GPT', 'Gemini', 'DeepSeek', 'Llama', 'agents', 'Nvidia', 'model'];
  const urls = [
    `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=60`,
    ...queries.map((q) => `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(q)}&tags=story&numericFilters=created_at_i>${since},points>8&hitsPerPage=50`),
  ];
  const { results, errors } = await pool(urls, 6, async (u) => (await getJSON(u)).hits);
  const items = [];
  for (const h of results.flat()) {
    if (!h.title) continue;
    const isShow = /^show hn/i.test(h.title);
    const text = `${h.title} ${h.url || ''}`;
    if (!isAiRelated(text)) continue;
    const discussion = `https://news.ycombinator.com/item?id=${h.objectID}`;
    items.push({
      id: `hn:${h.objectID}`,
      url: h.url || discussion,
      discussionUrl: discussion,
      title: h.title.replace(/^Show HN:\s*/i, ''),
      summary: h.story_text ? clip(stripHtml(h.story_text), 280) : '',
      author: h.author,
      publishedAt: h.created_at_i * 1000,
      source: 'Hacker News',
      kind: 'community',
      platform: 'hn',
      weight: 1.0,
      engagement: { score: h.points || 0, comments: h.num_comments || 0 },
      section: isShow ? 'builds' : 'news',
    });
  }
  return { items, errors };
}

function redditItem(p, section) {
  const d = p.data;
  const external = d.url && !/reddit\.com|redd\.it/.test(d.url) ? decodeEntities(d.url) : null;
  const preview = d.preview?.images?.[0]?.source?.url;
  return {
    id: `reddit:${d.id}`,
    url: section === 'builds' ? `https://www.reddit.com${d.permalink}` : external || `https://www.reddit.com${d.permalink}`,
    linkUrl: external,
    discussionUrl: `https://www.reddit.com${d.permalink}`,
    title: decodeEntities(d.title),
    summary: clip((d.selftext || '').replace(/\s+/g, ' '), 300),
    author: d.author,
    publishedAt: d.created_utc * 1000,
    source: `r/${d.subreddit}`,
    kind: 'community',
    platform: 'reddit',
    weight: 0.9,
    image: preview ? decodeEntities(preview) : d.thumbnail?.startsWith('http') ? d.thumbnail : null,
    engagement: { score: d.score || 0, comments: d.num_comments || 0 },
    section,
    flair: d.link_flair_text || null,
  };
}

// Reddit blocks many anonymous datacenter clients. With REDDIT_CLIENT_ID and
// REDDIT_CLIENT_SECRET (a free "script" app) we use OAuth, which always works;
// otherwise we try the public JSON, then the RSS listing.
let redditToken = { value: null, expires: 0 };

async function redditAuth() {
  const { REDDIT_CLIENT_ID: id, REDDIT_CLIENT_SECRET: secret } = process.env;
  if (!id || !secret) return null;
  if (redditToken.value && redditToken.expires > Date.now()) return redditToken.value;
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: { authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'frontier-wire/0.1' },
    body: 'grant_type=client_credentials',
  });
  const json = await res.json();
  redditToken = { value: json.access_token, expires: Date.now() + (json.expires_in - 60) * 1000 };
  return redditToken.value;
}

async function subreddit(name, listing, limit) {
  const token = await redditAuth().catch(() => null);
  if (token) {
    const json = await getJSON(`https://oauth.reddit.com/r/${name}/${listing}?limit=${limit}&raw_json=1`, { headers: { authorization: `Bearer ${token}`, 'user-agent': 'frontier-wire/0.1' } });
    return json.data.children.filter((c) => !c.data.stickied && !c.data.over_18);
  }
  try {
    const res = await get(`https://www.reddit.com/r/${name}/${listing}.json?limit=${limit}&raw_json=1`, { headers: { accept: 'application/json' }, retries: 0 });
    if (/\/login/.test(res.url)) throw new Error('reddit requires login from this network');
    const json = await res.json();
    return json.data.children.filter((c) => !c.data.stickied && !c.data.over_18);
  } catch (err) {
    // RSS has no scores, so treat every entry as passing the score bar.
    const entries = parseFeed(await getText(`https://www.reddit.com/r/${name}/${listing === 'new' ? 'new' : 'top'}/.rss?t=day&limit=${limit}`));
    if (!entries.length) throw err;
    return entries.map((e) => {
      const id = e.url.match(/comments\/(\w+)/)?.[1] || e.url;
      const ext = e.summaryHtml?.match(/<a href="([^"]+)">\[link\]<\/a>/)?.[1];
      return { data: { id, title: e.title, permalink: new URL(e.url).pathname, url: ext || e.url, selftext: stripHtml(e.summaryHtml || '').replace(/submitted by .*$/, ''), author: e.author?.replace(/^\/u\//, ''), created_utc: (e.publishedAt || Date.now()) / 1000, subreddit: name, score: 20, num_comments: 0 } };
    });
  }
}

export async function fetchReddit() {
  const jobs = [
    ...SUBREDDITS.news.map((s) => ({ s, listing: 'hot', section: 'news' })),
    ...SUBREDDITS.news.slice(0, 4).map((s) => ({ s, listing: 'new', section: 'news' })),
    ...SUBREDDITS.builds.map((s) => ({ s, listing: 'hot', section: 'builds' })),
  ];
  const { results, errors } = await pool(jobs, 4, async ({ s, listing, section }) => {
    const posts = await subreddit(s, listing, 40);
    return posts
      .map((p) => redditItem(p, section))
      .filter((i) => {
        const text = `${i.title} ${i.summary} ${i.flair || ''}`;
        if (section === 'builds') {
          const flairBuild = /showcase|project|built|show|launch|resource|tool/i.test(i.flair || '');
          return (flairBuild || looksLikeBuild(text)) && (isAiRelated(text) || ['vibecoding', 'ClaudeAI', 'LocalLLaMA', 'ChatGPTCoding', 'cursor', 'AI_Agents'].includes(s));
        }
        if (listing === 'new' && i.engagement.score < 5) return false;
        return i.engagement.score >= 15 || listing === 'new';
      });
  });
  return { items: results.flat(), errors };
}

// Bluesky: public author feeds, no auth. Falls back to the profile RSS.
export async function fetchBluesky() {
  const { results, errors } = await pool(BLUESKY_ACCOUNTS, 4, async (handle) => {
    try {
      const json = await getJSON(`https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?actor=${handle}&limit=30&filter=posts_no_replies`);
      return json.feed
        .filter((f) => !f.reason)
        .map(({ post }) => {
          const rkey = post.uri.split('/').pop();
          const ext = post.embed?.external;
          return {
            id: `bsky:${post.uri}`,
            url: `https://bsky.app/profile/${post.author.handle}/post/${rkey}`,
            linkUrl: ext?.uri || null,
            title: clip(post.record.text.replace(/\s+/g, ' '), 220),
            summary: ext?.title ? clip(ext.title, 160) : '',
            author: post.author.displayName || post.author.handle,
            handle: post.author.handle,
            avatar: post.author.avatar,
            publishedAt: Date.parse(post.record.createdAt),
            source: 'Bluesky',
            kind: 'social',
            platform: 'bluesky',
            weight: 0.9,
            engagement: { score: (post.likeCount || 0) + 2 * (post.repostCount || 0), comments: post.replyCount || 0 },
          };
        });
    } catch {
      const entries = parseFeed(await getText(`https://bsky.app/profile/${handle}/rss`));
      return entries.map((e) => ({
        id: `bsky:${e.url}`,
        url: e.url,
        title: clip(e.summary || e.title, 220),
        summary: '',
        author: handle,
        handle,
        publishedAt: e.publishedAt,
        source: 'Bluesky',
        kind: 'social',
        platform: 'bluesky',
        weight: 0.9,
      }));
    }
  });
  return { items: results.flat().filter((i) => i.title && isAiRelated(`${i.title} ${i.summary}`)), errors };
}
