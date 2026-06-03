#!/usr/bin/env node
/* =========================================================================
 * sync-weekly.js — fetch the live Conflict Studies & Insights weekly brief
 * (https://conflictstudiesandinsights.pages.dev) and convert it into the
 * dashboard's weekly-report schema, written to weekly-live.json.
 *
 * The dashboard's Weekly tab loads weekly-live.json (if present & valid) as
 * the default "● LIVE" edition, falling back to the seed data otherwise.
 *
 * Run by .github/workflows/sync-weekly.yml on a schedule. Parsing is
 * defensive: if the brief's structure can't be parsed into >=4 theatres with
 * a BLUF, the script exits non-zero WITHOUT overwriting the existing file, so
 * a structure change never publishes a broken edition.
 * ========================================================================= */
"use strict";
const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

const SOURCE = "https://conflictstudiesandinsights.pages.dev";
const OUT = path.resolve(__dirname, "..", "weekly-live.json");

// Map the brief's theatre names to the dashboard's theatre ids
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

// Brief trend vocabulary -> dashboard trend keys
function normTrend(t) {
  const s = norm(t).toLowerCase().replace(/[^a-z]/g, "");
  if (s.includes("escalat")) return "Escalating";
  if (s.includes("deteriorat")) return "Deteriorating";
  if (s.includes("unstable") || s.includes("volatile")) return "Volatile";
  if (s.includes("improv")) return "Improving";
  if (s.includes("deescalat")) return "De-escalating";
  return "Stable"; // "Holding" etc.
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

function parseRange(title) {
  // e.g. "Weekly Brief — 25 May – 4 June 2026"
  const m = norm(title).match(/(\d{1,2})\s+([A-Za-z]+)\s*[–-]\s*(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})/);
  if (!m) return null;
  const [, d1, mo1, d2, mo2, yr] = m;
  const year = +yr;
  const toISO = (d, mo) => {
    const mi = MONTHS[mo.slice(0, 3).toLowerCase()];
    if (mi == null) return null;
    return new Date(Date.UTC(year, mi, +d)).toISOString().slice(0, 10);
  };
  return { start: toISO(d1, mo1), end: toISO(d2, mo2), label: norm(`${d1} ${mo1} – ${d2} ${mo2} ${yr}`) };
}

