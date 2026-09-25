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
 *   • the most relevant recent English-language articles (mode=ArtList,
 *     sort=HybridRel over the last 3 days) merged with a Google News RSS pull,
 *     title-filtered by the item's terms and ranked by an army-learning
 *     relevance score (military vocabulary + the item's topics of interest,
 *     source rank, small recency bonus); the app shows the newest of the kept
 *     twelve as "Newest reporting"
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
const OUT = process.env.FEED_OUT || path.join(ROOT, "watchlist-live.json");   // FEED_OUT: write elsewhere when testing
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
    const iso = d && !isNaN(d) ? d.toISOString() : null;
    items.push({ title: title.replace(/\s+-\s+[^-]+$/, ""), url: link, domain: source || "news.google.com", country: "", date: iso ? iso.slice(0, 10) : null, ts: iso, rank: items.length });
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
    out.push({ date: new Date(start).toISOString().slice(0, 10), value: items.filter(i => i.ts && Date.parse(i.ts) >= start && Date.parse(i.ts) < end).length });
  }
  return { timeline: out, capped: items.length >= 90 };
}

// TimelineVolRaw → [{ date: "YYYY-MM-DD", value: n }]
function parseTimeline(j) {
  const series = (j && j.timeline && j.timeline[0] && j.timeline[0].data) || [];
  return series.map(p => ({ date: `${p.date.slice(0, 4)}-${p.date.slice(4, 6)}-${p.date.slice(6, 8)}`, value: Number(p.value) || 0 }));
}

function parseArticles(j, feed) {
  const arts = (j && j.articles) || [];
  const seen = new Set();
  const out = [];
  for (const a of arts) {
    const title = norm(a.title);
    const lower = title.toLowerCase();
    if (!title || !a.url) continue;
    if (!titleMatch({ title }, feed)) continue;   // cut full-text noise
    const key = lower.replace(/[^a-z0-9]/g, "").slice(0, 60);
    if (seen.has(key)) continue;
    seen.add(key);
    const d = String(a.seendate || "");                       // 20260924T133000Z
    const date = d.length >= 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null;
    const ts = d.length >= 15 ? `${date}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z` : (date ? `${date}T00:00:00Z` : null);
    out.push({ title, url: a.url, domain: a.domain || "", country: a.sourcecountry || "", date, ts, rank: out.length });
  }
  return out;
}

// Relevance guard on titles. `feed.terms`: any one must appear. `feed.require`
// (optional): a list of groups, at least one term of EVERY group must appear
// (two-party theatres: one term per side, so "Thai rocker wins talent show"
// and "India v Pakistan cricket" do not pass). `feed.exclude` (optional) and
// the global EXCLUDE list drop sport, entertainment and other title noise.
const EXCLUDE = ["cricket", "asian games", "olympic", "world cup", "football", "soccer", "tennis", "badminton", "hockey", "basketball",
  "friendlies", "friendly match", "medal", "medals", "afc", "fifa", "esports", "marathon",
  "pageant", "miss universe", "got talent", "box office", "k-pop", "concert", "celebrity", "recipe", "horoscope", "premier league",
  "documentary", "film festival", "mooncake", "cultural harmony", "habitat for humanity", "tourism", "travel guide"];
