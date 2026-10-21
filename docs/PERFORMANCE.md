# Performance

Measured numbers from the scheduled maintenance runs, newest first. Benchmarks:
`npm run bench` (Node) and `bun scripts/bench.js` (Bun) time the CPU-bound hot
paths on the items in `data/state.json` (a real crawl). Server numbers come from
a keep-alive HTTP client against `NODE_ENV=production SPIDER=off AGGREGATOR=off`.

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
