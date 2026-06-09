#!/usr/bin/env node
/* =========================================================================
 * sync-weekly.js — fetch the Conflict Studies & Insights weekly brief
 * (https://conflictstudiesandinsights.pages.dev) — the current edition AND
 * every archived ("Previous Editions") edition — and convert each into the
 * dashboard's weekly-report schema, written to weekly-live.json as:
 *   { __live, syncedAt, sourceUrl, editions: [ <newest first> ] }
 *
 * The dashboard's Weekly tab lists all editions (current = "● LIVE", past =
 * archived) and falls back to the seed data if the file is missing/invalid.
 * Future editions appear automatically: when a new edition is published the
 * prior one is archived, so the next sync picks them all up.
 *
 * Parsing is defensive: if fewer than 1 valid edition is produced the script
 * exits non-zero WITHOUT overwriting the existing file.
 * ========================================================================= */
"use strict";
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");
const { deriveCapabilityEvidence } = require("./lib/capability-evidence");

const SOURCE = "https://conflictstudiesandinsights.pages.dev";
const OUT = path.resolve(__dirname, "..", "weekly-live.json");

const THEATRE_IDS = [
  { id: "RU_UA",    keys: ["russia", "ukraine"] },
  { id: "IL_LB",    keys: ["lebanon"] },
  { id: "IL_GZ",    keys: ["gaza"] },
  { id: "IL_US_IR", keys: ["iran"] },
  { id: "TH_KH",    keys: ["thailand", "cambodia"] }
];
const DOMAINS = ["Fires & Strikes", "Intelligence", "Manoeuvre", "Protection", "Sustainment", "Command & Control"];
const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };

const norm = s => (s || "").replace(/\s+/g, " ").trim();
const squash = s => norm(s).toLowerCase().replace(/[^a-z]/g, "");

function theatreId(name) {
  const s = squash(name);
  const hit = THEATRE_IDS.find(t => t.keys.every(k => s.includes(k)) || t.keys.some(k => s.includes(k)));
  return hit ? hit.id : null;
}
function normTrend(t) {
  const s = norm(t).toLowerCase().replace(/[^a-z]/g, "");
  if (s.includes("escalat")) return "Escalating";
  if (s.includes("deteriorat")) return "Deteriorating";
  if (s.includes("unstable") || s.includes("volatile")) return "Volatile";
  if (s.includes("improv")) return "Improving";
  if (s.includes("deescalat")) return "De-escalating";
  return "Stable";
}
function statusLabel(phase, trend) {
  const ceasefire = /ceasefire|truce/i.test(phase);
  if (ceasefire && ["Escalating", "Deteriorating", "Volatile"].includes(trend)) return "Ceasefire Under Strain";
  if (trend === "Escalating") return "Escalating";
  if (trend === "Deteriorating" || trend === "Volatile") return "Deteriorating";
  if (trend === "Improving" || trend === "De-escalating") return "Tentative De-escalation";
  return "Stable";
}
function statusScore(phase, trend) {
  let base = /active|combat|high-intensity|war/i.test(phase) ? 80 : /ceasefire|truce|post-conflict/i.test(phase) ? 50 : 55;
  base += ({ Escalating: 8, Deteriorating: 5, Volatile: 3, Stable: 0, Improving: -5, "De-escalating": -8 })[trend] || 0;
  return Math.max(0, Math.min(100, base));
}
function mapDomain(pill) {
  if (DOMAINS.includes(pill)) return pill;
  const s = (pill || "").toLowerCase();
  if (/fire|strike|missile|drone/.test(s)) return "Fires & Strikes";
  if (/intel|isr|recon|surveillance/.test(s)) return "Intelligence";
  if (/manoeuvre|maneuver|ground|terrain|advance/.test(s)) return "Manoeuvre";
  if (/protect|defen[cs]e|spillover|air.?defen/.test(s)) return "Protection";
  if (/sustain|logist|supply/.test(s)) return "Sustainment";
  if (/command|control|c2|diploma|political|negotiat/.test(s)) return "Command & Control";
  return null;
}
function parseRange(str) {
  const m = norm(str).match(/(\d{1,2})\s+([A-Za-z]+)\s*[–-]\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (!m) return null;
  const [, d1, mo1, d2, mo2, yr] = m;
  const year = +yr;
  const toISO = (d, mo) => {
    const mi = MONTHS[mo.slice(0, 3).toLowerCase()];
    return mi == null ? null : new Date(Date.UTC(year, mi, +d)).toISOString().slice(0, 10);
  };
  return { start: toISO(d1, mo1), end: toISO(d2, mo2), label: norm(`${d1} ${mo1} – ${d2} ${mo2} ${yr}`) };
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { "user-agent": "conflict-dashboard-sync" } });
  if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
  return res.text();
}

