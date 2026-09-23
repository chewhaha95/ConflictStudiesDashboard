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
 * GDELT rate-limits per source IP (one request every 5 s), and GitHub's shared
 * runner IPs are often throttled by other users' traffic. So the script:
 *   • paces itself and retries 429s / network errors with backoff;
 *   • falls back to Google News RSS (open, no key) for headlines and for
 *     weekly counts (capped at ~100 items) when GDELT refuses;
 *   • merges with the previous file — an item that could not be refreshed keeps
 *     its last data (with its own fetchedAt) — and writes whenever at least one
 *     item refreshed, so the feed converges across runs;
 *   • stops starting new items after a global deadline so a run never overruns.
 * ========================================================================= */
"use strict";
const fs = require("fs");
const path = require("path");

const API = "https://api.gdeltproject.org/api/v2/doc/doc";
const ROOT = path.resolve(__dirname, "..");
const REG = path.join(ROOT, "watchlist.json");
const OUT = path.join(ROOT, "watchlist-live.json");
const PACE_MS = Number(process.env.GDELT_PACE_MS || 5500);
const RETRY_MS = [12000, 30000];                 // backoff after a 429 / network error
const DEADLINE_MS = Number(process.env.FEED_DEADLINE_MS || 40 * 60 * 1000);
const MAX_ARTICLES = 12;
const T0 = Date.now();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || "").replace(/\s+/g, " ").replace(/\s([,.!?;:])/g, "$1").trim();

class Throttled extends Error {}
async function gdeltOnce(params) {
  const u = new URL(API);
  Object.entries(params).forEach(([k, v]) => u.searchParams.set(k, v));
  const res = await fetch(u, { headers: { "User-Agent": "conflict-studies-dashboard/1.0 (watchlist feed)" }, signal: AbortSignal.timeout(30000) });
  const text = await res.text();
  if (res.status === 429 || /limit requests to one every/i.test(text)) throw new Throttled("GDELT throttled (429)");
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
  try { return JSON.parse(text); }
  catch (e) { throw new Error(`non-JSON response: ${text.slice(0, 120)}`); }
}
// Retry throttling and network errors with backoff; give up after RETRY_MS is spent.
async function gdelt(params) {
  let last;
  for (let attempt = 0; attempt <= RETRY_MS.length; attempt++) {
    try { return await gdeltOnce(params); }
    catch (e) {
      last = e;
      if (attempt === RETRY_MS.length) break;
      await sleep(RETRY_MS[attempt]);
    }
  }
  throw last;
}

