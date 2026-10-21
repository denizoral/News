# Features changelog

One full-stack feature per scheduled maintenance run, newest first.

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
