// "Built with AI": things people made, from launch sites, code hosts and demos.

import { getJSON, getText, pool } from '../http.js';
import { clip, stripHtml, decodeEntities } from '../pipeline/text.js';
import { isAiRelated } from '../pipeline/classify.js';
import { parseFeed } from './rss.js';

export async function fetchHuggingFace() {
  const errors = [];
  const items = [];
  try {
    const spaces = await getJSON('https://huggingface.co/api/spaces?sort=trendingScore&direction=-1&limit=40&full=true');
    for (const s of spaces) {
      const card = s.cardData || {};
      items.push({
        id: `hf-space:${s.id}`,
        url: `https://huggingface.co/spaces/${s.id}`,
        title: card.title || s.id.split('/')[1].replace(/[-_]/g, ' '),
        summary: card.short_description || '',
        author: s.author,
        emoji: card.emoji,
        publishedAt: Date.parse(s.lastModified || s.createdAt),
        createdAt: Date.parse(s.createdAt),
        source: 'Hugging Face Spaces',
        kind: 'demo',
        platform: 'huggingface',
        weight: 1,
        engagement: { score: s.likes || 0, trending: s.trendingScore || 0 },
        section: 'builds',
        tags: [card.sdk].filter(Boolean),
      });
    }
  } catch (e) {
    errors.push({ item: 'spaces', error: e.message });
  }
  try {
    const models = await getJSON('https://huggingface.co/api/models?sort=trendingScore&direction=-1&limit=25');
    for (const m of models) {
      items.push({
        id: `hf-model:${m.id}`,
        url: `https://huggingface.co/${m.id}`,
        title: m.id,
        summary: [m.pipeline_tag, m.library_name].filter(Boolean).join(' · '),
        author: m.id.split('/')[0],
        publishedAt: Date.parse(m.createdAt),
        source: 'Hugging Face',
        kind: 'lab',
        platform: 'huggingface',
        weight: 0.8,
        engagement: { score: m.likes || 0, trending: m.trendingScore || 0, downloads: m.downloads || 0 },
        section: 'models',
      });
    }
  } catch (e) {
    errors.push({ item: 'models', error: e.message });
  }
  return { items, errors };
}

// New AI repos gaining stars fast. Uses GITHUB_TOKEN when set (higher limits).
export async function fetchGitHub() {
  const headers = process.env.GITHUB_TOKEN ? { authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {};
  const since = new Date(Date.now() - 10 * 86400e3).toISOString().slice(0, 10);
  const queries = [
    `topic:llm created:>${since}`,
    `topic:ai-agents created:>${since}`,
    `topic:mcp created:>${since}`,
    `claude OR gpt OR llm in:name,description created:>${since}`,
  ];
  const { results, errors } = await pool(queries, 2, async (q) => {
    const json = await getJSON(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=30`, { headers });
    return json.items;
  });
  const items = results.flat().filter((r) => r.stargazers_count >= 25).map((r) => ({
    id: `gh:${r.full_name}`,
    url: r.html_url,
    title: r.full_name,
    summary: clip(r.description || '', 220),
    author: r.owner?.login,
    avatar: r.owner?.avatar_url,
    publishedAt: Date.parse(r.created_at),
    source: 'GitHub',
    kind: 'code',
    platform: 'github',
    weight: 1,
    engagement: { score: r.stargazers_count, forks: r.forks_count },
    section: 'builds',
    tags: [r.language].filter(Boolean),
  }));

  // Trending page as a second signal; HTML parse is best effort.
  try {
    const html = await getText('https://github.com/trending?since=daily');
    for (const block of html.split('<article class="Box-row">').slice(1)) {
      const name = block.match(/<h2[^>]*>\s*<a[^>]*href="\/([^"]+)"/)?.[1];
      const desc = stripHtml(block.match(/<p class="[^"]*">([\s\S]*?)<\/p>/)?.[1] || '');
      const today = Number((block.match(/([\d,]+) stars today/)?.[1] || '0').replace(/,/g, ''));
      if (!name || !isAiRelated(`${name} ${desc}`)) continue;
      items.push({
        id: `gh:${name}`,
        url: `https://github.com/${name}`,
        title: name,
        summary: clip(desc, 220),
        author: name.split('/')[0],
        publishedAt: Date.now(),
        source: 'GitHub Trending',
        kind: 'code',
        platform: 'github',
        weight: 1.1,
        engagement: { score: today, starsToday: today },
        section: 'builds',
      });
    }
  } catch (e) {
    errors.push({ item: 'trending', error: e.message });
  }
  return { items, errors };
}

export async function fetchProductHunt() {
  const entries = parseFeed(await getText('https://www.producthunt.com/feed'));
  const items = entries
    .filter((e) => isAiRelated(`${e.title} ${e.summary}`))
    .map((e) => ({
      id: `ph:${e.url}`,
      url: e.url,
      title: e.title,
      summary: clip(e.summary.replace(/\s*Discussion\s*\|\s*Link\s*$/i, ''), 220),
      author: e.author,
      publishedAt: e.publishedAt,
      source: 'Product Hunt',
      kind: 'launch',
      platform: 'producthunt',
      weight: 1,
      section: 'builds',
    }));
  return { items, errors: [] };
}

// Show HN with AI in it, newest first. Complements the Algolia pull.
export async function fetchShowHN() {
  const { results, errors } = await pool(['AI', 'LLM', 'Claude', 'GPT', 'agent'], 3, async (q) =>
    parseFeed(await getText(`https://hnrss.org/show?q=${encodeURIComponent(q)}&count=40`)),
  );
  const items = results.flat().map((e) => {
    const points = Number(e.summaryHtml?.match(/Points: (\d+)/)?.[1] || 0);
    const comments = Number(e.summaryHtml?.match(/# Comments: (\d+)/)?.[1] || 0);
    const discussion = e.summaryHtml?.match(/Comments URL: <a href="([^"]+)"/)?.[1];
    return {
      id: `hn:${discussion?.split('id=')[1] || e.url}`,
      url: e.url,
      discussionUrl: discussion,
      title: e.title.replace(/^Show HN:\s*/i, ''),
      summary: '',
      author: e.author,
      publishedAt: e.publishedAt,
      source: 'Hacker News',
      kind: 'community',
      platform: 'hn',
      weight: 1,
      engagement: { score: points, comments },
      section: 'builds',
    };
  });
  return { items, errors };
}

// New models landing on OpenRouter are a fast, reliable "release" signal.
export async function fetchOpenRouter() {
  const json = await getJSON('https://openrouter.ai/api/v1/models');
  const cutoff = Date.now() - 4 * 86400e3;
  const items = json.data
    .filter((m) => m.created * 1000 > cutoff)
    .map((m) => ({
      id: `or:${m.id}`,
      url: `https://openrouter.ai/${m.id}`,
      title: `${decodeEntities(m.name)} is now available on OpenRouter`,
      summary: clip(stripHtml(m.description || ''), 260),
      publishedAt: m.created * 1000,
      source: 'OpenRouter',
      kind: 'lab',
      platform: 'web',
      weight: 0.8,
      section: 'news',
      modelName: m.name,
    }));
  return { items, errors: [] };
}
