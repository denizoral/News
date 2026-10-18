# Frontier Wire

The latest AI news in one fast page. Frontier Wire crawls lab blogs, the tech
press, newsletters, X, Bluesky, Reddit, Hacker News and Google News every one to
five minutes, merges duplicate coverage into single stories, ranks them by how
much attention they're getting, and puts live **Polymarket** odds next to the
stories they relate to. A second view collects things people **built with AI**.

```
npm install
npm start            # http://localhost:3000
```

The first crawl takes about ten seconds. After that the page updates itself over
Server-Sent Events; when you're scrolled down reading, it offers new stories in
a pill instead of reshuffling the page under you.

## What it pulls

| Source | How | Cadence |
| --- | --- | --- |
| **X** (44 curated accounts: labs, leaders, researchers, leak trackers) | Public embed timelines by default (free); X API v2, RSSHub or Nitter if configured | 2 min, a few accounts per run |
| **Polymarket** | Gamma API: `ai`, `openai`, `tech` tags plus 14 targeted searches | 90 s |
| **Hacker News** | Algolia search across 12 AI queries plus the front page | 2 min |
| **Reddit** | 9 news subs and 8 builder subs (OAuth, JSON or RSS fallback) | 3 min |
| **Bluesky** | Public author feeds | 3 min |
| **Google News** | 12 topic searches over the past day (thousands of outlets) | 5 min |
| **Lab blogs and press** | 25 RSS/Atom feeds: OpenAI, DeepMind, Google AI, Hugging Face, NVIDIA, The Verge, TechCrunch, Ars, MIT Tech Review, Wired, The Decoder, Simon Willison, Latent Space, Import AI, Interconnects, smol AI News, TLDR AI, … | 5 min |
| **Lab pages without feeds** | Anthropic, Mistral, Meta AI, xAI news pages, scraped | 10 min |
| **OpenRouter** | New models appearing in the catalog (an early release signal) | 10 min |
| **Built with AI** | Show HN, Reddit showcases, GitHub (new repos gaining stars + Trending), Hugging Face Spaces, Product Hunt | 5–30 min |

Every source is in `src/config.js`. Add a feed, handle or subreddit there and
nothing else needs to change.

### Getting X posts

X's API is paid (pay-per-use, no free tier for new developers), so by default
the site reads X's **public embed timelines**, the free endpoint behind
embedded profile timelines on other websites. It needs no key, but X rate-limits it
hard, so the crawler is careful with it:

- Each run (every 2 minutes) fetches only a few accounts (`X_EMBED_PER_RUN`,
  default 4), most overdue first. Labs and scoop accounts are revisited about every
  10 minutes, other people about every 25.
- Requests are spaced out and alternate between two embed hosts.
- When X answers "too many requests", the X source backs off for 2 minutes,
  doubling up to 30, and keeps showing the posts it already has.

It works best from a home or office connection; cloud servers are often
rate-limited outright. The footer's **Sources** panel shows how many accounts
are loaded and when the next retry is.

For a steadier feed, set one of these and it is used first:

1. `X_BEARER_TOKEN`: official API v2 recent search (paid).
2. `RSSHUB_URL`: a self-hosted [RSSHub](https://docs.rsshub.app) with X cookies.
3. `NITTER_INSTANCES`: one or more Nitter instances, comma separated.

### Optional keys

Copy `.env.example` to `.env`. Everything is optional:

- `X_BEARER_TOKEN`, `RSSHUB_URL`, `NITTER_INSTANCES`: X, as above.
- `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`: Reddit blocks many datacenter IPs;
  a free "script" app at reddit.com/prefs/apps fixes that.
- `GITHUB_TOKEN`: higher GitHub search limits.

## How stories are built

1. **Normalize.** Every source emits the same item shape (title, url, source,
   platform, time, engagement).
2. **Cluster.** Items merge when they link the same canonical URL or their titles
   are near-duplicates (token Jaccard over an inverted index, within 48 hours).
   The best headline leads: first-party lab post, then press, then community.
3. **Score.** Source weight × engagement (log-scaled per platform) × number of
   distinct sources × freshness and momentum decay. Stories that keep picking up
   coverage stay warm.
4. **Correlate markets.** Stories and markets share an entity dictionary
   (OpenAI/ChatGPT/Altman → `openai`, and so on). A market is attached when they
   share a company **and** a theme (IPO, funding, regulation, benchmarks, AGI) or
   two or more concrete words. Markets that name many companies ("Which company
   has the best model?") count a shared name for less, so they don't attach to
   every story.

## Hosting

- **Node server** (live, recommended): `npm start`, or `docker build -t wire . &&
  docker run -p 3000:3000 -v wire-data:/data wire`. Crawl state persists to
  `data/state.json`, so restarts are instant.
- **Static** (free): `.github/workflows/pages.yml` crawls every 10 minutes and
  publishes `public/` with a fresh `data/snapshot.json` to GitHub Pages. Enable
  Pages → "GitHub Actions" in the repo settings and add any keys as secrets. The
  page detects there's no server and polls the snapshot instead.

## Project layout

```
src/
  config.js          every source, account, feed and cadence
  http.js            fetch with timeouts, retries, per-host backoff, proxy support
  sources/           one module per source family
  pipeline/          text utils, classification, clustering, scoring, market matching
  store.js           in-memory store, persistence, snapshot building
  crawler.js         per-source scheduler
  server.js          static files, /api/snapshot, /api/stream (SSE), /api/status
public/              the site (no build step)
scripts/crawl-once.js  one crawl, optionally writes the static snapshot
test/                node:test unit tests (npm test)
```

Keyboard: `/` search, `j`/`k` move between stories, `Esc` clears search.
