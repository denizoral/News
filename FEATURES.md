# Features changelog

Full-stack features from the scheduled maintenance runs, newest first.

## 2026-10-22 · Any day (#day)

**Backend.** `src/index/day.js` rebuilds the front page of any past day from
the archive.
- **Stories:** the day's English AI articles and posts (spidered pages as well
  as feed items, since older days have few feed items) are clustered with the
  front page's `clusterItems` and ranked by distinct sources, then outlets,
  then engagement. Each story leads with its most central headline (the one
  sharing the most words with the others), so a marketing blog's rewrite
  doesn't stand in for the story.
- **Around them:** the most-liked X posts; deals announced that day (the
  Deals parser); companies and themes whose share of articles is ≥1.5× their
  share in the four weeks before; releases that day; and the markets whose
  odds moved most within the day (odds history starts Oct 14, 2026).
- **`GET /api/day?d=YYYY-MM-DD`** and **`GET /api/days`** (items per day over
  371 days for the calendar). A past day is cached for 6 hours, today for 10
  minutes. Days take 0.2–0.9 s cold and ~50 ms cached.

**UI.** `#day` (yesterday) and `#day/<date>`:
- A year calendar: one square per day, shaded in five quantile steps of one
  hue (so a year of crawl growth doesn't wash out early months), with a
  legend, month and weekday labels and a hover tooltip. Every square is a
  link. On phones it scrolls sideways inside its card, opening on the latest
  weeks.
- Previous/next day links, a date picker, and ← / → keys.
- The day: four tiles, a numbered front page (lead image when the lead has
  one, summaries on the top three, topic chips, "N more reports"
  disclosure), and a side column with "Far more than usual" lift bars, deals,
  releases, markets that moved (from → to, points) and most-liked X posts.
- **Motion:** calendar squares pop in column by column; a new day slides in
  from the side you moved toward; bars grow. Off under reduced motion.
- **Reach it:** footer, ⌘K ("Any day", or type a date like "March 10"), and
  every day in This week links to its page.

## 2026-10-22 · Outlets (#outlets, #outlet/<site>)

**Backend.** `src/index/outlets.js` profiles every outlet with 20 or more AI
articles in 90 days (116 today). One scan of the window (~60k rows, ~0.4 s)
feeds the directory and every profile and is kept for 30 minutes.
- **Beat:** the companies and themes an outlet names more than all outlets do
  (share against all-outlet share, ≥1.25×).
- **Similar beat:** cosine of the outlets' residual mixes (share minus the
  all-outlet share, chi-scaled), so outlets aren't "alike" just for both
  covering OpenAI. The Verge → Engadget, CNET; Tom's Hardware → TechPowerUp,
  StorageReview.
- **Also:** a year of weekly volume, AI articles by hour (left out for feeds
  that only give dates) and weekday, median length, top writers, the most
  covered names and the latest headlines. Repos, model cards, papers and
  social sites aren't outlets.
- **`GET /api/outlets`** and **`GET /api/outlet?site=`** (404 below the bar).

**UI.**
- `#outlets`: a directory with a 13-week sparkline, articles per week, share
  about AI and beat chips per outlet, a live filter (by name or beat: "Nvidia"
  finds the chip press) and three sorts.
- `#outlet/<site>`: tiles, the beat as bars with an all-outlets tick on each,
  weekly volume and hour-of-day bar charts with hover tooltips, weekday bars,
  most-covered grid, similar outlets, writers (each a site search) and latest
  headlines. Follow puts the outlet into For you.
- **Motion:** rows rise in staggered and bars grow. Off under reduced motion.

## 2026-10-22 · Ask the Wire (#ask)

**Backend.** `src/index/ask.js` answers a question with up to five sentences
quoted from stored coverage, each citing its article. Nothing is generated.
- **Retrieval:** the nearest articles by meaning (bge-small, in the vectors
  worker) and the best BM25 matches on the question's words, merged by
  reciprocal rank. English only. Model cards and repos (Hugging Face, GitHub,
  OpenRouter) are left out.
- **Sentences:** split from each article's body and cleaned:
  - datelines, photo credits and "Skip to content" are stripped
  - paragraphs that were glued together are split
  - questions, menus, boilerplate and other languages are dropped

  The lead and the sentences sharing the question's words make up about 70
  candidates.
- **Ranking:** candidates are embedded (vectors cached across questions) and
  scored by similarity to the question, plus small credit for shared words,
  the lead, the article's rank and recency. Recency weighs more when the
  question asks for the "latest".
- **Answer:** picked by maximal marginal relevance, so near-copies are skipped,
  with at most two sentences from one article.
