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

## Search engine

Besides the feed, Frontier Wire runs its own crawler and search engine. Type in
the search box: suggestions appear as you type, and Enter opens a results page.

**What gets stored.** Everything, permanently, in one SQLite file
(`data/wire.db`): every headline, post, project, model and market the
aggregator sees, plus the full text of every page the spider crawls. Images are
saved to `data/media/`, named by the SHA-256 of their bytes so a picture used by
ten articles is stored once. A disk budget (`MEDIA_MAX_GB`, default 5) deletes
the oldest images first.

**The spider** is a focused crawler, not a whole-web one. It needs no API keys:

- **Where it starts:** ~30 AI news sites (lab blogs, tech press, newsletters) in
  `src/config.js`, plus the full page behind every link the aggregator finds.
- **How it finds new articles:**
  - It rechecks those starting pages every 15 minutes and their sitemaps every 30.
  - It reads the RSS/Atom feeds that pages advertise, every 20 minutes. Only
    site-wide and AI-topic feeds are followed, not per-post comment feeds.
  - Sites that keep producing indexed articles are promoted to starting pages
    automatically, up to 25. You can review and dismiss them in the dashboard.
  - It follows links freely inside starting sites, and one hop out to other
    sites when the link is about AI.
  - Anything that keeps yielding nothing new is checked less often, up to 8×
    the interval, and goes back to normal as soon as it has news.
- **How it stays polite and keeps going:**
  - It obeys robots.txt (including Crawl-delay) and identifies itself as
    `FrontierWireBot`.
  - It waits at least 2 seconds between requests to the same site, and caps each
    site at 600 pages a day.
  - When a site rate-limits it (HTTP 429, or 503 with Retry-After), the whole
    site rests for as long as it asks, without counting as an error.
  - After 8 failures in a row (timeouts, server errors), a site rests for 15
    minutes, doubling up to 6 hours.
- **What it extracts:**
  - The article text, using Mozilla Readability, or the JSON-LD article body when
    the HTML is hard to parse.
  - Title, author, date and images, from Open Graph, JSON-LD and meta tags.
  - Character encodings are detected the way browsers do it (byte-order mark,
    header, `<meta charset>`), including correct Windows-1252.
- **What it skips:** `noindex` pages, exact duplicates, and pages that aren't
  about AI. A page counts as about AI if its headline or summary says so, or the
  body keeps coming back to it.
- **State:** the queue lives in the database, so a restart picks up where it
  left off. Logs go to `data/logs/server.log` (rotated at 10 MB).

**Ranking** is BM25 full-text relevance (title counts 10× the body, with
stemming so "models" matches "model"), adjusted for how many other sites link to
the page, engagement, and freshness. The All tab puts matching prediction
markets and images in their own boxes above the web results.

**Query syntax**

| Query | Meaning |
| --- | --- |
| `claude opus` | pages with both words |
| `"open weights"` | exact phrase |
| `nvidia -gaming` | exclude a word |
| `gemini OR claude` | either word |
| `site:theverge.com` | one site and its subdomains |
| `type:news`, `type:posts`, `type:markets` | one kind of result |
| `intitle:agents` | word must be in the title |

Tabs cover All, News, Images, Posts, Projects, Models and Markets, with filters
for time (day, week, month, year) and sorting by best match or newest.

**API:** `GET /api/search?q=&type=&time=&sort=&page=`, `GET /api/suggest?q=`,
`GET /api/doc?id=`, `GET /api/spider` (crawl stats), `GET /media/<hash>.<ext>`.

**Stored copies.** The full text of crawled pages is stored and searchable, but
the "Stored copy" reader view is off by default (`CACHED_COPIES=off`) because
showing other sites' full articles on a public site raises copyright issues.
Turn it on for private use.

Search needs the Node server. On the static GitHub Pages build, the search box
filters the feed instead.

## Admin dashboard

A dashboard at `/admin` (or `ADMIN_PATH`) runs everything without touching code:

- **Content:** search every document; fix a headline or summary; pin a story to the
  top of the front page; hide it; or remove it permanently. Hand edits lock the
  text, so crawlers can't overwrite them. Removals leave a hidden placeholder so
  feeds can't bring the story back.
- **Site:** name, tagline, announcement banner, which sections appear, and the
  `robots.txt` this site serves.
- **Crawler:** pause or resume, speed (parallel fetches, minimum gap per site),
  depth, pages per site per day, recheck intervals, images per page, starting
  pages, never-crawl list, and **per-site rules** (block a site, slow down, cap
  pages a day, skip paths). robots.txt is obeyed by default. Owners can switch it
  off for chosen sites or for every site, behind a typed confirmation, with a
  warning on the dashboard while it's off and an entry in the audit log. Also:
  crawl a URL now, clear a site's queue, retry failures,
  view any site's cached robots.txt.
- **Sources:** turn each feed on or off, set how often it runs, run it now, see
  why it's failing.
- **Storage & limits:** how long feed items and documents are kept, a document
  cap, the image budget, the largest image, whether stored copies are shown, and
  per-visitor limits for search and live connections.
