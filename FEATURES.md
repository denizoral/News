# Features changelog

Full-stack features from the scheduled maintenance runs, newest first.

## 2026-10-22 · Connections (entity graph)

**Backend.**
- **Names:** `src/index/graph.js` uses a typed vocabulary of about 110 names:
  labs and companies, people, products and models, and governments and
  regulators. It adds up to 25 names the coverage itself keeps using
  ("Claude Duet", "Gemini 4 Argon", "GPT-6 Astra"). A discovered name is a
  capitalised phrase in article summaries that:
  - is almost never written in lower case (so "Link" and "Hardware" drop
    out),
  - isn't an outlet's name,
  - doesn't start with "AI-",
  - isn't a shorter form of a longer name used about as often ("Opus 5.5").
- **Matching:** each article's headline and the start of its summary are
  matched case-sensitively, longest name first, so "Claude Code" isn't also
  "Claude". Model repo pages, OpenRouter listings and GitHub repos aren't
  counted.
- **Links:** ranked by co-mentions × log(1 + lift), keeping each name's 5
  strongest so the biggest names don't link to everything. A window has up
  to 72 names and 220 links.
- **Trend:** each name's count per day, and the window before it (for 7 and
  30 days) to show which names are rising.
- **`GET /api/graph?days=7|30|90`:** the network.
- **`GET /api/graph/detail?days=&a=[&b=]`:** a name's or a pair's headlines
  and articles per day, plus a name's most frequent companions. It's served
  from the scan the worker keeps.

**UI.**
- **`#graph`** (the new "Connections" tab): a force-laid-out SVG network.
  - Circles are sized by articles and coloured by kind, with a legend and
    labels on the 40 biggest names. The palette passes the dataviz
    validator.
  - The layout is deterministic and fitted to the frame. A collision pass
    keeps labels apart, and labels sit on a layer above every circle.
- **Interaction:**
  - Pointing at a name lights its links and neighbours and dims the rest,
    with no re-render.
  - Names and links are links to `#graph/<name>` and `#graph/<a>+<b>`, so
    they work from the keyboard.
- **Panel:** with nothing chosen, the strongest links and the names rising
  fastest. For a name: articles in the window, the change against the window
  before, articles per day, most frequent companions and latest headlines.
  For a pair, the same with the lift ("2.2× more often than chance").
  Names with a topic page link to it.
- **Window:** 7, 30 or 90 days, remembered per browser.
- **Motion:** circles pop in staggered, links draw, labels fade in and bars
  grow. All of it is off under `prefers-reduced-motion`.

## 2026-10-22 · Market moves ("Moved after the news")

**Backend.**
- **Jumps:** `src/index/moves.js` finds odds jumps in the stored history: 7+
  points within 3 hours that hold.
  - The median price for the 3 hours after must still differ from the median
    of the 6 hours before by 6+ points, in the same direction. Snap-back
    spikes and bid-ask bounce on thin markets don't count.
  - A move in two steps is one jump.
  - A jump isn't judged until an hour has passed.
  - It runs on the top 3 outcomes of every market with $20k+ volume, over
    the last 7 days.
- **Attribution:** each jump is credited to English articles and posts from
  the 6 hours before it (and its first hour) that are:
  - close in meaning to the market question (bge-small with the query
    instruction; market titles are embedded once), and
  - naming its subject: the outcome that moved ("Anthropic") plus a fairly
    uncommon word of the question ("Muse") on multi-outcome markets,
    otherwise two words of the question, one of them uncommon ("GPT Sol",
    not "OpenAI GPT").
  Weaker matches need a closer meaning. Words in more than 0.5% of the
  week's titles ("Google", "GPT") don't count as uncommon. Each match carries
  its story id when it reached the feed, so it links to the story page.
- **Endpoints:**
  - `GET /api/moves`: the explained jumps across markets.
  - `GET /api/moves?market=`: every jump on one market.
  - `/api/odds` now includes a market's jumps, and `/api/story` lists the
    moves a story's coverage came before.

**UI.**
- **Markets view:** "Moved after the news" cards above the list. Each shows
  the market, the outcome, from → to with ▲/▼ points, the time, and a small
  chart of the price around the jump with the jump drawn heavier. Below
  that, "Before it" gives the headline, the outlet and how long before. The
  copy says timing isn't proof of cause. Six cards show, then "Show all".
- **Odds charts:** each jump gets a shaded band and a numbered marker. The
  notes underneath give what came before each one, or "no story found". A
  card opens its market's chart.
- **Story pages:** each market gets a band on its small chart and a line
  such as "▲ 14 pts Anthropic (84% → 98%) 1h after this story's coverage".

## 2026-10-22 · Emerging themes

**Backend.**
- **Grouping:** `src/index/emerging.js` gives each live story the mean of
  its stored articles' embeddings (`story_ids` → `docs` → `doc_vecs`). It
  then groups related stories, biggest first. A story joins a theme only if
  it's close to both the theme's centre and the story that started it, so
  one broad "AI news" theme can't swallow everything.
- **Ranking:** themes need at least 3 stories and 3 outlets, with at least 3
  reports in the last 12 hours. They're ranked by recent reports × √growth,
  where growth is the reports-per-hour rate over the last 12 hours against
  the 36 before. Each theme gets a 48-hour hourly count.
- **Names:** the phrase its headlines share that the rest of the feed
  doesn't. Bigrams beat words, proper nouns ("Claude Duet") beat common words,
  and the headlines' own capitalisation is kept.