// Parse a single edition page into the dashboard weekly schema.
function parseEdition(html, pageUrl, rangeHint) {
  const doc = new JSDOM(html).window.document;
  const h2s = [...doc.querySelectorAll("h2")];

  // date range: prefer the <header> (archive <title>s can be stale), then hint, then title
  const headerTxt = (doc.querySelector("header") || {}).textContent || "";
  const range = parseRange(headerTxt) || parseRange(rangeHint || "")
    || parseRange((doc.querySelector("title") || {}).textContent || "") || { start: null, end: null, label: norm(rangeHint) || "Edition" };

  const blufH = h2s.find(h => /bluf/i.test(h.textContent));
  const blufP = blufH && blufH.closest("section") ? blufH.closest("section").querySelector("p") : null;
  const bluf = norm(blufP ? blufP.textContent : "");

  // status table -> per-theatre phase / trend / progress
  const status = {};
  const table = doc.querySelector("table");
  if (table) table.querySelectorAll("tbody tr").forEach(tr => {
    const tds = tr.querySelectorAll("td");
    if (tds.length < 4) return;
    const id = theatreId(tds[0].textContent);
    if (!id) return;
    status[id] = { phase: norm(tds[1].textContent), trend: norm(tds[2].textContent).replace(/[↑↓→↗↘↔]/g, ""), progress: norm(tds[3].textContent) };
  });

  // watch areas per theatre
  const watch = {};
  const watchH = h2s.find(h => /watch areas/i.test(h.textContent));
  if (watchH && watchH.closest("section")) watchH.closest("section").querySelectorAll("li").forEach(li => {
    const head = li.querySelector("div");
    const id = head ? theatreId(head.textContent) : null;
    if (!id) return;
    const parts = [...li.querySelectorAll("div")].map(d => norm(d.textContent));
    watch[id] = parts.slice(1).join(" ") || norm(li.textContent);
  });

  // theatre cards -> verbatim development blocks
  const pText = (p) => { const c = p.cloneNode(true); c.querySelectorAll(".src-group").forEach(s => s.remove()); return norm(c.textContent); };
  const theatres = {};
  doc.querySelectorAll("article.theatre-card").forEach(card => {
    const nameEl = card.querySelector(".th-name") || card.querySelector("h3");
    const id = nameEl ? theatreId(nameEl.textContent) : null;
    if (!id) return;
    const sub = norm((card.querySelector(".th-sub") || {}).textContent || "");
    const pills = [...card.querySelectorAll(".pill")].map(p => norm(p.textContent));
    const links = [...card.querySelectorAll("a.src-pill, .src-group a")].map(a => ({ label: norm(a.textContent) || a.href, url: a.href }));
    const uniqLinks = []; const seen = new Set();
    links.forEach(l => { if (l.url && !seen.has(l.url)) { seen.add(l.url); uniqLinks.push(l); } });

    const developments = [];
    // Headlines are .font-semibold elements (a separate .mb-15 div in newer
    // editions, or a span inside the pill row in older ones) — not pills, not
    // inside an Implication block. Resolve each to its containing block (the
    // nearest ancestor holding the narrative <p>s).
    const headlineNodes = [...card.querySelectorAll(".font-semibold")]
      .filter(n => !n.classList.contains("pill") && !n.closest(".pl-4"));
    headlineNodes.forEach(h => {
      let b = h.parentElement;
      while (b && b !== card && !b.querySelector(":scope > p")) b = b.parentElement;
      if (!b || b === card) b = h.parentElement;
      if (developments.find(d => d._block === b)) return;   // one dev per block
      developments.push({
        _block: b,
        pills: [...b.querySelectorAll(".pill")].map(p => norm(p.textContent)),
        headline: norm(h.textContent),
        paragraphs: [...b.querySelectorAll(":scope > p")].map(pText).filter(Boolean),
        sources: [...b.querySelectorAll("a[href^='http']")].map(a => ({ label: norm(a.textContent) || a.href, url: a.href })),
        implicationLabel: "", implicationBullets: []
      });
    });
    // Attach each "Implication [...]" block to the most recent preceding development
    [...card.querySelectorAll(".pl-4")].forEach(node => {
      const fm = node.querySelector(".font-mono");
      if (!fm || !/^implication/i.test(norm(fm.textContent))) return;
      let target = null;
      developments.forEach(d => { if (d._block.compareDocumentPosition(node) & 4) target = d; }); // 4 = FOLLOWING
      (target = target || developments[developments.length - 1]);
      if (!target) return;
      target.implicationLabel = norm([...fm.childNodes].map(n => n.textContent).join(" "));
      // bullets from <li>, else <p>, else the block's remaining text (older editions)
      let bullets = [...node.querySelectorAll("li")].map(li => norm(li.textContent)).filter(Boolean);
      if (!bullets.length) {
        bullets = [...node.querySelectorAll("p")].map(p => norm(p.textContent)).filter(Boolean);
        if (!bullets.length) { const c = node.cloneNode(true); const f = c.querySelector(".font-mono"); if (f) f.remove(); const rest = norm(c.textContent); if (rest) bullets = [rest]; }
      }
      target.implicationBullets = bullets;
    });
    developments.forEach(d => delete d._block);
    const headlines = developments.map(d => d.headline);
    const implications = developments.flatMap(d => d.implicationBullets);
    const pillDomain = pills.map(mapDomain).find(Boolean) || "Fires & Strikes";
    const st = status[id] || { phase: "—", trend: "Stable", progress: sub };
    const trend = normTrend(st.trend);
    const domainAnalysis = {};
    DOMAINS.forEach(d => (domainAnalysis[d] = "Not detailed in this edition."));
    pills.map(mapDomain).filter(Boolean).forEach((d, i) => { domainAnalysis[d] = implications[i] || headlines[0] || sub || domainAnalysis[d]; });

    theatres[id] = {
      phase: st.phase || "—", trend, progressToDate: st.progress || sub,
      conflictStatusScore: statusScore(st.phase, trend), statusLabel: statusLabel(st.phase, trend),
      bluf: sub || headlines[0] || "", keyDevelopments: headlines.length ? headlines : implications.slice(0, 3),
      developments, domainAnalysis,
      selectedDevelopmentPill: { domain: pillDomain, headline: headlines[0] || sub || "See edition", rationale: implications[0] || sub || "From the weekly brief." },
      watchAreas: watch[id] || "See the brief for this theatre's watch items.",
      sourceLinks: uniqLinks.slice(0, 4),
      tags: [...new Set(pills.map(p => p.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "")))].filter(Boolean).slice(0, 6)
    };
  });
  // theatres only in the status table (no card)
  Object.keys(status).forEach(id => {
    if (theatres[id]) return;
    const st = status[id], trend = normTrend(st.trend);
    const da = {}; DOMAINS.forEach(d => (da[d] = "Not detailed in this edition."));
    theatres[id] = { phase: st.phase, trend, progressToDate: st.progress, conflictStatusScore: statusScore(st.phase, trend),
      statusLabel: statusLabel(st.phase, trend), bluf: st.progress, keyDevelopments: [st.progress], developments: [], domainAnalysis: da,
      selectedDevelopmentPill: { domain: "Command & Control", headline: st.progress.slice(0, 80), rationale: st.progress },
      watchAreas: watch[id] || "See the brief.", sourceLinks: [], tags: [] };
  });

  if (!bluf || Object.keys(theatres).length < 4) throw new Error(`Unparseable edition at ${pageUrl}`);
  return {
    __live: true, weekId: "BRIEF-" + (range.end || range.start || Math.random().toString(36).slice(2)),
    rangeLabel: range.label, weekStart: range.start, weekEnd: range.end, sourceUrl: pageUrl, bluf, theatres
  };
}