// Title patterns that are never reporting: livestream spam (often in maths-bold
// or fullwidth Unicode), "way to watch" pages, score pages.
const EXCLUDE_RE = [/[\u{1D400}-\u{1D7FF}\uFF00-\uFFEF]/u, /\b(live ?streams?|live ?streaming|watch ?live|tv channel|free on tv|way to watch|live score|match live)\b/i];
const wordRe = t => new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`);
const titleMatch = (a, feed) => {
  const lower = String(a.title || "").toLowerCase();
  const terms = feed.terms || [];
  if (terms.length && !terms.some(t => lower.includes(t))) return false;
  if ((feed.require || []).some(group => !group.some(t => lower.includes(t)))) return false;
  if ([...EXCLUDE, ...(feed.exclude || [])].some(t => wordRe(t).test(lower))) return false;
  if (EXCLUDE_RE.some(re => re.test(String(a.title || "")))) return false;
  return true;
};

// ---- Relevance screen (Claude) ------------------------------------------------
// Title keywords cannot tell "Japan beats China for basketball gold" from
// "China urges Japan to earn trust", so after the heuristics the newest
// candidates are cross-checked by a model against the item's phase, status and
// topics. Verdicts are cached per title in watchlist-live.json (`screen`), so a
// title is judged once, and the screen is skipped (heuristics only, logged)
// when ANTHROPIC_API_KEY is not set or the API fails.
// Providers, first available wins: ANTHROPIC_API_KEY → Claude (claude-opus-5);
// else FEED_SCREEN_URL + FEED_SCREEN_KEY → the Cloudflare Worker's /screen route
// (Workers AI, free daily allowance); else GITHUB_TOKEN → GitHub Models (kept as
// a fallback; its endpoint answered "OK" text instead of an API in Sep 2026);
// else no screen. FEED_SCREEN=off disables it; FEED_SCREEN_MODEL overrides the model.
const SCREEN_MAX = 30;            // most relevant candidates sent per item
const SCREEN_KEEP = 300;          // cached verdicts kept per item
const titleKey = t => String(t || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
const SCREEN_SCHEMA = { type: "object", properties: { keep: { type: "array", items: { type: "integer" } } }, required: ["keep"], additionalProperties: false };
// GitHub Models endpoints, tried in order (the newer host first; the original
// Azure-hosted endpoint as a fallback). A non-JSON body is reported with its
// status, content-type and first bytes so a routing problem is diagnosable.
const GITHUB_MODELS = ["https://models.github.ai/inference/chat/completions", "https://models.inference.ai.azure.com/chat/completions"];
function screenJudge() {
  if ((process.env.FEED_SCREEN || "").toLowerCase() === "off") return null;
  if (process.env.ANTHROPIC_API_KEY) {
    const model = process.env.FEED_SCREEN_MODEL || "claude-opus-5";
    const Anthropic = require("@anthropic-ai/sdk").default || require("@anthropic-ai/sdk");
    const client = new Anthropic({ maxRetries: 2, timeout: 60000 });
    const judge = async (system, user) => {
      const res = await client.beta.messages.create({
        model, max_tokens: 1024,
        betas: ["server-side-fallback-2026-07-01"], fallbacks: "default",
        output_config: { effort: "low", format: { type: "json_schema", schema: SCREEN_SCHEMA } },
        system, messages: [{ role: "user", content: user }],
      });
      if (res.stop_reason === "refusal") throw new Error("screen refused");
      return (res.content || []).filter(b => b.type === "text").map(b => b.text).join("");
    };
    return Object.assign(judge, { label: `claude:${model}` });
  }
  if (process.env.FEED_SCREEN_URL && process.env.FEED_SCREEN_KEY) {
    const url = process.env.FEED_SCREEN_URL.replace(/\/+$/, "") + "/screen";
    const judge = async (system, user) => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${process.env.FEED_SCREEN_KEY}`, "Content-Type": "application/json", "User-Agent": "conflict-studies-dashboard/1.0 (feed relevance screen)" },
        body: JSON.stringify({ system, user }), signal: AbortSignal.timeout(60000),
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`Worker /screen HTTP ${res.status}: ${text.slice(0, 200)}`);
      const j = JSON.parse(text);
      if (j.error) throw new Error(`Worker /screen: ${j.error}`);
      return j.text || "";
    };
    return Object.assign(judge, { label: `workers-ai:${new URL(url).host}` });
  }
  if (process.env.GITHUB_TOKEN) {
    const model = process.env.FEED_SCREEN_MODEL || "openai/gpt-4o-mini";
    const judge = async (system, user) => {
      const body = JSON.stringify({ model, temperature: 0, max_tokens: 300, response_format: { type: "json_object" },
        messages: [{ role: "system", content: system + ' Respond with JSON only: {"keep": [indices]}.' }, { role: "user", content: user }] });
      const errors = [];
      for (const url of GITHUB_MODELS) {
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`, "Accept": "application/json", "Content-Type": "application/json", "User-Agent": "conflict-studies-dashboard/1.0 (feed relevance screen)" },
            body, signal: AbortSignal.timeout(60000),
          });
          const text = await res.text();
          const ctype = res.headers.get("content-type") || "";
          if (!res.ok) throw new Error(`HTTP ${res.status} ${ctype}: ${text.slice(0, 200)}`);
          let j; try { j = JSON.parse(text); } catch (e) { throw new Error(`non-JSON ${res.status} ${ctype}: ${JSON.stringify(text.slice(0, 120))}`); }
          const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
          if (!content) throw new Error(`no choices in response: ${text.slice(0, 200)}`);
          return content;
        } catch (e) { errors.push(`${new URL(url).host}: ${e.message}`); }
      }
      throw new Error(errors.join(" | "));
    };
    return Object.assign(judge, { label: `github-models:${model}` });
  }
  return null;
}
function screenPrompt(it, cands) {
  const topics = (it.topics || []).map((t, i) => `${i + 1}. ${t.topic} — watch: ${t.watch && t.watch.text}`).join("\n");
  const list = cands.map((a, i) => `${i}. [${a.domain || "?"}] ${a.title}`).join("\n");
  return `Conflict watchlist item: ${it.name}\nCurrent phase: ${(it.dims && it.dims.phase && it.dims.phase.now) || ""}\nStatus: ${(it.status && it.status.summary) || ""}\nTopics of interest:\n${topics}\n\nCandidate headlines (index. [source] title):\n${list}\n\nReturn the indices to KEEP.`;
}
const SCREEN_SYSTEM = "You screen news headlines for a military conflict-studies watchlist. Keep a headline only if it reports on the security, military, political-military, diplomatic or humanitarian dimension of the named conflict or theatre. Drop sport, entertainment, livestream and score pages, business or technology stories with no security angle, cultural or lifestyle pieces, homonyms (places or people with the same name elsewhere), and stories about a different conflict that merely mention a party. When unsure, drop it.";
// Info-ops watch: a stricter screen for the item's information-operations /
// strategic-communications sub-feed (register `infoOps`).
const INFOOPS_SYSTEM = "You screen news headlines for a military conflict-studies watchlist's information-operations watch. Keep a headline only if it reports on information operations, disinformation, cognitive or psychological warfare, propaganda or state-media narratives, official strategic communications (government, foreign-ministry, military or party statements aimed at an audience), influence campaigns, censorship, lawfare narratives or sanctions used as messaging, in the named theatre. Drop ordinary military, economic, sport or entertainment news, and anything not about messaging or influence. When unsure, drop it.";
function infoOpsPrompt(it, cands) {
  const io = it.infoOps || {};
  const list = cands.map((a, i) => `${i}. [${a.domain || "?"}] ${a.title}`).join("\n");
  return `Conflict watchlist item: ${it.name}\nInformation-operations watch since ${io.since || "?"} (${io.trigger || ""})\nQuestion: ${io.question || ""}\n\nCandidate headlines (index. [source] title):\n${list}\n\nReturn the indices to KEEP.`;
}
async function screenArticles(it, cands, prevScreen, judge, opts) {
  const system = (opts && opts.system) || SCREEN_SYSTEM;
  const prompt = (opts && opts.prompt) || screenPrompt;
  const screen = Object.assign({}, prevScreen || {});
  const unjudged = cands.filter(a => !(titleKey(a.title) in screen));
  let screened = true;
  if (unjudged.length && judge) {
    try {
      const text = await judge(system, prompt(it, unjudged));
      const raw = String(text).replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
      const m = raw.match(/\{[\s\S]*\}/);                    // tolerate prose around the JSON
      const parsed = JSON.parse(m ? m[0] : raw);
      if (!Array.isArray(parsed.keep)) throw new Error("no keep[] in verdict");
      const keep = new Set(parsed.keep.map(Number));
      const at = new Date().toISOString(), by = judge.label || "judge";
      unjudged.forEach((a, i) => { screen[titleKey(a.title)] = { ok: keep.has(i), at, by }; });
    } catch (e) { screened = false; console.error(`  screen ${it.id}: ${e.message} — keeping heuristic list`); }
  } else if (unjudged.length) screened = false;
  const kept = cands.filter(a => { const v = screen[titleKey(a.title)]; return !v || v.ok; });
  // keep the cache small: verdicts for current candidates first, then the newest others
  const keys = new Set(cands.map(a => titleKey(a.title)));
  const rest = Object.entries(screen).filter(([k]) => !keys.has(k)).sort((x, y) => String(y[1].at).localeCompare(String(x[1].at))).slice(0, SCREEN_KEEP - keys.size);
  const pruned = {}; for (const k of keys) if (screen[k]) pruned[k] = screen[k]; for (const [k, v] of rest) pruned[k] = v;
  return { kept, screen: pruned, screened, judged: unjudged.length };
}

// Merge article lists from several sources: dedupe by URL and by normalised
// title, newest first by timestamp (date when no time is known), cap at MAX_ARTICLES.
function mergeArticles(lists, cap = MAX_ARTICLES) {
  const seen = new Set(), out = [];
  for (const a of [].concat(...lists)) {
    const key = a.title.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 60);
    if (seen.has(key) || seen.has(a.url)) continue;
    seen.add(key); seen.add(a.url);
    out.push(a);
  }
  out.sort((x, y) => String(y.ts || y.date || "").localeCompare(String(x.ts || x.date || "")));
  return out.slice(0, cap);
}

// ---- Army-learning relevance ranking ------------------------------------------
// Title vocabulary that marks reporting an army can learn from: operations,
// weapons and effects, force posture, command, sustainment, adaptation. A
// headline earns a point per distinct hit (capped), plus points for words from
// the item's own topics of interest (topic / why / watch text), plus a rank
// bonus from the source (GDELT lists by relevance, Google News by relevance),
// plus a small recency bonus so, at equal relevance, the newer piece wins.
const MIL_TERMS = ["military", "army", "armed forces", "troops", "soldiers", "brigade", "battalion", "division", "regiment", "corps", "commander",
  "offensive", "counteroffensive", "counter-offensive", "assault", "attack", "strike", "strikes", "airstrike", "air strike", "raid", "shelling", "bombard",
  "frontline", "front line", "front-line", "battlefield", "battle", "combat", "fighting", "clashes", "clash", "firefight", "ambush", "incursion", "advance", "captured", "seized", "recaptur", "liberat", "withdraw", "retreat",
  "drone", "drones", "uav", "uas", "fpv", "loitering", "kamikaze", "missile", "missiles", "rocket", "artillery", "howitzer", "himars", "atacms", "mortar", "tank", "tanks", "armour", "armor", "armoured", "armored", "ifv", "apc",
  "air defence", "air defense", "patriot", "s-400", "interceptor", "intercepted", "shot down", "downed", "jamming", "electronic warfare", "ew", "gps", "spoofing", "radar", "isr", "reconnaissance", "surveillance", "satellite", "starlink",
  "mine", "mines", "minefield", "ied", "explosive", "sabotage", "special forces", "commando", "sniper", "infantry", "mechanised", "mechanized", "cavalry", "airborne", "marines", "navy", "naval", "warship", "frigate", "destroyer", "submarine", "coast guard", "coastguard", "fighter jet", "jets", "bomber", "helicopter", "warplane",
  "mobilis", "mobiliz", "conscript", "recruit", "reservist", "casualt", "killed", "wounded", "losses", "pow", "prisoner",
  "logistic", "supply line", "supply route", "ammunition", "ammo", "shells", "resupply", "sustainment", "repair", "depot", "arms", "weapons", "weapon", "munition", "procure", "defence industry", "defense industry", "production",
  "exercise", "drill", "drills", "wargame", "war game", "deploy", "deployment", "deployed", "posture", "buildup", "build-up", "reinforce", "garrison", "base", "airbase", "air base", "border", "blockade", "quarantine", "grey zone", "gray zone", "grey-zone", "gray-zone", "adiz", "median line", "incursion",
  "ceasefire", "cease-fire", "truce", "escalat", "de-escalat", "deterren", "peacekeep", "occupation", "occupied", "insurgen", "militant", "militia", "guerrilla", "terror",
  "doctrine", "tactic", "tactics", "lessons", "adapt", "innovation", "training", "command and control", "c2", "cyber", "cyberattack", "hack", "information operations", "disinformation", "propaganda", "cognitive warfare", "psychological",
  "pla", "idf", "hezbollah", "hamas", "houthi", "wagner", "junta", "rebel", "rebels", "resistance", "war", "warfare"];
const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "over", "under", "than", "then", "their", "what", "when", "where", "which", "while", "whether", "will", "would", "could", "should", "have", "has", "had", "are", "was", "were", "been", "being", "its", "not", "but", "also", "more", "most", "less", "very", "such", "each", "other", "against", "versus", "between", "across", "through", "toward", "towards", "about", "after", "before", "during", "without", "within", "along", "among", "both", "either", "only", "same", "some", "any", "all", "own", "off", "out", "how", "who", "whose", "why", "can", "may", "might", "must", "shall", "one", "two", "three", "new", "old", "first", "last", "next", "still", "yet", "ever", "never", "often", "rarely", "increasingly", "whether", "track", "watch", "assess", "observe", "monitor", "note", "does", "did", "make", "makes", "made", "come", "comes", "became", "become", "becomes", "remain", "remains", "local", "wider", "costs", "costly", "cost", "role", "roles", "case", "cases", "level", "levels", "way", "ways", "use", "used", "uses", "using", "versus", "per", "via", "etc"]);
// Distinct content words (≥4 letters, not a stop word) from the item's topics, so
// "counter-UAS", "signature", "sustainment" count towards the item's own learning themes.
function topicWords(it) {
  const text = (it.topics || []).map(t => [t.topic, t.why, t.watch && t.watch.text].join(" ")).join(" ").toLowerCase();
  const words = new Set();
  for (const w of text.split(/[^a-z0-9-]+/)) { const x = w.replace(/^-+|-+$/g, ""); if (x.length >= 4 && !STOP.has(x)) words.add(x); }
  return [...words];
}
// Terms match at a word start (so "drone" counts "drones", "escalat" counts
// "escalation"); short terms (≤4 letters: war, arms, base, pla, ew…) must be
// whole words so "warehouse", "warm" or "player" do not count.
const termRe = t => new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${t.length <= 4 ? "([^a-z0-9]|$)" : ""}`);
const MIL_RES = MIL_TERMS.map(termRe);
function relevanceHits(a, it) {
  const lower = String(a.title || "").toLowerCase();
  const mil = MIL_RES.filter(re => re.test(lower)).length;
  const tw = (a._topicWords || topicWords(it)).filter(w => termRe(w).test(lower)).length;
  return { mil, tw };
}
function relevanceScore(a, it, now = Date.now()) {
  const { mil, tw } = relevanceHits(a, it);
  const rank = a.rank == null ? 0 : Math.max(0, 2 - a.rank / 25);            // top of a relevance list: +2 → 0 after 50
  const age = a.ts ? Math.max(0, (now - Date.parse(a.ts)) / 3600000) : 72;   // hours old (unknown = 3 days)
  const recency = Math.max(0, 1.5 - age / 48);                               // +1.5 fresh → 0 after 2 days
  return Math.min(mil, 4) * 1.5 + Math.min(tw, 3) * 1.5 + rank + recency;
}
// Rank candidates by army-learning relevance, most relevant first; cap. A title
// with no military-vocabulary or topic hit (trade, culture, business) is used
// only as filler when fewer than MIN_HITS real hits exist, so a thin theatre
// still shows something but a busy one never leads with a supply-chain story.
const MIN_HITS = 4;
function rankArticles(arts, it, cap = MAX_ARTICLES, now = Date.now()) {
  const tw = topicWords(it);
  const scored = arts.map(a => { const b = Object.assign({ _topicWords: tw }, a); const h = relevanceHits(b, it); return { a, s: relevanceScore(b, it, now), hit: h.mil + h.tw > 0 }; })
    .sort((x, y) => y.s - x.s || String(y.a.ts || y.a.date || "").localeCompare(String(x.a.ts || x.a.date || "")));
  const hits = scored.filter(x => x.hit), rest = scored.filter(x => !x.hit);
  const out = hits.length >= MIN_HITS ? hits : hits.concat(rest.slice(0, MIN_HITS - hits.length));
  return out.slice(0, cap).map(x => Object.assign({}, x.a, { rel: Math.round(x.s * 10) / 10 }));
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

async function fetchItem(it, prevItem, judge, spamDomains) {
  const q = `${it.feed.query} sourcelang:english`;
  const feed = it.feed;
  const notSpam = a => !(spamDomains || []).some(d => String(a.domain || "").toLowerCase().endsWith(d));
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

  // 2. Most relevant recent articles: GDELT relevance-ranked (HybridRel) over
  //    the last 3 days (unless throttled) merged with a Google News pull over
  //    the same window, title-filtered, then ranked by army-learning relevance
  //    (military vocabulary + the item's topics, source rank, recency bonus).
  //    Widened to 7 days when the 3-day window is thin.
  const lists = [];
  if (!throttled) {
    try { lists.push(parseArticles(await gdelt({ query: q, mode: "ArtList", format: "json", timespan: "3d", maxrecords: 100, sort: "HybridRel" }), feed)); src.push("gdelt-articles"); }
    catch (e) { if (e instanceof Throttled) throttled = true; }
  }
  try { lists.push((await rssSearch(rssQuery(it.feed.query), 3)).filter(a => titleMatch(a, feed))); src.push("rss-articles"); }
  catch (e) { /* RSS unavailable this run */ }
  const pool = () => rankArticles(mergeArticles(lists, 500).filter(notSpam), it, SCREEN_MAX);
  let cands = pool();
  if (cands.length < 6) {
    try { lists.push((await rssSearch(rssQuery(it.feed.query), 7)).filter(a => titleMatch(a, feed))); cands = pool(); }
    catch (e) { /* keep what we have */ }
  }
  // 3. Relevance screen (model cross-check), then the MAX_ARTICLES most relevant
  //    survivors; the app shows the newest of them as "Newest reporting".
  const sc = await screenArticles(it, cands, (prevItem || {}).screen, judge);
  articles = sc.kept.slice(0, MAX_ARTICLES);
  if (sc.judged) src.push(sc.screened ? "screened" : "unscreened");
  if (timeline.length < 4) {
    const rss = await rssSearch(rssQuery(it.feed.query), 28);
    const w = rssWeekly(rss); timeline = w.timeline; capped = w.capped; granularity = "week"; src.push("rss-counts");
  }
  if (timeline.length < 2) throw new Error("no coverage data from GDELT or RSS");
  const out = Object.assign({ query: q, granularity, timeline, articles, screen: sc.screen, screened: sc.screened, source: src.join("+"), fetchedAt: new Date().toISOString() },
    windows(timeline, granularity, capped));

  // 4. Information-operations / strategic-communications watch (register
  //    `infoOps`, e.g. Taiwan after the Trump–Xi summit): a second, narrower
  //    query, newest first, screened with the info-ops prompt.
  const io = it.infoOps;
  if (io && io.enabled && io.feed && io.feed.query) {
    const ioLists = [];
    if (!throttled) {
      try { ioLists.push(parseArticles(await gdelt({ query: `${io.feed.query} sourcelang:english`, mode: "ArtList", format: "json", timespan: "3d", maxrecords: 250, sort: "DateDesc" }), io.feed)); }
      catch (e) { if (e instanceof Throttled) throttled = true; }
      await sleep(PACE_MS);
    }
    try { ioLists.push((await rssSearch(rssQuery(io.feed.query), 3)).filter(a => titleMatch(a, io.feed))); } catch (e) { /* RSS unavailable */ }
    let ioCands = mergeArticles(ioLists, SCREEN_MAX).filter(notSpam);
    if (ioCands.length < 6) { try { ioLists.push((await rssSearch(rssQuery(io.feed.query), 7)).filter(a => titleMatch(a, io.feed))); ioCands = mergeArticles(ioLists, SCREEN_MAX).filter(notSpam); } catch (e) { /* keep */ } }
    const ioSc = await screenArticles(it, ioCands, ((prevItem || {}).infoOps || {}).screen, judge, { system: INFOOPS_SYSTEM, prompt: infoOpsPrompt });
    out.infoOps = { since: io.since || null, candidates: ioCands.length, articles: ioSc.kept.slice(0, MAX_ARTICLES), screen: ioSc.screen, screened: ioSc.screened, fetchedAt: new Date().toISOString() };
  }
  return out;
}

module.exports = { titleMatch, mergeArticles, rankArticles, relevanceScore, topicWords, MIL_TERMS, parseArticles, rssSearch, rssQuery, screenArticles, screenPrompt, infoOpsPrompt, INFOOPS_SYSTEM, screenJudge, titleKey, EXCLUDE };
if (require.main !== module) return;

(async () => {
  const reg = JSON.parse(fs.readFileSync(REG, "utf8"));
  const only = (process.env.FEED_ONLY || "").split(",").map(x => x.trim()).filter(Boolean);   // FEED_ONLY=SCS,TW: test a subset
  const items = reg.items.filter(i => i.feed && i.feed.query && (!only.length || only.includes(i.id)));
  let prev = {};
  try { prev = JSON.parse(fs.readFileSync(OUT, "utf8")).items || {}; } catch (e) { /* first run */ }

  // refresh the stalest items first so the feed converges across throttled runs
  const order = items.slice().sort((a, b) => String((prev[a.id] || {}).fetchedAt || "").localeCompare(String((prev[b.id] || {}).fetchedAt || "")));
  const out = Object.assign({}, prev);
  const judge = screenJudge();
  const spamDomains = ((reg.definitions || {}).feed || {}).spamDomains || [];
  console.log(judge ? `Relevance screen: ${judge.label}` : "Relevance screen: skipped (no ANTHROPIC_API_KEY, FEED_SCREEN_URL/KEY or GITHUB_TOKEN) — title heuristics only");
  let ok = 0;
  for (const it of order) {
    if (Date.now() - T0 > DEADLINE_MS) { console.error(`⏱ deadline reached — ${it.id} and later items keep previous data`); break; }
    try {
      out[it.id] = await fetchItem(it, prev[it.id], judge, spamDomains);
      ok++;
      console.log(`✓ ${it.id.padEnd(9)} [${out[it.id].granularity}, ${out[it.id].source}] 7d=${out[it.id].count7d}${out[it.id].capped ? "+" : ""} prev7d=${out[it.id].prev7d}${out[it.id].surge ? " SURGE" : ""} articles=${out[it.id].articles.length}${out[it.id].screened === false ? " (unscreened)" : ""}${out[it.id].infoOps ? ` infoOps=${out[it.id].infoOps.articles.length}/${out[it.id].infoOps.candidates}` : ""}`);
    } catch (e) {
      console.error(`✗ ${it.id}: ${e.message}${prev[it.id] ? " (keeping previous data)" : ""}`);
    }
    await sleep(PACE_MS);
  }
  // drop items no longer in the register (all register items, not just the
  // FEED_ONLY subset, so a partial test run never discards the other items)
  const registered = new Set(reg.items.filter(i => i.feed && i.feed.query).map(i => i.id));
  Object.keys(out).forEach(id => { if (!registered.has(id)) delete out[id]; });
  if (ok === 0) {
    console.error(`No item could be refreshed — leaving ${path.basename(OUT)} untouched.`);
    process.exit(1);
  }
  fs.writeFileSync(OUT, JSON.stringify({
    __live: true,
    syncedAt: new Date().toISOString(),
    source: "GDELT DOC 2.0 API (api.gdeltproject.org) with Google News RSS fallback",
    refreshed: ok, total: registered.size, present: Object.keys(out).length,
    items: out
  }, null, 2) + "\n");
  console.log(`Wrote ${path.basename(OUT)}: ${ok}/${items.length} items refreshed this run, ${Object.keys(out).length} present.`);
})().catch(e => { console.error("feed sync crashed:", e && e.stack || e); process.exit(1); });
