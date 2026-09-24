#!/usr/bin/env node
/* =========================================================================
 * smoke-test.js — headless smoke test for the Conflict Studies Dashboard.
 *
 * Loads the real app.js inside a jsdom DOM (with fetch + Chart.js stubbed),
 * then asserts that the data model, deterministic aggregation, both view
 * modes, the brief-aligned section structure, and the filters all work.
 *
 * Exit code 0 = all checks passed; non-zero = a check failed (so it can gate
 * a SessionStart hook / CI). No browser required.
 * ========================================================================= */
"use strict";
const fs = require("fs");
const path = require("path");

let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch (e) {
  console.error("✖ jsdom is not installed. Run `npm install` first (the SessionStart hook does this automatically).");
  process.exit(2);
}

const root = path.resolve(__dirname, "..");
const html  = fs.readFileSync(path.join(root, "conflict-dashboard.html"), "utf8");
const data  = fs.readFileSync(path.join(root, "sample-data.json"), "utf8");
const appjs = fs.readFileSync(path.join(root, "app.js"), "utf8");
const wlRaw = fs.readFileSync(path.join(root, "watchlist.json"), "utf8");
const worldRaw = fs.readFileSync(path.join(root, "assets", "world-110m.json"), "utf8");
// fetch router shared by both DOM boots: seed data, the watchlist register and the base map
const routeFetch = (liveResp, feedResp) => async (u) => {
  const s = String(u);
  if (s.includes("weekly-live")) return liveResp;
  if (s.includes("watchlist-live")) return feedResp || { ok: false, status: 404, json: async () => ({}) };
  if (s.includes("watchlist.json")) return { ok: true, status: 200, json: async () => JSON.parse(wlRaw) };
  if (s.includes("world-110m")) return { ok: true, status: 200, json: async () => JSON.parse(worldRaw) };
  return { ok: true, status: 200, json: async () => JSON.parse(data) };
};

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log("  ✓ " + name); }
  else { console.error("  ✗ " + name + (detail ? "  — " + detail : "")); failures++; }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log("Conflict Studies Dashboard — smoke test\n");

  // --- 0. Static validation ------------------------------------------------
  console.log("Static checks:");
  let db;
  try { db = JSON.parse(data); check("sample-data.json parses", true); }
  catch (e) { check("sample-data.json parses", false, e.message); process.exit(1); }
  check("8 weekly reports", db.weeklyReports.length === 8, "got " + db.weeklyReports.length);
  check("5 theatres", db.theatres.length === 5);
  check("7 divisions", db.divisions.length === 7);
  check("6 domains", db.definitions.domains.length === 6);
  check("domains use brief ampersand style",
    db.definitions.domains.includes("Fires & Strikes") && db.definitions.domains.includes("Command & Control"));
  const reqFields = ["phase","trend","progressToDate","conflictStatusScore","statusLabel","bluf",
    "keyDevelopments","domainAnalysis","selectedDevelopmentPill","watchAreas","sourceLinks","tags"];
  let fieldOk = true;
  db.weeklyReports.forEach(w => {
    if (Object.keys(w.theatres).length !== 5) fieldOk = false;
    Object.values(w.theatres).forEach(e => {
      reqFields.forEach(f => { if (e[f] === undefined) fieldOk = false; });
      db.definitions.domains.forEach(d => { if (!e.domainAnalysis[d]) fieldOk = false; });
      if (!db.definitions.domains.includes(e.selectedDevelopmentPill.domain)) fieldOk = false;
    });
  });
  check("every weekly entry has all required fields + 6 domains", fieldOk);

  // watchlist register contract
  let wl;
  try { wl = JSON.parse(wlRaw); check("watchlist.json parses", true); }
  catch (e) { check("watchlist.json parses", false, e.message); process.exit(1); }
  check("register defines criteria and level descriptions for every scaled dimension", ["escalation", "tempo", "adaptation", "sgExposure"].every(d => wl.definitions.dimensions[d].desc && wl.definitions.dimensions[d].scale.every(l => wl.definitions.dimensions[d].levels[l])));
  check("every item carries a current-status summary with 2+ article links", wl.items.every(i => i.status && i.status.summary.length > 80 && i.status.sources.length >= 2 && i.status.sources.every(s => /^https?:/.test(s.url))));
  check("watchlist meta carries review dates + cadence", !!(wl.meta && wl.meta.reviewDate && wl.meta.previousReviewDate && wl.meta.cadenceDays));
  check("register is reviewed daily (cadenceDays = 1)", wl.meta.cadenceDays === 1);
  check("watchlist defines 3 tiers / 4 states and no publication actions",
    Object.keys(wl.definitions.tiers).join(",") === "1,2,3" &&
    Object.keys(wl.definitions.states).sort().join(",") === "Active,Archive,Priority,Watch" &&
    !wl.definitions.actions && wl.items.every(i => !i.csi));
  check("no publication prompts (CSI Flash / awareness post / …) anywhere in the register",
    !/CSI Flash|Weekly awareness post|Monthly pattern review|Quarterly candidate|Dashboard only|\bCSI\b/.test(wlRaw));
  check("watchlist items span the three tiers", wl.items.length >= 3 && [1, 2, 3].every(n => wl.items.some(i => i.tier === n)), "got " + wl.items.length);
  check("prevState / dims.prev are the previous review's values (no self-referential history)", wl.items.every(i => i.history[i.history.length - 1].state === i.state));
  check("every item carries an open-source feed query + title terms", wl.items.every(i => i.feed && i.feed.query && Array.isArray(i.feed.terms) && i.feed.terms.length));
  check("dated indicators use ISO dates", wl.items.every(i => i.next.every(n => !n.due || /^\d{4}-\d{2}-\d{2}$/.test(n.due))));
  check("dimension values sit on the defined scales", wl.items.every(i => ["escalation", "tempo", "adaptation", "sgExposure"].every(d => wl.definitions.dimensions[d].scale.includes(i.dims[d].now) && wl.definitions.dimensions[d].scale.includes(i.dims[d].prev))));
  const DIMS = ["phase", "escalation", "tempo", "adaptation", "sgExposure"];
  const wlOk = wl.items.every(i => i.id && i.name && [1, 2, 3].includes(i.tier) && wl.definitions.states[i.state] && wl.definitions.states[i.prevState] &&
    i.geo && typeof i.geo.lat === "number" && typeof i.geo.lon === "number" && Array.isArray(i.geo.countries) &&
    DIMS.every(d => i.dims[d] && i.dims[d].now != null && i.dims[d].prev != null) &&
    Array.isArray(i.changes) && Array.isArray(i.next) && i.next.every(n => wl.definitions.indicatorTypes.includes(n.type) && n.text) &&
    i.ignore && typeof i.ignore.flag === "boolean" && Array.isArray(i.history) && i.history.length >= 1);
  check("every watchlist item has state, geo, 5 dims (now+prev), changes, typed indicators, ignore verdict, history", wlOk);
  check("Tier 1 = Russia-Ukraine / Israel-Palestine / US-Israel-Iran / Israel-Lebanon / Thailand-Cambodia",
    wl.items.filter(i => i.tier === 1).map(i => i.id).sort().join(",") === "IL_GZ,IL_LB,IL_US_IR,RU_UA,TH_KH");
  check("Tier 2 = US-Venezuela / South China Sea / Taiwan Strait / China-Japan",
    wl.items.filter(i => i.tier === 2).map(i => i.id).sort().join(",") === "CN_JP,SCS,TW,US_VE");
  check("Tier 3 = India-Pakistan / Myanmar / other Middle East spillover",
    wl.items.filter(i => i.tier === 3).map(i => i.id).sort().join(",") === "IN_PK,ME_SPILL,MM");
  check("no item is linked to a weekly-brief theatre", wl.items.every(i => !i.briefTheatre));
  const world = JSON.parse(worldRaw);
  check("base map asset: >150 countries with rings; watchlist country ids resolve",
    world.countries.length > 150 && wl.items.every(i => i.geo.countries.every(c => world.countries.some(w => w.id === c))));

  // --- 1. Boot the app in a DOM -------------------------------------------
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  global.window = window; global.document = window.document;
  // Seed-only fetch: weekly-live.json returns 404 so the main harness exercises
  // the seed/fallback path deterministically.
  window.fetch = routeFetch({ ok: false, status: 404, json: async () => ({}) });
  window.Chart = function () { return { destroy() {} }; };
  window.Chart.prototype = {};
  window.HTMLCanvasElement.prototype.getContext = () => ({});
  window.eval(appjs);
  await sleep(250);
  const doc = window.document;

  // --- 1b. Watchlist tab (attention tracker + map) is the landing view ----
  // Expectations are DERIVED from watchlist.json so the checks survive each
  // daily review of the register (only the structure is hard-coded).
  console.log("\nWatchlist (attention tracker + map):");
  const fmtD = s => new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const stOrder = s => wl.definitions.states[s].order;
  const changed = i => DIMS.filter(d => i.dims[d].prev !== i.dims[d].now);
  const moved = i => i.prevState !== i.state;
  const movedUp = i => moved(i) && stOrder(i.state) < stOrder(i.prevState);
  const scoreOf = i => ({ Priority: 40, Active: 25, Watch: 10, Archive: 0 }[i.state] || 0) +
    ({ Severe: 20, High: 15, Moderate: 8, Low: 2 }[i.dims.escalation.now] || 0) + changed(i).length * 5 + (movedUp(i) ? 10 : 0) +
    ({ High: 8, Moderate: 4, Low: 0 }[i.dims.sgExposure.now] || 0) + ({ 1: 6, 2: 3, 3: 0 }[i.tier] || 0);
  const ranked = wl.items.slice().sort((a, b) => (a.ignore.flag - b.ignore.flag) || (scoreOf(b) - scoreOf(a)) || (a.tier - b.tier) || a.name.localeCompare(b.name));
  const N = wl.items.length;
  const ignoredItems = wl.items.filter(i => i.ignore.flag);
  const quietItems = wl.items.filter(i => !i.ignore.flag && !changed(i).length && !moved(i));
  const movedItems = wl.items.filter(moved);
  const zoneCount = wl.items.reduce((a, i) => a + (i.geo.zones || []).length, 0);
  const allInd = wl.items.flatMap(i => i.next);
  const datedInd = allInd.filter(n => n.due).sort((a, b) => a.due.localeCompare(b.due));
  const stateNames = Object.keys(wl.definitions.states).sort((a, b) => stOrder(a) - stOrder(b));

  check("no boot error", doc.querySelector("#boot-error").style.display === "none");
  check("Watchlist is the first tab and the landing view",
    doc.querySelector(".tab-btn").dataset.horizon === "watchlist" && doc.querySelector("#view-watchlist").classList.contains("active") && doc.body.classList.contains("watchlist-view"));
  let wv = doc.querySelector("#view-watchlist .view-body");
  check("period selector disabled (register is review-dated)", doc.querySelector("#period-select").disabled && /Review as of/.test(doc.querySelector("#period-select").textContent));
  check(`header: review date (${fmtD(wl.meta.reviewDate)}), previous review, cadence and state counts`,
    wv.textContent.includes(`review as of ${fmtD(wl.meta.reviewDate)}`) && wv.textContent.includes(`Previous review ${fmtD(wl.meta.previousReviewDate)}`) && wv.querySelectorAll(".wl-sub .wl-state").length === stateNames.length);
  check("staleness flag is computed against today", (() => {
    const el = wv.querySelector(".wl-stale"); if (!el) return false;
    const days = Math.round((Date.now() - new Date(wl.meta.reviewDate).getTime()) / 86400000);
    return el.classList.contains(days > wl.meta.cadenceDays * 1.5 ? "overdue" : "fresh");
  })());
  check("tier + state filter chips and hide-ignorable toggle", wv.querySelectorAll(".wl-f-tier").length === 3 && wv.querySelectorAll(".wl-f-state").length === stateNames.length && !!wv.querySelector(".wl-f-ignored"));
  // the seven questions, in order
  const h2s = [...wv.querySelectorAll(".section-head h2")].map(h => h.textContent);
  check("answers the questions as ordered sections (no CSI-action section, no Q-number prefixes)",
    /^What deserves attention now\?/.test(h2s[0]) && /^Which theatres moved\?/.test(h2s[1]) && /^What materially changed\?/.test(h2s[2]) &&
    /^What might happen next\?/.test(h2s[3]) && /^What can be ignored for now\?/.test(h2s[4]) && h2s.length === 5 &&
    h2s.every(h => !/\bQ[1-7]\b/.test(h) && !/CSI/.test(h)), h2s.join(" | "));
  check("no CSI action chips, columns or prompts rendered on the Watchlist tab", !wv.querySelector(".wl-action") && !wv.querySelector(".wl-act-grid") &&
    ![...wv.querySelectorAll("#wl-register thead th")].some(th => /CSI/.test(th.textContent)) && !/CSI Flash|Weekly awareness post|Dashboard only/.test(wv.textContent));
  // Q1 attention ranking
  const rank = [...wv.querySelectorAll(".wl-rank .wl-rank-item")];
  const expTop = ranked.filter(i => !i.ignore.flag).slice(0, 5);
  check("Q1: top-5 attention list with explainable score chips", rank.length === Math.min(5, expTop.length) && rank.every(r => r.querySelector(".wl-score .tip-body") && /Attention score/.test(r.querySelector(".wl-score .tip-body").textContent)));
  check(`Q1: ranking follows the documented score formula (top = ${expTop[0].name})`,
    rank.map(r => r.querySelector(".wl-name").textContent).join("|") === expTop.map(i => i.name).join("|") && rank[0].querySelector(".wl-score").firstChild.textContent === String(scoreOf(expTop[0])),
    rank.map(r => r.querySelector(".wl-name").textContent).join(" > "));
  check("Q1: ignorable items never enter the top list", rank.every(r => !ignoredItems.some(i => r.querySelector(".wl-name").textContent === i.name)));
  // map
  const svg = wv.querySelector("svg.wl-svg");
  check("map: self-contained SVG rendered (no tiles / map library)", !!svg && svg.getAttribute("viewBox") === "0 0 1000 394");
  check("map: base-map country paths drawn (>150)", svg.querySelectorAll("path.wl-land").length > 150);
  check(`map: ${N} conflict markers, one per watchlist item`, svg.querySelectorAll(".wl-marker").length === N);
  check("map: involved countries shaded by state", svg.querySelectorAll("path.wl-land[data-wl-country]").length >= new Set(wl.items.flatMap(i => i.geo.countries)).size - 1);
  check(`map: ${zoneCount} maritime zones drawn as dashed circles`, svg.querySelectorAll(".wl-zone").length === zoneCount);
  check("map: marker size encodes tier (T1 > T2 > T3)", (() => {
    const r = id => parseFloat(svg.querySelector(`.wl-marker[data-wl="${id}"] .wl-dot`).getAttribute("r"));
    const t1 = wl.items.find(i => i.tier === 1), t2 = wl.items.find(i => i.tier === 2), t3 = wl.items.find(i => i.tier === 3);
    return r(t1.id) > r(t2.id) && r(t2.id) > r(t3.id);
  })());
  check("map: state move glyph only on markers that moved this review",
    movedItems.every(i => !!svg.querySelector(`.wl-marker[data-wl="${i.id}"] .wl-mv-${movedUp(i) ? "up" : "down"}`)) &&
    wl.items.filter(i => !moved(i)).every(i => !svg.querySelector(`.wl-marker[data-wl="${i.id}"] .wl-mv`)));
  check("map: legend + region focus buttons", wv.querySelectorAll(".wl-legend .wl-lg").length >= 6 && wv.querySelectorAll(".wl-region").length === 6);
  // Q2 movements + state board
  check(`Q2: moved-since-previous-review list matches the register (${movedItems.length} move${movedItems.length === 1 ? "" : "s"})`, (() => {
    const mv = [...wv.querySelectorAll(".wl-moves-card .wl-mv-item:not(.minor)")];
    return mv.length === movedItems.length && movedItems.every(i => mv.some(li => li.querySelector(".wl-name").textContent === i.name && li.textContent.includes(i.prevState) && li.textContent.includes(i.state)));
  })());
  check("Q2: earlier moves (last 4 weeks) come from history, not from prevState", (() => {
    const cutoff = new Date(wl.meta.reviewDate).getTime() - 28 * 86400000;
    const exp = wl.items.flatMap(i => i.history.slice(1).filter((h, k) => new Date(h.date).getTime() >= cutoff && i.history[k].state !== h.state && !(moved(i) && i.history[k].state === i.prevState && h.state === i.state)));
    const got = [...wv.querySelectorAll(".wl-moves-card .wl-mv-item.minor")].filter(li => !li.querySelector(".wl-move-brief"));
    return got.length === exp.length;
  })());
  const cols = [...wv.querySelectorAll(".wl-board .wl-col")];
  check("Q2: state board has the monitoring states in order", cols.length === stateNames.length && cols.map(c => c.querySelector(".wl-state").textContent.trim()).join(",") === stateNames.join(","));
  check("Q2: board counts match the register", cols.map(c => c.querySelectorAll(".wl-card-chip").length).join(",") === stateNames.map(s => wl.items.filter(i => i.state === s).length).join(","));
  // Q3/Q4 register
  const reg = wv.querySelector("#wl-register");
  check(`Q3/Q4: register has ${N} rows ordered by attention`, reg.querySelectorAll("tbody tr.wl-row").length === N && reg.querySelector("tbody tr.wl-row").textContent.includes(ranked[0].name));
  check("Q4: changed level columns highlighted with previous → now (esc. risk / tempo / adaptation)", wl.items.every(i => {
    const row = reg.querySelector(`tr[data-wl-row="${i.id}"]`);
    const cells = [...row.querySelectorAll("td.wl-dim.wl-chg")];
    const exp = ["escalation", "tempo", "adaptation"].filter(d => i.dims[d].prev !== i.dims[d].now);
    return cells.length === exp.length && exp.every((d, k) => cells[k] && cells[k].textContent.includes(i.dims[d].prev) && cells[k].textContent.includes(i.dims[d].now));
  }));
  check("register: SG exposure and Changed columns removed", ![...reg.querySelectorAll("thead th")].some(th => /SG exposure|Changed/i.test(th.textContent)));
  check("register: every row carries a plain-language current status with article links and the phase label", wl.items.every(i => {
    const row = reg.querySelector(`tr[data-wl-row="${i.id}"]`);
    return row.querySelector(".wl-status-sum").textContent.trim() === i.status.summary && row.querySelectorAll(".wl-status-links a[href^='http']").length === i.status.sources.length && row.querySelector(".wl-phase-line").textContent.includes(i.dims.phase.now);
  }));
  check("register: column headers and level values carry hover definitions", (() => {
    const ths = [...reg.querySelectorAll("thead th.wl-th-help")];
    const esc = ths.find(th => /Esc\. risk/.test(th.textContent));
    return ths.length >= 8 && ths.every(th => (th.getAttribute("title") || "").length > 30) && /Severe:/.test(esc.getAttribute("title")) &&
      [...reg.querySelectorAll("td.wl-dim")].every(td => /:/.test(td.getAttribute("title") || ""));
  })());
  check("register: no brief link tag on any row", reg.querySelectorAll("tr.wl-row .t-chip").length === 0);
  check("register: rows collapsed by default", reg.querySelectorAll("tr.wl-detail-row").length === 0);
  // expand a row → detail with changes / next / ignore verdict / reporting / history
  const probe = wl.items.find(i => i.next.some(n => n.due)) || wl.items[0];
  reg.querySelector(`[data-wl-toggle="${probe.id}"]`).click(); await sleep(40);
  wv = doc.querySelector("#view-watchlist .view-body");
  const det = wv.querySelector(`tr[data-wl-detail="${probe.id}"]`);
  check("expanded row shows what changed / what next / ignore verdict / reporting / history (no brief signal)", !!det &&
    /What materially changed/.test(det.textContent) && /What might happen next/.test(det.textContent) && !/What CSI should do/.test(det.textContent) &&
    /Ignore for now\?/.test(det.textContent) && !/\bQ[1-7]\b/.test(det.textContent) && !/Brief signal/.test(det.textContent) && !det.querySelector(".wl-brief") && /State history/.test(det.textContent));
  check("detail: every changed dimension spelled out (prev → now)", det.querySelectorAll(".wl-chg-line .wl-chg-pill").length === changed(probe).length && changed(probe).every(d => det.textContent.includes(probe.dims[d].prev)));
  check("detail: typed indicators with 'If seen →' consequences and rendered dates",
    det.querySelectorAll(".wl-ind").length === probe.next.length && det.querySelectorAll(".wl-ind .wl-ind-type").length === probe.next.length &&
    det.querySelectorAll(".wl-ind-if").length === probe.next.filter(n => n.ifSeen).length && probe.next.filter(n => n.due).every(n => det.textContent.includes(fmtD(n.due))));
  check("detail: without a live feed the reporting block explains the 6-hourly sync", /Latest open-source reporting/.test(det.textContent) && /No live feed loaded/.test(det.textContent));
  check("register: Coverage column present, empty without a feed", [...reg.querySelectorAll("thead th")].some(th => /Coverage/.test(th.textContent)) && reg.querySelectorAll("td.wl-feed-cell .wl-spark").length === 0);
  check("header: live-feed status shows 'not loaded' without a feed", /Live feed not loaded/.test(wv.querySelector(".wl-feedstat").textContent));
  check("detail: source links rendered when the item carries sources", (probe.sources || []).length
    ? det.querySelectorAll(".wl-src-list a[href^='http']").length === probe.sources.length
    : !det.querySelector(".wl-src-list"));
  // Q5 indicators table
  const ind = wv.querySelector("#wl-indicators");
  const indRows = [...ind.querySelectorAll("tbody tr:not(.wl-sep)")];
  check(`Q5: indicators table lists every item's indicators (${allInd.length}), dated first`, indRows.length === allInd.length && (!!ind.querySelector("tr.wl-sep") || datedInd.length === allInd.length));
  check("Q5: dated indicators are in date order with a due status", (() => {
    const all = [...ind.querySelectorAll("tbody tr")];
    const sep = all.findIndex(r => r.classList.contains("wl-sep"));
    const before = sep < 0 ? all : all.slice(0, sep);
    if (!datedInd.length) return before.length === 0;
    const dues = before.map(r => r.querySelector(".wl-due").textContent);
    return before.length === datedInd.length && before.every(r => r.querySelector(".wl-due-sub")) && dues[0].includes(fmtD(datedInd[0].due)) && dues[dues.length - 1].includes(fmtD(datedInd[datedInd.length - 1].due));
  })());
  check("Q5: indicator types are the seven named kinds", [...ind.querySelectorAll(".wl-ind-type")].every(s => wl.definitions.indicatorTypes.includes(s.textContent.trim())));
  // Q7 ignore
  const ig = [...wv.querySelectorAll(".wl-ig-list .wl-ig-item")];
  check(`Q7: ignore-for-now list = the ${ignoredItems.length} flagged items with reason tags + revisit trigger`,
    ig.length === ignoredItems.length && ig.every(li => li.querySelectorAll(".tag").length >= 1 && /Revisit trigger/.test(li.textContent)) && ignoredItems.every(i => ig.some(li => li.querySelector(".wl-name").textContent === i.name)));
  check("Q7: quiet-but-not-flagged items called out", quietItems.length
    ? (/Quiet this review/.test(wv.textContent) && quietItems.every(i => wv.querySelector(".wl-quiet").textContent.includes(i.name)))
    : !wv.querySelector(".wl-quiet"));
  check("method note explains the derivation + how to update watchlist.json", /Attention score/.test(wv.querySelector(".wl-method").textContent) && /watchlist\.json/.test(wv.querySelector(".wl-method").textContent));
  // interactions: marker click opens + selects the row; region focus zooms the map; filters narrow everything
  const pick = wl.items.find(i => i.id !== probe.id);
  wv.querySelector(`.wl-marker[data-wl="${pick.id}"]`).dispatchEvent(new window.Event("click", { bubbles: true })); await sleep(40);
  wv = doc.querySelector("#view-watchlist .view-body");
  check("map: clicking a marker selects + expands its register row", wv.querySelector(`tr[data-wl-row="${pick.id}"]`).classList.contains("selected") && !!wv.querySelector(`tr[data-wl-detail="${pick.id}"]`) && !!wv.querySelector(`.wl-marker[data-wl="${pick.id}"].selected .wl-ring`));
  wv.querySelector(`[data-wl-map="${pick.id}"]`).click(); await sleep(40);
  wv = doc.querySelector("#view-watchlist .view-body");
  check("'Show on map' focuses the item's region (viewBox narrows)", (() => {
    const vb = wv.querySelector("svg.wl-svg").getAttribute("viewBox").split(" ").map(Number);
    const pressed = [...wv.querySelectorAll(".wl-region")].find(b => b.getAttribute("aria-pressed") === "true");
    return pressed && pressed.dataset.region !== "world" && vb[2] < 600 && vb[2] > 100;
  })());
  wv.querySelector('.wl-region[data-region="world"]').click(); await sleep(40);
  wv = doc.querySelector("#view-watchlist .view-body");
  check("focus returns to the world view", wv.querySelector("svg.wl-svg").getAttribute("viewBox") === "0 0 1000 394");
  // pan / zoom: wheel zooms in place (no re-render), markers stay screen-sized, drag pans, reset restores the preset
  (() => {
    const svg = wv.querySelector("svg.wl-svg");
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 394 });
    const vb0 = svg.getAttribute("viewBox");
    svg.dispatchEvent(new window.WheelEvent("wheel", { deltaY: -300, clientX: 500, clientY: 197, bubbles: true, cancelable: true }));
    const vb1 = svg.getAttribute("viewBox").split(" ").map(Number);
    const scale1 = svg.querySelector(".wl-marker .wl-mk").getAttribute("transform");
    check("map: wheel zooms the viewBox in place around the cursor", vb1[2] < 1000 && vb1[2] > 100 && svg === wv.querySelector("svg.wl-svg") && vb0 !== svg.getAttribute("viewBox"));
    check("map: markers are counter-scaled so they keep their screen size", /scale\(0\.\d+\)/.test(scale1) && Math.abs(parseFloat(scale1.match(/scale\(([\d.]+)\)/)[1]) - vb1[2] / 1000) < 0.001);
    check("map: region chips unpressed while in a free view", [...wv.querySelectorAll(".wl-region")].every(b => b.getAttribute("aria-pressed") === "false"));
    svg.dispatchEvent(new window.MouseEvent("pointerdown", { button: 0, clientX: 400, clientY: 200, bubbles: true }));
    svg.dispatchEvent(new window.MouseEvent("pointermove", { clientX: 300, clientY: 150, bubbles: true }));
    svg.dispatchEvent(new window.MouseEvent("pointerup", { clientX: 300, clientY: 150, bubbles: true }));
    const vb2 = svg.getAttribute("viewBox").split(" ").map(Number);
    check("map: dragging pans the view (same zoom, shifted origin)", Math.abs(vb2[2] - vb1[2]) < 0.01 && vb2[0] > vb1[0] && vb2[1] > vb1[1]);
    wv.querySelector('.wl-zoom[data-zoom="reset"]').click();
  })();
  await sleep(40);
  wv = doc.querySelector("#view-watchlist .view-body");
  check("map: reset returns to the selected focus preset", wv.querySelector("svg.wl-svg").getAttribute("viewBox") === "0 0 1000 394" && wv.querySelector('.wl-region[data-region="world"]').getAttribute("aria-pressed") === "true");
  check("map: zoom buttons present (+ / − / reset)", wv.querySelectorAll(".wl-zoom").length === 3);
  const t1n = wl.items.filter(i => i.tier === 1).length;
  wv.querySelector('.wl-f-tier[data-tier="1"]').click(); await sleep(40);
  wv = doc.querySelector("#view-watchlist .view-body");
  check(`tier filter narrows map, register, indicators and board to Tier 1 (${t1n} items)`,
    wv.querySelectorAll(".wl-marker").length === t1n && wv.querySelectorAll("#wl-register tbody tr.wl-row").length === t1n && wv.querySelectorAll(".wl-board .wl-card-chip").length === t1n && wv.textContent.includes(`showing ${t1n}`));
  wv.querySelector("[data-wl-reset]").click(); await sleep(40);
  wv = doc.querySelector("#view-watchlist .view-body");
  wv.querySelector(".wl-f-ignored").click(); await sleep(40);
  wv = doc.querySelector("#view-watchlist .view-body");
  check(`'Hide ignorable' removes the ${ignoredItems.length} flagged items`, wv.querySelectorAll("#wl-register tbody tr.wl-row").length === N - ignoredItems.length && wv.querySelectorAll(".wl-marker").length === N - ignoredItems.length);
  wv.querySelector("[data-wl-reset]").click(); await sleep(40);
  check(`filters reset to all ${N}`, doc.querySelectorAll("#view-watchlist #wl-register tbody tr.wl-row").length === N);
  // exports (JSON/CSV) route to the watchlist register while the tab is active
  const dl = [];
  window.URL.createObjectURL = () => "blob:x"; window.URL.revokeObjectURL = () => {};
  window.HTMLAnchorElement.prototype.click = function () {};   // jsdom cannot navigate to blob: URLs
  const origBlob = window.Blob;
  window.Blob = function (parts, opts) { dl.push({ text: parts.join(""), type: opts && opts.type }); return { size: 1, type: opts && opts.type }; };
  doc.querySelector("#export-json").click(); doc.querySelector("#export-csv").click(); await sleep(20);
  window.Blob = origBlob;
  check("export JSON/CSV carry the watchlist (derived score / movement / feed columns)", dl.length === 2 && (() => {
    const j = JSON.parse(dl[0].text); const csvHead = dl[1].text.split("\n")[0];
    return j.view === "watchlist" && j.items.length === N && typeof j.items[0].attentionScore === "number" && "movement" in j.items[0] &&
      /attentionScore/.test(csvHead) && /stateMove/.test(csvHead) && !/csi/i.test(csvHead) && dl[1].text.split("\n").length === N + 1;
  })());
  // hand over to the Weekly tab for the brief-structure checks below
  doc.querySelector('.tab-btn[data-horizon="weekly"]').click(); await sleep(60);
  check("switching to Weekly restores the filter rail", !doc.body.classList.contains("watchlist-view") && doc.querySelector("#view-weekly").classList.contains("active"));

  // --- 2. Weekly view + brief-aligned structure ---------------------------
  console.log("\nWeekly view (brief structure):");
  const wb = doc.querySelector("#view-weekly .view-body");
  check("no boot error", doc.querySelector("#boot-error").style.display === "none");
  check("8 period options", doc.querySelectorAll("#period-select option").length === 8);
  check("BLUF label = 'BLUF — Bottom Line Up Front'", wb.textContent.includes("BLUF — Bottom Line Up Front"));
  check("'Conflict Status Chart' heading", wb.textContent.includes("Conflict Status Chart"));
  check("'Key Developments' heading", wb.textContent.includes("Key Developments"));
  check("'Watch Areas — Next 7 Days' heading", wb.textContent.includes("Watch Areas — Next 7 Days"));
  check("5 status-matrix rows", wb.querySelectorAll("#status-matrix tbody tr").length === 5);
  check("5 theatre cards", wb.querySelectorAll(".theatre-card").length === 5);
  check("Theatre 01–05 numbering", [...wb.querySelectorAll(".tc-title")].some(t => t.textContent.includes("Theatre 01")));
  // Weekly mirrors the brief: development blocks (pills → headline → narrative →
  // Implication), and NO six-domain breakdown.
  check("5 brief-style development blocks", wb.querySelectorAll(".brief-dev").length >= 5);
  check("development domain pills shown (brief style)", wb.querySelectorAll(".brief-pills .pill").length >= 5);
  check("Implication blocks shown (>=5)", wb.querySelectorAll(".brief-impl").length >= 5);
  check("no six-domain breakdown on Weekly tab", wb.querySelectorAll("details.domains").length === 0);
  check("no status score on Weekly tab", wb.querySelectorAll(".progress-mini").length === 0 && !wb.textContent.includes("Status score"));
  check("5 watch-area items", wb.querySelectorAll(".watch-item").length === 5);

  // --- 3a. Monthly: Tactical Learning view --------------------------------
  console.log("\nMonthly (tactical learning):");
  doc.querySelector('.tab-btn[data-horizon="monthly"]').click(); await sleep(50);
  let mb = doc.querySelector("#view-monthly .view-body");
  check("monthly tab hides the left filter rail (full-width promulgation)", doc.body.classList.contains("monthly-view"));
  check("2 monthly periods (8 weeks / 4)", doc.querySelectorAll("#monthly-period-select option").length === 2);
  check("monthly BLUF (tactical learning) present", /Monthly BLUF — Tactical Learning/.test(mb.textContent) && mb.querySelector(".bluf-card p").textContent.length > 50);
  check("formation-group selector has 5 options", doc.querySelectorAll("#formation-group-select option").length === 5);
  check("All Groups default shows 4 overview cards", mb.querySelectorAll(".fg-overview .fg-card").length === 4);
  check("overview cards are full-card buttons (accessible click target)",
    [...mb.querySelectorAll(".fg-overview .fg-card")].every(c => c.tagName === "BUTTON" && /^Open .+ tactical learnings/.test(c.getAttribute("aria-label") || "")));
  check("no theatre status matrix on Monthly tab", !mb.querySelector("#status-matrix"));
  // select a group -> tactical panel
  const fgSel = doc.querySelector("#formation-group-select");
  fgSel.value = "MANOEUVRE"; fgSel.dispatchEvent(new window.Event("change")); await sleep(50);
  mb = doc.querySelector("#view-monthly .view-body");
  check("group panel: audience banner shown", /Audience —/.test((mb.querySelector(".fg-audience-banner") || {}).textContent || ""));
  check("group panel: echelon filter (4 chips)", mb.querySelectorAll(".ech-filter .ech-chip").length === 4);
  check("group panel: tactical insight cards", mb.querySelectorAll(".tac-card").length >= 1);
  check("cards reproduce the report as labelled sections (no forced fixed lanes)",
    [...mb.querySelectorAll(".tac-card")].every(c => c.querySelectorAll(".tac-sections .tac-sec .tac-sec-h").length >= 2) &&
    mb.querySelectorAll(".tac-card .tac-fields").length === 0 && mb.querySelectorAll(".tac-card .tac-lanes").length === 0);
  check("section flow varies by report (some cards carry an Insights / To Consider section)",
    [...mb.querySelectorAll(".tac-card")].some(c => /Insights/.test(c.textContent)) &&
    [...mb.querySelectorAll(".tac-card")].some(c => /To Consider/.test(c.textContent)));
  check("cards show echelon badges", mb.querySelectorAll(".tac-card .ech-badge").length >= 1);
  check("observation carries cited articles readers can open", mb.querySelectorAll(".tac-sections a[href^='http']").length >= 1);
  check("sections carry their own inline citations", mb.querySelectorAll(".tac-sec .tac-sec-cites a[href^='http']").length >= 1);
  check("card header shows a confidence chip", mb.querySelectorAll(".tac-card .tac-conf").length >= 1);
  check("no fixed 4-step scaffolding remains on these cards", mb.querySelectorAll(".tac-card .tac-evidence, .tac-card .lane-sop").length === 0);
  check("monthly BLUF still visible inside a group", /Monthly BLUF — Tactical Learning/.test(mb.textContent));
  // echelon sub-filter narrows the cards
  const allCards = mb.querySelectorAll(".tac-card").length;
  const compChip = [...mb.querySelectorAll(".ech-chip")].find(b => b.dataset.ech === "Company");
  compChip.click(); await sleep(50);
  mb = doc.querySelector("#view-monthly .view-body");
  const compCards = [...mb.querySelectorAll(".tac-card .ech-badge")];
  check("echelon filter narrows to selected echelon", compCards.length > 0 && compCards.length <= allCards && compCards.every(b => /Company/i.test(b.textContent)));
  // back to All Groups via data-group button
  mb.querySelector('[data-group="ALL"]').click(); await sleep(50);
  check("can switch back to All Groups", doc.querySelector("#view-monthly .view-body").querySelectorAll(".fg-overview .fg-card").length === 4);
  // leaving Monthly restores the filter rail for Weekly / Capabilities
  doc.querySelector('.tab-btn[data-horizon="weekly"]').click(); await sleep(40);
  check("filter rail restored on Weekly tab (monthly-view cleared)", !doc.body.classList.contains("monthly-view"));
  doc.querySelector('.tab-btn[data-horizon="monthly"]').click(); await sleep(40);

  // --- 4. Top control bar: removed mode switch / quarterly / division dd ---
  console.log("\nTop control bar (trimmed):");
  check("horizon tabs are Watchlist / Weekly / Monthly / Capabilities only", [...doc.querySelectorAll(".tab-btn")].map(b => b.dataset.horizon).join(",") === "watchlist,weekly,monthly,capabilities");
  check("no Quarterly tab", !doc.querySelector('.tab-btn[data-horizon="quarterly"]') && !doc.querySelector("#view-quarterly"));
  check("no Theatre/Division mode switch", !doc.querySelector("[data-mode]"));
  check("no top division dropdown", !doc.querySelector("#division-select") && !doc.querySelector("#division-wrap"));

  // weekly-briefs quick access sits beside the horizon tabs
  check("Weekly Briefs quick-access button present beside the tabs",
    !!doc.querySelector(".control-bar .briefs-access #briefs-toggle") &&
    doc.querySelector(".seg").nextElementSibling.classList.contains("briefs-access"));
  check("briefs menu is closed until opened", doc.querySelector("#briefs-menu").hidden === true);
  doc.querySelector("#briefs-toggle").click(); await sleep(20);
  check("clicking Weekly Briefs opens a menu with items", doc.querySelector("#briefs-menu").hidden === false && doc.querySelectorAll("#briefs-menu .briefs-item").length >= 2);
  check("briefs menu links to the brief site + offers in-app Weekly tab",
    !!doc.querySelector("#briefs-menu .briefs-site[href^='http']") && !!doc.querySelector("#briefs-menu [data-open-weekly]"));
  // in-app item jumps to the Weekly view
  doc.querySelector("#briefs-menu [data-open-weekly]").click(); await sleep(30);
  check("in-app briefs item switches to the Weekly tab", doc.querySelector("#view-weekly").classList.contains("active"));

  // --- 5. Filters ----------------------------------------------------------
  console.log("\nFilters:");
  doc.querySelector('.tab-btn[data-horizon="weekly"]').click(); await sleep(40);
  doc.querySelector("#search").value = "enrichment";
  doc.querySelector("#search").dispatchEvent(new window.Event("input")); await sleep(40);
  check("search narrows the matrix",
    doc.querySelector("#view-weekly .view-body").querySelectorAll("#status-matrix tbody tr").length < 5);
  doc.querySelector("#search").value = "";
  doc.querySelector("#search").dispatchEvent(new window.Event("input")); await sleep(40);

  // --- 6. Capabilities & Countermeasures view ------------------------------
  console.log("\nCapabilities & Countermeasures:");
  check("capabilities seed present", Array.isArray(db.capabilities) && db.capabilities.length >= 20);
  check("capability lifecycle defs present", !!db.capabilityDefs && !!db.capabilityDefs.lifecycle);
  // every cross-reference resolves
  const capIds = new Set(db.capabilities.map(c => c.id));
  let refOk = true;
  db.capabilities.forEach(c => [...(c.counters||[]), ...(c.counteredBy||[]), ...(c.supersedes||[]), ...(c.supersededBy||[])]
    .forEach(r => { if (!capIds.has(r)) refOk = false; }));
  check("all capability references resolve", refOk);

  doc.querySelector('.tab-btn[data-horizon="capabilities"]').click(); await sleep(60);
  const cb = doc.querySelector("#view-capabilities .view-body");
  check("capabilities view is active", doc.querySelector("#view-capabilities").classList.contains("active"));
  check("capabilities tab hides the left filter rail (full-width)", doc.body.classList.contains("capabilities-view") && !doc.body.classList.contains("monthly-view"));
  check("capability BLUF rendered", cb.textContent.includes("BLUF — Capability Picture"));
  check("BLUF shows operational picture (stressed / bypass / uncountered)",
    /Most stressed counters/.test(cb.textContent) && /Key bypasses/.test(cb.textContent) && /Uncountered \/ weakly countered/.test(cb.textContent));
  check("BLUF claims carry layer provenance tags (brief-derived + research-judged)",
    cb.querySelectorAll(".bluf-card .pt-brief").length >= 1 && cb.querySelectorAll(".bluf-card .pt-research").length >= 1);
  check("BLUF separates reporting picture (Layer 1) from capdev assessment (Layer 2)",
    cb.querySelectorAll(".bluf-card .bluf-layer-h").length >= 2 &&
    /Current reporting picture/.test(cb.textContent) && /Broader capdev assessment/.test(cb.textContent));
  check("research-judged is a distinct source type (Layer 2)", cb.querySelectorAll(".src-badge.src-research").length >= 1);
  check("summary cards rendered (6, explainable)", cb.querySelectorAll(".kpi").length === 6 && [...cb.querySelectorAll(".kpi")].every(k => !!k.querySelector(".tip-body, .th-info")));
  check("contest is the analytic unit (Tracked contests card)", /Tracked contests/.test(cb.textContent));
  check("heat methodology explained (inputs/method/fallback in tooltip)", /Recency-weighted/.test(cb.textContent) && /normalised 0–100/.test(cb.textContent) && /Fallback:/.test(cb.textContent));
  check("metric tooltips on Heat / Lifecycle / Trend headers", cb.querySelectorAll(".matrix thead .th-info .tip-body").length >= 3);
  check("lifecycle chips define phases on hover/tap", [...cb.querySelectorAll(".matrix tbody .lc-chip .tip-body")].some(t => /Newly observed|Dominant and widely employed/.test(t.textContent)));
  // Two distinct tables: primary contest table + secondary inventory table
  const h2list = [...cb.querySelectorAll(".section-head h2")].map(h => h.textContent);
  check("primary table is Capability Contests, secondary is Capability Inventory",
    h2list.includes("Capability Contests") && h2list.includes("Capability Inventory") &&
    h2list.indexOf("Capability Contests") < h2list.indexOf("Capability Inventory"));
  check("contest table populated and contest-based (measure vs counter)",
    cb.querySelectorAll(".matrix tbody tr").length >= 5 && cb.querySelectorAll(".matrix tbody .vs").length >= 1);
  check("contest table columns (Threatened fn / Judgment / Research confidence / SAF action / Formation / Research basis)",
    ["Threatened function", "Judgment", "Research confidence", "SAF action", "Formation", "Research basis"].every(h => [...cb.querySelectorAll(".matrix thead th")].some(th => th.textContent.includes(h))));
  check("inventory holds only standalone (non-contest) capabilities",
    [...cb.querySelectorAll(".matrix thead th")].some(th => /Capability$/.test(th.textContent.trim())));
  check("Supporting-briefs column + source-type badges present",
    [...cb.querySelectorAll(".matrix thead th")].some(th => /Supporting briefs/.test(th.textContent)) &&
    cb.querySelectorAll(".matrix tbody .src-badge").length >= 1 && cb.querySelectorAll(".matrix tbody .saf-act").length >= 5);
  check("contest cards are the heart (measure ⇄ counter)", cb.querySelectorAll(".contest-card").length > 0);
  check("each contest card exposes the full chain", [...cb.querySelectorAll(".contest-card")].every(c =>
    /Threatened function/.test(c.textContent) && /Countermeasure/.test(c.textContent) && /Observed effect/.test(c.textContent) &&
    /Adaptation \/ bypass/.test(c.textContent) && /Operational judgment/.test(c.textContent) && /SAF learning/.test(c.textContent) &&
    c.querySelector(".src-badge") && c.querySelector(".judg")));
  check("cards split into two evidence layers (reporting vs capdev)", [...cb.querySelectorAll(".contest-card")].every(c =>
    c.querySelector(".cc-layer-1") && c.querySelector(".cc-layer-2") &&
    /Current reporting picture/.test(c.textContent) && /Broader capability-development assessment/.test(c.textContent)));
  check("Layer-1 zone is brief-derived, Layer-2 zone is research-judged", [...cb.querySelectorAll(".contest-card")].every(c =>
    c.querySelector(".cc-layer-1 .src-brief") && c.querySelector(".cc-layer-2 .src-research, .cc-layer-2 .src-analyst")));
  check("Layer-2 judgments carry a research source-packet drawer + research confidence",
    cb.querySelectorAll(".contest-card .cc-layer-2 .ev-research").length >= 1 &&
    [...cb.querySelectorAll(".contest-card")].some(c => /Research confidence/.test(c.textContent)));
  check("cards carry evidence lineage (first/last seen, theatres, supporting weeks, basis)",
    [...cb.querySelectorAll(".contest-card")].every(c =>
      /First seen/.test(c.textContent) && /Last seen/.test(c.textContent) && /Supporting weeks/.test(c.textContent) &&
      c.querySelector(".cc-lineage") && c.querySelector(".cc-basis")));
  check("cards carry an evidence-discipline flag", [...cb.querySelectorAll(".contest-card")].every(c => c.querySelector(".disc")));
  check("cards carry rule-based confidence (n/8 score)", [...cb.querySelectorAll(".contest-card")].every(c => /\(\d\/8\)/.test(c.textContent)));
  check("SAF learning is structured (Emulate / Trial / Review / Do not assume)",
    [...cb.querySelectorAll(".contest-card .saf-grid")].length >= 1 &&
    [...cb.querySelectorAll(".contest-card")].some(c => /Emulate/.test(c.textContent) && /Do not assume/.test(c.textContent)));
  check("cards carry formation-relevance tags", [...cb.querySelectorAll(".contest-card")].some(c => c.querySelector(".form-chip")));
  check("an uncountered contest is shown honestly (no invented counter)",
    [...cb.querySelectorAll(".contest-card")].some(c => /not yet evidenced|Currently uncountered|uncountered/i.test(c.textContent)));
  check("supersession graded (fully / partial / niche)", cb.querySelectorAll(".sup-row .sup-grade").length > 0);
  check("cross-theatre proliferation: every shown row has why/limits/SAF relevance",
    cb.querySelectorAll(".cmp-table tbody tr").length > 0 &&
    [...cb.querySelectorAll(".cmp-table tbody tr")].every(tr => [...tr.querySelectorAll("td")].slice(2).every(td => td.textContent.trim() && td.textContent.trim() !== "—")));
  check("3 brief-defensible charts rendered (tempo & doughnuts removed)", cb.querySelectorAll("canvas").length === 3);
  check("'what's hot across theatres' chart present", !!cb.querySelector("#cap-theatre-heat"));
  check("observation-activity chart present (replaces time-to-counter)", !!cb.querySelector("#cap-activity"));
  check("removed un-sourced charts (heat doughnut / lifecycle / vector / tempo)",
    !cb.querySelector("#cap-heat") && !cb.querySelector("#cap-lifecycle") && !cb.querySelector("#cap-vector") && !cb.querySelector("#cap-tempo"));
  check("per-theatre hottest-capability captions (5)", cb.querySelectorAll(".theatre-leaders .tl").length === 5);
  // Cycles (cards) must appear before the primary contest table
  check("Measure⇄Countermeasure Cycles precede the contest table",
    h2list.indexOf("Measure ⇄ Countermeasure Cycles") !== -1 &&
    h2list.indexOf("Measure ⇄ Countermeasure Cycles") < h2list.indexOf("Capability Contests"),
    h2list.join(" | "));
  check("period selector disabled in capabilities view", doc.querySelector("#period-select").disabled === true);

  // lifecycle filter narrows the leaderboard
  const beforeRows = cb.querySelectorAll(".matrix tbody tr").length;
  const peakBtn = [...cb.querySelectorAll(".lc-filter")].find(b => b.dataset.lc === "Peak");
  peakBtn.click(); await sleep(50);
  const afterRows = doc.querySelector("#view-capabilities .view-body").querySelectorAll(".matrix tbody tr").length;
  check("lifecycle filter (Peak) narrows leaderboard", afterRows > 0 && afterRows < beforeRows, `before=${beforeRows} after=${afterRows}`);

  // reset lifecycle filter for the remaining checks
  peakBtn.click(); await sleep(50);

  // --- 6b. Computed capability heat & trend (from weekly observations) -----
  console.log("\nComputed capability dynamics:");
  check("weekly capability signals present", !!db.weeklyCapabilitySignals);
  let sigOk = true, sigCount = 0;
  Object.keys(db.weeklyCapabilitySignals).filter(k => k !== "_doc").forEach(wk => {
    db.weeklyCapabilitySignals[wk].forEach(s => { sigCount++; if (!capIds.has(s.id)) sigOk = false; });
  });
  check("all signal capIds resolve (" + sigCount + " signals)", sigOk);
  const capView = doc.querySelector("#view-capabilities .view-body");
  check("activity sparklines rendered (inventory)", capView.querySelectorAll("svg.sparkline").length >= 10);
  check("observation-source methodology note shown", /seed signal weeks|live brief edition/.test(capView.textContent));
  // Fibre-optic FPV (signals ramp up over time) should read as Rising
  const fiberRow = [...capView.querySelectorAll(".matrix tbody tr")].find(tr => tr.textContent.includes("Fibre-optic FPV"));
  check("rising capability shows Rising trend", fiberRow && fiberRow.textContent.includes("Rising"), fiberRow ? fiberRow.textContent.replace(/\s+/g, " ").slice(0, 80) : "row missing");
  // A fading capability (COTS quadcopter, only early signals) should read Declining
  const djiRow = [...capView.querySelectorAll(".matrix tbody tr")].find(tr => tr.textContent.includes("COTS quadcopter"));
  check("fading capability shows Declining trend", djiRow && djiRow.textContent.includes("Declining"), djiRow ? djiRow.textContent.replace(/\s+/g, " ").slice(0, 80) : "row missing");

  // theatre filter re-scopes the capabilities view (and its charts' data source)
  const gazaCb = doc.querySelector('#filter-theatres input[value="IL_GZ"]');
  gazaCb.checked = true; gazaCb.dispatchEvent(new window.Event("change", { bubbles: true })); await sleep(50);
  const scoped = doc.querySelector("#view-capabilities .view-body");
  // Theatres live in the inventory table's 5th column (the last .matrix table).
  const invTbl = [...scoped.querySelectorAll(".matrix")].pop();
  const gazaCells = [...invTbl.querySelectorAll("tbody tr td:nth-child(5)")];
  const allGaza = gazaCells.length > 0 && gazaCells.every(td => td.textContent.includes("ISR-GAZ"));
  check("theatre filter re-scopes capabilities to selected theatre", scoped.querySelectorAll(".matrix tbody tr").length > 0 && allGaza);
  check("charts still render after theatre filter", scoped.querySelectorAll("canvas").length === 3);
  gazaCb.checked = false; gazaCb.dispatchEvent(new window.Event("change", { bubbles: true })); await sleep(40);

  // --- 7. Live weekly edition (sync integration) --------------------------
  console.log("\nLive weekly edition:");
  // Fallback path: with no live edition, weekly shows seed only (no LIVE option/banner)
  doc.querySelector('.tab-btn[data-horizon="weekly"]').click(); await sleep(40);
  const wb2 = doc.querySelector("#view-weekly .view-body");
  check("fallback: no LIVE banner when weekly-live.json absent", !wb2.querySelector(".live-banner"));
  check("fallback: 8 seed weekly periods", doc.querySelectorAll("#period-select option").length === 8);

  // weekly-live.json on disk (if present) must satisfy the multi-edition contract
  const livePath = path.join(root, "weekly-live.json");
  if (fs.existsSync(livePath)) {
    const lw = JSON.parse(fs.readFileSync(livePath, "utf8"));
    const eds = Array.isArray(lw.editions) ? lw.editions : (lw.theatres ? [lw] : []);
    const okLive = lw.__live === true && eds.length >= 1 && eds.every(ed =>
      ed.weekStart && ed.weekEnd && ed.bluf && Object.keys(ed.theatres).length >= 4 &&
      Object.values(ed.theatres).every(e => e.phase && e.trend && e.selectedDevelopmentPill && Array.isArray(e.developments) && e.watchAreas));
    check("weekly-live.json matches multi-edition contract", okLive, `${eds.length} editions`);
    check("multiple editions present (past + current)", eds.length >= 2, `${eds.length} editions`);
    const hasDevs = eds.some(ed => Object.values(ed.theatres).some(e => e.developments.length && e.developments[0].headline && Array.isArray(e.developments[0].paragraphs)));
    check("editions carry verbatim development blocks", hasDevs);
    const ce = lw.capabilityEvidence || {};
    const ceOk = Object.keys(ce).length >= 1 && Object.values(ce).every(arr => arr.every(x => x.weekId && x.theatre && x.url && x.headline));
    check("capabilityEvidence present & traceable (capId → brief obs w/ links)", ceOk, `${Object.keys(ce).length} capabilities evidenced`);
    // tightened matcher: every row is confidence-graded and theatre-relevant
    const capById = {}; (JSON.parse(data).capabilities || []).forEach(c => (capById[c.id] = c));
    const confOk = Object.values(ce).every(arr => arr.every(x => ["high", "medium", "low"].includes(x.confidence) && ["headline", "pill", "body"].includes(x.where)));
    check("evidence rows are confidence-graded (high/medium/low + where)", confOk);
    const theatreOk = Object.entries(ce).every(([id, arr]) => arr.every(x => !capById[id] || !capById[id].theatres.length || capById[id].theatres.includes(x.theatre)));
    check("evidence is theatre-relevant (no cross-theatre keyword collisions)", theatreOk);
  } else {
    console.log("  (weekly-live.json not present — skipping contract check)");
  }

  // Injection path: synthetic editions (current + archived) drive the Weekly view
  const mkTheatres = (marker) => {
    const t = {};
    ["RU_UA", "IL_LB", "IL_GZ", "IL_US_IR", "TH_KH"].forEach(id => {
      const da = {}; ["Fires & Strikes", "Intelligence", "Manoeuvre", "Protection", "Sustainment", "Command & Control"].forEach(d => (da[d] = "x"));
      t[id] = { phase: "Active Combat", trend: "Escalating", progressToDate: "p", conflictStatusScore: 80,
        statusLabel: "Escalating", bluf: "b", keyDevelopments: ["k"], domainAnalysis: da,
        developments: [{ pills: ["Fires & Strikes", "Sustainment"], headline: marker + "-HEADLINE",
          paragraphs: [marker + "-NARR"], implicationLabel: "Implication [Fires & Strikes · Sustainment]", implicationBullets: [marker + "-IMPL"] }],
        selectedDevelopmentPill: { domain: "Fires & Strikes", headline: "h", rationale: "r" }, watchAreas: "w", sourceLinks: [], tags: [] };
    });
    return t;
  };
  const liveStub = {
    __live: true, syncedAt: new Date().toISOString(), sourceUrl: "https://example.org",
    editions: [
      { __live: true, weekId: "BRIEF-NEW", rangeLabel: "25 May – 4 June 2026", weekStart: "2026-05-25", weekEnd: "2026-06-04", sourceUrl: "https://example.org/new", bluf: "LATEST-BLUF", theatres: mkTheatres("LATEST") },
      { __live: true, weekId: "BRIEF-OLD", rangeLabel: "18 May – 25 May 2026", weekStart: "2026-05-18", weekEnd: "2026-05-25", sourceUrl: "https://example.org/old", bluf: "ARCHIVED-BLUF", theatres: mkTheatres("ARCHIVED") }
    ],
    capabilityEvidence: (() => {
      const row = (t, hl) => ({ weekId: "BRIEF-NEW", rangeLabel: "25 May – 4 June 2026", theatre: t, headline: hl, url: "https://example.org/evidence", source: "ISW" });
      return {
        cap_shahed: [row("RU_UA", "EVIDENCE-HEADLINE")],
        cap_fpv: [row("RU_UA", "FPV-EVIDENCE")],
        cap_fpv_fiber: [row("RU_UA", "FIBRE-EVIDENCE")],
        cap_ew_tac: [row("RU_UA", "EW-EVIDENCE")],
        cap_patriot: [row("RU_UA", "PATRIOT-EVIDENCE")],
        cap_iran_brm: [row("IL_US_IR", "IRAN-EVIDENCE")],
        cap_iron_dome: [row("IL_LB", "IRONDOME-EVIDENCE")]
      };
    })()
  };
  const dom2 = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  global.window = dom2.window; global.document = dom2.window.document;
  // Live open-source feed stub: a 30-day timeline with a surge on the first item, headlines on all
  const feedStub = (() => {
    const items = {};
    wl.items.forEach((i, k) => {
      const tl = []; for (let d = 29; d >= 0; d--) { const dt = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10); tl.push({ date: dt, value: k === 0 && d < 7 ? 40 : 5 }); }
      const vals = tl.map(p => p.value), c7 = vals.slice(-7).reduce((a, b) => a + b, 0), p7 = vals.slice(-14, -7).reduce((a, b) => a + b, 0);
      items[i.id] = { query: i.feed.query, granularity: "day", timeline: tl, count7d: c7, prev7d: p7, capped: false, surge: c7 >= 20 && c7 >= 2 * Math.max(p7, 1),
        articles: [{ title: "FEED-HEADLINE " + i.id, url: "https://example.org/feed/" + i.id, domain: "example.org", country: "X", date: tl[tl.length - 1].date }] };
    });
    return { __live: true, syncedAt: new Date().toISOString(), source: "GDELT stub", refreshed: wl.items.length, total: wl.items.length, items };
  })();
  dom2.window.fetch = routeFetch({ ok: true, status: 200, json: async () => liveStub }, { ok: true, status: 200, json: async () => feedStub });
  dom2.window.Chart = function () { return { destroy() {} }; }; dom2.window.Chart.prototype = {};
  dom2.window.HTMLCanvasElement.prototype.getContext = () => ({});
  dom2.window.eval(appjs);
  await sleep(250);
  const d2 = dom2.window.document;
  // Watchlist in live mode: no brief signal anywhere, even with live brief editions loaded
  const liveProbe = wl.items[0];
  d2.querySelector(`#view-watchlist [data-wl-toggle="${liveProbe.id}"]`).click(); await sleep(40);
  const liveDet = d2.querySelector(`#view-watchlist tr[data-wl-detail="${liveProbe.id}"]`);
  check("watchlist: no brief signal, brief tag or brief-moves list even when live brief editions are synced",
    !!liveDet && !liveDet.querySelector(".wl-brief") && !/Brief signal/.test(d2.querySelector("#view-watchlist .view-body").textContent) && !d2.querySelector("#view-watchlist .wl-move-brief") && !d2.querySelector("#view-watchlist .wl-register .t-chip"));
  check("watchlist header 'Last updated' ignores the brief sync on the Watchlist tab", (() => {
    const l = d2.querySelector("#meta-updated").previousElementSibling; return /open-source feed sync/.test(l.textContent) && !/brief sync/.test(d2.querySelector("#meta-updated").title);
  })());
  // live open-source feed wired through: header status, sparklines, surge flag + score bonus, headlines in the detail
  const wv2 = d2.querySelector("#view-watchlist .view-body");
  check("feed: header shows the live feed as synced", /● LIVE feed · synced/.test(wv2.querySelector(".wl-feedstat").textContent) && !wv2.querySelector(".wl-feedstat.off"));
  check("header 'Last updated' reports the newest live sync, not the seed timestamp", (() => {
    const v = d2.querySelector("#meta-updated"), l = v.previousElementSibling;
    return !/30 May 2026/.test(v.textContent) && /open-source feed sync|watchlist review/.test(l.textContent) && /seed data/.test(v.title);
  })());
  check("feed: every register row carries a 30-day coverage sparkline + 7-day count", wv2.querySelectorAll("#wl-register tbody tr.wl-row td.wl-feed-cell .wl-spark").length === wl.items.length && wv2.querySelectorAll("#wl-register .wl-feed-n b").length === wl.items.length);
  check("feed: surge flagged on the surging item only and adds +8 to its attention score", (() => {
    const surged = wl.items[0];
    const row = wv2.querySelector(`tr[data-wl-row="${surged.id}"]`);
    const others = [...wv2.querySelectorAll("#wl-register tbody tr.wl-row")].filter(r => r !== row);
    return !!row.querySelector(".wl-surge") && others.every(r => !r.querySelector(".wl-surge")) && /Live coverage surge: \+8/.test(row.querySelector(".wl-score .tip-body").textContent);
  })());
  check("feed: 'Live coverage moves' block lists the surging item under the state moves", (() => {
    const items = [...wv2.querySelectorAll(".wl-moves-card .wl-cov-item")];
    return /Live coverage moves/.test(wv2.querySelector(".wl-moves-card").textContent) && items.length >= 1 && items[0].querySelector(".wl-name").textContent === wl.items[0].name && !!items[0].querySelector(".wl-surge");
  })());
  check("feed: the seed DOM (no feed) shows no coverage-moves block", !/Live coverage moves/.test(doc.querySelector("#view-watchlist .view-body").textContent) || doc.querySelector("#view-watchlist .wl-cov-item") === null);
  check("feed: expanded row lists the latest open-source headlines with links", (() => {
    const det2 = d2.querySelector(`#view-watchlist tr[data-wl-detail="${liveProbe.id}"]`);
    return !!det2 && /Latest open-source reporting/.test(det2.textContent) && !!det2.querySelector(".wl-art-list a[href='https://example.org/feed/" + liveProbe.id + "']") && /FEED-HEADLINE/.test(det2.textContent);
  })());
  d2.querySelector('.tab-btn[data-horizon="weekly"]').click(); await sleep(60);
  const opts2 = [...d2.querySelectorAll("#period-select option")];
  check("all brief editions listed (current + past), newest first", opts2.length === 2 && /● LIVE/.test(opts2[0].textContent) && /18 May – 25 May/.test(opts2[1].textContent));
  const wb3 = d2.querySelector("#view-weekly .view-body");
  check("latest edition is the default ● LIVE view", !!wb3.querySelector(".live-banner") && /●\s*LIVE/.test(wb3.querySelector(".live-banner").textContent));
  check("latest renders verbatim words, no domain grid",
    wb3.querySelectorAll(".brief-dev").length >= 5 && wb3.textContent.includes("LATEST-HEADLINE") &&
    wb3.textContent.includes("LATEST-NARR") && wb3.textContent.includes("LATEST-IMPL") &&
    wb3.querySelectorAll("details.domains").length === 0);
  // switch to the archived past edition
  d2.querySelector("#period-select").value = "BRIEF-OLD";
  d2.querySelector("#period-select").dispatchEvent(new dom2.window.Event("change")); await sleep(50);
  const wb4 = d2.querySelector("#view-weekly .view-body");
  check("past edition shows 'Archived edition' banner + verbatim words",
    /Archived edition/.test((wb4.querySelector(".live-banner") || {}).textContent || "") && wb4.textContent.includes("ARCHIVED-HEADLINE"));
  // capability brief-evidence wired through to the leaderboard
  d2.querySelector('.tab-btn[data-horizon="capabilities"]').click(); await sleep(60);
  const cb2 = d2.querySelector("#view-capabilities .view-body");
  check("brief-evidence drawer + cited link shown on evidenced capability",
    cb2.querySelectorAll(".ev-badge.ev-yes").length >= 1 && /EVIDENCE-HEADLINE/.test(cb2.textContent) && !!cb2.querySelector(".ev-list a[href^='http']"));
  check("heat is brief-derived in live mode (source badges shown)",
    /brief-derived/.test(cb2.textContent) && cb2.querySelectorAll(".src-badge.src-brief").length >= 1);
  check("lean default: only brief-evidenced contests shown, analyst-judged hidden",
    cb2.querySelectorAll(".contest-card").length >= 1 &&
    [...cb2.querySelectorAll(".contest-card")].length < (JSON.parse(data).capabilityContests || []).length);
  check("an uncountered contest renders without an invented counter (live)",
    [...cb2.querySelectorAll(".contest-card")].some(c => /not yet evidenced|Currently uncountered/i.test(c.textContent)));
  check("'Brief-evidenced only' default ON; toggling OFF reveals analyst-judged items", (() => {
    const chip = cb2.querySelector("#cap-ev-only"); if (!chip || chip.getAttribute("aria-pressed") !== "true") return false;
    const beforeRows = cb2.querySelectorAll(".matrix tbody tr").length;
    const beforeContests = cb2.querySelectorAll(".contest-card").length;
    chip.click();
    const after = d2.querySelector("#view-capabilities .view-body");
    return after.querySelectorAll(".matrix tbody tr").length > beforeRows && after.querySelectorAll(".contest-card").length > beforeContests;
  })());
  // in live mode the briefs menu lists the actual synced editions (newest ● LIVE)
  d2.querySelector("#briefs-toggle").click(); await sleep(20);
  check("live briefs menu lists synced editions with source links", (() => {
    const items = [...d2.querySelectorAll("#briefs-menu .briefs-item[href^='http']")];
    const edLinks = items.filter(a => /example\.org\/(new|old)/.test(a.getAttribute("href") || ""));
    return edLinks.length >= 2 && !!d2.querySelector("#briefs-menu .briefs-live");
  })());

  // restore globals for any later use
  global.window = window; global.document = doc;

  // --- 8. Mobile affordances ----------------------------------------------
  console.log("\nMobile affordances:");
  check("collapsible Filters toggle present", !!doc.querySelector("#filters-toggle"));
  check("export buttons have short labels", doc.querySelectorAll('.export-group .lbl-short').length >= 1);
  check("viewport meta is responsive", /width=device-width/.test((doc.querySelector('meta[name="viewport"]') || {}).content || ""));
  // toggling adds the filters-open class (drives the mobile show/hide)
  doc.querySelector("#filters-toggle").click();
  check("Filters toggle opens the panel", doc.querySelector(".sidebar").classList.contains("filters-open"));
  doc.querySelector("#filters-toggle").click();
  check("Filters toggle closes the panel", !doc.querySelector(".sidebar").classList.contains("filters-open"));

  // --- Result --------------------------------------------------------------
  console.log("");
  if (failures === 0) { console.log("✓ SMOKE TEST PASSED — all checks green."); process.exit(0); }
  console.error(`✗ SMOKE TEST FAILED — ${failures} check(s) failed.`);
  process.exit(1);
})().catch(e => { console.error("SMOKE TEST CRASHED:", e && e.stack || e); process.exit(1); });
