# Performance

Measured numbers from the scheduled maintenance runs, newest first. Benchmarks:
`npm run bench` (Node) and `bun scripts/bench.js` (Bun) time the CPU-bound hot
paths on the items in `data/state.json` (a real crawl). Server numbers come from
a keep-alive HTTP client against `NODE_ENV=production SPIDER=off AGGREGATOR=off`.

## 2026-10-22 (22:49 run)

**New names: FTS lookups.** Looking up article bodies for a name with the
FTS match joined to `docs` and `ORDER BY published_at` made SQLite walk docs
by date and probe the index per row: 10.4 s for "claude duet". Moving the
match into an `id IN (SELECT rowid … MATCH …)` subquery: 6 ms. The "was it in
the archive before?" count went the other way: the `IN` form counts every
match (18 ms a name), while a join with `LIMIT 60` stops as soon as the answer
is clear (1 ms). Also, one `RegExp` per candidate instead of one per
description. The whole computation went from over 100 s on the first draft to
3.5 s (60 days, about 20k articles, 230 candidates checked against the
archive), cached for an hour in the history worker.

**Rumor tracker.** 1.3 s over 90 days in the worker, plus 0.7–2 s to load the
embedding index the first time (the settlement and merge checks compare
headline vectors). Cached 30 minutes.

| Endpoint | Cold | Warm | Payload (gzip) |
|---|---|---|---|
| `/api/rumors` | 5.8 s | 1.6 ms | 139 KB (35 KB) |
| `/api/new-names` | 8.5 s (queued behind rumors) | 0.9 ms | 61 KB (22 KB) |

## 2026-10-22 (20:49 run)

**News map layout.** Exact t-SNE (from the first two principal components, so
the same data gives the same picture) over 360–640 story vectors: 1.4 s (a
day) to 3.7 s (a week) including clustering the window, once per 15 minutes
in the history worker. The first learning rate (120) diverged on small inputs;
the sklearn-style `max(n/48, 50)` converges. Regions first came from greedy
grouping in embedding space and didn't match the layout: only **49%** of a
story's five nearest dots on the map shared its region. Ward clustering of
the 2-D layout itself: **94–95%**, and every story lands in a region.
`/api/map` 122–244 KB raw, 112 KB gzip for a week; cold 4–5 s, then cached.

**Head to head.** Reuses the entity graph's window scan (cached in the
worker), so a comparison is ~0.4–0.7 s cold (most of it the two companies'
deal histories) and 1 ms warm; 17 KB. Distinctive words use weighted
log-odds with an informative Dirichlet prior whose strength scales with the
window (a fixed 500 found nothing on thin windows).

## 2026-10-22 (18:49 run)

**Forecast scan.** 120 days of bodies (30k rows): reading takes 1.2 s; the
first extractor tried the horizon pattern on every sentence and ran the quote
extractor on every body with a quote mark: 8.3 s in all. Only paragraphs that
name a year or "years"/"decade" (a cheap pattern) and then match the horizon
are split into sentences, and quotes are extracted only when such a paragraph
has a quote mark: **8.3 s → 2.7 s**, once per worker; later refreshes read new
rows by id. `/api/predictions` cold 4.8 s (scan + queue), warm 3 ms, 16 KB gzip.

**Catch-up.** Clustering the window costs 0.1 s (12 h, 1.2k items) to 0.6 s
(a week, 9k items) in the history worker. Windows snap to 15 minutes (an hour
past a day) so readers share answers; warm responses are a few ms, 6–8 KB
gzip. Storylines are raced against 1.5 s so a cold start doesn't block it.

## 2026-10-22 (16:49 run)

**Quote scan.** Reading 45 days of article bodies (31k rows, 259 MB of text)
with `id > ? AND type = 'article' AND hidden = 0 AND +published_at >= ?`, SQLite
picked `docs_moderation (hidden=?)` and walked the whole table. The first pass
now reads by date on `docs_type_pub` with `+hidden`. Later passes read only new
ids, through the covering `docs_when` index.

| Step | Before | After |
|---|---:|---:|
| First pass, SQL | 16.0 s | 1.8 s |
| Extraction (23.7k AI articles) | 4.1 s (patterns tried on whole bodies) | 1.2 s (only paragraphs with a quote mark and a saying verb) |
| Refresh (new rows) | – | 12 ms |

