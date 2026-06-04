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

  // --- 1. Boot the app in a DOM -------------------------------------------
  const dom = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  const { window } = dom;
  global.window = window; global.document = window.document;
  // Seed-only fetch: weekly-live.json returns 404 so the main harness exercises
  // the seed/fallback path deterministically.
  window.fetch = async (u) => String(u).includes("weekly-live")
    ? ({ ok: false, status: 404, json: async () => ({}) })
    : ({ ok: true, status: 200, json: async () => JSON.parse(data) });
  window.Chart = function () { return { destroy() {} }; };
  window.Chart.prototype = {};
  window.HTMLCanvasElement.prototype.getContext = () => ({});
  window.eval(appjs);
  await sleep(250);
  const doc = window.document;

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

  // --- 3a. Monthly: Formation Learning view -------------------------------
  console.log("\nMonthly (formation learning):");
  doc.querySelector('.tab-btn[data-horizon="monthly"]').click(); await sleep(50);
  let mb = doc.querySelector("#view-monthly .view-body");
  check("2 monthly periods (8 weeks / 4)", doc.querySelectorAll("#period-select option").length === 2);
  check("monthly BLUF (formation learning) present", /Monthly BLUF — Formation Learning/.test(mb.textContent) && mb.querySelector(".bluf-card p").textContent.length > 50);
  check("formation-group selector has 5 options", doc.querySelectorAll("#formation-group-select option").length === 5);
  check("All Groups default shows 4 overview cards", mb.querySelectorAll(".fg-overview .fg-card").length === 4);
  check("no theatre status matrix on Monthly tab", !mb.querySelector("#status-matrix"));
  // select a group -> full panel
  const fgSel = doc.querySelector("#formation-group-select");
  fgSel.value = "MANOEUVRE"; fgSel.dispatchEvent(new window.Event("change")); await sleep(50);
  mb = doc.querySelector("#view-monthly .view-body");
  check("group panel: audience banner shown", /Audience —/.test((mb.querySelector(".fg-audience-banner") || {}).textContent || ""));
  check("group panel: what worked / failed columns", !!mb.querySelector(".col-worked") && !!mb.querySelector(".col-failed"));
  check("group panel: training implications box", !!mb.querySelector(".train-box"));
  check("group panel: commander questions", mb.querySelectorAll(".cq-list li").length >= 1);
  check("group panel: source-theatre chips", mb.querySelectorAll(".t-chip").length >= 1);
  check("group panel: linked insight cards (EOLA)", mb.querySelectorAll(".insight-card").length >= 1 && mb.querySelectorAll(".eola .eola-k").length >= 4);
  check("monthly BLUF still visible inside a group", /Monthly BLUF — Formation Learning/.test(mb.textContent));
  // back to All Groups via data-group button
  mb.querySelector('[data-group="ALL"]').click(); await sleep(50);
  check("can switch back to All Groups", doc.querySelector("#view-monthly .view-body").querySelectorAll(".fg-overview .fg-card").length === 4);

  // --- 4. Top control bar: removed mode switch / quarterly / division dd ---
  console.log("\nTop control bar (trimmed):");
  check("horizon tabs are Weekly / Monthly / Capabilities only", [...doc.querySelectorAll(".tab-btn")].map(b => b.dataset.horizon).join(",") === "weekly,monthly,capabilities");
  check("no Quarterly tab", !doc.querySelector('.tab-btn[data-horizon="quarterly"]') && !doc.querySelector("#view-quarterly"));
  check("no Theatre/Division mode switch", !doc.querySelector("[data-mode]"));
  check("no top division dropdown", !doc.querySelector("#division-select") && !doc.querySelector("#division-wrap"));

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
  check("capability BLUF rendered", cb.textContent.includes("BLUF — Capability Picture"));
  check("KPI strip rendered (5 KPIs)", cb.querySelectorAll(".kpi").length === 5);
  check("heat leaderboard populated", cb.querySelectorAll(".matrix tbody tr").length >= 20);
  check("measure-countermeasure cycle cards present", cb.querySelectorAll(".cycle-card").length > 0);
  check("supersession chains present", cb.querySelectorAll(".sup-row").length > 0);
  check("cross-theatre proliferation rows present", cb.querySelectorAll(".cmp-table tbody tr").length > 0);
  check("6 capability charts rendered", cb.querySelectorAll("canvas").length === 6);
  check("'what's hot across five theatres' chart present", !!cb.querySelector("#cap-theatre-heat"));
  check("'heat by theatre over weeks' line chart removed", !cb.querySelector("#cap-theatre-series"));
  check("per-theatre hottest-capability captions (5)", cb.querySelectorAll(".theatre-leaders .tl").length === 5);
  // Cycles section must appear before the Heat Leaderboard
  const h2s = [...cb.querySelectorAll(".section-head h2")].map(h => h.textContent);
  check("Measure⇄Countermeasure Cycles precede Heat Leaderboard",
    h2s.indexOf("Measure ⇄ Countermeasure Cycles") !== -1 &&
    h2s.indexOf("Measure ⇄ Countermeasure Cycles") < h2s.indexOf("Heat Leaderboard"),
    h2s.join(" | "));
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
  check("activity sparklines rendered", capView.querySelectorAll("svg.sparkline").length >= 20);
  check("'computed from ... observations' note shown", capView.textContent.includes("observations — not hardcoded"));
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
  const allGaza = [...scoped.querySelectorAll(".matrix tbody tr td:nth-child(5)")].every(td => td.textContent.includes("ISR-GAZ"));
  check("theatre filter re-scopes capabilities to selected theatre", scoped.querySelectorAll(".matrix tbody tr").length > 0 && allGaza);
  check("charts still render after theatre filter", scoped.querySelectorAll("canvas").length === 6);
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
    ]
  };
  const dom2 = new JSDOM(html, { runScripts: "outside-only", pretendToBeVisual: true });
  global.window = dom2.window; global.document = dom2.window.document;
  dom2.window.fetch = async (u) => String(u).includes("weekly-live")
    ? ({ ok: true, status: 200, json: async () => liveStub })
    : ({ ok: true, status: 200, json: async () => JSON.parse(data) });
  dom2.window.Chart = function () { return { destroy() {} }; }; dom2.window.Chart.prototype = {};
  dom2.window.HTMLCanvasElement.prototype.getContext = () => ({});
  dom2.window.eval(appjs);
  await sleep(250);
  const d2 = dom2.window.document;
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
