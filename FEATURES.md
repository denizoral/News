# Features changelog

Full-stack features from the scheduled maintenance runs, newest first.

## 2026-10-23 · Shipped (#shipped)

**Backend.** `src/index/shipped.js`, `/api/shipped`:
- **Products:** ChatGPT, Claude, Gemini, Copilot, Grok, Meta AI,
  Perplexity, Codex, Claude Code, Cursor, Apple Intelligence and Alexa+.
- **What counts:** 120 days of article headlines that open with the product
  or its maker and a shipping verb ("can now", "rolls out", "adds",
  "launches", "is testing", "removes", "will let"…).
- **What's left out:**
  - other companies building on a product ("Webflow adds … to ChatGPT");
  - first-person posts, how-tos, comparisons and negations ("didn't");
  - business stories (IPO, trademarks, attacks) and newsletter roundups.
- **Kinds:** removal, pricing, test or spotted, new model, more places and
  people, or new feature.
- **Grouping:** the same change within four days is one entry.
- **Output:** 17 weekly counts per product, the busiest product, and
  removals in 30 days.

**UI.** `public/shipped.js`:
- A "who ships most" heatmap of products by week, in one hue and five
  steps. Hovering a cell lists that week's changes; tapping a product row
  filters.
- Product and kind chips.
- A changelog grouped as "This week", "Last week" and "Week of …".

## 2026-10-23 · Research papers (#papers)

**Backend.** `src/index/papers.js`, `/api/papers`:
- **What it reads:** a year of Hugging Face paper pages (about 400–1,000 a
  month), each title once.
- **Nine themes,** a paper can have several: agents, reasoning and RL,
  vision, generation, robotics, efficiency, safety, code and maths, and
  benchmarks.
- **Rising words:** title words in the last 30 days against the 90 before,
  by lift.
- **Papers in the news:** named papers ("QwenGyre:", "LatentLoop:") from
  the last 60 days whose name a news headline carries as written.
  - **Plain-word names:** a name like "Mosaic" or "Foresight" also needs
    two more words from the paper's title.
  - **Speed:** 63 days of news titles are read once and indexed by word,
    instead of one search per paper (6.5 s → 0.5 s).

