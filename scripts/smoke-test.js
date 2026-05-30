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
  window.fetch = async () => ({ ok: true, status: 200, json: async () => JSON.parse(data) });
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
  check("5 development pills", wb.querySelectorAll(".dev-pill").length === 5);
  check("5 'Implication (...)' SAF lines", wb.querySelectorAll(".pill-implication").length === 5);
  check("30 domain-analysis cells (6×5)", wb.querySelectorAll(".domain-item").length === 30);
  check("5 watch-area items", wb.querySelectorAll(".watch-item").length === 5);

  // --- 3. Aggregation: monthly + quarterly --------------------------------
  console.log("\nAggregation (rollups + drilldown):");
  doc.querySelector('.tab-btn[data-horizon="monthly"]').click(); await sleep(40);
  const mb = doc.querySelector("#view-monthly .view-body");
  check("2 monthly periods (8 weeks / 4)", doc.querySelectorAll("#period-select option").length === 2);
  check("monthly comparison rows = 5", mb.querySelectorAll(".cmp-table tbody tr").length === 5);
  check("monthly drilldown to 4 weeks", mb.querySelectorAll(".drill").length === 4);
  check("monthly BLUF is non-trivial", mb.querySelector(".bluf-card p").textContent.length > 50);

  doc.querySelector('.tab-btn[data-horizon="quarterly"]').click(); await sleep(40);
  const qb = doc.querySelector("#view-quarterly .view-body");
  check("1 quarterly period", doc.querySelectorAll("#period-select option").length === 1);
  check("quarterly comparison rows = 5", qb.querySelectorAll(".cmp-table tbody tr").length === 5);
  check("quarterly drilldown to 2 months", qb.querySelectorAll(".drill").length === 2);

  // --- 4. Division mode reframing -----------------------------------------
  console.log("\nDivision mode (SAF reframing):");
  doc.querySelector('.tab-btn[data-horizon="weekly"]').click();
  doc.querySelector('[data-mode="division"]').click(); await sleep(40);
  const dvb = doc.querySelector("#view-weekly .view-body");
  check("division banner shown", !!dvb.querySelector(".note-banner"));
  check("5 division-relevance blocks", dvb.querySelectorAll(".div-relevance").length === 5);
  check("10 commander questions (2×5)", dvb.querySelectorAll(".dr-q li").length === 10);
  check("BLUF reframed with division lens", dvb.querySelector(".tc-summary").textContent.includes("lens"));
  const genPill = dvb.querySelector(".dev-pill .pill-domain").textContent;
  doc.querySelector("#division-select").value = "DIV6";
  doc.querySelector("#division-select").dispatchEvent(new window.Event("change")); await sleep(40);
  const d6Pill = doc.querySelector("#view-weekly .view-body .dev-pill .pill-domain").textContent;
  check("different divisions emphasise different domains", genPill !== d6Pill, `GEN=${genPill} DIV6=${d6Pill}`);

  // --- 5. Filters ----------------------------------------------------------
  console.log("\nFilters:");
  doc.querySelector('[data-mode="theatre"]').click(); await sleep(40);
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
  check("7 capability charts rendered", cb.querySelectorAll("canvas").length === 7);
  check("'what's hot across five theatres' chart present", !!cb.querySelector("#cap-theatre-heat"));
  check("'heat by theatre over weeks' chart present", !!cb.querySelector("#cap-theatre-series"));
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
  check("charts still render after theatre filter", scoped.querySelectorAll("canvas").length === 7);
  gazaCb.checked = false; gazaCb.dispatchEvent(new window.Event("change", { bubbles: true })); await sleep(40);

  // division priority flag appears in capabilities view
  doc.querySelector('[data-mode="division"]').click(); await sleep(60);
  check("division priority ★ flagged in capabilities",
    doc.querySelector("#view-capabilities .view-body").querySelectorAll(".prio").length > 0);

  // --- Result --------------------------------------------------------------
  console.log("");
  if (failures === 0) { console.log("✓ SMOKE TEST PASSED — all checks green."); process.exit(0); }
  console.error(`✗ SMOKE TEST FAILED — ${failures} check(s) failed.`);
  process.exit(1);
})().catch(e => { console.error("SMOKE TEST CRASHED:", e && e.stack || e); process.exit(1); });