**Storylines.** Clustering 60 days, one day at a time, takes about 1.0 s on the
history lane. Past days are kept, so a refresh reclusters only today. Chaining
782 chapters by their mean embeddings takes about 0.1 s on the vectors lane,
which already holds the vectors. A storyline page comes from the same result.

**New endpoints** (cold after restart, then warm, gzipped):

| Endpoint | Cold | Warm | Size |
|---|---:|---:|---:|
| /api/storylines | 2.4 s (incl. vector load) | 6 ms | 18.0 KB |
| /api/storyline | – | 1 ms | 14.8 KB |
| /api/quotes | 2.4 s (first scan) | 2 ms | 5.8 KB |
| /api/quotes?q=nvidia | – | 26 ms | 5.0 KB |
| /api/person | – | 9 ms | 5.4 KB |

**Reddit.** A run takes about 238 s. That is deliberate: the crawler waits out
Reddit's quota between anonymous requests. Every run is still ok, and the crawl
runs in the background without blocking anything.

## 2026-10-22 (14:49 run)

**Outlet profiles.** For `WHERE site = ? AND type = 'article' AND hidden = 0
AND published_at >= ?`, SQLite chose `docs_type_pub`, reading a year of every
outlet's articles. With `+type`/`+published_at` it switched to
`docs_moderation (hidden=?)`, a full-table walk. Only with `+hidden` too does it
use `docs_site`:

| Profile (three queries) | Before | After |
|---|---:|---:|
| theverge.com | 1.47 s (24 s under start-up load) | 86 ms |
| techcrunch.com | 1.49 s (9.4 s under load) | 59 ms |
| unite.ai (56k articles) | 1.54 s | 0.75 s |

**New endpoints** (cold, then cached, gzipped):

| Endpoint | Cold | Cached | Size |
|---|---:|---:|---:|
| /api/days | 0.36 s | – | 1.8 KB |
| /api/day (busy day, Oct 21) | 0.86 s | 53 ms | 17.6 KB |
| /api/day (May 4) | 0.21 s | – | 3.9 KB |
| /api/outlets | 0.99 s (0.4 s scan) | – | 5.8 KB |

## 2026-10-22 (12:49 run)

**Deals.** The first version filtered by `d.published_at BETWEEN …`. On two
years SQLite chose `docs_pub` and ran the FTS match per row: it had not
finished after more than 120 s. With `+d.published_at`, FTS runs first:

| /api/deals | Time | Gzipped |
| --- | ---: | ---: |
| 90 days | 0.13 s | 42 KB |
| 1 year | 0.15 s | 61 KB |
| 2 years | 0.6 s | 74 KB |
| company history (all time) | 0.27 s | 2.7 KB |

**Ask the Wire.** Embedding the candidate sentences is the cost:

| Candidates | Embedding time |
| ---: | ---: |
| 120 sentences | 1.75 s |
| 72 sentences, pre-ranked by shared words and position | ~1 s |

- **Vector cache:** an LRU of sentence vectors (8,000 Float32Arrays, ~12 MB)
  skips articles that came up before.
- **Response times:** 0.9–2.7 s cold and about 1 ms cached, against 2.3–2.7 s
  before.
- **Passages step:** 0.3–0.5 s warm in the vectors worker.

## 2026-10-22 (10:49 run)

**Spider: 304s were crashes.** Since conditional GET (22cea59), `get()`
hands back 304 responses instead of throwing them. The spider then streamed
the missing body: "Cannot read properties of null (reading
Symbol.asyncIterator)".
- **Scale:** 3,210 such errors in six hours (about 530 an hour, the biggest
  error class by far). Each counted towards resting the site.
- **Fix:** 304s now log as `not-modified` and keep the site healthy, and
  `readBody` treats a missing body as empty. Zero of these errors since the
  restart.

**Trends (`computeTrends`, ~203k docs, 5.2 GB database).**

| Query (range) | Before | After |
| --- | ---: | ---: |
| openai, anthropic, google deepmind (1 year), cold | 36.2 s | 0.47 s |
| gemini, llama, mistral, qwen (1 year), cold | — | 0.74 s |
| agents, "reasoning model" (2 years), cold | 25.4 s | 0.87 s |
| nvidia (90 days), cold | 19.0 s | 0.39 s |
| same as first, warm | 1.1 s | 0.30 s |