(async () => {
  const rootHtml = await fetchText(SOURCE);
  const rootDoc = new JSDOM(rootHtml).window.document;

  // discover archived editions: anchors to relative .html whose text is a date range
  const archive = [];
  rootDoc.querySelectorAll("a[href]").forEach(a => {
    const href = a.getAttribute("href") || "";
    if (!/\.html$/i.test(href) || /^https?:/i.test(href)) return;
    const text = norm(a.textContent);
    if (!parseRange(text)) return;
    const url = new URL(href, SOURCE).href;
    if (!archive.find(x => x.url === url)) archive.push({ url, hint: text });
  });

  const editions = [];
  const push = (ed) => { if (ed && !editions.find(e => e.weekId === ed.weekId)) editions.push(ed); };

  // current edition (root)
  try { push(parseEdition(rootHtml, SOURCE)); }
  catch (e) { console.error("  ! root edition:", e.message); }

  // archived editions
  for (const a of archive) {
    try { push(parseEdition(await fetchText(a.url), a.url, a.hint)); }
    catch (e) { console.error("  ! archive " + a.url + ":", e.message); }
  }

  if (!editions.length) throw new Error("No valid editions parsed; not overwriting weekly-live.json.");

  // newest first
  editions.sort((x, y) => String(y.weekEnd || "").localeCompare(String(x.weekEnd || "")));

  // ---- derive capability evidence from the editions (traceable provenance) ----
  // Theatre-scoped, confidence-graded matcher — see scripts/lib/capability-evidence.js.
  let capabilityEvidence = {};
  try {
    const seed = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "sample-data.json"), "utf8"));
    capabilityEvidence = deriveCapabilityEvidence(editions, seed.capabilities);
  } catch (e) { console.error("  ! capability evidence extraction skipped:", e.message); capabilityEvidence = {}; }
  const evCount = Object.values(capabilityEvidence).reduce((s, a) => s + a.length, 0);

  fs.writeFileSync(OUT, JSON.stringify({
    __live: true, syncedAt: new Date().toISOString(), sourceUrl: SOURCE, editions, capabilityEvidence
  }, null, 2) + "\n");
  console.log(`✓ weekly-live.json written: ${editions.length} edition(s) — ${editions.map(e => e.rangeLabel).join(" | ")}.`);
  console.log(`  capability evidence: ${evCount} item(s) across ${Object.keys(capabilityEvidence).length} capabilities.`);
})().catch(e => { console.error("✗ sync-weekly failed:", e.message); process.exit(1); });