**UI.** `public/papers.js`:
- Nine theme small multiples (share of each month's papers, one scale) that
  filter, with hover.
- Rising words sized by lift.
- Papers in the news, with their headlines.
- The latest papers with theme links.

**Tests:** `test/papers-shipped.test.js`.

## 2026-10-23 · Fix: the labeler stalled on half an emoji

The classifier service failed a 28-item batch with a tokenizer `TypeError`
every minute from 17:53, so 27 items went unlabelled.

- **Cause:** `itemText` cut text with `String#slice(0, 400)`, which split a
  👀 into a lone UTF-16 surrogate. The tokenizer can't take that.
- **Fixed:**
  - `cutChars()` cuts by characters, for the labeler's and the embedder's
    texts;
  - the service replaces lone surrogates;
  - a failing batch is retried one text at a time, with the bad text
    logged and left unscored, so one item can't stall the queue again.

## 2026-10-23 · AI in science (#science)

**Backend.** `src/index/science.js`, `/api/science`:
- **What counts:** a year of English headlines where AI meets research or
  medicine. Data science, computer science, science fiction, "physical AI",
  data centers and stock talk are left out.
- **Fields,** in four groups:
  - life sciences and drugs (biology, drug discovery);
  - health and medicine;
  - maths and physics;
  - earth, climate and materials.
- **What happened:** concerns, money and deals, discoveries and results,
  new tools, or studies. "Cancer risk" is medicine, not a concern.
- **Lab:** DeepMind, OpenAI, Anthropic, Microsoft, Nvidia and others, when
  named.
- **Grouping:** the same thing within five days is one event, and a later
  report can upgrade a tool or study to a discovery.
- **Output:** monthly counts by group, labs with their discovery counts,
  the latest discoveries, and stats.

**UI.** `public/science.js`:
- Events stacked by field group, with a legend that filters.
- The latest discoveries as a timeline.
- Labs as bars, with the discovery share drawn darker.
- Chips for what happened, and event cards with every report.
- Hover tooltips on the columns and labs.

**Tests:** `test/science.test.js`.

## 2026-10-23 · What's coming (#ahead)

**Backend.** `src/index/ahead.js`, `/api/ahead`, `/api/ahead.ics`:
- **Dates read:** future dates named in the last 45 days of headlines:
  - "on January 14 (2027)";
  - "in/by/until/starting December";
  - "next week", "next month";
  - "Q1 2027";
  - "on Thursday".
- **Resolved:** against the day each headline ran.
- **Kept only when looking ahead:**
  - a bare month or weekday needs a forward cue (will, set to, expected,
    scheduled…);
  - "by", "until" and "starting" count as cues themselves;
  - headlines looking back are left out ("tried to … in May").
- **Kinds:** retirements and shutdowns, deadlines and rules, events and
  earnings, or launches.
- **Grouping:** outlets reporting the same date for the same thing become
  one item.
- **Markets:** the Polymarket markets closing on each day in the next 120
  days are added from the live feed. Dates are in New York time, so a 04:59
  UTC close counts as the day before. Each day shows its biggest markets
  with their leading odds.
- **Order:** on one date, quarter and month items come before day items,
  so agenda headings stay together.
- **Calendar feed:** an iCalendar feed of day-precise dates (folded lines,
  escaped text), or `?id=` for one date.

**UI.** `public/ahead.js`:
- Three month grids (Monday first) with a dot per date coloured by kind, a
  today marker, past days dimmed, and hover listing the titles. Tapping a
  day filters the agenda.
- Month and quarter dates are listed above each grid.
- An agenda under "This week", "Next week", month headings and "Sometime
  in …".
- Each item has a date badge, kind, sources and "Add to calendar". Market
  days show odds bars.
- "Subscribe in your calendar" (webcal) and "Download .ics".
- Kind chips.

**Tests:** `test/ahead.test.js`.

## 2026-10-23 · Framing (#framing)

**Backend.** `src/index/framing.js`, `/api/framing`:
- **Grouping:** the last 48 hours of English AI headlines are grouped into
  stories by meaning. A headline joins a story when its bge-small cosine to
  the story's first headline is at least 0.85, among candidates sharing two
  or more words. 0.82 merged different Nvidia stories; 0.89 split real
  ones.
- **Outlets:** one headline per outlet. Outlet names are merged across
  domains (bbc.co.uk = bbc.com), and a dashed subtitle isn't taken as an
  outlet.
- **For each story told by four or more outlets:**
  - the words most of them share, and the words only one outlet used;
  - each headline's tone;
  - its shape: question, quote, number, explainer or scoop;
  - how differently they're worded (mean pairwise Jaccard distance);
  - the range of tone.
- **Most divided:** the stories with the widest tone range, then the widest
  wording spread.
- **Outlets against the pack:** each outlet's headline tone minus the other
  outlets' on the same stories. A darker or brighter outlet shows up even
  though outlets cover different news.

**UI.** `public/framing.js`:
- Story cards with a wording-spread meter and good and bad counts. Opening
  one lines up every outlet's headline, with its own words highlighted, a
  good or bad tag (the words behind it on hover) and shape tags, under
  "most say …".
- Most divided first, then every story.
- "Against the pack" as diverging bars.
- `#framing?s=` deep-links to a story.

## 2026-10-23 · The mood of AI news (#mood)

**Backend.** `src/pipeline/tone.js` and `src/index/mood.js`, `/api/mood`:
- **Tone of a headline:** read from evaluative words, about 150 good and
  250 bad. "not", "without" and "despite" flip the word after them, and
  non-evaluative senses are skipped ("fine-tune", "free tier"). A launch is
  neither good nor bad.
- **Mood:** points of good headlines minus bad, from 26 weeks of English AI
  headlines (each copy counted once), by week.
- **Companies:** 14 big ones, with 90 days against the 90 before, this week,
  a weekly series, and this week's good and bad headlines.
- **Outlets:** the warmest and coolest of those with 40 or more headlines.
- **This week:** the words driving it (with last week's counts) and the
  strongest-worded headlines.

**UI.** `public/mood.js`:
- Week-by-week diverging bars around zero, with hover (indigo for good,
  magenta for bad, the pair validated earlier).
- Companies as dumbbells: the last 90 days as a dot, the 90 before as a
  ring. Tapping one opens its weeks and this week's headlines.
- This week's words sized by count.
- Warmest and coolest outlets as bars.
- The week's good and bad headlines in two columns, with the words that
  made them so.

**Tests:** `test/mood-framing.test.js` (tone, mood, framing).

## 2026-10-23 · Watchlist (#watch)

**Backend.** `src/index/watch.js`, `/api/watch?q=…&s=…`:
- **What a watch is:** any site search ("exact phrase", -word, OR,
  intitle:, site:, type:), parsed by the search module's own parser.
- **What it matches:** headlines and summaries of articles and posts from
  the last 14 days.
- **How it's counted:**
  - each query is read once in the history worker, as counts in 10-minute
    buckets plus the newest rows;
  - the result is cached for three minutes, shared by everyone watching the
    same query;
  - the server counts what's newer than each reader's own last look (`s`).
  The counts stay exact however broad the watch ("nvidia" has 1,526 matches
  in 14 days).
- **Limits:** up to 12 watches of 100 characters each. Responses are
  `private, no-store`.

**UI.** `public/watch.js`:
- Watches are kept in the browser.
- **Each card shows:**
  - the "N new" count;
  - 14 days of matches as columns, with the days since your last look in
    full colour and hover;
  - the newest headlines, with new ones marked;
  - "Mark seen" and "All results".
- **Across watches:** "Mark all seen", suggestion chips, and the page title
  shows the count of new matches.
- "Watch this search →" on every search page (`#watch?add=`).

**Tests:** `test/watch.test.js`.

## 2026-10-23 · The compute race (#chips)

**Backend.** `src/index/chips.js`, `/api/chips`:
- **What counts:** a year of English chip headlines. Each must name silicon
  (GPUs, TPUs, accelerators, HBM, fabs, AI servers); stock tips, gaming
  cards, phones and model releases are left out.
- **Camps:** Nvidia, AMD, cloud giants' own chips, Chinese chips, chip
  startups, and memory and fabs.
- **What happened:** export controls, shortages and prices, deals and
  orders, launches, or money.
- **Grouping:** one camp's news of one kind told the same way within five
  days is one event.
- **GPU counts:** taken with the report that names them, with the buyer
  from the verb or the headline's subject.
- **Output:**
  - each camp's monthly share of chip headlines and its 90-day change in
    points;
  - the export-control timeline;
  - stats.

**UI.** `public/chips.js`:
- Events stacked by what happened, with a legend that filters.
- Six camp small multiples on one scale (tap to filter).
- GPU counts as bars on a log scale.
- The export-control timeline.
- Camp chips and event cards with every report.
- Hover tooltips throughout.

**Tests:** `test/chips.test.js`.

## 2026-10-23 · AI words (#terms)

**Backend.** `src/index/terms.js`, `/api/terms`:
- **Glossary:** 48 hand-written definitions of the jargon in AI news, in five
  kinds (products, techniques, business, safety, culture). Examples: agents,
  MCP, mixture of experts, RAG, open weights, alignment, AI slop.
- **For each term:**
  - its share of all stored headlines, month by month for a year, so a busier
    crawl doesn't look like a rising word;
  - headlines in the last 90 days and the change in share against the 90
    before;
  - the peak month;
  - the five latest English headlines.
- **Matching:** the search index stems words and ignores case, so every
  match is checked against the term's own words. "Transformer" doesn't
  count "transform", and "MoE" doesn't count "Scott Moe". Words that also
  mean other things (agents, tokens, inference, alignment) count only next to
  an AI word.
- **Cost:** one read per term; about 2 s in the history worker, kept on disk.
- **Rising and fading:** the biggest gains and losses in share.

**UI.** `public/terms.js`:
- Rising cards with sparklines that draw in.
- Rising-and-fading diverging bars on one scale, with hover.
- The glossary A to Z with kind chips. Each entry shows its definition, a
  sparkline, the 90-day count and its change; opening it shows the year as
  columns (with hover) and the latest headlines.
- `#terms?t=mcp` opens a term and scrolls to it.

**Tests:** `test/terms.test.js`.

## 2026-10-23 · Open weights (#open)

**Backend.** `src/index/openweights.js`, `/api/open`:
- **What counts:** a year of headlines where a lab releases a model and says
  the weights are open, or names a family that ships open (Gemma, Qwen,
  Llama, Nemotron, GLM, Kimi…). Tools, engines, datasets, chips, deals and
  hosted-only or weightless releases are left out.
- **For each release:**
  - the lab and where it's based (US, China, Europe or elsewhere);
  - the model's name;
  - total and active parameters (a size in the model's own name wins);
  - context length, license, and what it handles: text, code, speech,
    images, or vision.
- **Grouping:** the same lab's model within a month is one release.
- **Built on:** the lab must be the subject of the headline. Another
  company's model post-trained on a lab's weights is a derivative
  (Cognition's SWE-2 on Kimi K3).
- **Output:** monthly releases by region, labs, sizes over time, and 90-day
  shares. The tiles show the biggest model, the share that are mixtures of
  experts, and the median size.

**UI.** `public/open.js`:
- Releases by month stacked by region, with legend items that filter.
- Sizes over time on a log scale. Each dot is coloured by region, a dashed
  line drops to the active parameters, and the biggest are labelled without
  colliding.
- Labs with their region, which filter.
- Built on, as chips.
- Release cards with every report, and kind-of-model chips.
- Hover tooltips throughout.

**Tests:** `test/openweights.test.js`.

**Also:** deep links that open a card or term (#open, #terms, #robots,
#incidents) now scroll after the router's jump to the top, so they land on
the item.

## 2026-10-23 · The week in AI quiz (#quiz)

**Backend.** `src/index/quiz.js`, `src/index/quizbook.js`:
- **Editions:** a new quiz every Saturday (UTC) from the week that just
  ended. The latest six weeks are kept.
- **Questions** (up to ten):
  - the week's English AI headlines grouped by story and ranked by how many
    outlets ran them, with a name taken out (company, person, product or
    place);
  - an amount from a money headline ("revenue leaps to $___");
  - where a Polymarket market that moved at least 8 points ended the week.
- **Wrong options:** names of the same kind that the week's headlines
  carried, amounts a few times off, or odds ten or more points apart that
  include where the market started. A blank is skipped when a related name
  gives it away ("Anthropic" next to "Claude").
- **Frozen:** an edition is built once in the history worker (about 0.2–1.3 s)
  and stored in kv, so the answer key never changes and it survives restarts.
- **Counts only:** `quiz_answers` and `quiz_scores` count how many readers
  picked each option and finished with each score. Nothing else is stored.
- **API:**
  - `GET /api/quiz?edition=` gives the questions without answers;
  - `GET /api/quiz/stats` gives the answers, the stories behind them and how
    readers split;
  - `POST /api/quiz/answer` and `POST /api/quiz/score` accept same-origin
    JSON only and are rate limited.

**UI.** `public/quiz.js`:
- One card at a time, with a progress bar and View Transitions between
  questions.
- After you answer: the right option and your pick are marked, each option
  shows a bar of how readers split, then the verdict and the story or
  market behind it.
- At the end: your score, how you did against every reader (a histogram with
  you marked), a copyable 🟩🟥 result, and a review of every answer with its
  story.
- Week chips switch editions and show your score on weeks you've played.
- Answers are kept in this browser.

**Tests:** `test/quiz.test.js` (edition dates, the three kinds of question,
giveaways, building from the index, no answers before playing, counting).

## 2026-10-23 · Robots (#robots)

**Backend.** `src/index/robots.js`, `/api/robots`:
- **What it reads:** a year of English robotics headlines. Robotaxis,
  robots.txt, papers, deals and stock talk are left out.
- **What happened:** money raised, unveiled, put to work, production, robot
  brains and data, or a setback.
- **For each event:** the kind of robot (humanoid, home, delivery, medical,
  industrial) and the company, from about 60 placed in the US, China, Europe
  or Japan and Korea. "Ex-DeepMind founders" isn't DeepMind, and investors
  named in a funding headline aren't the company. A startup that isn't on
  the list is named from before its verb.
- **Numbers:**
  - the round (not the valuation, and not talks);
  - a price tag;
  - a unit count with its year.
- **Grouping:** one company's news of one kind within a week is one event;
  its funding news within three weeks is one round.
- **Output:** monthly counts by kind and region, companies, the biggest
  rounds, prices, production numbers, and 90-day shares for the US and
  China.

**UI.** `public/robots.js`:
- **Charts:**
  - monthly stacked columns by what happened (four series plus setbacks in
    grey);
  - the race between regions as small multiples on one scale (tap to
    filter);
  - companies with their region, and the biggest rounds, as bars;
  - price tags on a log scale;
  - production numbers.
- **Filters:** what happened and the kind of robot, as chips.
- **Event cards:** every report. `&e=` opens a card and scrolls to it.
- **Hover:** tooltips on columns, region bars, prices, companies and rounds.

**Tests:** `test/robots.test.js`.

## 2026-10-23 · AI and jobs (#jobs)

**Backend.** `src/index/jobs.js`, `/api/jobs`:
- **What it reads:** a year of English headlines about layoffs, job cuts,
  headcount and work that also mention AI, automation or agents. Other
  senses ("Steve Jobs", long-running GPU jobs, how-tos) are left out.
- **A round of cuts:** a company named with a layoff verb. Bosses named in
  place of the company map back to it (Jack Dorsey → Block). Each round has:
  - a headcount (the figure most reports give) or a share of staff;
  - why AI comes into it: AI does the work, to pay for AI, a refocus on AI,
    says it isn't AI, or just AI in the picture;
  - planned or announced.
  Reports of the same company's cuts within three weeks are one round.
- **The argument:** other headlines are read as "AI is taking jobs" or "it's
  an excuse / overstated", deduped across outlets. Kinds of work named
  (customer service, engineers, entry-level, HR, creative, back office,
  managers, white-collar) are collected too.
- **Output:** cuts, 12 months of rounds by reason with jobs named and both
  sides of the argument, companies by jobs named, roles, stats.

**UI.** `public/jobs.js`: stat tiles, monthly rounds stacked by reason,
the argument as diverging bars (worry above the line, scepticism below, one
scale), companies by jobs named (tap to filter), cut cards with every
report, both sides side by side, and kind-of-work chips. Hover tooltips on
all charts.

## 2026-10-23 · AI incidents (#incidents)

**Backend.** `src/index/incidents.js`, `/api/incidents`:
- **What it reads:** a year of English headlines with failure words and an
  AI product word. Advice, detection and defence tools, funding, market talk,
  outages (on #uptime) and AI finding someone else's bug are left out.
- **Each headline gives:** a kind (agents gone wrong, robotaxis, harm to
  people, scams, deepfakes, hacks and leaks, propaganda, made-up answers,
  bias), the product involved, what was done (paused, banned, patched,
  apology, investigation, lawsuit), and whether it was in a lab or study.
- **Incidents:** same kind and product within five days and about the same
  thing (or, without a product, the same story within two days).
- **Output:** incidents, months by kind, kinds with 90-day counts, products,
  responses, stats (90 days vs the 90 before, agent incidents, share with a
  response).

**UI.** `public/incidents.js`: stat tiles, a year as one lane per kind with
dots sized by outlets (hover for the headline, tap to open its card),
products and responses as bars that filter, kind and lab/world chips, and
incident cards with every report. Short lane names on phones.

## 2026-10-23 · Job lanes and storylines on disk

Jobs a visitor is waiting on now run before background refreshes in each
worker lane. Storylines are kept on disk across restarts like the other
default views.

## 2026-10-23 · The buildout (#buildout)

**Backend.** `src/index/buildout.js`:
- **What it reads:** a year of English data center headlines (FTS prefilter
  on "data center", "AI factory", Stargate, gigawatt…). Market-research
  releases, stock tips, how-tos and drone strikes are left out.
- **Each headline gives:**
  - the builder, from a list of labs, clouds and data center companies, or
    else the headline's subject ("KT Cloud breaks ground…");
  - the place: a US state, a city or project we can place (Abilene,
    Memphis, Hyperion…) or a country or region;
  - the size in GW (fleet-wide goals and chip deals don't count);
  - the money (not revenue, valuations, tax breaks or bills);
  - the power source: gas, nuclear, solar, batteries and more;
  - the status: announced, approved, building, online or cancelled.
- **Pushback:** moratorium or pause, ban, rejected, withdrawn, lawsuit,
  protest.
- **Projects:** headlines about the same builder in the same place are one
  project; the same story from several outlets within two days is one event.
- **Places:** projects, gigawatts and pushback by kind for each US state and
  region.
- **Also:** twelve months of project, pushback and power stories; power
  sources; builders; and stats, including how many places paused, banned or
  rejected data centers in 90 days and pushback's share of the coverage.
- `/api/buildout`.

**UI.** `public/buildout.js`:
- stat tiles;
- stacked monthly columns and a pushback-share line (the line doesn't depend
  on how much we collected that month), both with hover tooltips;
- a US tile map shaded by projects or by pushback, with a tooltip per state
  and the rest of the world as bars; tapping a place filters everything
  below;
- tabs:
  - **Projects:** cards with a status rail, a GW bar, money, power chips and
    an event timeline;
  - **Pushback:** kind chips and a feed;
  - **Power and builders:** bars and a builder table;
- tiles pop in, columns grow, the line draws, cards rise; all off under
  reduced motion.

## 2026-10-23 · AI rules (#rules)

**Backend.** `src/index/rules.js`:
- **What counts:** a year of AI policy headlines. Each needs an AI word, a
  rule word and a jurisdiction. Law-firm news, explainers, guides, questions,
  lawsuits, and company or platform bans ("Etsy bans…") are left out.
- **Jurisdiction:** a US state (or its governor), US federal (Congress, the
  White House, agencies, a US measure about China), the EU, the UK, China and
  others, or international.
- **Measure name:** a bill number (SB 53), an act name read back from "Act"
  to a stop word (RAISE Act; Colorado's AI Act isn't the EU's), an executive
  order or the AI Action Plan.
- **Stage:** proposed, advancing, passed, signed, in force, or blocked
  (vetoed, struck down, delayed, repealed).
- **Subjects:** chips and export controls, preemption, kids, deepfakes,
  frontier safety, copyright, jobs, privacy, health, energy, government use.
- **Grouping:** headlines naming the same measure are one measure; without
  a name, the same jurisdiction and subject. A measure stands at the
  furthest stage it reached, unless it was blocked since.
- **Also:** monthly steps and jurisdictions by stage.
- `/api/rules`.

**UI.** `public/rules.js`:
- stat tiles;
- monthly stacked columns, four stage groups, with a tooltip;
- jurisdictions as stacked bars of where their measures stand; tap to
  filter, hover for counts;
- subject chips;
- measure cards with a stage rail, jurisdiction and subject chips, and a
  timeline; named measures first.

## 2026-10-23 · Job results survive restarts

`src/index/offload.js`:
- the default views' results (rumors, deals, the court, the buildout, and
  others with no typed parameters) are written to `data/jobcache/`;
- after a restart they're served at once, as fresh as the file's time
  allows, while they refresh;
- off under the test runner.

## 2026-10-23 · AI status (#uptime)

**Backend.** `src/sources/uptime.js` (a new source, every 10 minutes) and
`src/index/uptime.js`:
- **Where incidents come from:** the public history feeds on the status
  pages of OpenAI, Claude, GitHub (Copilot incidents only), Cursor,
  Perplexity, DeepSeek, Hugging Face, Groq, Together AI, Runway, Cohere and
  Cloudflare (Workers AI and AI Gateway only). Several hosts disallow `/api/`
  in robots.txt, so only the feeds are read, with conditional GET. Mistral's
  page sits behind a Cloudflare challenge and is skipped.
- **Feed shapes:** Statuspage (every update in the entry), incident.io and
  Flashduty (latest status only) and Instatus (one item per update) are all
  reduced to incidents with timed updates.
- **Start times:** incident.io pages are read once per incident, four per
  poll, to get each update's time.
- **Storage:** polls merge into a new `status_incidents` table, so history
  grows beyond what the feeds keep.
- **Severity:** judged from the wording ("outage", "unavailable" is major;
  "degraded", "elevated errors" is minor; maintenance is its own kind).
- **Per service:** the current state, a 90-day strip of each day's worst
  severity, incidents in 30 and 90 days, and median time to fix.
- **Start-hour heatmap:** incident starts by weekday and UTC hour.
- **Coverage:** headlines and X posts naming the service and an outage
  ("is down", "outage"; not "shut down" or "hands-down"), each attached to
  its nearest incident, with how many minutes before or after the status
  page they came.
- `/api/uptime`.

**UI.** `public/uptime.js`:
- an "open right now" banner with a pulsing dot;
- service cards with an icon and label for each state;
- 90-day day strips that grow in, with a hover tooltip per day;
- filter by service, and a maintenance toggle;
- incident cards with update timelines, components and the reports around
  them;
- the start-hour heatmap;
- refreshes every two minutes while open.

## 2026-10-23 · Courtroom (#court)

**Backend.** `src/index/court.js`:
- **Reading headlines:** a year of English legal headlines (FTS prefilter),
  each parsed for:
  - the defendant (an AI lab, or big tech when the headline has an AI word);
  - the plaintiff ("X sues Y", "sued by", "v.", a name beside "case", or
    groups such as authors, news publishers, music labels, US states,
    families);
  - the kind of claim (copyright, child safety, deepfakes, privacy, trade
    secrets, antitrust, defamation, government, governance, criminal, labour);
  - the event (filed, ruling, dismissed, settled, verdict).
- **Not counted:** figures of speech ("settle for", "courting", "AI judges")
  and bills.
- **Cases:** the same parties make one case. Without a plaintiff, the same
  defendant and kind of claim do. A plaintiff-less case joins the one
  matching case that names a plaintiff.
- **Events:** the same news from several outlets within two days is one
  event.
- **Status:** the latest decisive event. Amounts are kept from settlements
  and verdicts.
- **Also returned:** 12 months of filings, rulings and outcomes, and
  defendants by kind of claim.
- `/api/court`.

**UI.** `public/court.js`:
- stacked monthly columns with hover;
- a who-is-sued-over-what dot matrix that filters;
- chips for each kind of claim;
- case cards with status, amount and an event timeline.

## 2026-10-23 · Benchmarks (#benchmarks)

**Backend.** `src/index/benchmarks.js`:
- **Benchmarks covered:** 15, including SWE-bench Verified and Pro,
  Terminal-Bench, GPQA Diamond, Humanity's Last Exam, ARC-AGI-2 and -3, AIME,
  FrontierMath, OSWorld, MMLU-Pro, MMMU, BrowseComp, τ²-bench and
  LiveCodeBench.
- **Reading scores.** Articles naming a benchmark (FTS) are split into
  sentences. Each mention takes the nearest unused percentage: "81.2% on X"
  comes first, and a score across an "and" or a comma belongs to the next
  benchmark.
- **The model** is the nearest model name before the score. Failing that,
  it's the one model the headline names.
- **Left out:** research before/after deltas, human baselines, and sentences
  with no model.
- **Claims.** The same model, benchmark and score across outlets is one
  claim. When outlets disagree, the score most of them carried wins and the
  others are listed.
- **Leaderboards.** Scores confirmed by 2+ outlets rank first; single-source
  claims are kept apart. The state of the art over time is every confirmed
  new best. A benchmark is shown once it has two or more confirmed models.
- **API:** `GET /api/benchmarks`, from the history worker, cached for an
  hour.

**UI.** `#benchmarks/<key>`, in the footer and ⌘K:
- benchmark chips, and what each one measures;
- the current leader;
- a chart with every confirmed claim as a dot and the state of the art as a
  step line, with a hover tooltip;
- a leaderboard against the full 0–100% scale. Rows open to show the
  quoted sentence, the source, how many outlets carried it and other
  reported scores;
- single-source claims behind a disclosure, as hollow bars.

**Motion.** The step line draws, the dots pop in and the bars sweep out. All
of it is off under `prefers-reduced-motion`.

**Known limits.** Labs report their own numbers under their own conditions.
Single-outlet claims are often misreads, which is why they're kept apart.

## 2026-10-23 · Talent moves (#talent)

**Backend.** `src/index/talent.js`:
- **Finding moves.** FTS picks a year of headlines with a move verb (joins,
  hires, poaches, leaves, departs, steps down…).
- **Parsing.** Each headline is parsed into who, from where and to where.
  Verbs are found with small patterns and companies looked up from the
  entity graph's vocabulary.
- **The person** can be:
  - a known name;
  - a capitalised name;
  - a name at the end of a role phrase ("safety leader David Robinson",
    "Nobel laureate John Jumper");
  - a role on its own ("data center chief").

  "Former X …", "from X" and "X's …" set where they came from.
- **Not counted as moves:**
  - partner deals, products "joining the race", programmes, marketplaces;
  - board and trust seats;
  - internal appointments ("Apple names X as CFO"), which are listed but not
    counted as arrivals.
- **Merging.** The same person within 45 days is one move, and an unnamed
  headline folds into the named one.
- **What it returns:** flows between companies, and arrivals, departures and
  net per company.
- **API:** `GET /api/talent`, from the history worker, cached for an hour.

**UI.** `#talent?org=<key>`, in the footer and ⌘K:
- the headline numbers (moves, who gained most, who lost most);
- a flow diagram from where people left to where they went;
- arrivals and departures per company as diverging bars around one zero
  line. Click a company to filter;
- the moves: date, kind, person and role, from → to chips, source headline.

**Motion.** Ribbons draw, bars sweep out and cards rise in. All of it is off
under `prefers-reduced-motion`.

## 2026-10-23 · Android apps and reader accounts

**Backend.**
- **Reader accounts** (`src/accounts/`):
  - email + password (scrypt) and Google sign-in, with Google ID tokens
    verified against Google's keys and our client ids;
  - 30-day sliding bearer sessions, stored hashed;
  - per-IP and per-email limits, and a growing lock after failures;
  - follows and alert settings: outlet threshold, daily cap, quiet hours;
  - password change ends older sessions, and accounts can be deleted.
- **Endpoints:** `/api/user/*`, plus `/api/devices` for phones (signed in or
  not).
- **Firebase sender** (`src/push/fcm.js`): HTTP v1, with a service-account
  JWT. It stays off until `data/firebase-service-account.json` exists.
- **What gets pushed** (`src/push/mobile.js`):
  - breaking news to every phone that wants it;
  - followed topics, names, X accounts and outlets once enough outlets carry
    the story, never the same story twice;
  - to admin phones: new FEATURES.md entries, and sources failing or
    recovering.
- **Admin API for the app.** It accepts bearer tokens from the admin app
  (same passwords and two-factor codes; no cookie, so no CSRF), and adds
  `/api/admin/changelog`, `/api/admin/devices` and `/api/admin/readers`.
- **Downloads.** The server offers the latest APKs at `/apps/*.apk`.

**Apps** (`android/`, Kotlin + Jetpack Compose):
- **Frontier Wire:**
  - Today: a breaking banner, trending chips you can follow, and story cards;
  - follow anything from a story's ⋮;
  - For you;
  - Alerts: thresholds, daily cap, quiet hours, and your follows;
  - Account: sign in, sign up, Google, delete.

  Without Firebase it checks every 15 minutes in the background.
- **Wire Admin:** sign-in with a two-factor code, then:
  - an overview;
  - this changelog;
  - sources, with "run now";
  - content hide and pin;
  - readers and push stats;
  - the audit log.
- **Shared core:** an API client, a Keystore-encrypted session and the site's
  palette in light and dark.

## 2026-10-22 · Rumor mill (#rumors)

**Backend.** `src/index/rumors.js`:
- **Claims.** A hedged headline ("reportedly", "in talks", "sources say",
  "weighs a sale", "nears a deal", "Report:") about a name from the entity
  graph is a claim. Within a week, another hedged headline joins it when it:
  - shares the name and most of its particulars, or
  - names the same amount ("$15 billion" and "$15B" are one token), or
  - names the same two names and the same move ("acquire" = "buy"), or
  - is almost the same headline by embedding (cosine 0.84 or more).
- **Settling a claim.** Later coverage settles it only when it:
  - names the claim's subject (the first name in its headline),
  - shares its particulars,
  - is close in meaning (cosine 0.76 or more), and
  - carries no hedge, forecast, "to file", "how to watch" or "what to expect".

  "Announces / confirms / closes / launches" settles a claim on its own. A
  plain statement of fact ("DeepSeek raises $15B") needs two outlets.
  "Denies / no plans / talks collapse" makes it denied. Nothing for three
  weeks means it went quiet. Roundups and newsletters neither start nor
  settle claims.
- **What it returns:** totals, the share that came true, the median head
  start, a histogram of head starts, and outlets' track records (3+ claims
  that played out).
- **API:** `GET /api/rumors`, computed in the history worker and cached for 30
  minutes.

**UI.** `#rumors`, in the footer and ⌘K:
- **Outcome tiles.** Four tiles (came true, denied, still open, went quiet)
  with icons. Each filters the list.
- **Claims.** A line under each claim runs from the first report to whatever
  settled it, and the settling headline is quoted beneath. Open claims end in
  a pulsing dot; quiet ones end in a hollow dot.
- **Sidebar:**
  - a "How far ahead" bar list;
  - "Whose rumors hold up", a stacked bar per outlet (came true | denied |
    went quiet) with a legend.

**Motion.** Tiles and cards rise in. Lines draw from the first report and the
end dot pops. Bars sweep out. All of it is off under `prefers-reduced-motion`.

**Known limits.**
- The archive only gets dense from September, so many older rumors "went
  quiet" because the follow-up isn't stored, not because there wasn't one.
- An unrelated headline about the same product can still settle a claim now
  and then.

## 2026-10-22 · New names (#new)

**Backend.** `src/index/newnames.js`:
- **Finding names.** A new name is a run of up to four capitalised or
  numbered words in the last 60 days of headlines and descriptions. To count,
  it must be carried by 4+ outlets and stay capitalised mid-sentence in
  descriptions (so a Title Case headline's "Bans DeepSeek" doesn't count). It
  must also barely appear before the window in the archive's headlines and
  descriptions (FTS). Evergreen listicles get re-dated, so their bodies don't
  count.
- **Merging and filtering.** Generic dressing is dropped ("Duet AI",
  "AI Startups"). A shorter name folds into the longer one it nearly always
  comes with. Entity-graph vocabulary and outlet names are left out.
- **What it is.** Taken from article bodies and descriptions: the appositive
  ("Claude Duet, a proactive AI agent …"), "is a …" or "a new chip called …"
  clause. Clauses are grouped by head noun, and the one most outlets agree on
  wins, with its source and how many outlets agree.
- **For each name:**
  - **kind:** model, agent, tool, device, company, project, security or
    policy;
  - **owner:** the lab it's named after, or the one it's most often
    mentioned with;
  - **first report;**
  - **daily mentions,** with a rising or fading trend.

  People and unplaceable names without agreement are dropped.
- **API:** `GET /api/new-names`, computed in the history worker and cached for
  an hour.

**UI.** `#new` ("What's that?"), in the footer and ⌘K:
- **Arrivals strip.** One dot per name on the day it first appeared, sized by
  coverage and piled when several arrived together. The biggest are labelled.
  Clicking a dot (or Enter) scrolls to its card and flashes it.
- **Filters.** Kind chips (they scroll sideways on phones) and a sort: newest,
  most covered, rising.
- **Cards** show:
  - kind and owner, and the name, which links to search;
  - the definition as a cited quote;
  - a sparkline since first seen, with mentions, outlets and trend;
  - the first report;
  - latest coverage, behind a disclosure.

**Motion.** Dots drop in left to right, cards rise in and sparklines draw.
All of it is off under `prefers-reduced-motion`.

## 2026-10-22 · Head to head (#vs)

Two labs, people, products or governments side by side.

- **Backend** (`src/index/versus.js`, history worker): reuses the entity
  graph's 7/30/90-day scan. For two names: articles per day for each and for
  both, totals against the window before, each one's biggest day (with the
  headline most like the rest of that day's), outlets that wrote about either
  and how far each leans from the overall split, the words that set each
  one's headlines apart (weighted log-odds with an informative prior, phrases
  and their own words folded together), who else comes up with each, money
  (raised, last valuation, recent deals from the deals index), headlines
  about only one, and headlines about both. Also the list of names worth
  comparing in the window, for the pickers.
- **API**: `/api/versus?a=&b=&days=` (404 with the name list when a name
  isn't in the window or both are the same).
- **UI**: big name pickers (grouped by kind) with a swap button, window chips
  and popular match-ups; a tug-of-war bar that grows from the middle with
  each side's share and change; a two-line daily chart with crosshair
  tooltip and legend; two columns (words as weighted chips that link to
  search, biggest day, seen-with bars that link to that match-up, money,
  only-about headlines); a "Together" band; a diverging outlet-lean chart.
  The graph's pair panel links "Head to head". Footer and ⌘K link it.

## 2026-10-22 · News map (#map)

Every story of the last day, three days or week, laid out by meaning.

- **Backend** (`src/index/newsmap.js`, history worker): the window's items
  clustered into stories as on the front page (up to 360/520/640, biggest
  first); each story is the mean of its items' embeddings; deterministic
  exact t-SNE (PCA start) puts them in 2-D; Ward clustering of the layout
  makes 10–16 regions, each named by the phrase its headlines share, placed
  at its median and marked growing when its last quarter holds more than the
  map's share of stories.
- **API**: `/api/map?days=1|3|7`.
- **UI**: an SVG map with soft region territories (hulls), dots sized by
  outlets and shaded by age in one hue, region names placed biggest first
  without overlaps, a ripple-in entrance from the centre. Hover (or tap)
  shows the headline; click opens the story page. Wheel/pinch zoom keeps the
  point under the cursor, drag pans, +/−/⤢ buttons, Esc resets. Clicking a
  region (on the map or in the side list) flies the camera into it and lists
  its stories; "Find on the map" dims everything that doesn't match, live,
  without moving the camera. Footer and ⌘K link it.

## 2026-10-22 · Catch up (#catchup, welcome back)

Everything since a reader's last visit, on one page.

- **Backend** (`src/index/catchup.js`, history worker): the window's AI
  articles and X posts clustered the way the front page is and ranked by
  outlets; each story keeps its story-page id (from `story_ids`), whether it
  was already running before the window ("kept going"), and when each report
  landed. Plus activity per hour (or 3 h / 6 h for longer windows), names
  named far more than in the four weeks before, deals and X posts. The main
  thread adds breaking alerts, explained market moves, releases and storylines
  that gained a chapter in the window. Windows are clamped to 1 h–7 days and
  snapped (15 min, or an hour past a day) so readers share cached answers.
- **API**: `/api/catchup?since=<ms>`.
- **UI**: the front page shows a "Welcome back — you were away 14 hours" bar
  when a browser returns after 3+ hours (last-seen time in localStorage, kept
  for the session, dismissible). `#catchup` has range chips (since my last
  visit, 6 h … a week), tiles, a stacked articles/X-posts chart with
  tooltips, the biggest stories with a dot strip of when coverage landed
  (dots pop in), storylines that moved on, and a side column of breaking
  alerts, market moves with sparklines and the story before them, releases,
  standout names, deals and X posts. Footer and ⌘K link it.

## 2026-10-22 · Predictions (#predictions)

What people and companies say will happen in AI, and by when.

- **Backend** (`src/index/forecasts.js`, history worker): reads 120 days of
  article bodies for sentences that put a claim about the future on a year
  ("by 2030", "within five years", "by the end of the decade") and pins each
  on someone: a quoted speaker (via the quote extractor), the subject of
  "expects/predicts/plans…" (surnames resolved to the full name used earlier
  in the piece; headings run into the sentence dropped), or "according to".
  Past-tense reports, fiscal years and event dates are skipped. Each gets a
  target year, a theme (AGI, jobs, compute & power, chips, robots, adoption,
  money) and a kind (a company's own **plan** vs a forecast). The same
  sentence across outlets is one forecast. Incremental like quotes.
- **API**: `/api/predictions?theme=&year=&who=`; person pages
  (`/api/person`) now include that person's predictions.
- **UI**: theme chips with counts; "When they say it happens" bar chart by
  target year (hover tooltips; click a bar to filter that year, the others
  step back); "Coming due" cards with a meter of how much time to the
  deadline has passed; the ledger grouped by year with the date phrase
  highlighted and a "Carried by N outlets" disclosure; "Who makes the most
  calls" (people open their quote pages, firms filter the page).

## 2026-10-22 · Storylines (#storylines, #storyline/<id>)

Stories that keep coming back over days and weeks: the arrest, then the
hearing, then the court filing.

- **Backend** (`src/index/storylines.js`):
  - Each of the last 60 days is clustered the way the front page is, in the history worker. Past days are clustered once and kept.
  - Each story with 2+ outlets becomes a chapter. Its vector is the mean of its articles' bge-small embeddings, in the vectors worker.
  - Chapters are read in date order. Each joins the open storyline it is closest to, or starts a new one. To join, a chapter must be within 0.8 cosine of the line's last four chapters and close to the line as a whole, so a line can't drift.
  - Below 0.85, a chapter must also share a rare headline word, which keeps "the same company's other news" out.
  - A line closes after 8 quiet days. A storyline needs chapters on 3+ days.
  - Storylines are ranked by coverage with a one-week half-life.
- **API:**
  - `/api/storylines` (list)
  - `/api/storyline?id=` (chapters)
  - Story pages get a `storyline` field.
- **UI:**
  - A swimlane timeline on one shared axis: four weeks on desktop, two on a phone.
  - Each lane has a dot per day, sized by reports. Developing lines end in a pulsing dot.
  - Rows rise in turn and dots pop in left to right. Dot tooltips. All/Developing filter.
  - A storyline page has tiles, a reports-per-day bar chart with hover, and a chapter-by-chapter timeline with "N quiet days" gaps and every outlet's copy.
  - Story pages show a "Part of a storyline" link.
  - Linked from the footer and ⌘K.

## 2026-10-22 · Who said what (#quotes, #person/<key>)

Direct quotes from AI coverage, attributed by name.

- **Backend** (`src/index/quotes.js`):
  - Reads article bodies for the common reporting shapes ("…," said Name, role / "…," Name said / Company CEO Name said: "…").
  - Strips leading role words and resolves surname-only attributions to the full name used in the piece.
  - Skips pronouns and organisations' voices.
  - Groups the same line carried by several outlets.
  - The worker keeps an in-memory index of 45 days and reads only new rows on refresh.
- **API:**
  - `/api/quotes?q=`: people quoted by 2+ outlets in 30 days, plus the most-carried lines this week.
  - `/api/person?name=`: every line, topics, outlets, and who else spoke in the same stories.
- **UI:**
  - A wall of pull quotes with an accent bar that draws in, and a staggered rise.
  - "Ran in N outlets" disclosure.
  - People directory with monograms, 30-day sparklines and topic chips, and a debounced server-side filter.
  - Person page with roles, topic chips, a quotes-per-day bar chart with hover, a timeline of their lines, "Quoted by" bars, and "In the same stories".
  - Linked from the footer and ⌘K.

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