- **What was slow:** counting matches per day needs only each document's
  date, but the FTS join read the full rows, bodies included, from a 5 GB
  table.
- **Fix:** `docs_when (id, published_at, first_seen, hidden, type)` covers the
  join, and `docs_at` (on the date expression) covers the per-day totals.
  Peak headlines rank ids through the narrow index and read only the few
  rows kept.
- **Over HTTP:** 1.7 s for the first request after a restart, 13 ms cached.

**Status page.** `/api/health?hours=24` takes 86 ms (`docs_seen` index for
arrivals per hour). API timing costs one `performance.now()` per request.

## 2026-10-22 (08:49 run)

**Search sorted by date (`search()`, live index of ~203k docs, one process,
warm).**

| Query | Before | After |
| --- | ---: | ---: |
| `nvidia` | 537 ms | 167 ms |
| `anthropic` | 511 ms | 141 ms |
| `open weights` | 384 ms | 90 ms |
| `"claude duet"` | 7 ms | 8 ms |

- **What was slow:** in date order, `bm25()` and two `snippet()` calls ran
  for every matching row before the sort picked 20. On common words that's
  thousands of rows. Behind a busy server the same request took 4.7–6.5 s.
- **Now:** a subquery picks the page by date alone, then columns and inlinks
  are read for its rows and snippets are built for the page only, as
  relevance mode already did. Results are identical.

**Model comparison (`computeModels`, ~120 releases, history worker).**

| | Before | After |
| --- | ---: | ---: |
| All models | 8,168 ms | 978 ms |
| `/api/models`, warm | — | 20 ms (17 KB gzipped) |

- Score extraction split whole article bodies into sentences. Only the text
  within 320 characters of each mention of the model is read now.
- One-word names ("Extract", "Summarize") must appear with their lab, as
  in coverage, which dropped their 80 ms scans.

**Feeds:** a topic feed builds in about 3 ms from the live snapshot, an
account feed in about 270 ms, a follows feed in about 350 ms (the For you
ranking). Each is cached a minute and answers repeats with a 304.

## 2026-10-22 (06:49 run)

**X account analytics (`computeAccounts`, 30 days: ~700 posts against
~27k articles, in the vectors worker).**

| | Before | After |
| --- | ---: | ---: |
| Every account, cold | 4,013 ms | 911 ms |
| Every account, warm | — | 217 ms |
| One account, warm | 120–220 ms | 18 ms |

- **What was slow:** loading full article rows (titles, URLs) for 30 days.
  The scan now reads only ids, times and sites; titles and URLs are fetched
  for the few matches.
- **Caching:** results for posts more than a day old can't change, so they
  are cached by URL. A warm run only redoes the last day's posts.
- **Dot products:** a dot product between two stored int8 rows
  (`VectorIndex.dot`) costs the same as the search loop. Each post only
  compares with its own 30-hour window, found by binary search on time.
- **Cached responses:** `/api/accounts` and `/api/account` are cached for
  10 minutes in the worker. The directory is warmed 60 s after start.

**For you (`/api/foryou`):** ~290 ms with 6 follows on the live feed. Most
of that is the taste job (URL → doc → row lookups and 300 dot products
against the centroid). The follow matching on the main thread takes under
5 ms for 400 stories.

## 2026-10-22 (04:49 run)

New work per feed rebuild and per request, measured on the live feed (400
news stories, ~4,900 items):

| | Time | Notes |
| --- | ---: | --- |
| Breaking detection (`BreakingTracker.update`) | 0.35 ms | per rebuild; a rebuild is ~140 ms |
| Palette index build (`buildIndex`) | 3.1 ms | ~600 entries; once per feed version |
| Palette query (`jumpSearch`) | 0.6–1.5 ms | linear prefix scan; no need for a trie at this size |
| Push payload encryption | <1 ms | per subscriber; ECDH + HKDF + AES-GCM in `node:crypto` |

- **Snapshot size:** only the active breaks go in the snapshot (no curves,
  images or topics; a few hundred bytes). The curves come from
  `/api/breaking`.
