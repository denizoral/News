# Performance

Measured numbers from the scheduled maintenance runs, newest first. Benchmarks:
`npm run bench` (Node) and `bun scripts/bench.js` (Bun) time the CPU-bound hot
paths on the items in `data/state.json` (a real crawl). Server numbers come from
a keep-alive HTTP client against `NODE_ENV=production SPIDER=off AGGREGATOR=off`.

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