- **Users:** owners, admins, editors and viewers, each with only the permissions
  they need. Also temporary passwords, two-factor resets, and signing a user out
  everywhere.
- **Audit log:** every sign-in attempt and every change, who made it, from
  where, and before/after values.

Changes apply live; nothing needs a restart.

### Creating the first account

There is no default account and no web setup page an attacker could reach
first. On the server:

```
npm run admin -- create your-name            # owner; prompts for a password
npm run admin -- list
npm run admin -- reset-password your-name
npm run admin -- reset-2fa your-name
npm run admin -- disable some-user
```

Passwords are typed at a hidden prompt (or piped with `--password-stdin`), never
passed as arguments or environment variables. Then sign in at `/admin`. Two-factor
sign-in with an authenticator app is required, and you get ten single-use
recovery codes.

### Security model

| Threat | Defence |
| --- | --- |
| Password guessing | scrypt hashes (N=2^15); per-IP and per-account rate limits; a growing account lock after 5 failures; identical errors and timing for unknown users; a global cap on concurrent hashing so login floods can't exhaust CPU |
| Stolen password | TOTP two-factor required by default; codes can't be replayed; secrets encrypted at rest (AES-256-GCM) |
| Session theft | 256-bit random token in an `HttpOnly`, `SameSite=Strict`, `Secure`, `__Host-` cookie; only its SHA-256 is stored; idle (30 min) and absolute (12 h) expiry; new token at every sign-in step; a password change ends all sessions |
| CSRF | SameSite=Strict, plus a per-session token header, plus an Origin check on every state-changing request |
| XSS | Strict CSP (`script-src 'self'`; the admin UI is `default-src 'none'` and loads nothing from third parties); all output escaped; no inline handlers |
| Clickjacking | `frame-ancestors 'none'`, `X-Frame-Options: DENY` |
| Privilege escalation | Permissions checked server-side on every route; every setting declares the minimum role that may change it; admins can't mint owners; the last owner can't be removed |
| Bad input | Every setting validated against a typed schema, all or nothing; JSON only; body size limits; prototype-pollution keys stripped |
| SSRF through the crawler | Crawled URLs must resolve to public addresses. Checked before each request, on every redirect, and (without an outbound proxy) at connect time, which stops DNS rebinding. Only ports 80, 443, 8080 and 8443 |
| Scanning, DoS | Optional IP allowlist (admin area returns 404 to everyone else); per-IP API budget; public search rate limits and caching; caps on live connections; header and request timeouts |
| Accountability | Append-only audit log of every action and sign-in attempt |

The Overview page includes a security checklist that flags whatever is still
missing for production.

## Running in production

1. Put it behind HTTPS (a load balancer, a CDN or a reverse proxy) and set
   `NODE_ENV=production`, `PUBLIC_ORIGIN=https://your-domain`, and `TRUST_PROXY` to
   the number of proxy hops. **Without `TRUST_PROXY`, every visitor looks like
   the proxy:** they share one rate limit, and the IP allowlist can't tell them apart.
2. Set `ADMIN_ENCRYPTION_KEY` from your secret manager and `ADMIN_ALLOWED_IPS` to
   your office or VPN ranges. Never commit `.env`; `data/` is git-ignored too.
3. Use the Docker image (`docker build -t wire .`). It runs as an unprivileged
   user, keeps all state in the `/data` volume, and has a `/healthz` check.
4. **For millions of visitors**, cache at the edge: `/api/snapshot` sends
   `Cache-Control: public, max-age=5` and an ETag, so a CDN serves the front page
   and the origin sees a few requests a second whatever the traffic. Search
   responses are cacheable for 15 s too. On the origin machine, run one
   background process (the default) plus extra web-only processes with
   `SPIDER=off AGGREGATOR=off`. They share the SQLite file (WAL mode allows many
   readers), and they reload the feed every 30 s. In-process rate limits only
   cover one process, so set the same limits at your CDN. Past what one
   machine can serve, the next step is moving search to a dedicated service
   (OpenSearch, Typesense), which this codebase doesn't do yet.

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
  store.js           in-memory feed store and snapshot building
  db.js              SQLite schema: documents, FTS5 indexes, frontier, hosts, images
  index/             writing documents, and search (query parser, ranking, suggest)
  spider/            crawler engine, robots.txt, page extraction, sitemaps, image store
  settings.js        typed, validated runtime settings (edited from the dashboard)
  admin/             auth (sessions, 2FA, roles), API routes, content moderation, audit log
  security/          password hashing, TOTP, encryption at rest, rate limits, SSRF guard, HTTP hardening
admin-ui/            the dashboard (served only under ADMIN_PATH, never as public static files)
scripts/admin.js     create and manage admin accounts from the server
  crawler.js         per-source scheduler
  server.js          static files, /api/snapshot, /api/stream (SSE), /api/status
public/              the site (no build step)
scripts/crawl-once.js  one crawl, optionally writes the static snapshot
test/                node:test unit tests (npm test)
```

Keyboard: `/` search (arrow keys pick a suggestion), `j`/`k` move between stories, `Esc` clears search.