- **Service worker:** network-first, so it adds no latency online. It
  caches only the shell, the snapshot, story pages and the breaking archive,
  not search, so the cache stays small.

## 2026-10-22 (02:49 run)

**Market moves (`computeMoves`, 129 markets with $20k+ volume, 7 days).**

| | Time | Notes |
| --- | ---: | --- |
| One query per jump, every vector in the window decoded | 5.98 s | 386 jumps × ~1,500 documents |
| One pass over the week's titles, an index by title word, vectors read only for documents that name the market | 0.39–0.41 s | ~11k documents read once |

Jumps come from the odds table (an index on market, outcome, ts). Market
titles are embedded once per title and kept in memory. The result is cached
for 10 minutes and warmed 30 s after start. `/api/moves` is 34 KB for 24
moves, ~13 ms when cached.

**Entity graph (`computeGraph`, history worker).**

| Window | Before | After |
| --- | ---: | ---: |
| 7 days | 679 ms | 516 ms |
| 30 days (scans 60 for the trend) | 2,488 ms | 581 ms |
| 90 days | 1,999 ms | 754 ms |

- **Repo pages:** Hugging Face model pages, OpenRouter listings and GitHub
  repos are no longer read. They aren't coverage, and their long
  descriptions were most of the bytes.
- **Summaries:** only their first 300 characters are fetched, with
  `substr()` in SQL.
- **Detail views:** the window's scan stays in the worker, so a name's or a
  pair's headlines take ~1–5 ms.
- **Payloads:** `/api/graph` is 15–28 KB. The force layout runs once per
  window and screen shape in the browser (~70 names, 360 iterations, then a
  collision pass) and is cached, so live updates don't recompute it.

## 2026-10-22 (00:50 run)

**Story pages, uncached (`/api/story`, 20 live stories, after warm-up).**

| | Median | Range |
| --- | ---: | ---: |
| Two vector scans per page (X reactions, then background) | ~0.6 s | 0.41–0.79 s, one at 9.8 s |
| Second query reuses the first scan of the same vector | 0.29 s | 0.04–0.69 s |

- **Vector scans:** the scan over 200k vectors is ~140 ms. Time-window and
  site filters drop most neighbours, so filtered queries take 800 candidates
  instead of ~80.
- **Brief:** the "how many outlets agree" step compared every candidate
  sentence with every other, which is quadratic (~700 sentences on a big
  story). It now runs only for the 80 most central sentences.
- **Payloads:** a story page is ~6.6 KB; cached responses take ~1 ms.

**Emerging themes:** 400 stories, each a mean of its stored vectors, grouped
in 0.25–0.36 s in the history worker (vector reads ~100 ms, grouping
~25–80 ms), cached for 10 minutes. `/api/emerging` is 11 KB.

**Story ids:** assigning ids to ~550 live stories on each rebuild is in-memory
map lookups. Only new links and changed stories are written: a story's log
row at most every 5 minutes.

## 2026-10-21 (20:37 run)

**Main-thread SQLite.** A CPU profile of a restart showed two queries
blocking the event loop.

| Query | Before | After | Change |
| --- | ---: | ---: | --- |
| Moderated docs, on every feed rebuild (`store.loadModeration`) | 345 ms | <1 ms | Partial index `docs_moderated ON docs(url) WHERE hidden = 1 OR pinned = 1 OR locked = 1`; an `OR` can't use the existing `(hidden, pinned, locked)` index, so it scanned all rows. |
| Spider hub discovery, about hourly (`discoverHubs`) | 4.7 s cold, 0.75–0.95 s warm | 145 ms | Covering index `docs_fetched (fetched_at, type, hidden, site)` plus `INDEXED BY`. The planner otherwise picked the `hidden` index, which matches nearly every row, and read whole 25 KB rows. |

Both indexes are created in `migrate()`. On the 5 GB database that took 1 s.

**Release coverage** (new): 122 releases cost 0.2–0.33 s of FTS phrase queries
in the history worker, cached for 30 minutes. Cached responses take ~1 ms.

## 2026-10-21 (16:37 run)

**Vector search (semantic search, related coverage).** Every article and post
gets a 384-dimension bge-small embedding, stored as int8 with one float scale
(388 bytes per document, ~77 MB for 200k). Search is a brute-force dot product
in a worker thread. Measured on 200k random vectors on this box, with the
embedding backfill running alongside:

