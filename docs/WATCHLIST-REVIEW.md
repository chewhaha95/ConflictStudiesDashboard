# Watchlist review runbook (automated, open sources)

This is the procedure the scheduled review session follows every day to
rewrite `watchlist.json`. Every item is re-checked at every run. It is written so that a fresh session with no
memory of previous runs can execute it end to end. A human may run it the
same way.

## Ground rules

- **Open sources only.** Every material change, level and indicator must rest
  on a dated article or official statement seen during the run, cited in the
  item's `sources`. Nothing from memory for the period after the previous
  review. Prefer ISW / Critical Threats, Reuters, AP, BBC, Al Jazeera, USNI,
  CSIS, Crisis Group, Kyiv Independent, Meduza, Times of Israel, The National,
  Focus Taiwan, Japan Times, Bangkok Post, Nation Thailand, Khmer Times,
  Irrawaddy, DVB, Dawn, The Hindu, Singapore MFA/MHA/MINDEF statements.
- **The weekly brief is not a source and is not shown.** Do not copy its
  assessments or reference it.
- **Everything is compared over a 7-day window, not review to review.** The
  register is reviewed daily, but every comparison the dashboard shows (state
  moves, changed dimensions, the score bonuses) is made against the register
  as it stood `meta.compareDays` (7) days before `meta.reviewDate`. It reads
  that from each item's `snapshots` (one entry per review: `date`, `state`
  and the five dimension values). The review only appends today's snapshot;
  it never edits or writes `prev` values.
- **Not a news archive.** `changes` holds what materially moved over the
  last 7 days: dated bullets (`D Mon:` prefix), up to 6. Keep the bullets
  still inside the window, add today's, drop older ones. `next` holds named,
  checkable indicators, dated where a date exists. If nothing changed in the
  window, say "No material change over the last 7 days" and keep levels
  unchanged.
- **Flag, don't guess.** Single-source or unverifiable items are labelled
  "Unverified (single source)". Conflicting dates are stated as conflicting.
- **No publication prompts.** Do not write a `csi` field or recommend what to
  publish, escalate or leave (no "CSI Flash", "weekly awareness post" and the
  like, in `ifSeen` or anywhere else). Phrase consequences analytically:
  "escalate", "flag today", "note for the monthly pattern set", "track
  only". The team makes publication decisions outside the dashboard.
- **Scope is fixed.** The twelve items, their ids, tiers and `geo` blocks do
  not change. Only states, dimensions, text, indicators, ignore
  verdicts, history, timeline, assessment, sources and `feed` queries change.

## Procedure

1. Read `watchlist.json`. Note `meta.reviewDate` — that becomes
   `meta.previousReviewDate`. The new `meta.reviewDate` is today (UTC date).
2. Research every item for the window `previousReviewDate` → today (normally
   the last 24 hours; longer if a run was missed). Use
   parallel research agents (one per two or three items) with the structure:
   phase · material changes (dated, sourced) · levels with one-line
   justification · upcoming indicators to the end of the next quarter with
   type and date · confidence · sources. At least 6 varied searches per item.