- **Confidence:** well covered, partly covered or closest matches.
- **`GET /api/ask?q=`**, cached 30 minutes. About 1.5–2.5 s cold.

**UI.** `#ask?q=…`, reached from the footer, the ⌘K palette and search.
- **Palette:** a question typed into ⌘K offers "Ask the Wire" first.
- **Search:** a question typed into search gets an "Answer it from the
  coverage →" link.
- **Empty page:** example questions and the visitor's recent questions, kept
  in this browser.
- **Answer card:** shows a confidence label (icon and word) and how many
  articles it drew on. Sentences rise in one after another with a brief accent
  on their rule, each with its outlet, date and a numbered citation.
- **Sources:** pointing at a citation lights up its source in the numbered
  list, which shows cited sources first and related ones after.
- **Links:** "Search every article" and "How often it comes up".

## 2026-10-22 · Deals (#deals)

**Backend.** `src/index/deals.js` reads funding rounds, valuations and
acquisitions out of headlines.
- **Parsing:** a full-text query finds headlines with deal verbs. Each is
  parsed for:
  - the company, cutting descriptors ("Legal AI startup Harvey",
    "Berlin-based YGO", "OpenAI-backed …") and title-case bridges ("OpenAI Is
    Racing to Raise")
  - the amount, in dollars, with euros and pounds converted and flagged
  - the round, valuation, investors ("led by", "from")
  - whether it is only in talks
- **Filters:** contracts, chip orders, funds, price targets, stock tips and
  undated archive pages are skipped. Only AI coverage counts.
- **Grouping:** headlines about the same company, kind and a similar amount
  within 30 days become one deal, with its outlets and first report. A
  valuation-only headline joins its round. An amount that equals the
  company's reported valuation is dropped as a misprint (an "Anthropic raises
  $965B" headline).
- **Totals:** capital raised per week or month by stage (seed, A–B, C and
  later, not given), top raisers, the largest round and acquisitions.
- **Per company:** every deal on record with its valuation history.
- **`GET /api/deals?range=90d|1y|2y`** and **`GET /api/deals/company?key=`**.
  Computed in the history worker in 0.15–0.6 s, cached 30 minutes; 60–74 KB
  gzipped.

**UI.** `#deals?r=…&k=…&c=…`, reached from the footer and the palette.
- **Header:** four tiles.
- **Chart:** a stacked bar chart of capital raised by stage, in the validated
  four-colour set, with a legend. Bars grow in, and hovering shows a band and
  a tooltip per period.
- **Deal list:** grouped by month, with:
  - round, buyer, valuation and "In talks" labels
  - the first report and the number of outlets
  - a live filter by company or investor
  - Latest or Largest sorting, and "Show more"
- **Raised the most:** a sticky sidebar whose bars grow in.
- **Company panel:** clicking any company opens its total raised, a
  valuation line with hover, and a timeline of every deal with its headlines.
- **Acquisitions view:** shows the list alone.

## 2026-10-22 · Trends (#trends)

**Backend.**
- **`src/index/trends.js`:** for one to four terms (words or "phrases"),
  how many stored stories mention each per day (30 or 90 days) or per week
  (1 or 2 years), divided by everything stored in that bucket. That gives
  mentions per 1,000 stories, so a line only rises when the share does, not
  when we crawl more. Markets and hidden documents don't count.
- **Peaks:** the three highest buckets per term, at least four apart and with
  three mentions or more. Each comes with the best-matching headline, in
  English first, since the archive also holds machine-translated copies.
- **Change:** the last four complete buckets against the four before.
- **Cost:** runs in the history worker, cached 15 minutes. Two narrow date
  indexes keep it off the 5 GB table: a cold one-year comparison of three
  labs went from 36 s to 0.5 s (see PERFORMANCE.md).
- **`GET /api/trends?q=a,b&range=1y`** and
  **`GET /api/trends/moment?q=&from=&to=`**: the best stories for one term in
  one period, one per headline.

**UI.** `#trends?q=…&r=…`, reached from the footer, the ⌘K palette, a "How
often it comes up →" link on search results and a link on every topic page.
- **Input:** a comma-separated box, removable chips per term in the series
  colour, and 30 days / 90 days / 1 year / 2 years. Presets when empty.
- **Summary cards:** total mentions, change and peak date per term.
- **Line chart:** up to four validated colours with a legend and direct labels
  at the line ends. Lines draw in one after another. Hover shows a crosshair
  and every term's value.
- **Peaks and moments:** numbered peak markers pop in after the lines and
  are listed with their headlines. Clicking a marker, a listed peak or any
  point opens what each term's coverage said that day or week.
- **Table:** every bucket as a table, behind "Show as a table".

## 2026-10-22 · Status (#status)

**Backend.**
- **`src/status.js`:** a row per aggregator source run (`source_runs`).
- **Vitals:** every five minutes (`vitals`), the event-loop delay at the 99th
  percentile, memory, API response time at the 95th percentile, the
  embedding and labeler queues, and X accounts cached. Both tables keep 30
  days.
- **`GET /api/health?hours=24|48|168`:** per source, hourly runs, failures,
  median time and items added; uptime; p50/p95; the last error.
- **More in the same call:** documents arriving per hour, spider fetches per
  hour by outcome, the vitals, and when each tracked X account last posted.
  It takes about 85 ms and is cached for a minute.
- **History:** a week of past runs was backfilled from the journal.

**UI.** `#status`, linked from the footer and the palette.
- **Headline:** "Everything is working", or which sources are failing or
  flaky, with a status icon and a word, never colour alone.
- **Tiles:** sources working, documents arriving, API p95 and X accounts
  posting.
- **Uptime strips:** one cell per hour per source (all ok, some failed, all
  failed, no runs), with a tooltip per hour, median time, last run and the
  last error behind a click.
- **Charts:** documents per hour and spider fetches per hour by outcome
  (stacked, validated palette, bars grow in), plus four vitals line charts
  with a crosshair.
- **X accounts:** quietest first, flagged after three days without a post.

## 2026-10-22 · Compare models (#models)

**Backend.**
- **`src/index/models.js`:** every release on the Releases page (90 days)
  with listing data plus what the wire knows about it.
  - **Price:** input, output and a blended price (3 parts input to 1 part
    output) per million tokens, from OpenRouter.
  - **Size:** total and active parameters from the name, the Hugging Face
    sizes or the listing's blurb ("501B A23B", "2.5B active … 40B total").
  - **Coverage:** stories and outlets since launch, the first week, the last
    seven days, stories per day and the first reporter (reusing release
    coverage).
  - **Reported benchmark scores:** read from stored articles that name the
    model, but only from a sentence that names this model and no other, with
    a percentage right beside a known benchmark (SWE-bench Verified/Pro,
    Terminal-Bench by version, HLE, GPQA, ARC-AGI by version, AIME, OSWorld
    and others). Tables and comparisons are skipped. When outlets disagree,
    the value most outlets printed wins and the score is marked disputed.
- **Cost:** ~1 s for all ~120 releases in the history worker, cached 30
  minutes, warmed 20 s after start. Only text near each mention of the name
  is split into sentences (8.2 s → 1.0 s).
- **`GET /api/models`:** all models plus the benchmarks found (17 KB gzipped).

**UI.** `#models`, reached from a List | Compare switch on Releases, the
command palette and the Releases tab.
- **Price chart:** blended price (log) against stories since launch or
  context window. API-only and open-weight models are two validated colours
  with a legend. Free models get their own strip. Labels go on the most
  covered and the picked models, placed clear of other labels and dots.
  Dots pop in with a stagger; hover shows a tooltip, click picks a model.
- **Table:** sortable by name, date, price, context, size and stories, with
  reported-score chips linking to the article that printed them.
- **Side by side:** up to four models (`#models/<id>+<id>`, shareable).
  Prices, context, parameters, weights, coverage, a stories-per-day spark on
  one scale, first report and every reported benchmark. The best value in
  each row is marked.

## 2026-10-22 · API and feeds (#developers)

**Backend.**
- **Feeds (`src/feeds.js`)** as RSS 2.0 and JSON Feed 1.1 (`.xml` / `.json`):
  - `/feeds/topic/<key>`: live stories on a topic.
  - `/feeds/account/<handle>`: an X account's posts (14 days).
  - `/feeds/search?q=`: newest results for a search.
  - `/feeds/foryou?t=&n=&a=&o=`: the For you ranking for a set of follows
    (the follows travel in the address; nothing is stored).
  - `/feeds/breaking`: stories as they break.
  - Items link to the article, with the story page and other outlets in the
    body. Built at most once a minute per address. An ETag made from the
    items gives readers a 304 when nothing changed. CORS is open.
- **`GET /api`:** the API described from one catalog (`src/apicatalog.js`):
  groups, parameters, notes and live example URLs. A test calls every
  documented example to check it's routed.
- **`stopWorkers()`** in `offload.js` lets tests (and shutdown) end the
  worker threads.

**UI.** `#developers` (footer link "API and feeds", and the palette).
- **Make a feed:** topic, X account, search, your follows or breaking; RSS
  or JSON Feed. Shows the address with Copy and Open, and a live preview of
  the first items with the build time.
- **Endpoints:** every endpoint grouped, with parameters and notes. "Try it"
  runs the example (filled with ids from the live page) and shows status,
  time, size and highlighted JSON, with long arrays and strings cut.
- **Feed buttons** on topic pages, account pages, For you (your follows)
  and Breaking. A click copies the feed address for a reader; a modified
  click opens it. The page head also advertises the breaking feed.

## 2026-10-22 · X account pages ("Who’s first on X")

**Backend** (`src/index/accounts.js`, in the vectors worker).
- **Ahead of the press:** every stored X post (~700 in 30 days, all
  embedded) is compared with the articles published from six hours before
  it to a day after (int8 dot products against rows already in memory).
  When articles that say the same thing (cosine ≥ 0.80) only appear after
  the post, the post led the press by the time to the first of them.
  - A post doesn't count when the press covered it first, or within 10
    minutes.
  - Its own linked article doesn't count, and neither do Reddit or Hacker
    News, which relay links.
  - A single late follow-up (one outlet, more than 6 h later) doesn't count.
  - Results for posts over a day old are final and cached.
- **Per account:** posts per day, a weekday × hour grid, the companies and
  themes it posts about, the accounts it mentions, its lead posts, its most
  picked-up posts (joined live stories with many sources) and its latest
  posts.
- **`GET /api/accounts`:** every account ranked by lead posts, with a 14-day
  sparkline.
- **`GET /api/account?handle=`:** one account. Add `&vs=` for two accounts
  side by side plus the names they share.
- The ⌘K palette's X-account results now open account pages, and the
  palette lists every account, not only those in the live posts.

**UI** (`public/accounts.js`).
- **`#accounts`:** a ranked list with a lead bar, median lead, a 14-day
  sparkline, the top three topics, group and sort chips, and a Follow
  button.
- **`#account/<handle>`:**
  - stat tiles;
  - a posts-per-day bar chart with hover;
  - a heatmap of posting hours in the reader's own time zone;
  - "talks about" share bars;
  - the lead posts, each showing how far ahead it was and of whom;
  - a "Compare with…" picker.
- **`#account/<a>/vs/<b>`:**
  - two daily charts on one shared scale;
  - a butterfly chart of the names both accounts post about;
  - a head-to-head table that marks the leader;
  - each account's best lead posts.
- **Where to find it:** the X tab links to it ("Who’s first on X →"), and
  every author name on X posts opens that account's page. Bars grow and
  rows rise in, both off under reduced motion.

## 2026-10-22 · For you (follows and a personal feed)

**Backend** (`src/index/foryou.js`).
- **`GET /api/foryou?t=&n=&a=&o=&s=`** takes the reader's follows from the
  query string and keeps nothing: topics, names from the Connections graph,
  X handles, outlets and saved story ids, at most 30 of each. Malformed
  values are dropped.
- **Matching:** a story matches when it is tagged with a followed topic,
  names a followed name, or carries a post or article from a followed
  account or outlet. Each match carries its reasons.
- **Taste vector:** the mean embedding of the saved stories and the best
  follow matches, computed in the vectors worker, scores every live story.
  This brings in stories close in meaning that name no follow (marked ≈).
- **Ranking:** distinct follow matches, then taste, then story score, with
  a boost for stories that are breaking. The response also carries the
  latest posts from followed accounts.
- **`GET /api/follow/suggest`:** what is worth following now: topics in the
  live feed, the most-mentioned names, accounts that lead the press, and
  the busiest outlets.

**UI** (`public/foryou.js`).
- **Follow buttons:** topic pages, Connections name panels, account pages
  and the account list each get one. The plus folds into a check. Every
  copy on the page stays in step, and a toast confirms each change.
- **Follows** are kept in this browser (`fw.follows`). The **For you** tab
  shows how many there are.
- **`#foryou`:**
  - with no follows, a picker of suggestions;
  - with follows, the ranked feed with reason chips (topic, name, @account,
    outlet, ≈ taste, Breaking);
  - a "Following" manager with unfollow buttons;
  - recent posts from followed accounts;
  - more suggestions;
  - a short "How it works".
- The palette and j/k cover both new pages. The service worker caches the
  new modules (cache `fw-v2`).

## 2026-10-22 · ⌘K palette, reading list, shortcuts and installable app

**Backend.**
- **`src/index/jump.js`:** one in-memory index of everything with a page or
  panel: topic pages, names from the entity graph, X accounts, releases
  (linking to their story when there is one), emerging themes, live stories
  and markets. It is rebuilt only when the feed, the graph or the themes
  change (~3 ms for ~600 entries); a query takes ~1 ms.
  - Every word typed must start a word of the entry ("cl du" finds Claude
    Duet, "@sama" an account). Ranking: whole and leading matches, then kind
    (topics and names first), then size. At most five of one kind.
- **`GET /api/jump?q=`:** palette results. Slow inputs (graph, themes) are
  waited on for at most 250 ms.
- **`GET /api/saved?ids=`:** for up to 100 saved story ids, how each looks
  now: sources, still live, breaking, or from the story log once it has
  left the feed.

**UI** (`public/palette.js`).
- **⌘K / Ctrl+K** (or the ⌘K button) opens a palette: recent jumps, pages
  and actions when empty; server results grouped by kind as you type, with
  a "Search everything" fallback. Arrow keys, Enter, Esc; pointer hover
  follows. It scales in, with the backdrop blurring (off under reduced
  motion).
- **Reading list (`#saved`):** save from a story page's **Save** button, the
  palette, or `s` on the story under the keyboard. Kept per browser. Each
  row shows what changed since saving ("+3 sources since you saved it",
  "Breaking now", "Left the live feed"). A bookmark counter appears in the
  masthead once something is saved.
- **Keyboard:** `j`/`k` move through the front page (lead, "also leading"
  and the river), Tech, X, search results, This week, Breaking and Saved,
  with a focus outline that follows; `s` save, `b` breaking, `g` front
  page, `?` the list of shortcuts.
- **Installable app:** `manifest.webmanifest`, 192/512 px and maskable
  icons, theme colours and shortcuts (Breaking, Saved, On X). The service
  worker (`public/sw.js`) is network-first, so deploys are live on the next
  load; offline, it serves the last app shell, front page and every saved
  story page. Service workers need HTTPS or localhost.

## 2026-10-22 · Breaking news and push alerts

**Backend.**
- **Detection (`src/pipeline/breaking.js`)**, run on every feed rebuild
  (0.35 ms over 400 stories). A story's last hour is counted in distinct
  voices:
  - an outlet counts 1, a lab's own post 1.5,
  - an X account 0.75 (at most four),
  - Hacker News or a subreddit 0.4 (at most two),
  - outlets running the same headline word for word (syndicated copy)
    0.25 after the first.
  It breaks at 4 with at least two outlets or labs, if its first report is
  under six hours old. It ends when the pace stays under 2 for 30 minutes,
  or after six hours. Tuned by replaying 48 hours of the feed: 6–7 breaks,
  about three a day (Claude Duet, the SpaceX revenue beat, ChatGPT Ads, the
  $35B Nvidia orders).
- **History:** every break is stored in a `breaking` table with its
  coverage curve (distinct voices every 10 minutes from the first report).
  Breaks still running survive a restart. `scripts/breaking-backfill.js`
  replays the stored feed to fill the archive on a fresh install.
- **Web Push with only `node:crypto` (`src/pipeline/webpush.js`):** VAPID
  (ES256 JWT) and aes128gcm payload encryption (RFC 8291). The VAPID key
  pair is made on first use in `data/vapid.json` (mode 600, never in git).
  Subscriptions are accepted only for the browsers' push services over
  HTTPS, so the server can't be pointed elsewhere.
- **Alerts (`src/pipeline/alerts.js`):** one push per break, at most one
  every 20 minutes; subscriptions answered with 404/410 are removed, and
  ones failing five times in a row. Send counts are in `/api/status`
  (`alerts`).
- **API:** `GET /api/breaking?days=1|7|30` (active breaks with curves, plus
  history); `GET /api/push/key`; `POST /api/push/subscribe` and
  `/api/push/unsubscribe` (same-origin JSON only, 4 KB limit, rate-limited).
  The snapshot carries the active breaks, so the banner needs no extra
  request.

**UI** (`public/breaking.js`).
- **Banner** under the masthead on every page while a story is breaking:
  a pulsing label, the headline (links to the story page), sources in the
  last hour and when it broke, "+N more". It slides in with one shimmer
  sweep. Dismissable per story. The masthead bell gets a pinging dot.
- **`#breaking`:** each live break as a card with its coverage curve (the
  break moment marked, crosshair tooltip, line draws in). The archive
  (24 hours, 7 or 30 days) shows a sparkline per break, how long after the
  first report it broke, its peak and how long it lasted. A "How it works"
  panel explains the rule.
- **Alerts card:** turns push on or off. It explains plainly when the
  browser can't (no HTTPS, notifications blocked, unsupported).

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