| Inner loop | Time per query (200k) |
| --- | ---: |
| Float query × int8 rows | 148 ms |
| Int8 query × int8 rows, 4 accumulators (shipped) | 114 ms |

Same top 10 results for both. A WASM SIMD kernel (`i32x4.dot_i16x8_s`) should
be several times faster still, but there's no WASM toolchain on the box yet;
it's the next step if the index grows.

**Query latency** (`/api/search?mode=meaning`, end to end, uncached, ~11k
vectors loaded so far):

| | Before | After |
| --- | ---: | ---: |
| Vector search on the shared history worker | 450–2,400 ms (queued behind topic warm-up and digest jobs) | — |
| Own worker lane, queries waiting on 64-doc embed batches | 97–834 ms | — |
| Own lane, model lock taken per 16 docs | — | 59–107 ms |

Embedding throughput: bge-small at 64 tokens embeds ~100 docs/s alone on 6
threads (128 tokens: ~59/s). It's ~35/s in production while the classifier
shares the CPU, so the ~198k-document backfill takes about 1.5 hours, newest
first. New documents are always embedded before the backfill continues.

**Polymarket outage.** When every Polymarket request failed (six crawls,
15:29–15:37 UTC, HTTP 404), the crawler set the market list to empty. That
blanked the Markets tab and the odds on stories until the next good crawl. It
now keeps the last good list and marks the source `stale`.

## 2026-10-21 (12:37 run)

**Weekly digest kept off the main thread.** The digest clusters every AI item
the aggregator stored over two weeks (this week and the one before, for
comparison) with the front page's `clusterItems`. On live data (3,098 items
this week, 2,377 stories) that takes 238 ms. It runs in the same worker as topic
pages, which is now a shared module (`src/index/offload.js` plus
`history-worker.js`), so it never blocks a request. Results are cached for 30
minutes, served stale while a refresh runs, and warmed after start.

| Request (warm) | Time |
| --- | ---: |
| `/api/digest` | 1.8–2.3 ms |
| `/digest.xml` | ~1 ms |
| `/api/topic?key=nvidia` (unchanged after the refactor) | 1.0 ms |

## 2026-10-21 (08:37 run)

### Story rebuild: 200 ms → 100 ms

`Store.rebuild()` re-clusters every item, links markets and builds the
snapshot about 2.5 times a minute, and it runs on the event loop: each one
stalled requests for ~200 ms. Measured on the live `data/state.json` (3,925
items, 180 markets), median of 8 rebuilds, Node 24.22:

| Step | Before | After |
| --- | ---: | ---: |
| `matchMarkets` (2,409 stories × 180 markets) | 69.6 ms | **13.9 ms** |
| `clusterItems` + `scoreStory` | 96.2 ms | **46.7 ms** |
| Whole `rebuild()` | 199.8 ms | **99.7 ms** |

- `matchMarkets` prepares each market once per Polymarket crawl (cached by
  object), caches each story's significant tokens by text, and indexes markets
  by company so a story is only compared with markets that share one. Output
  is identical: 83 of 2,409 stories linked, 0 differences against the old
  code.
- `clusterItems` caches the pure per-string work that repeats between
  rebuilds: title tokens, canonical URLs, entity extraction and keyword
  topics (bounded maps, cleared when full).

`npm run bench` now includes the `matchMarkets` line.

## 2026-10-21 (04:37 run)

### Live updates: hidden tabs stop downloading the snapshot

The server publishes a new snapshot about 2.5 times a minute (5 versions in a
measured 2-minute window, each one real: new stories, re-scored items). The
snapshot is 1.2 MB of JSON, 299 KB with Brotli, and every open tab fetched each
version even when it was in the background. Now a hidden tab fetches nothing
and catches up with one request when shown, updates that arrive within 2 s
share one fetch, and the footer's spider line stops polling while hidden.

| Open tab, per hour | Before | After |
| --- | ---: | ---: |
| Visible | ~150 fetches, ~45 MB | same (each version is real) |
| Hidden | ~150 fetches, ~45 MB | **0** (1 fetch on return) |

The next step for visible tabs would be sending deltas instead of the whole
snapshot.

## 2026-10-21