// ---- Google News RSS fallback (open, no key) ------------------------------
const RSS = "https://news.google.com/rss/search";
const unescapeXml = s => String(s || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
const tag = (xml, name) => { const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`)); return m ? unescapeXml(m[1]).trim() : ""; };
async function rssSearch(q, days) {
  const u = new URL(RSS);
  u.searchParams.set("q", `${q} when:${days}d`);
  u.searchParams.set("hl", "en-SG"); u.searchParams.set("gl", "SG"); u.searchParams.set("ceid", "SG:en");
  const res = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0 (compatible; conflict-studies-dashboard/1.0)" }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`RSS HTTP ${res.status}`);
  const xml = await res.text();
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const x = m[1];
    const title = norm(tag(x, "title")), link = tag(x, "link"), pub = tag(x, "pubDate"), source = tag(x, "source");
    const d = pub ? new Date(pub) : null;
    if (!title || !link) continue;
    items.push({ title: title.replace(/\s+-\s+[^-]+$/, ""), url: link, domain: source || "news.google.com", country: "", date: d && !isNaN(d) ? d.toISOString().slice(0, 10) : null, ts: d && !isNaN(d) ? d.getTime() : null });
  }
  return items;
}
// GDELT queries use GDELT syntax; strip the sourcelang filter for Google News.
const rssQuery = q => q.replace(/\s*sourcelang:\w+/g, "").trim();
// Weekly counts from a 28-day RSS pull (capped at ~100 items by Google News).
function rssWeekly(items) {
  const now = Date.now();
  const out = [];
  for (let w = 3; w >= 0; w--) {
    const end = now - w * 7 * 86400000, start = end - 7 * 86400000;
    out.push({ date: new Date(start).toISOString().slice(0, 10), value: items.filter(i => i.ts != null && i.ts >= start && i.ts < end).length });
  }
  return { timeline: out, capped: items.length >= 90 };
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
  const terms = it.feed.terms || [];
  let timeline = [], granularity = "day", capped = false, articles = [], src = [];
  let throttled = false;

  // 1. GDELT daily timeline (best), else GDELT weekly windows (unless throttled), else RSS weekly counts
  try { timeline = parseTimeline(await gdelt({ query: q, mode: "TimelineVolRaw", format: "json", timespan: "30d" })); }
  catch (e) { if (e instanceof Throttled) throttled = true; }
  await sleep(PACE_MS);
  if (timeline.length >= 14) src.push("gdelt-timeline");
  else if (!throttled) {
    try { const w = await weeklyWindows(q); timeline = w.timeline; capped = w.capped; granularity = "week"; src.push("gdelt-windows"); }
    catch (e) { if (e instanceof Throttled) throttled = true; }
  }

  // 2. GDELT relevant articles (unless throttled), else RSS
  if (!throttled) {
    try { articles = parseArticles(await gdelt({ query: q, mode: "ArtList", format: "json", timespan: "7d", maxrecords: 75, sort: "HybridRel" }), terms); src.push("gdelt-articles"); }
    catch (e) { if (e instanceof Throttled) throttled = true; }
  }
  let rss = null;
  if (!articles.length || timeline.length < 4) {
    rss = await rssSearch(rssQuery(it.feed.query), 28);
    if (!articles.length) {
      articles = rss.filter(a => !terms.length || terms.some(t => a.title.toLowerCase().includes(t))).slice(0, MAX_ARTICLES).map(({ ts, ...a }) => a);
      src.push("rss-articles");
    }
    if (timeline.length < 4) { const w = rssWeekly(rss); timeline = w.timeline; capped = w.capped; granularity = "week"; src.push("rss-counts"); }
  }
  if (timeline.length < 2) throw new Error("no coverage data from GDELT or RSS");
  return Object.assign({ query: q, granularity, timeline, articles, source: src.join("+"), fetchedAt: new Date().toISOString() },
    windows(timeline, granularity, capped));
}

(async () => {
  const reg = JSON.parse(fs.readFileSync(REG, "utf8"));
  const items = reg.items.filter(i => i.feed && i.feed.query);
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(OUT, "utf8")).items || {}; } catch (e) { /* first run */ }

  // refresh the stalest items first so the feed converges across throttled runs
  const order = items.slice().sort((a, b) => String((prev[a.id] || {}).fetchedAt || "").localeCompare(String((prev[b.id] || {}).fetchedAt || "")));
  const out = Object.assign({}, prev);
  let ok = 0;
  for (const it of order) {
    if (Date.now() - T0 > DEADLINE_MS) { console.error(`⏱ deadline reached — ${it.id} and later items keep previous data`); break; }
    try {
      out[it.id] = await fetchItem(it);
      ok++;
      console.log(`✓ ${it.id.padEnd(9)} [${out[it.id].granularity}, ${out[it.id].source}] 7d=${out[it.id].count7d}${out[it.id].capped ? "+" : ""} prev7d=${out[it.id].prev7d}${out[it.id].surge ? " SURGE" : ""} articles=${out[it.id].articles.length}`);
    } catch (e) {
      console.error(`✗ ${it.id}: ${e.message}${prev[it.id] ? " (keeping previous data)" : ""}`);
    }
    await sleep(PACE_MS);
  }
  // drop items no longer in the register
  Object.keys(out).forEach(id => { if (!items.some(i => i.id === id)) delete out[id]; });
  if (ok === 0) {
    console.error(`No item could be refreshed — leaving ${path.basename(OUT)} untouched.`);
    process.exit(1);
  }
  fs.writeFileSync(OUT, JSON.stringify({
    __live: true,
    syncedAt: new Date().toISOString(),
    source: "GDELT DOC 2.0 API (api.gdeltproject.org) with Google News RSS fallback",
    refreshed: ok, total: items.length, present: Object.keys(out).length,
    items: out
  }, null, 2) + "\n");
  console.log(`Wrote ${path.basename(OUT)}: ${ok}/${items.length} items refreshed this run, ${Object.keys(out).length} present.`);
})().catch(e => { console.error("feed sync crashed:", e && e.stack || e); process.exit(1); });
