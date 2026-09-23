#!/usr/bin/env node
/* =========================================================================
 * sync-watchlist-feed.js — live open-source reporting feed for the Watchlist.
 *
 * For every item in watchlist.json it queries the GDELT DOC 2.0 API (open,
 * no key) for:
 *   • a coverage timeline — daily counts from mode=TimelineVolRaw when GDELT
 *     serves it, otherwise four weekly article counts from date-windowed
 *     mode=ArtList queries (GDELT refuses the timeline modes from some
 *     networks; ArtList is capped at 250 records per window, flagged `capped`)
 *   • the most relevant English-language articles of the last 7 days
 *     (mode=ArtList, sort=HybridRel), title-filtered by the item's terms
 * and writes watchlist-live.json:
 *   { __live, syncedAt, source, items: { <id>: { query, granularity,
 *     timeline, count7d, prev7d, capped, surge, articles } } }
 *
 * GDELT asks for at most one request every 5 seconds, so the script paces
 * itself (~2–3 minutes for 12 items). It is defensive: an item whose requests
 * fail keeps its previous data (if any), and the file is only rewritten when
 * at least half of the items refreshed successfully.
 * ========================================================================= */
"use strict";
const fs = require("fs");
const path = require("path");

const API = "https://api.gdeltproject.org/api/v2/doc/doc";
const ROOT = path.resolve(__dirname, "..");
const REG = path.join(ROOT, "watchlist.json");
const OUT = path.join(ROOT, "watchlist-live.json");
const PACE_MS = Number(process.env.GDELT_PACE_MS || 5500);
const MAX_ARTICLES = 12;

const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || "").replace(/\s+/g, " ").replace(/\s([,.!?;:])/g, "$1").trim();

async function gdelt(params) {
  const u = new URL(API);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  const res = await fetch(u, { headers: { "User-Agent": "conflict-studies-dashboard/1.0 (watchlist feed)" } });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`non-JSON response: ${text.slice(0, 120)}`); }
}

// TimelineVolRaw → [{ date: "YYYY-MM-DD", value: n }]
function parseTimeline(j) {
  const series = (j && j.timeline && j.timeline[0] && j.timeline[0].data) || [];
  return series.map(p => ({ date: `${p.date.slice(0, 4)}-${p.date.slice(4, 6)}-${p.date.slice(6, 8)}`, value: Number(p.value) || 0 }));
}

function parseArticles(j, terms) {
  const arts = (j && j.articles) || [];
  const seen = new Set();
  const out = [];
  for (const a of arts) {
    const title = norm(a.title);
    const lower = title.toLowerCase();
    if (!title || !a.url) continue;
    if (terms.length && !terms.some(t => lower.includes(t))) continue;   // cut full-text noise
    const key = lower.replace(/[^a-z0-9]/g, "").slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    const d = String(a.seendate || "");
    out.push({
      title, url: a.url, domain: a.domain || "",
      country: a.sourcecountry || "",
      date: d.length >= 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null
    });
    if (out.length >= MAX_ARTICLES) break;
  }
  return out;
}

function windows(timeline, granularity, capped) {
  const vals = timeline.map(p => p.value);
  const n = granularity === "day" ? 7 : 1;
  const last = vals.slice(-n).reduce((a, b) => a + b, 0);
  const prev = vals.slice(-2 * n, -n).reduce((a, b) => a + b, 0);
  // a surge cannot be asserted when the counts are capped on both sides
  const surge = !capped && last >= 20 && last >= 2 * Math.max(prev, 1);
  return { count7d: last, prev7d: prev, capped: !!capped, surge };
}

const gd = d => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;

// Fallback timeline: four 7-day windows counted from date-windowed ArtList queries
// (each capped at 250 records — the cap is reported so the UI can say "250+").
async function weeklyWindows(q) {
  const now = new Date();
  const out = [];
  let capped = false;
  for (let w = 3; w >= 0; w--) {
    const end = new Date(now.getTime() - w * 7 * 86400000);
    const start = new Date(end.getTime() - 7 * 86400000);
    const j = await gdelt({ query: q, mode: "ArtList", format: "json", maxrecords: 250, sort: "DateDesc",
      startdatetime: gd(start) + "000000", enddatetime: gd(end) + "235959" });
    const n = ((j && j.articles) || []).length;
    if (n >= 250) capped = true;
    out.push({ date: start.toISOString().slice(0, 10), value: n });
    await sleep(PACE_MS);
  }
  return { timeline: out, capped };
}

async function fetchItem(it) {
  const q = `${it.feed.query} sourcelang:english`;
  let timeline = [], granularity = "day", capped = false;
  try {
    timeline = parseTimeline(await gdelt({ query: q, mode: "TimelineVolRaw", format: "json", timespan: "30d" }));
  } catch (e) { /* timeline modes refused from this network — fall back below */ }
  await sleep(PACE_MS);
  if (timeline.length < 14) {
    const w = await weeklyWindows(q);
    timeline = w.timeline; capped = w.capped; granularity = "week";
  }
  const al = await gdelt({ query: q, mode: "ArtList", format: "json", timespan: "7d", maxrecords: 75, sort: "HybridRel" });
  return Object.assign({ query: q, granularity, timeline, articles: parseArticles(al, it.feed.terms || []), fetchedAt: new Date().toISOString() },
    windows(timeline, granularity, capped));
}

(async () => {
  const reg = JSON.parse(fs.readFileSync(REG, "utf8"));
  const items = reg.items.filter(i => i.feed && i.feed.query);
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(OUT, "utf8")).items || {}; } catch (e) { /* first run */ }

  const out = {};
  let ok = 0;
  for (const it of items) {
    try {
      out[it.id] = await fetchItem(it);
      ok++;
      console.log(`✓ ${it.id.padEnd(9)} [${out[it.id].granularity}] 7d=${out[it.id].count7d}${out[it.id].capped ? "+" : ""} prev7d=${out[it.id].prev7d}${out[it.id].surge ? " SURGE" : ""} articles=${out[it.id].articles.length}`);
    } catch (e) {
      console.error(`✗ ${it.id}: ${e.message}${prev[it.id] ? " (keeping previous data)" : ""}`);
      if (prev[it.id]) out[it.id] = prev[it.id];
    }
    await sleep(PACE_MS);
  }
  if (ok < Math.ceil(items.length / 2)) {
    console.error(`Only ${ok}/${items.length} items refreshed — leaving ${path.basename(OUT)} untouched.`);
    process.exit(1);
  }
  fs.writeFileSync(OUT, JSON.stringify({
    __live: true,
    syncedAt: new Date().toISOString(),
    source: "GDELT DOC 2.0 API — https://api.gdeltproject.org/api/v2/doc/doc",
    refreshed: ok, total: items.length,
    items: out
  }, null, 2) + "\n");
  console.log(`Wrote ${path.basename(OUT)}: ${ok}/${items.length} items refreshed.`);
})().catch(e => { console.error("feed sync crashed:", e && e.stack || e); process.exit(1); });
