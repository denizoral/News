# Features changelog

One full-stack feature per scheduled maintenance run, newest first.

## 2026-10-21 · Search by meaning and related coverage

**Backend.**
- **Embeddings:** the classifier service (`classifier/server.py`) has a second
  model, `BAAI/bge-small-en-v1.5`, behind `POST /embed`. It takes its model
  lock per 16 texts, so interactive queries never wait long behind the
  backfill.
- **Embedder:** `src/index/vectors.js` embeds every article and post (its
  title and the first 200 characters of its summary) into a new `doc_vecs`
  table, as int8 plus a scale. New documents go first; the other ~198k are
  backfilled newest first. `/api/status` reports `embeddings` (done, backlog,
  errors).
- **Search:** vectors are searched by brute force in a dedicated worker lane
  (`offload.js` now runs a `vectors` worker beside the `history` one). That
  worker keeps every vector in memory and picks up new rows every 5 minutes.
- **`GET /api/search?mode=meaning&q=…`:** the closest documents in meaning,
  in the keyword search's response shape. It honours the News/Posts tabs and
  the time filters, keeps one copy per headline and returns up to 50.
- **`GET /api/related?id=<story>`:** up to 6 stored articles closest to a live
  story. It leaves out the story's own sources and near-copies of its
  headline, and requires similarity ≥ 0.72.

**UI.**
- **Search:** results get a Words / Meaning switch, kept in the URL
  (`&mode=meaning`). Meaning mode shows only the tabs it supports. A keyword
  search with no results offers "search by meaning".
- **Stories:** cards on News and Tech get a quiet "Related" link next to the
  source count. It opens a panel under the story listing the related articles
  with logo, outlet and date. Earlier reporting shows up there too, so the
  background to a developing story is one click away.

**Motion.** The panel opens through a View Transition, its rows rise in with a
short stagger, and a skeleton holds the space while it loads. All of it is off
under `prefers-reduced-motion`.

## 2026-10-21 · This week (weekly digest + RSS)

**Backend.** `src/index/digest.js` builds the week from the permanent index,
not the live feed (which holds three days). Every AI-related item the
aggregator stored in the last seven days (English, with a platform, so
spidered pages don't count) is clustered into stories the same way the front
page does. Stories are ranked by how many distinct sources covered them.
- **Top 12:** stories with at least two sources. Outlet suffixes like
  "… - Engadget" are trimmed.
- **Day by day:** each day's leading story that isn't already in the top list,
  with the day's story count.
- **Most covered:** the companies and themes with the most stories. Change in
  share of stories against the week before shows only once the index holds
  enough of that week to compare.
- **Markets that moved:** the price at the start of the week against now, from
  the odds history (`movers()` in `odds.js`). Markets with less than half a
  week of history are skipped.

`GET /api/digest` returns all of it. `GET /digest.xml` is an RSS 2.0 feed of
the week's biggest stories, also linked from the page `<head>`. It runs in the
shared history worker (`offload.js`), cached for 30 minutes.

**UI.** A "This week" tab (`#week`):
- A header with the date range, story and source counts, and an RSS button.
- "Biggest stories": the lead story with its image, then a numbered list.
  Each story has a coverage bar scaled to the leader and its source count;
  hovering the bar names the sources.
- "Day by day": a compact list, newest first.
- A side column: "Most covered" as bars linking to each topic page, "Markets
  that moved" with 7-day sparklines and "from → to", and "Released this week"
  from the releases feed.
- Long X-post titles are clamped to two lines.

**Motion.** Rows rise in with a stagger and the coverage bars fill from the
left, only when a new digest arrives. The tab change uses the existing View
Transition. All of it is off under `prefers-reduced-motion`.

## 2026-10-21 · Topic pages

**Backend.** `src/index/topics.js` answers "how big has this been, and what
happened when?" for every company and theme the classifier knows (OpenAI,
Nvidia, Regulation, IPOs, …) from all ~195k stored documents. For each of the
last 30 days it counts the articles and posts mentioning the topic (FTS over
title and description) and divides by that day's total, so crawl-volume swings
don't look like news. The timeline covers 14 days of English headlines that
name the topic. Within a day, a headline more outlets ran ranks first, and
syndicated copies collapse into one entry credited to the earliest. The
queries run in a worker thread with its own read-only connection
(`topics-worker.js`), since node:sqlite is synchronous. Results are cached for
15 minutes, and trending topics are pre-warmed after start.
`GET /api/topic?key=openai` returns the whole page. The day-totals query was
rewritten from a 13 s table scan to 0.6 s using the `published_at` index.
Market `entities` are now public in the snapshot so pages can list related
markets.

