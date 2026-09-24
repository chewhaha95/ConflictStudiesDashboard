# Conflict Studies Dashboard

A single-page interactive dashboard for international conflict studies:
a **Conflict Watchlist** tracker with map, plus weekly / monthly reporting
across five theatres and a capabilities-and-countermeasures view. Static
files only (no backend); published to GitHub Pages. See the README comment
at the top of `conflict-dashboard.html` for the file layout and how to run
it locally.

## Watchlist tab (landing view)

The Watchlist answers six questions, in order, from `watchlist.json`:

| # | Question | Where on the page |
|---|----------|-------------------|
| Q1 | What deserves attention now? | Ranked top-5 with an explainable attention score |
| Q2 | Which theatres moved state (Watch → Active → Priority) in the last 7 days? | Map markers (▲▼), "State moves in the last 7 days" + "Earlier moves", state board |
| Q3 | What has materially changed in the last 7 days? | Register rows (newest live headline on top, plain-language current status with links) + expanded "What materially changed" |
| Q4 | Did phase / escalation risk / tempo / adaptation / Singapore exposure change over the last 7 days? | Highlighted register cells (7 days ago → now); hover a header or value for the criteria |
| Q5 | What might happen next? | Typed, dated indicators (named event, threshold, deadline, mobilisation sign, force movement, diplomatic decision, escalation indicator) |
| Q6 | What can be ignored for now? | Ignore-for-now list with reason tags and revisit triggers |

**Tiers** (standing relevance): T1 Priority Conflicts · T2 Active Regional &
Escalation Watches · T3 Baseline Regional Research Reserve.
**Monitoring states** (current attention): Priority · Active · Watch · Archive.
A Tier 1 conflict can sit in any state; the tier says how much it matters to
the Army, the state says how much attention it needs today.

**Comparison window.** The register is reviewed daily, but every comparison
(state moves, changed dimensions, score bonuses, the header's "Changes …"
range) is made against the register as it stood 7 days before the review
date (`meta.compareDays`). Each item keeps one snapshot per review
(`snapshots`: date, state, five dimensions); the baseline is the newest
snapshot at least 7 days old, or the oldest on file until a full week of
daily snapshots has accrued.

The map is a self-contained SVG (Natural Earth 1:110m outlines in
`assets/world-110m.json`): no tiles, no map library, works offline and in
print. Marker colour = state, size = tier, dashed circles = maritime zones,
▲▼ = state moved this review. Region focus buttons zoom to Europe, the
Middle East, South Asia, the Indo-Pacific or the Americas.

### Live, from open sources

The watchlist is fully automated:

- **Live reporting feed** — `.github/workflows/sync-watchlist-feed.yml` runs
  `scripts/sync-watchlist-feed.js` hourly against the open GDELT DOC
  2.0 API and commits `watchlist-live.json`: a 30-day daily coverage
  timeline and the newest title-matched articles per item (GDELT newest-first
  over the last 3 days merged with a Google News pull, so the "Newest
  reporting" line is the latest article, not the most relevant one). The
  register shows a coverage sparkline, a 7-day count with change, a **surge**
  flag (≥2× the previous week and ≥20 articles, +8 attention points) and the
  headlines in each expanded row. Queries live in each item's `feed` block:
  `query` (GDELT syntax), `terms` (any must appear in the title), optional
  `require` (groups; one term from every group, e.g. one per side of a
  two-party theatre) and `exclude`, plus a global sport/entertainment
  exclusion list in the script.
- **Daily automated review** — a scheduled Claude Code session (05:30 SGT, published by 07:00)
  follows `docs/WATCHLIST-REVIEW.md`: researches all twelve items from open
  sources, rewrites `watchlist.json` (states, dimensions, a daily snapshot,
  changes, indicators, ignore verdicts, history, sources), runs
  `npm test` and pushes to `main`. Pages deploys on push.

### Topics of interest

Each item carries three team-set topics (`topics`: topic, why it matters here,
adaptability, watch status and text), loaded from the watchlist workbook. They
appear as the register's Topics of interest / Why it matters / Watch areas
columns, and each indicator in `next` references the topic it informs
(`topic` index, or null for cross-cutting), which the Next indicator column
and the indicators table show. The automated review does not edit topics.

Beside the timeline in the expanded row, a **Topic assessment** card
(`assessment`: date, one or two paragraphs, 3–5 sources) reads the last two
weeks of open-source evidence through those three topics: what each watch
area is showing and what it implies for the "why it matters" question. The
daily review rewrites it from open sources.

### Manual review (same procedure)

Edit `watchlist.json` only — the dashboard derives rank, movements, change
flags, staleness and surges:

1. Set `meta.reviewDate` and `meta.previousReviewDate`.
2. For each item, set the new `now` on each dimension (`phase`, `escalation`,
   `tempo`, `adaptation`, `sgExposure`) and the new `state`; append any state
   move to `history`.
3. Append today's snapshot (`date`, `state`, the five dimension values) to the
   item's `snapshots`; keep the newest 60.
4. Rewrite `whyNow`, `changes` (dated bullets covering the last 7 days), `next` (named, checkable
   indicators with `due` dates where they exist) and `ignore`. Publication decisions (what to publish, escalate or leave) are made by the team outside the dashboard and are not recorded here.
5. Run `npm test` — the smoke test validates the register schema.

The Watchlist stands entirely on open sources: it neither displays nor uses
the weekly brief shown on the Weekly tab.

## Hosting and sharing

The site is static. GitHub Pages (`.github/workflows/pages.yml`) is the primary
deploy and the **data origin**: the sync workflows and the daily review commit
`watchlist.json`, `watchlist-live.json` and `weekly-live.json` to `main`, and
Pages serves them with `Access-Control-Allow-Origin: *`.

A mirror on another host gives the dashboard a link that does not show the
GitHub account. `conflict-dashboard.html` names the data origin in
`<meta name="data-origin">`; when the page is served from any other host it
reads the three live JSON files from that origin (falling back to its own copy
if the read fails), so the mirror stays current without redeploying on every
data commit. Same-origin, localhost and `file://` previews ignore the meta tag.

**Cloudflare Pages mirror — the address to share:
<https://csidashboard.pages.dev/>.** Set up as Workers & Pages → Create →
Pages → Connect to Git → this repository, production branch `main`, no build command, output
directory `/`. Under the project's Settings → Builds → *Build watch paths*,
exclude `watchlist-live.json`, `watchlist.json` and `weekly-live.json` so the
hourly feed commits do not consume the free build quota; code merges still
deploy. `_headers` sets `Cache-Control: no-cache` there so a deploy is never
hidden behind a cached `app.js`. A custom domain can be attached to either
host.

**Hourly feed trigger.** GitHub runs this repository's `schedule:` workflows
hours late, so the feed sync is fired every hour by a Cloudflare Worker cron
that calls GitHub's workflow-dispatch API; see
[`cloudflare/feed-trigger/README.md`](cloudflare/feed-trigger/README.md) for
the five-minute setup (a fine-grained token with Actions write on this repo).

## Development

```
npm install
npm test          # syntax check + headless smoke test (jsdom)
python3 -m http.server 8000   # then open http://localhost:8000/conflict-dashboard.html
```