Environment: production server (12 cores, 14 GB), Node 24.22, live `data/wire.db`
with 165,874 indexed documents. Before and after run in one process against the
same database: `universal(q)`, median of 5, uncached.

### Search: snippets only for the returned page

Relevance search ranks up to 400 candidates and returns 20, but it built two
FTS5 `snippet()`s for all 400 (~300 ms on a common term). Snippets are now
built only for the page returned, in a second query by rowid. Results and
snippets are byte-identical.

| Query | Before | After | Speed-up |
| --- | ---: | ---: | ---: |
| claude | 539 ms | **200 ms** | 2.7× |
| openai | 718 ms | **404 ms** | 1.8× |
| gpt 6 | 511 ms | **77 ms** | 6.6× |
| nvidia | 603 ms | **272 ms** | 2.2× |
| rubin | 191 ms | **18 ms** | 10.9× |
| model release | 677 ms | **313 ms** | 2.2× |

What's left on common terms is mostly joining 400 candidates to `docs` and
`inlinks` (~80–130 ms) and the per-type facet count (~40–55 ms).

### Reddit: no more self-inflicted 429s

Anonymous Reddit requests went two at a time and ignored the quota Reddit
reports on each response (`x-ratelimit-remaining`, `-reset`); the JSON
endpoint, refused with 403 on this network, was retried every 30 minutes. In
the 4 hours before the change, 14 runs failed with "cooling down". Requests now
go one at a time and wait out the reset when the quota reads 0, and a JSON
refusal is remembered for 6 hours.

## 2026-10-20

Environment: cloud container, Node 22.22.0, Bun 1.4.2, 565 news items / 852 total.

### Hot paths (median ms per operation)

| Benchmark | Node before | Node after | Bun after |
| --- | ---: | ---: | ---: |
| clusterItems + scoreStory (565 items) | 24.9 | **9.7** | 12.9 |
| isAiRelated + extractEntities (1,700 texts) | 16.2 | **1.5** | 1.8 |
| parseFeed, 200-item RSS | 4.7 | 4.7 | 5.6 |
| tokens + canonicalUrl | 3.0 | 3.0 | 3.2 |
| stripHtml, 200 bodies | 2.6 | 2.6 | 1.3 |
| JSON.stringify state | 2.2 | 2.2 | 1.0 |
| gzip state | 7.6 | 7.6 | 5.0 |

`extractEntities` ran one regex per alias (~140 scans per text). It is now one
alternation scan that restarts one character after each hit, with identical
output (verified on 1,712 real titles and summaries plus edge cases).

**Runtime verdict.** Bun is faster on JSON serialization and the regex-light
`stripHtml`, slower on clustering, entity extraction and feed parsing. The
server's hot work is the latter, and SQLite FTS5 (native C) already does
search, so there is no clear win from moving any module to Bun, and nothing
CPU-bound enough to justify Rust/WASM yet. Revisit if clustering grows past
~50 ms (it is O(n · shared-token postings)).

### Payloads (bytes on the wire)

| Resource | Before (gzip) | After (Brotli) | Change |
| --- | ---: | ---: | ---: |
| /api/snapshot | 188,543 | 147,768 | −22% |
| /api/snapshot, uncompressed | 918,410 | 751,141 | −18% |
| / (index.html) | 2,072 | 1,669 | −19% |
| app.js | 9,628 | 8,334 | −13% |
| styles.css | 5,578 | 4,862 | −13% |
| search.js | 5,119 | 4,433 | −13% |

The snapshot dropped market fields the page never reads (each outcome's
question, slug, volume and end date; liquidity; entities) and rounds volumes.
Bodies are compressed once and kept: static files at Brotli 11, the snapshot
at 6 (it changes every few minutes, ~12 ms), cached search responses at 5.
Server latency was already sub-millisecond for cached bodies (0.1–0.3 ms per
request) and is unchanged.

### Crawl

| | Before | After |
| --- | ---: | ---: |
| Reddit requests per run (anonymous) | ~38 + RSS fallbacks | 5 |
| Reddit items | 68 (429s) | 100 |
| Feeds answered 304 on a repeat run | 0 | 16 of 41 |
| Full crawl wall time (first / repeat) | 13.4 s / — | 6.2 s / 2.7 s |