**UI.** `#topic/<key>`: the topic name and a summary line (mentions, busiest
day, current trend lift). A 30-day bar chart of coverage share follows, where
hovering a bar shows the day's mentions and share and today's bar is marked
as partial. Below it is a dated timeline with source logos and outlet counts.
A side column shows the topic's stories in the live feed and its Polymarket
markets with 7-day sparklines. Reach it from a trending card: filtering by a
topic shows a "30-day history →" chip.

**Motion.** Bars grow from the baseline in a left-to-right stagger and the
timeline days rise in, only when a page's data first arrives. The route
change cross-fades with a View Transition. All of it is off under
`prefers-reduced-motion`.

## 2026-10-21 · Polymarket odds history

**Backend.** `src/pipeline/odds.js` keeps the site's own record of every AI
market's odds in a new `odds` table in `data/wire.db`. Each Polymarket crawl
(every 90 s) writes an outcome's price when it has moved, and at least every 30
minutes; rows older than 30 days are pruned. So markets have a line from day
one, their hourly history for the past week is backfilled from Polymarket's
public price-history API (`clob.polymarket.com/prices-history`): 8 markets per
crawl, busiest first, each only once. Every market in the snapshot carries a
7-day `spark` of its leading outcome. `GET /api/odds?id=pm:…` returns up to
four outcomes' full history for the chart, backfilling the other outcomes on
first request. `/api/status` reports `odds` (rows recorded, backfills, errors).

**UI.**
- Markets tab: each card has a 7-day strip (sparkline, coloured green or red
  by direction, plus "27% → 17%"). Click it and the card widens to a full chart:
  one percent axis, day ticks, a line per outcome with direct labels at the end,
  a legend, and a crosshair tooltip that reads every outcome at that moment.
- News: stories with odds show a tiny 7-day sparkline next to the percentage.
- Chart colours are the dataviz reference categorical slots, validated for both
  themes; the light-mode contrast warning is met by the direct labels.

**Motion.** Sparklines sweep in from the left; the expanded chart rises in and
the card resize uses a View Transition; the chevron rotates. All of it is off
under `prefers-reduced-motion`.

## 2026-10-21 · Who breaks news first

**Backend.** `src/pipeline/scoops.js` looks at every story with two or more
original sources and credits the earliest one, with its lead over the next
different source. Hacker News and Reddit relay other people's links, so they're
neither credited nor used as the baseline. Leads under 5 minutes are a tie;
leads over 12 hours are old background pieces that got clustered into a new
story, not races. Each story carries `first` ({ name, platform, leadMin, next });
the snapshot carries `scoops`, a leaderboard over the live window (3 days):
first reports per source, median lead, and their biggest scoops. About 1 in 8
stories has a clear first reporter.

**UI.**
- Story cards show a small amber badge, "First: @ai_for_success · 49m ahead",
  when the lead is 10 minutes or more; hovering names the runner-up.
- The X tab gets a "Who breaks news first" board in its right-hand column:
  rank, logo, first reports, a bar scaled to the leader, the usual lead and the
  biggest scoop. X accounts on the board filter the feed when clicked. On
  narrow screens the board follows the feed, and on phones the subject chips
  scroll in one row so posts start above the fold.

**Motion.** Board rows rise in with a stagger and their bars sweep out from
the left the first time the board appears; bars glide to new lengths after
that. Off under `prefers-reduced-motion`.

**Known limit.** Finance syndicators (TradingView, Yahoo Finance) often
republish wire copy with early timestamps and top the board; crediting the
original wire when the copy names it would be a good refinement.

## 2026-10-20 · Trending now

**Backend.** `src/pipeline/trending.js` counts, for every company, person and
theme the classifier knows (OpenAI, Nvidia, Regulation, Funding, …), the
distinct news items mentioning it in the recent window and compares that with
its pace over the 24 hours before. Score = log2(1 + count) × lift, where lift =
(count + 1) / (expected + 1). A topic needs at least 3 items from 2+ sources,
so one prolific feed can't make a trend. Each topic carries a 24-hour
sparkline in 2-hour buckets. The 6-hour view ships inside the snapshot (works
for static hosting too); `GET /api/trending?hours=1|3|6|12|24` serves other
windows, cached per snapshot version with an ETag. Entity extraction per item
is memoized, so it adds ~1 ms to a rebuild.

**UI.** A "Trending now" strip above the lead story: ranked cards with name,
sparkline, story count and lift ("4.5×"). Clicking a card filters the river to
that entity (click again or "Show all stories" to clear); 3h / 6h / 24h chips
switch the window.

**Motion** (all transform/opacity, all off under `prefers-reduced-motion`):
- trending cards rise in with a stagger and their sparklines sweep in;
- new stories rise in, staggered, while stories already on screen stay still;
- skeleton placeholders shaped like story cards with a sweeping highlight;
- View Transitions cross-fade between tabs and filters where supported;
- odds bars now scale with `transform` and glide from the previous value when
  a market moves; the percentage ticks up or down once.