3. For every item:
   - set the new `now` on each dimension (`phase` free text; `escalation`
     Low/Moderate/High/Severe; `tempo` and `adaptation` Low/Medium/High;
     `sgExposure` Low/Moderate/High);
   - decide the new `state` (Priority = direct strategic relevance or high
     Army learning value; Active = material trend, escalation or regional
     relevance; Watch = baseline monitoring; Archive = reserve, revisit on a
     named trigger); if it changed from yesterday's, append
     `{date, state, note}` to `history`;
   - maintain `timeline`: 4–8 entries `{date, text, url}` (ISO date of the
     event, one plain sentence, no state names, the open-source article or
     statement the entry rests on; add `"unverified": true` when it rests on
     a single source) that recap the key events of the conflict's current
     phase so far, in chronological order. Entries come from open-source
     research, never from the register's own text. Append today's event
     when it is material, merge or drop the least important when over 8,
     and do not rewrite past entries without cause. The dashboard shows it
     as "Timeline so far" in the expanded row;
   - rewrite `assessment` — `{date: <today>, text: [one or two paragraphs],
     sources: [{label, url}] (3–5)}`: the "Topic assessment" card beside the
     timeline. It is written through the item's three `topics`: for each
     topic, what the last 14 days of open-source evidence says about its
     watch area (say whether the Rising / Established / Contested status is
     borne out or contradicted), and what that implies for the "why it
     matters" question and adaptability. 140–230 words in total, plain
     analytical prose, evidence dated ("on 18 Sep"), topics referred to by
     name, all three covered, no bullets, no monitoring-state names, no
     publication or action recommendations. It is not a news summary and
     does not repeat `status` or `timeline`. Sources are the articles the
     paragraphs rest on, newest first; mark single-source claims
     "(single source)";
   - append today's snapshot to `snapshots`:
     `{date: <today>, state, phase, escalation, tempo, adaptation, sgExposure}`
     with the values just set (one snapshot per review date; replace the
     entry if today's already exists; keep the newest 60);
   - rewrite `status` — `summary`: two plain-language sentences on what is
     happening now, readable without context, whose first sentence states
     the newest development with its date; and `sources`: two or three
     `{label, url}` links to the newest reporting the summary rests on (at
     least one from the last 48 hours whenever such reporting exists; never
     older than 7 days unless nothing newer exists). Do not write a
     `status.latest` field (remove it if present): the dashboard shows the
     newest headline from the hourly live feed above the summary;
   - do not edit `topics` (three per item: `topic`, `why`, `adaptability`,
     `watch.status`, `watch.text`); the team sets them from the watchlist
     workbook. Every `next` entry must carry `topic`: the 0-based index of
     the topic and watch area it informs, or `null` when it bears on the
     theatre as a whole (elections, summits, talks with no capability angle).
     Prefer indicators that speak to a topic's watch area.
   - rewrite `whyNow` (one or two sentences), `changes` (7-day window, see
     ground rules), `next` (each with
     `type` from `definitions.indicatorTypes`, `due` as ISO date or null,
     `ifSeen`), `ignore` (`flag`, `reasons` from
     `definitions.ignoreReasons`, `note`), `confidence`, `learningValue`,
     and replace `sources` with the run's citations (label + URL);
   - adjust `feed.query` / `feed.terms` / `feed.require` / `feed.exclude`
     (see `definitions.feed`) only if the item's vocabulary
     changed (new place names, operations, actors);
   - **feed noise check**: read the item's `articles` in `watchlist-live.json`
     (the live feed, committed hourly). For any headline that is not
     reporting on the conflict's security, military, diplomatic or
     humanitarian dimension (sport, entertainment, livestream pages,
     business-only stories, homonyms such as Lebanon, Pennsylvania), add a
     short, specific lowercase substring to that item's `feed.exclude`, or a
     `feed.require` group when one side of a two-party theatre is missing,
     and add spam sources to `definitions.feed.spamDomains`. Keep entries
     specific; never add a term that would drop genuine reporting.
4. Update `meta.reviewer` to "Automated open-source review, <date>".
5. Validate: `npm test` must pass (it checks scales, dates, snapshots,
   history consistency, ranking and rendering).
6. Publish through the review branch (never push to `main` directly):
   ```
   git checkout -B claude/watchlist-review
   git add watchlist.json
   git commit -m "chore: automated watchlist review <date>"
   git push --force origin claude/watchlist-review
   ```
   The `Publish automated watchlist review` workflow checks that only
   `watchlist.json` changed, runs `npm test` on the merged tree, merges into
   `main` and deploys to Pages, all without a human. If the push is refused,
   retry with exponential backoff; if it still fails, say so in the final
   message. The run is complete only when the push has succeeded. The feed
   workflow keeps `watchlist-live.json` current separately.

## Criteria for the levels

Use `definitions.dimensions` in `watchlist.json` verbatim: each scaled
dimension (escalation risk, tempo, adaptation, Singapore exposure) carries a
`desc` and a `levels` map that defines every value. Set a level only when its
definition is met by dated reporting in the window.

## Attention score (derived, do not type in)

state (Priority 40 / Active 25 / Watch 10 / Archive 0) + escalation (Severe
20 / High 15 / Moderate 8 / Low 2) + 5 per dimension changed over the 7-day
window + 10 if the state moved up over it + Singapore exposure (High 8 / Moderate 4 / Low 0) + tier (T1 6 /
T2 3 / T3 0) + 8 on a live coverage surge. Items flagged ignore-for-now rank
last.
