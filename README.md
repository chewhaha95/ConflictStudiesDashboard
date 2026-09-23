# Conflict Studies Dashboard

A single-page interactive dashboard for international conflict studies:
a **Conflict Watchlist** tracker with map, plus weekly / monthly reporting
across five theatres and a capabilities-and-countermeasures view. Static
files only (no backend); published to GitHub Pages. See the README comment
at the top of `conflict-dashboard.html` for the file layout and how to run
it locally.

## Watchlist tab (landing view)

The Watchlist answers seven questions, in order, from `watchlist.json`:

| # | Question | Where on the page |
|---|----------|-------------------|
| Q1 | What deserves attention now? | Ranked top-5 with an explainable attention score |
| Q2 | Which theatres moved state (Watch → Active → Priority)? | Map markers (▲▼), "Moved since previous review", state board |
| Q3 | What has materially changed? | Register rows + expanded "What materially changed" |
| Q4 | Did phase / escalation risk / tempo / adaptation / Singapore exposure change? | Highlighted register cells (previous → now) |
| Q5 | What might happen next? | Typed, dated indicators (named event, threshold, deadline, mobilisation sign, force movement, diplomatic decision, escalation indicator) |
| Q6 | What should CSI do? | Action board: CSI Flash / Weekly awareness post / Monthly pattern review / Quarterly candidate / Dashboard only |
| Q7 | What can be ignored for now? | Ignore-for-now list with reason tags and revisit triggers |

**Tiers** (standing relevance): T1 Priority Conflicts · T2 Active Regional &
Escalation Watches · T3 Baseline Regional Research Reserve.
**Monitoring states** (current attention): Priority · Active · Watch · Archive.
A Tier 1 conflict can sit in any state; the tier says how much it matters to
the Army, the state says how much attention it needs this week.

The map is a self-contained SVG (Natural Earth 1:110m outlines in
`assets/world-110m.json`): no tiles, no map library, works offline and in
print. Marker colour = state, size = tier, dashed circles = maritime zones,
▲▼ = state moved this review. Region focus buttons zoom to Europe, the
Middle East, South Asia, the Indo-Pacific or the Americas.

### Live, from open sources

The watchlist is fully automated:

- **Live reporting feed** — `.github/workflows/sync-watchlist-feed.yml` runs
  `scripts/sync-watchlist-feed.js` every 6 hours against the open GDELT DOC
  2.0 API and commits `watchlist-live.json`: a 30-day daily coverage
  timeline and the latest title-matched articles per item. The register shows
  a coverage sparkline, a 7-day count with change, a **surge** flag (≥2× the
  previous week and ≥20 articles, +8 attention points) and the headlines in
  each expanded row. Queries live in each item's `feed` block.
- **Weekly automated review** — a scheduled Claude Code session follows
  `docs/WATCHLIST-REVIEW.md`: researches all twelve items from open sources,
  rewrites `watchlist.json` (states, dimensions with previous values,
  changes, indicators, CSI actions, ignore verdicts, history, sources), runs
  `npm test` and pushes to `main`. Pages deploys on push.

### Manual review (same procedure)

Edit `watchlist.json` only — the dashboard derives rank, movements, change
flags, staleness, surges and the brief signal:

1. Set `meta.reviewDate` and `meta.previousReviewDate`.
2. For each item, copy each dimension's `now` into `prev`, then set the new `now`
   (`phase`, `escalation`, `tempo`, `adaptation`, `sgExposure`).
3. Set `prevState` to the state at the previous review and `state` to the new
   one; append any move to `history`.
4. Rewrite `whyNow`, `changes` (this week only), `next` (named, checkable
   indicators with `due` dates where they exist), `csi` and `ignore`.
5. Run `npm test` — the smoke test validates the register schema.

Items with `briefTheatre` set are enriched at runtime with the latest brief
edition (live if `weekly-live.json` is synced, seed otherwise), so the brief's
phase / trend / headline sits next to the analyst's call.

## Development

```
npm install
npm test          # syntax check + headless smoke test (jsdom)
python3 -m http.server 8000   # then open http://localhost:8000/conflict-dashboard.html
```