- **Cost:** ~0.25–0.35 s for 400 stories in the history worker, cached for
  10 minutes.
- **`GET /api/emerging`:** the top 8 themes.
- **`GET /api/emerging?id=`:** one theme with all its stories. It's keyed by
  the theme's lead story and still found if the theme has regrouped.

**UI.**
- **Front page:** an "Emerging" block at the top of the rail lists up to 5
  themes. Each shows its name, lead headline, a 48-hour bar strip (last 12
  hours in colour), a "New" or "↑ 15×" badge, and story and outlet counts.
- **`#theme/<id>`:**
  - a headline summary ("45 reports in the last 12 hours, new in the last 12
    hours · 19 stories from 29 outlets") with links to related topics,
  - a reports-per-hour chart with a dashed line 12 hours back,
  - every story in the theme, each linking to its story page.
- **Motion:** rail items rise in, the "New" badge shimmers, chart bars grow
  and story rows stagger. All of it is off under `prefers-reduced-motion`.

## 2026-10-22 · Story pages

**Backend.**
- **Stable story ids (`src/index/stories.js`):** every item that has ever
  been in a story is linked to the id that story first had (`story_ids`). A
  re-clustered story takes the id most of its items already carry. A link
  therefore survives new sources, a new lead article, merges and the story
  leaving the 3-day feed: `story_log` keeps its headline, topics and markets,
  and the stored documents keep the rest. The feed's stories now carry
  `sid`.
- **`GET /api/story?id=<sid>` (`src/index/storypage.js`):**
  - **timeline:** each outlet's first report in order. Hacker News and Reddit
    are marked as discussion, and the first original report is the lead.
  - **growth:** outlets and X accounts over time.
  - **brief:** an extractive summary across outlets (`src/pipeline/brief.js`).
    Sentences are scored by TF-IDF closeness to the story's centre and by how
    many outlets said much the same thing. Lead sentences get a small boost.
    Sentences leaning on an earlier one ("The decision…") and boilerplate are
    penalised. Picks skip near-repeats and the summary already shown under the
    headline, at most two per outlet, each credited and linked.
  - **reactions:** the story's own X posts plus X posts close in meaning
    within its time window.
  - **background:** earlier articles on the subject from at least 12 hours
    before it broke, by meaning.
  - **markets:** each linked market's odds history over the story's life,
    and the leading outcome's price when it broke against now.
  - A story that has left the feed is rebuilt from the stored documents;
    one that was merged resolves to the live story it joined.
- **Vector search:** `similarDocs` gains `until` and `sites` filters, with a
  wider candidate pool when filtering.

**UI.**
- **`#story/<sid>`:**
  - a header with status (Developing / Archived), topic links, headline, dek,
    who reported it first, outlet count, latest update and "Copy link"
    (share sheet on touch),
  - **The brief**,
  - **How it spread:** a step chart of outlets over time with a crosshair
    tooltip, and a timeline of outlets with "+2h 14m" offsets (first 10,
    then "Show all"),
  - a side column with **On X**, **Markets** (sparkline, dashed "story
    broke" marker, "41% → 62% since the story broke") and **Background**.
- **Entry points:** the "Developing" badge on story cards, and a "Full
  coverage" link under the expanded source list.
- **Motion:** the step line draws itself, dots pop in as outlets arrived,
  timeline rows and brief sentences rise in, and the hero image fades up.
  All of it is off under `prefers-reduced-motion`.

## 2026-10-21 · Release coverage

**Backend.**
- **Matching:** `src/index/releases.js` finds, for every model on the
  Releases page, the stored articles and posts that name it. It looks from
  the day before launch to 30 days after, in English only.
  - The name is matched as a whole version, so "Claude Opus 5" doesn't pick up
    "Claude Opus 5.5". Spacing variants such as "Qwen3.8" and "Qwen 3.8" both
    count.
  - A one-word name like "Flint" or "Extract" must appear with its lab's name.
  - Model repo pages, OpenRouter "now available" notices and translations are
    left out.
  - Syndicated copies collapse into one entry, with an outlet count.
  - First reporter: the earliest article with the model in its headline.
- **Cost:** about 0.2–0.3 s for the whole list, run in the history worker and
  cached for 30 minutes. It warms at startup from the saved list. When the list
  changes, the last result is served while the new one is computed.
- **`GET /api/releases/coverage`:** story and outlet counts for every release.
- **`GET /api/release?id=<release>`:** one release in full: count, outlets,
  first reporter, stories per day and the top 8 stories.
- **Fix:** releases are now merged across OpenRouter and Hugging Face even when
  the two name the lab differently ("z-ai"/"zai-org", "deepseek"/"deepseek-ai",
  "liquid"/"liquidai"). That removed 6 duplicate entries (128 → 122).

**UI.** On a release row, "In the news ↗" (which only worked while a story was
in the live 3-day feed) becomes "N stories". It opens a panel under the row
with:
- a one-line summary ("111 stories from 53 outlets since launch. First:
  Google, Oct 13."),
- a small bar chart of stories per day, with a tooltip per day,
- the top stories, with logo, outlet, "+N" more outlets and date. The first
  report is marked "First".

**Motion.** The panel opens through a View Transition, the chevron turns, the
bars grow from the baseline with a short stagger and the rows rise in. All of it
is off under `prefers-reduced-motion`.

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