(async () => {
  const res = await fetch(SOURCE, { headers: { "user-agent": "conflict-dashboard-sync" } });
  if (!res.ok) throw new Error("Fetch failed: HTTP " + res.status);
  const html = await res.text();
  const doc = new JSDOM(html).window.document;
  const h2s = [...doc.querySelectorAll("h2")];

  // --- date range ---
  const range = parseRange(doc.querySelector("title") ? doc.querySelector("title").textContent : "")
    || { start: null, end: null, label: "Live edition" };

  // --- overall BLUF ---
  const blufH = h2s.find(h => /bluf/i.test(h.textContent));
  const blufP = blufH && blufH.closest("section") ? blufH.closest("section").querySelector("p") : null;
  const bluf = norm(blufP ? blufP.textContent : "");

  // --- status table -> per-theatre phase / trend / progress ---
  const table = doc.querySelector("table");
  const status = {};
  if (table) {
    table.querySelectorAll("tbody tr").forEach(tr => {
      const tds = tr.querySelectorAll("td");
      if (tds.length < 4) return;
      const id = theatreId(tds[0].textContent);
      if (!id) return;
      status[id] = {
        phase: norm(tds[1].textContent),
        trend: norm(tds[2].textContent).replace(/[↑↓→↗↘↔]/g, ""),
        progress: norm(tds[3].textContent)
      };
    });
  }

  // --- watch areas per theatre ---
  const watchH = h2s.find(h => /watch areas/i.test(h.textContent));
  const watch = {};
  if (watchH && watchH.closest("section")) {
    watchH.closest("section").querySelectorAll("li").forEach(li => {
      const head = li.querySelector("div");
      const id = head ? theatreId(head.textContent) : null;
      if (!id) return;
      const parts = [...li.querySelectorAll("div")].map(d => norm(d.textContent));
      watch[id] = parts.slice(1).join(" ") || norm(li.textContent);
    });
  }

  // --- theatre cards -> developments, pills, implications, sources ---
  const theatres = {};
  doc.querySelectorAll("article.theatre-card").forEach(card => {
    const nameEl = card.querySelector(".th-name") || card.querySelector("h3");
    const id = nameEl ? theatreId(nameEl.textContent) : null;
    if (!id) return;
    const sub = norm((card.querySelector(".th-sub") || {}).textContent || "");
    const pills = [...card.querySelectorAll(".pill")].map(p => norm(p.textContent));
    const links = [...card.querySelectorAll("a.src-pill, .src-group a")]
      .map(a => ({ label: norm(a.textContent) || new URL(a.href).hostname, url: a.href }));
    const uniqLinks = []; const seen = new Set();
    links.forEach(l => { if (l.url && !seen.has(l.url)) { seen.add(l.url); uniqLinks.push(l); } });

    // Verbatim development blocks, in the brief's order: each headline's block
    // carries its domain pills + narrative paragraphs; each "Implication [...]"
    // block attaches to the most recent development.
    const pText = (p) => { const c = p.cloneNode(true); c.querySelectorAll(".src-group").forEach(s => s.remove()); return norm(c.textContent); };
    const developments = [];
    let cur = null;
    card.querySelectorAll(".font-semibold.mb-15, .pl-4").forEach(node => {
      if (node.classList.contains("font-semibold")) {
        const block = node.parentElement;
        developments.push(cur = {
          pills: [...block.querySelectorAll(".pill")].map(p => norm(p.textContent)),
          headline: norm(node.textContent),
          paragraphs: [...block.querySelectorAll(":scope > p, p")].map(pText).filter(Boolean),
          implicationLabel: "",
          implicationBullets: []
        });
      } else {
        const fm = node.querySelector(".font-mono");
        if (!fm || !/^implication/i.test(norm(fm.textContent)) || !cur) return;
        cur.implicationLabel = norm(fm.textContent);
        cur.implicationBullets = [...node.querySelectorAll("li")].map(li => norm(li.textContent)).filter(Boolean);
      }
    });
    const headlines = developments.map(d => d.headline);
    const implications = developments.flatMap(d => d.implicationBullets);

    const pillDomain = pills.map(mapDomain).find(Boolean) || "Fires & Strikes";
    const st = status[id] || { phase: "—", trend: "Stable", progress: sub };
    const trend = normTrend(st.trend);

    const domainAnalysis = {};
    DOMAINS.forEach(d => (domainAnalysis[d] = "Not detailed in this edition."));
    pills.map(mapDomain).filter(Boolean).forEach((d, i) => {
      domainAnalysis[d] = implications[i] || headlines[0] || sub || domainAnalysis[d];
    });

    theatres[id] = {
      phase: st.phase || "—",
      trend,
      progressToDate: st.progress || sub,
      conflictStatusScore: statusScore(st.phase, trend),
      statusLabel: statusLabel(st.phase, trend),
      bluf: sub || headlines[0] || "",
      keyDevelopments: headlines.length ? headlines : implications.slice(0, 3),
      developments,                 // verbatim brief-style development blocks
      domainAnalysis,
      selectedDevelopmentPill: {
        domain: pillDomain,
        headline: headlines[0] || sub || "See edition",
        rationale: implications[0] || sub || "From the live weekly brief."
      },
      watchAreas: watch[id] || "See the live brief for this theatre's watch items.",
      sourceLinks: uniqLinks.slice(0, 4),
      tags: [...new Set(pills.map(p => p.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "")))].filter(Boolean).slice(0, 6)
    };
  });

  // Theatres present only in the status table (no dedicated card) still appear
  Object.keys(status).forEach(id => {
    if (theatres[id]) return;
    const st = status[id], trend = normTrend(st.trend);
    const da = {}; DOMAINS.forEach(d => (da[d] = "Not detailed in this edition."));
    theatres[id] = {
      phase: st.phase, trend, progressToDate: st.progress,
      conflictStatusScore: statusScore(st.phase, trend), statusLabel: statusLabel(st.phase, trend),
      bluf: st.progress, keyDevelopments: [st.progress], domainAnalysis: da,
      selectedDevelopmentPill: { domain: "Command & Control", headline: st.progress.slice(0, 80), rationale: st.progress },
      watchAreas: watch[id] || "See the live brief.", sourceLinks: [], tags: []
    };
  });

  // --- validate ---
  const count = Object.keys(theatres).length;
  if (!bluf || count < 4) {
    throw new Error(`Parse looks wrong (bluf=${bluf ? "yes" : "no"}, theatres=${count}); not overwriting weekly-live.json.`);
  }

  const out = {
    __live: true,
    weekId: "LIVE-" + (range.end || new Date().toISOString().slice(0, 10)),
    rangeLabel: range.label,
    weekStart: range.start,
    weekEnd: range.end,
    sourceUrl: SOURCE,
    syncedAt: new Date().toISOString(),
    bluf,
    theatres
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + "\n");
  console.log(`✓ weekly-live.json written: ${count} theatres, range "${range.label}".`);
})().catch(e => { console.error("✗ sync-weekly failed:", e.message); process.exit(1); });
