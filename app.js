/* =========================================================================
 * Conflict Studies Dashboard — app.js
 *
 * Architecture (clear module separation; single-page, no backend):
 *   1.  STATE          — current mode/horizon/period/filters
 *   2.  DATA layer     — load sample-data.json (swap for live API here)
 *   3.  TIME utilities — Monday-to-Monday buckets, week->month->quarter
 *   4.  AGGREGATION    — deterministic rollups (monthly/quarterly) + helpers
 *   5.  DIVISION layer — reframes the same data per Singapore Army division
 *   6.  FILTERS        — theatre/phase/trend/domain/search
 *   7.  RENDER         — weekly / monthly / quarterly views, both modes
 *   8.  CHARTS         — Chart.js instances (status, trend, domain, timeline)
 *   9.  EXPORT         — JSON / CSV / print (PDF-friendly)
 *  10.  APP            — init + event wiring
 *
 * Monthly and quarterly reports are NOT stored. They are computed from the
 * weekly source of truth so the rollups are genuinely aggregated.
 * ========================================================================= */
(function () {
  "use strict";

  /* ----------------------------------------------------------------------
   * 1. STATE
   * -------------------------------------------------------------------- */
  const State = {
    mode: "theatre",          // 'theatre' | 'division'
    division: "GEN",          // active division id
    horizon: "weekly",        // 'weekly' | 'monthly' | 'quarterly'
    periodId: null,           // active week/month/quarter id
    theme: "light",
    filters: {
      theatres: new Set(),    // empty => all
      phases:   new Set(),
      trends:   new Set(),
      domains:  new Set(),
      search:   ""
    }
  };

  // Populated after load
  let DB = null;              // raw data
  let MONTHS = [];            // computed monthly reports
  let QUARTERS = [];          // computed quarterly reports
  const THEATRE_BY_ID = {};
  const DIV_BY_ID = {};

  /* ----------------------------------------------------------------------
   * 2. DATA LAYER
   *    To go live later, replace loadData() with a fetch to your API that
   *    returns the same JSON shape (meta/definitions/theatres/divisions/
   *    weeklyReports). Nothing else in the app needs to change.
   * -------------------------------------------------------------------- */
  async function loadData() {
    const res = await fetch("sample-data.json", { cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  }

  /* ----------------------------------------------------------------------
   * 3. TIME UTILITIES  (Monday-to-Monday bucketing & grouping)
   * -------------------------------------------------------------------- */
  const Time = {
    // Monday 00:00 of the ISO week containing `d`
    mondayOf(d) {
      const x = new Date(d);
      const day = (x.getUTCDay() + 6) % 7; // 0 = Monday
      x.setUTCDate(x.getUTCDate() - day);
      x.setUTCHours(0, 0, 0, 0);
      return x;
    },
    iso(d) { return new Date(d).toISOString().slice(0, 10); },

    // Find the weekly report whose [weekStart, weekEnd) bucket contains `dateStr`
    weekForDate(dateStr) {
      const t = new Date(dateStr).getTime();
      return DB.weeklyReports.find(w =>
        t >= new Date(w.weekStart).getTime() && t < new Date(w.weekEnd).getTime()
      ) || null;
    },

    // Chunk an ordered array into groups of n
    chunk(arr, n) {
      const out = [];
      for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
      return out;
    },

    fmtRange(start, end) {
      const o = { day: "2-digit", month: "short", year: "numeric" };
      return `${new Date(start).toLocaleDateString("en-GB", o)} – ${new Date(end).toLocaleDateString("en-GB", o)}`;
    },
    fmtDateTime(s) {
      return new Date(s).toLocaleString("en-GB", {
        day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit"
      });
    }
  };

  /* ----------------------------------------------------------------------
   * 4. AGGREGATION
   * -------------------------------------------------------------------- */
  const Agg = {
    avg(nums) { return nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : 0; },

    // Comparative trend label from score delta across a period (deterministic)
    comparativeTrend(firstScore, lastScore) {
      const d = lastScore - firstScore;
      if (d > 6)  return "Escalating";
      if (d > 2)  return "Deteriorating";
      if (d < -6) return "De-escalating";
      if (d < -2) return "Improving";
      return "Stable";
    },

    // Tally which domain most often became the development pill
    countDominantDomains(entries) {
      const counts = {};
      DB.definitions.domains.forEach(d => (counts[d] = 0));
      entries.forEach(e => { if (e && e.selectedDevelopmentPill) counts[e.selectedDevelopmentPill.domain]++; });
      let top = null, max = -1;
      Object.entries(counts).forEach(([d, c]) => { if (c > max) { max = c; top = d; } });
      return { counts, dominant: top, dominantCount: max };
    },

    // Aggregate a theatre across an ordered list of weekly entries -> rolled-up entry
    rollupTheatre(theatreId, entries, label) {
      const valid = entries.filter(Boolean);
      const scores = valid.map(e => e.conflictStatusScore);
      const first = valid[0], last = valid[valid.length - 1];
      const dom = this.countDominantDomains(valid);

      // Turning points = the selected development pill headline from each sub-period
      const turningPoints = valid.map(e => e.selectedDevelopmentPill.headline);

      // Persistent risks = tags appearing in a majority of sub-periods
      const tagCount = {};
      valid.forEach(e => (e.tags || []).forEach(t => (tagCount[t] = (tagCount[t] || 0) + 1)));
      const persistentRisks = Object.entries(tagCount)
        .filter(([, c]) => c >= Math.ceil(valid.length / 2))
        .sort((a, b) => b[1] - a[1]).map(([t]) => t);

      const trend = this.comparativeTrend(first.conflictStatusScore, last.conflictStatusScore);

      return {
        theatre: theatreId,
        phase: last.phase,                         // current phase = latest
        trend,                                     // comparative over the period
        progressToDate: last.progressToDate,
        conflictStatusScore: this.avg(scores),
        peakScore: Math.max(...scores),
        statusLabel: last.statusLabel,
        bluf: `${THEATRE_BY_ID[theatreId].name}: ${label} net trend ${trend.toLowerCase()} ` +
              `(avg status ${this.avg(scores)}, peak ${Math.max(...scores)}). ` +
              `Dominant analytical driver: ${dom.dominant}. Currently ${last.phase.toLowerCase()}.`,
        // Most significant development pill across the period = most frequent domain,
        // represented by the latest pill in that domain (or the latest pill overall)
        selectedDevelopmentPill: (function () {
          const inDom = valid.filter(e => e.selectedDevelopmentPill.domain === dom.dominant);
          const chosen = (inDom.length ? inDom[inDom.length - 1] : last).selectedDevelopmentPill;
          return { domain: dom.dominant, headline: chosen.headline, rationale: chosen.rationale };
        })(),
        domainPillCounts: dom.counts,
        keyDevelopments: turningPoints,
        persistentRisks,
        watchAreas: last.watchAreas,
        domainAnalysis: last.domainAnalysis,       // carry latest domain detail for drilldown
        tags: Object.keys(tagCount)
      };
    },

    // Aggregate the overall BLUF across theatres for a rolled-up period
    aggregateBLUF(theatreEntries, label) {
      const esc = [], deesc = [], stable = [];
      Object.values(theatreEntries).forEach(e => {
        const name = THEATRE_BY_ID[e.theatre].short;
        if (e.trend === "Escalating" || e.trend === "Deteriorating") esc.push(name);
        else if (e.trend === "Improving" || e.trend === "De-escalating") deesc.push(name);
        else stable.push(name);
      });
      const parts = [];
      if (esc.length)   parts.push(`escalating/deteriorating in ${esc.join(", ")}`);
      if (deesc.length) parts.push(`improving in ${deesc.join(", ")}`);
      if (stable.length) parts.push(`broadly stable in ${stable.join(", ")}`);
      return `${label}: trajectory is ${parts.join("; ")}. ` +
             `Aggregated from underlying reports; expand any theatre to drill down.`;
    },

    buildMonths() {
      const groups = Time.chunk(DB.weeklyReports, DB.meta.rollup.weeksPerMonth);
      return groups.map((weeks, i) => {
        const monthId = `M${i + 1}`;
        const label = `Monthly Roll-up ${i + 1}`;
        const theatreEntries = {};
        DB.theatres.forEach(t => {
          const entries = weeks.map(w => w.theatres[t.id]);
          theatreEntries[t.id] = Agg.rollupTheatre(t.id, entries, label);
        });
        return {
          id: monthId, level: "monthly", label,
          start: weeks[0].weekStart, end: weeks[weeks.length - 1].weekEnd,
          weekIds: weeks.map(w => w.weekId),
          bluf: Agg.aggregateBLUF(theatreEntries, label),
          theatres: theatreEntries
        };
      });
    },

    buildQuarters() {
      const groups = Time.chunk(MONTHS, DB.meta.rollup.monthsPerQuarter);
      return groups.map((months, i) => {
        const qId = `Q${i + 1}`;
        const label = `Quarterly Roll-up ${i + 1}`;
        const theatreEntries = {};
        DB.theatres.forEach(t => {
          // Roll up from the already-aggregated monthly theatre entries
          const entries = months.map(m => m.theatres[t.id]);
          theatreEntries[t.id] = Agg.rollupTheatre(t.id, entries, label);
        });
        return {
          id: qId, level: "quarterly", label,
          start: months[0].start, end: months[months.length - 1].end,
          monthIds: months.map(m => m.id),
          weekIds: months.flatMap(m => m.weekIds),
          bluf: Agg.aggregateBLUF(theatreEntries, label),
          theatres: theatreEntries
        };
      });
    }
  };

  /* ----------------------------------------------------------------------
   * 5. DIVISION LAYER
   *    Reframes the SAME theatre data for a selected Singapore Army division.
   *    Doctrinal assumptions are declared in the data file and surfaced as
   *    helper text. This is analytical tailoring for planning/study only —
   *    NOT classified or authoritative doctrine.
   * -------------------------------------------------------------------- */
  const Division = {
    // A planning question per domain — used to generate commander prompts
    domainQuestion: {
      "Fires & Strikes": "How would this strike profile stress our counter-fire, air-defence and EW posture?",
      "Intelligence":      "Do we have the ISR and indications-&-warning coverage to detect this pattern early in our own AO?",
      "Manoeuvre":         "What does this manoeuvre dynamic imply for our mobility, terrain control and reserve-commitment decisions?",
      "Protection":        "Are our force-protection and air/missile-defence measures sized for a threat of this character?",
      "Sustainment":       "Can our logistics and munitions stocks sustain operations at this tempo and duration?",
      "Command & Control":"Is our C2 and decision tempo resilient enough to match this environment?"
    },

    // SAF-relevance "Implication [Domain]" framing, mirroring the reference brief's
    // imperative voice (Formations should rehearse / Staffs should track /
    // Commanders should treat / Planners should consider).
    domainImplication: {
      "Fires & Strikes":    "Formations should rehearse dispersal, hardening and counter-fire against this strike profile.",
      "Intelligence":       "Staffs should track the indications-and-warning picture and close ISR coverage gaps.",
      "Manoeuvre":          "Planners should consider mobility, terrain control and reserve-commitment implications.",
      "Protection":         "Commanders should treat layered air/missile defence and force protection as a priority.",
      "Sustainment":        "Planners should consider munitions stockpiles and logistics resilience at this tempo.",
      "Command & Control":  "Staffs should track decision tempo and C2 resilience under contested conditions."
    },

    // Choose the domain this division would emphasise for an entry:
    // the highest-priority emphasised domain that has substantive analysis.
    emphasisDomain(div, entry) {
      for (const d of div.emphasizedDomains) {
        if (entry.domainAnalysis && entry.domainAnalysis[d]) return d;
      }
      return entry.selectedDevelopmentPill.domain;
    },

    // Build the division-tailored layer for a (weekly or rolled-up) theatre entry.
    // theatreId is passed explicitly because weekly entries are keyed by id and
    // do not carry a `theatre` field (only aggregated rollups do).
    tailor(div, entry, theatreId) {
      const tid = theatreId || entry.theatre;
      const theatreName = THEATRE_BY_ID[tid].name;
      const domain = this.emphasisDomain(div, entry);
      const domainText = (entry.domainAnalysis && entry.domainAnalysis[domain]) || "";

      const bluf =
        `${div.name} lens — ${entry.bluf} ` +
        `For ${div.focus.toLowerCase()}, emphasis falls on ${domain}.`;

      const relevance =
        `Read for ${div.focus.toLowerCase()}. ${domain}: ${domainText} ` +
        `(Analytical tailoring for planning/study — not authoritative doctrine.)`;

      const commanderQuestions = [
        this.domainQuestion[domain],
        `What planning assumptions should ${div.name} revisit given the ${theatreName} development "${entry.selectedDevelopmentPill.headline}"?`
      ];

      const watch =
        `${div.focus}: ${entry.watchAreas}`;

      return { domain, bluf, relevance, commanderQuestions, watch };
    }
  };

  /* ----------------------------------------------------------------------
   * 6. FILTERS
   * -------------------------------------------------------------------- */
  const Filters = {
    // Return ordered theatre ids that pass the active filters for a given
    // period object (week/month/quarter) keyed `.theatres`.
    apply(period) {
      const f = State.filters;
      const q = f.search.trim().toLowerCase();
      return DB.theatres.map(t => t.id).filter(id => {
        const e = period.theatres[id];
        if (!e) return false;
        if (f.theatres.size && !f.theatres.has(id)) return false;
        if (f.phases.size && !f.phases.has(e.phase)) return false;
        if (f.trends.size && !f.trends.has(e.trend)) return false;
        if (f.domains.size && !f.domains.has(e.selectedDevelopmentPill.domain)) return false;
        if (q) {
          const hay = [
            THEATRE_BY_ID[id].name, e.bluf, e.phase, e.trend,
            (e.keyDevelopments || []).join(" "),
            (e.tags || []).join(" "),
            e.selectedDevelopmentPill.headline
          ].join(" ").toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
    },
    reset() {
      State.filters.theatres.clear();
      State.filters.phases.clear();
      State.filters.trends.clear();
      State.filters.domains.clear();
      State.filters.search = "";
    }
  };

  /* ----------------------------------------------------------------------
   * 7. RENDER
   * -------------------------------------------------------------------- */
  const el = (sel) => document.querySelector(sel);
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const Render = {
    toneFor(label, kind) {
      const def = DB.definitions;
      if (kind === "status") return "tone-" + (def.statusLabels[label] || "neutral");
      if (kind === "trend") return "tone-" + ((def.trends[label] && def.trends[label].tone) || "neutral");
      return "tone-neutral";
    },
    trendArrow(t) { return (DB.definitions.trends[t] && DB.definitions.trends[t].arrow) || "→"; },

    statusChip(label) {
      return `<span class="chip ${this.toneFor(label, "status")}">${esc(label)}</span>`;
    },
    trendChip(t) {
      return `<span class="trend ${this.toneFor(t, "trend")}"><span class="arrow">${this.trendArrow(t)}</span>${esc(t)}</span>`;
    },
    phaseTag(p) {
      const tip = DB.definitions.phases[p] || "";
      return `<span class="phase-tag tip" tabindex="0">${esc(p)}<span class="tip-body">${esc(tip)}</span></span>`;
    },

    // Active period object for the current horizon
    currentPeriod() {
      if (State.horizon === "weekly")  return DB.weeklyReports.find(w => w.weekId === State.periodId);
      if (State.horizon === "monthly") return MONTHS.find(m => m.id === State.periodId);
      return QUARTERS.find(q => q.id === State.periodId);
    },

    // ---- BLUF card ----
    bluf(period, watchLabel) {
      return `
        <div class="card bluf-card card-pad section">
          <div class="bluf-label">BLUF — Bottom Line Up Front</div>
          <p>${esc(period.bluf)}</p>
          <div class="bluf-sub">${esc(watchLabel)} · ${esc(Time.fmtRange(period.weekStart || period.start, period.weekEnd || period.end))}</div>
        </div>`;
    },

    // ---- Conflict status matrix (visual table) ----
    statusMatrix(period, ids) {
      if (!ids.length) return `<div class="empty">No theatres match the current filters.</div>`;
      const rows = ids.map(id => {
        const e = period.theatres[id];
        const t = THEATRE_BY_ID[id];
        return `
          <tr>
            <td class="theatre-cell">${esc(t.name)}<div style="font-size:11px;color:var(--text-faint)">${esc(t.region)}</div></td>
            <td>${this.phaseTag(e.phase)}</td>
            <td>${this.trendChip(e.trend)}</td>
            <td>
              <div style="font-size:12px;max-width:280px">${esc(e.progressToDate)}</div>
              <div class="progress-mini" title="Conflict status score ${e.conflictStatusScore}/100"><span style="width:${e.conflictStatusScore}%;background:${this.scoreColor(e.conflictStatusScore)}"></span></div>
            </td>
            <td>${this.statusChip(e.statusLabel)}</td>
          </tr>`;
      }).join("");
      return `
        <div class="card matrix-wrap section">
          <table class="matrix" id="status-matrix">
            <thead><tr>
              <th data-sort="name">Theatre <span class="sort-ind"></span></th>
              <th data-sort="phase">Phase <span class="sort-ind"></span></th>
              <th data-sort="trend">Trend <span class="sort-ind"></span></th>
              <th data-sort="score">Progress to date <span class="sort-ind"></span></th>
              <th data-sort="status">Conflict Status <span class="sort-ind"></span></th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>`;
    },
    scoreColor(s) {
      if (s >= 75) return "var(--tone-bad-fg)";
      if (s >= 55) return "var(--tone-warn-fg)";
      if (s >= 40) return "var(--tone-neutral-fg)";
      return "var(--tone-good-fg)";
    },

    // ---- Theatre card ----
    theatreCard(period, id, idx) {
      const e = period.theatres[id];
      const t = THEATRE_BY_ID[id];
      const div = State.mode === "division" ? DIV_BY_ID[State.division] : null;
      const tailor = div ? Division.tailor(div, e, id) : null;
      const pillDomain = tailor ? tailor.domain : e.selectedDevelopmentPill.domain;
      // Stable "Theatre 01–05" numbering by data order (mirrors the reference brief)
      const theatreNo = String(DB.theatres.findIndex(x => x.id === id) + 1).padStart(2, "0");
      const implication = Division.domainImplication[pillDomain] || "";

      // Domain analysis grid (collapsible). The pill domain is highlighted.
      const domainGrid = DB.definitions.domains.map(d => {
        const isPill = d === pillDomain;
        const text = (e.domainAnalysis && e.domainAnalysis[d]) || "—";
        const tip = DB.definitions.domainTooltips[d] || "";
        return `
          <div class="domain-item ${isPill ? "is-pill" : ""}">
            <div class="dn tip" tabindex="0">${isPill ? '<span class="star">★</span>' : ""}${esc(d)}<span class="tip-body">${esc(tip)}</span></div>
            <div class="dd">${esc(text)}</div>
          </div>`;
      }).join("");

      const devList = (e.keyDevelopments || []).map(k => `<li>${esc(k)}</li>`).join("");
      const tags = (e.tags || []).map(tg => `<span class="tag">#${esc(tg)}</span>`).join("");
      const links = (e.sourceLinks || []).map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)} ↗</a>`).join("");
      const persistent = (e.persistentRisks && e.persistentRisks.length)
        ? `<div class="subhead">Persistent risks</div><div class="tags">${e.persistentRisks.map(r => `<span class="tag">#${esc(r)}</span>`).join("")}</div>` : "";

      const divisionBlock = tailor ? `
        <div class="div-relevance">
          <div class="dr-flag">${esc(div.name)} relevance · ${esc(div.focus)}</div>
          <p style="margin:6px 0 0">${esc(tailor.relevance)}</p>
          <div class="subhead" style="margin-top:10px">Recommended commander questions</div>
          <ol class="dr-q">${tailor.commanderQuestions.map(q => `<li>${esc(q)}</li>`).join("")}</ol>
          <div class="subhead" style="margin-top:10px">What ${esc(div.name)} should watch next</div>
          <p style="margin:0;font-size:12.5px;color:var(--text-muted)">${esc(tailor.watch)}</p>
        </div>` : "";

      const summary = tailor ? tailor.bluf : e.bluf;

      return `
        <article class="card theatre-card" data-open="${idx === 0 ? "true" : "false"}" data-theatre="${id}">
          <div class="tc-head" role="button" tabindex="0" aria-expanded="${idx === 0}">
            <span class="tc-caret">▶</span>
            <div style="min-width:0">
              <div class="tc-title"><span style="color:var(--text-faint);font-weight:700">Theatre ${theatreNo}</span> — ${esc(t.name)}</div>
              <div class="tc-summary">${esc(summary)}</div>
            </div>
            <div class="tc-meta">
              ${this.phaseTag(e.phase)}
              ${this.trendChip(e.trend)}
              ${this.statusChip(e.statusLabel)}
            </div>
          </div>
          <div class="tc-body">
            <div class="kv-row">
              <div class="kv"><div class="k">Current phase</div><div class="v">${esc(e.phase)}</div></div>
              <div class="kv"><div class="k">Trend</div><div class="v">${this.trendChip(e.trend)}</div></div>
              <div class="kv"><div class="k">Progress to date</div><div class="v" style="max-width:420px">${esc(e.progressToDate)}</div></div>
              <div class="kv"><div class="k">Status score</div><div class="v">${e.conflictStatusScore}/100</div></div>
            </div>

            <div class="dev-pill">
              <span class="pill-flag tip" tabindex="0">★ Selected Development Pill
                <span class="tip-body">The single most significant analytical domain for this period — chosen after analysing all six domains.</span>
              </span>
              <div class="pill-domain">${esc(pillDomain)}</div>
              <div class="pill-headline">${esc(e.selectedDevelopmentPill.headline)}</div>
              <div class="pill-rationale">${esc(e.selectedDevelopmentPill.rationale)}</div>
              <div class="pill-implication"><strong>Implication (${esc(pillDomain)}):</strong> ${esc(implication)}</div>
              ${tailor ? `<div class="pill-rationale"><em>${esc(div.name)} reads this primarily through ${esc(pillDomain)}.</em></div>` : ""}
            </div>

            <div class="subhead">Key developments</div>
            <ul class="dev-list">${devList}</ul>
            ${persistent}

            <details class="domains">
              <summary>Domain analysis — six domains (development pill marked ★)</summary>
              <div class="domain-grid">${domainGrid}</div>
            </details>

            ${divisionBlock}

            ${tags ? `<div class="tags">${tags}</div>` : ""}
            ${links ? `<div class="src-links">${links}</div>` : ""}
          </div>
        </article>`;
    },

    // ---- Watch areas panel ----
    watchPanel(period, ids, days) {
      const div = State.mode === "division" ? DIV_BY_ID[State.division] : null;
      const items = ids.map(id => {
        const e = period.theatres[id];
        const text = div ? Division.tailor(div, e, id).watch : e.watchAreas;
        return `<div class="watch-item"><div class="wt">${esc(THEATRE_BY_ID[id].name)}</div><div class="wd">${esc(text)}</div></div>`;
      }).join("");
      return `
        <div class="section">
          <div class="section-head"><h2>Watch Areas — Next ${days} Days</h2>
            <span class="hint">Diplomatic milestones, named meetings, deadlines and decision points</span></div>
          <div class="watch-grid">${items || `<div class="empty">No theatres match the current filters.</div>`}</div>
        </div>`;
    },

    // ---- Comparison table (monthly/quarterly) ----
    comparisonTable(period, ids) {
      const rows = ids.map(id => {
        const e = period.theatres[id];
        return `<tr>
          <td class="theatre-cell">${esc(THEATRE_BY_ID[id].name)}</td>
          <td>${this.phaseTag(e.phase)}</td>
          <td>${this.trendChip(e.trend)}</td>
          <td class="matrix-cell-num">${e.conflictStatusScore} (peak ${e.peakScore || e.conflictStatusScore})</td>
          <td><strong>${esc(e.selectedDevelopmentPill.domain)}</strong><div style="font-size:11.5px;color:var(--text-muted)">${esc(e.selectedDevelopmentPill.headline)}</div></td>
          <td>${(e.persistentRisks || []).map(r => `#${esc(r)}`).join(", ") || "—"}</td>
        </tr>`;
      }).join("");
      return `<div class="card matrix-wrap"><table class="cmp-table">
        <thead><tr><th>Theatre</th><th>Phase (current)</th><th>Net trend</th><th>Avg status</th><th>Most significant development pill</th><th>Persistent risks</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
    },

    // ---- Drilldown (period -> children) ----
    drilldown(period) {
      if (State.horizon === "monthly") {
        const inner = period.weekIds.map(wid => {
          const w = DB.weeklyReports.find(x => x.weekId === wid);
          return `<details class="drill"><summary>${esc(wid)} · ${esc(Time.fmtRange(w.weekStart, w.weekEnd))}</summary>
            <div class="drill-body"><p style="font-size:12.5px">${esc(w.bluf)}</p></div></details>`;
        }).join("");
        return `<div class="section"><div class="section-head"><h2>Drill down — underlying weekly reports</h2></div>${inner}</div>`;
      }
      if (State.horizon === "quarterly") {
        const inner = period.monthIds.map(mid => {
          const m = MONTHS.find(x => x.id === mid);
          const weeks = m.weekIds.map(wid => `<li>${esc(wid)}</li>`).join("");
          return `<details class="drill"><summary>${esc(m.label)} · ${esc(Time.fmtRange(m.start, m.end))}</summary>
            <div class="drill-body"><p style="font-size:12.5px">${esc(m.bluf)}</p>
            <div style="font-size:12px;color:var(--text-muted)">Underlying weeks: <ul class="dev-list">${weeks}</ul></div></div></details>`;
        }).join("");
        return `<div class="section"><div class="section-head"><h2>Drill down — underlying monthly &amp; weekly reports</h2></div>${inner}</div>`;
      }
      return "";
    },

    // ---- Top-level render for the active horizon ----
    renderActiveView() {
      const period = this.currentPeriod();
      if (!period) return;
      const ids = Filters.apply(period);
      const horizon = State.horizon;
      const days = horizon === "weekly" ? 7 : horizon === "monthly" ? 30 : 90;
      const watchLabel = horizon === "weekly" ? "Weekly brief"
        : horizon === "monthly" ? "Monthly roll-up (aggregated from 4 weekly reports)"
        : "Quarterly roll-up (aggregated from underlying monthly reports)";

      // header meta
      el("#meta-range").textContent = Time.fmtRange(period.weekStart || period.start, period.weekEnd || period.end);

      const container = el(`#view-${horizon} .view-body`);
      let html = "";

      // mode banner
      if (State.mode === "division") {
        const d = DIV_BY_ID[State.division];
        html += `<div class="note-banner"><strong>Division View — ${esc(d.name)}.</strong> ${esc(d.doctrinalAssumption)} Lens: ${esc(d.lens)}</div>`;
      }

      html += this.bluf(period, watchLabel);

      html += `<div class="section"><div class="section-head"><h2>Conflict Status Chart</h2>
        <span class="hint">Theatre · Phase · Trend · Progress to date · Conflict Status — click a header to sort</span></div>${this.statusMatrix(period, ids)}</div>`;

      // charts row
      html += `<div class="section"><div class="section-head"><h2>Analytics</h2></div>${this.chartLayout(horizon)}</div>`;

      if (horizon === "weekly") {
        html += `<div class="section">
          <div class="section-head"><h2>Key Developments</h2>
            <div class="head-actions">
              <button class="btn" data-action="expand-all">Expand all</button>
              <button class="btn" data-action="collapse-all">Collapse all</button>
            </div></div>
          <div class="theatre-grid">${ids.map((id, i) => this.theatreCard(period, id, i)).join("") || `<div class="empty">No theatres match the current filters.</div>`}</div>
        </div>`;
      } else {
        html += `<div class="section"><div class="section-head"><h2>Theatre Comparison Summary</h2>
          <span class="hint">Rolled-up trend shifts &amp; most significant development pill by theatre</span></div>
          ${this.comparisonTable(period, ids)}</div>`;
        html += `<div class="section">
          <div class="section-head"><h2>Theatre Detail</h2>
            <div class="head-actions">
              <button class="btn" data-action="expand-all">Expand all</button>
              <button class="btn" data-action="collapse-all">Collapse all</button>
            </div></div>
          <div class="theatre-grid">${ids.map((id, i) => this.theatreCard(period, id, i)).join("") || `<div class="empty">No theatres match the current filters.</div>`}</div>`;
        html += this.drilldown(period);
      }

      html += this.watchPanel(period, ids, days);

      container.innerHTML = html;
      Charts.renderFor(horizon, period, ids);
      this.wireCardEvents(container);
      this.wireSortable(container, period);
    },

    chartLayout(horizon) {
      if (horizon === "weekly") {
        return `<div class="chart-grid">
          <div class="card chart-card"><h3>Weekly status matrix</h3><div class="chart-sub">Conflict status score by theatre, selected week</div><div class="chart-holder"><canvas id="c-status"></canvas></div></div>
          <div class="card chart-card"><h3>Timeline (all weeks)</h3><div class="chart-sub">Status score trajectory across the loaded weeks</div><div class="chart-holder"><canvas id="c-timeline"></canvas></div></div>
          <div class="card chart-card"><h3>Development-pill frequency by theatre</h3><div class="chart-sub">Which domain most often became the development pill</div><div class="chart-holder"><canvas id="c-domain"></canvas></div></div>
          <div class="card chart-card"><h3>Domain mix this week</h3><div class="chart-sub">Development-pill domain across theatres this week</div><div class="chart-holder"><canvas id="c-weekmix"></canvas></div></div>
        </div>`;
      }
      if (horizon === "monthly") {
        return `<div class="chart-grid">
          <div class="card chart-card"><h3>Monthly trend comparison</h3><div class="chart-sub">Weekly status scores within the month, by theatre</div><div class="chart-holder"><canvas id="c-trend"></canvas></div></div>
          <div class="card chart-card"><h3>Development-pill frequency</h3><div class="chart-sub">Dominant domains across the month, by theatre</div><div class="chart-holder"><canvas id="c-domain"></canvas></div></div>
        </div>`;
      }
      return `<div class="chart-grid">
        <div class="card chart-card"><h3>Quarterly escalation / stability overview</h3><div class="chart-sub">Average status by theatre per month</div><div class="chart-holder"><canvas id="c-escal"></canvas></div></div>
        <div class="card chart-card"><h3>Phase progression</h3><div class="chart-sub">Status-score trajectory across the quarter</div><div class="chart-holder"><canvas id="c-timeline"></canvas></div></div>
        <div class="card chart-card"><h3>Most significant domain patterns by theatre</h3><div class="chart-sub">Development-pill frequency across the quarter</div><div class="chart-holder"><canvas id="c-domain"></canvas></div></div>
      </div>`;
    },

    // Collapsible theatre cards + expand/collapse all
    wireCardEvents(root) {
      root.querySelectorAll(".tc-head").forEach(head => {
        const toggle = () => {
          const card = head.closest(".theatre-card");
          const open = card.getAttribute("data-open") === "true";
          card.setAttribute("data-open", String(!open));
          head.setAttribute("aria-expanded", String(!open));
        };
        head.addEventListener("click", toggle);
        head.addEventListener("keydown", e => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
        });
      });
      root.querySelectorAll('[data-action="expand-all"]').forEach(b =>
        b.addEventListener("click", () => root.querySelectorAll(".theatre-card").forEach(c => {
          c.setAttribute("data-open", "true"); c.querySelector(".tc-head").setAttribute("aria-expanded", "true");
        })));
      root.querySelectorAll('[data-action="collapse-all"]').forEach(b =>
        b.addEventListener("click", () => root.querySelectorAll(".theatre-card").forEach(c => {
          c.setAttribute("data-open", "false"); c.querySelector(".tc-head").setAttribute("aria-expanded", "false");
        })));
    },

    // Sortable status matrix
    wireSortable(root, period) {
      const table = root.querySelector("#status-matrix");
      if (!table) return;
      let sortKey = null, asc = true;
      table.querySelectorAll("thead th").forEach(th => {
        th.addEventListener("click", () => {
          const key = th.getAttribute("data-sort");
          asc = sortKey === key ? !asc : true;
          sortKey = key;
          const ids = Filters.apply(period);
          const val = (id) => {
            const e = period.theatres[id];
            switch (key) {
              case "name": return THEATRE_BY_ID[id].name;
              case "phase": return e.phase;
              case "trend": return e.trend;
              case "score": return e.conflictStatusScore;
              case "status": return e.statusLabel;
              default: return 0;
            }
          };
          ids.sort((a, b) => {
            const va = val(a), vb = val(b);
            const cmp = typeof va === "number" ? va - vb : String(va).localeCompare(String(vb));
            return asc ? cmp : -cmp;
          });
          const tbody = table.querySelector("tbody");
          tbody.innerHTML = ids.map(id => {
            const e = period.theatres[id], t = THEATRE_BY_ID[id];
            return `<tr><td class="theatre-cell">${esc(t.name)}<div style="font-size:11px;color:var(--text-faint)">${esc(t.region)}</div></td>
              <td>${this.phaseTag(e.phase)}</td><td>${this.trendChip(e.trend)}</td>
              <td><div style="font-size:12px;max-width:280px">${esc(e.progressToDate)}</div><div class="progress-mini" title="Conflict status score ${e.conflictStatusScore}/100"><span style="width:${e.conflictStatusScore}%;background:${this.scoreColor(e.conflictStatusScore)}"></span></div></td>
              <td>${this.statusChip(e.statusLabel)}</td></tr>`;
          }).join("");
          table.querySelectorAll(".sort-ind").forEach(s => s.textContent = "");
          th.querySelector(".sort-ind").textContent = asc ? "▲" : "▼";
        });
      });
    }
  };

  /* ----------------------------------------------------------------------
   * 8. CHARTS  (Chart.js)
   * -------------------------------------------------------------------- */
  const Charts = {
    registry: {},
    palette: ["#1f5fa8", "#a01f2e", "#1d6b4c", "#8a5a00", "#5a3da8"],
    domainPalette: {
      "Fires & Strikes": "#a01f2e", "Intelligence": "#1f5fa8", "Manoeuvre": "#1d6b4c",
      "Protection": "#8a5a00", "Sustainment": "#5a3da8", "Command & Control": "#0f8a8a"
    },
    css(v) { return getComputedStyle(document.body).getPropertyValue(v).trim(); },
    baseOpts() {
      const grid = this.css("--border");
      const text = this.css("--text-muted");
      return {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { labels: { color: text, boxWidth: 12, font: { size: 10 } } } },
        scales: {
          x: { ticks: { color: text, font: { size: 10 } }, grid: { color: grid } },
          y: { ticks: { color: text, font: { size: 10 } }, grid: { color: grid } }
        }
      };
    },
    destroyAll() { Object.values(this.registry).forEach(c => c && c.destroy()); this.registry = {}; },
    make(id, cfg) {
      const cv = document.getElementById(id);
      if (!cv || typeof Chart === "undefined") return;
      this.registry[id] = new Chart(cv.getContext("2d"), cfg);
    },

    // counts of pill-domain across a set of weekly reports, per theatre
    domainFreq(weeks) {
      const data = {};
      DB.theatres.forEach(t => { data[t.id] = {}; DB.definitions.domains.forEach(d => data[t.id][d] = 0); });
      weeks.forEach(w => DB.theatres.forEach(t => {
        const e = w.theatres[t.id]; if (e) data[t.id][e.selectedDevelopmentPill.domain]++;
      }));
      return data;
    },

    renderFor(horizon, period, ids) {
      this.destroyAll();
      const labelsT = ids.map(id => THEATRE_BY_ID[id].short);

      if (horizon === "weekly") {
        // status bar
        this.make("c-status", {
          type: "bar",
          data: { labels: labelsT, datasets: [{ label: "Status score",
            data: ids.map(id => period.theatres[id].conflictStatusScore),
            backgroundColor: ids.map(id => Render.scoreColor(period.theatres[id].conflictStatusScore)) }] },
          options: Object.assign(this.baseOpts(), { plugins: { legend: { display: false } }, scales: Object.assign(this.baseOpts().scales, { y: Object.assign(this.baseOpts().scales.y, { max: 100 }) }) })
        });
        // timeline across all weeks
        this.timeline(ids);
        // domain frequency across all weeks
        this.domainStacked("c-domain", DB.weeklyReports, ids);
        // week mix doughnut
        const mix = {}; DB.definitions.domains.forEach(d => mix[d] = 0);
        ids.forEach(id => mix[period.theatres[id].selectedDevelopmentPill.domain]++);
        const dl = Object.keys(mix).filter(d => mix[d] > 0);
        this.make("c-weekmix", {
          type: "doughnut",
          data: { labels: dl, datasets: [{ data: dl.map(d => mix[d]), backgroundColor: dl.map(d => this.domainPalette[d]) }] },
          options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "right", labels: { color: this.css("--text-muted"), font: { size: 10 }, boxWidth: 12 } } } }
        });
      }

      if (horizon === "monthly") {
        // weekly scores within month, per theatre
        const weeks = period.weekIds.map(wid => DB.weeklyReports.find(w => w.weekId === wid));
        this.make("c-trend", {
          type: "line",
          data: { labels: weeks.map(w => w.weekId),
            datasets: ids.map((id, i) => ({ label: THEATRE_BY_ID[id].short,
              data: weeks.map(w => w.theatres[id].conflictStatusScore),
              borderColor: this.palette[i % this.palette.length], backgroundColor: "transparent", tension: .3 })) },
          options: this.baseOpts()
        });
        this.domainStacked("c-domain", weeks, ids);
      }

      if (horizon === "quarterly") {
        const months = period.monthIds.map(mid => MONTHS.find(m => m.id === mid));
        this.make("c-escal", {
          type: "bar",
          data: { labels: months.map(m => m.label),
            datasets: ids.map((id, i) => ({ label: THEATRE_BY_ID[id].short,
              data: months.map(m => m.theatres[id].conflictStatusScore),
              backgroundColor: this.palette[i % this.palette.length] })) },
          options: this.baseOpts()
        });
        this.timeline(ids);
        const weeks = period.weekIds.map(wid => DB.weeklyReports.find(w => w.weekId === wid));
        this.domainStacked("c-domain", weeks, ids);
      }
    },

    timeline(ids) {
      const weeks = DB.weeklyReports;
      this.make("c-timeline", {
        type: "line",
        data: { labels: weeks.map(w => w.weekId.replace("2026-", "")),
          datasets: ids.map((id, i) => ({ label: THEATRE_BY_ID[id].short,
            data: weeks.map(w => w.theatres[id].conflictStatusScore),
            borderColor: this.palette[i % this.palette.length], backgroundColor: "transparent", tension: .3, pointRadius: 2 })) },
        options: this.baseOpts()
      });
    },

    domainStacked(canvasId, weeks, ids) {
      const freq = this.domainFreq(weeks);
      this.make(canvasId, {
        type: "bar",
        data: {
          labels: ids.map(id => THEATRE_BY_ID[id].short),
          datasets: DB.definitions.domains.map(d => ({
            label: d, data: ids.map(id => freq[id][d]), backgroundColor: this.domainPalette[d]
          }))
        },
        options: Object.assign(this.baseOpts(), {
          scales: { x: Object.assign(this.baseOpts().scales.x, { stacked: true }),
                    y: Object.assign(this.baseOpts().scales.y, { stacked: true }) }
        })
      });
    }
  };

  /* ----------------------------------------------------------------------
   * 9. EXPORT
   * -------------------------------------------------------------------- */
  const Export = {
    currentViewObject() {
      const p = Render.currentPeriod();
      return {
        generatedAt: new Date().toISOString(),
        mode: State.mode,
        division: State.mode === "division" ? DIV_BY_ID[State.division].name : null,
        horizon: State.horizon,
        period: { id: p.weekId || p.id, range: Time.fmtRange(p.weekStart || p.start, p.weekEnd || p.end) },
        bluf: p.bluf,
        theatres: Filters.apply(p).map(id => {
          const e = p.theatres[id];
          const base = {
            theatre: THEATRE_BY_ID[id].name, phase: e.phase, trend: e.trend,
            progressToDate: e.progressToDate, conflictStatusScore: e.conflictStatusScore,
            statusLabel: e.statusLabel, developmentPill: e.selectedDevelopmentPill,
            keyDevelopments: e.keyDevelopments, watchAreas: e.watchAreas, tags: e.tags
          };
          if (State.mode === "division") base.divisionTailoring = Division.tailor(DIV_BY_ID[State.division], e, id);
          return base;
        })
      };
    },
    download(name, type, content) {
      const blob = new Blob([content], { type });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = name; document.body.appendChild(a); a.click();
      a.remove(); URL.revokeObjectURL(url);
    },
    json() {
      const obj = this.currentViewObject();
      this.download(`conflict-${State.horizon}-${obj.period.id}.json`, "application/json", JSON.stringify(obj, null, 2));
    },
    csv() {
      const obj = this.currentViewObject();
      const cols = ["theatre", "phase", "trend", "progressToDate", "conflictStatusScore", "statusLabel", "developmentPillDomain", "developmentPillHeadline", "watchAreas"];
      const q = (s) => `"${String(s == null ? "" : s).replace(/"/g, '""')}"`;
      const rows = obj.theatres.map(t => [
        t.theatre, t.phase, t.trend, t.progressToDate, t.conflictStatusScore, t.statusLabel,
        t.developmentPill.domain, t.developmentPill.headline, t.watchAreas
      ].map(q).join(","));
      this.download(`conflict-${State.horizon}-${obj.period.id}.csv`, "text/csv", [cols.join(","), ...rows].join("\n"));
    },
    print() { window.print(); }
  };

  /* ----------------------------------------------------------------------
   * 10. APP  — init & event wiring
   * -------------------------------------------------------------------- */
  const App = {
    setActiveView() {
      document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      el(`#view-${State.horizon}`).classList.add("active");
      el(`.tab-btn[data-horizon="${State.horizon}"]`).classList.add("active");
    },

    // Build the period selector contents for the active horizon
    refreshPeriodSelect() {
      const sel = el("#period-select");
      let opts = [];
      if (State.horizon === "weekly")
        opts = DB.weeklyReports.map(w => ({ id: w.weekId, label: `${w.weekId} · ${Time.fmtRange(w.weekStart, w.weekEnd)}` }));
      else if (State.horizon === "monthly")
        opts = MONTHS.map(m => ({ id: m.id, label: `${m.label} · ${Time.fmtRange(m.start, m.end)}` }));
      else
        opts = QUARTERS.map(qr => ({ id: qr.id, label: `${qr.label} · ${Time.fmtRange(qr.start, qr.end)}` }));

      // default to latest period for the horizon
      if (!opts.find(o => o.id === State.periodId)) State.periodId = opts[opts.length - 1].id;
      sel.innerHTML = opts.map(o => `<option value="${o.id}" ${o.id === State.periodId ? "selected" : ""}>${esc(o.label)}</option>`).join("");
    },

    rerender() {
      this.setActiveView();
      this.refreshPeriodSelect();
      Render.renderActiveView();
    },

    buildFilterControls() {
      // theatre checkboxes
      el("#filter-theatres").innerHTML = DB.theatres.map(t =>
        `<label class="check"><input type="checkbox" value="${t.id}"> ${esc(t.name)}</label>`).join("");
      // phase chips (from definitions)
      el("#filter-phases").innerHTML = Object.keys(DB.definitions.phases).map(p =>
        `<button class="fchip" aria-pressed="false" data-val="${esc(p)}" title="${esc(DB.definitions.phases[p])}">${esc(p)}</button>`).join("");
      // trend chips
      el("#filter-trends").innerHTML = Object.keys(DB.definitions.trends).map(t =>
        `<button class="fchip" aria-pressed="false" data-val="${esc(t)}">${esc(DB.definitions.trends[t].arrow)} ${esc(t)}</button>`).join("");
      // domain chips
      el("#filter-domains").innerHTML = DB.definitions.domains.map(d =>
        `<button class="fchip" aria-pressed="false" data-val="${esc(d)}">${esc(d)}</button>`).join("");
      // division dropdown
      el("#division-select").innerHTML = DB.divisions.map(d =>
        `<option value="${d.id}">${esc(d.name)}</option>`).join("");
    },

    wire() {
      // horizon tabs
      document.querySelectorAll(".tab-btn").forEach(b =>
        b.addEventListener("click", () => { State.horizon = b.dataset.horizon; this.rerender(); }));

      // mode switch
      document.querySelectorAll('[data-mode]').forEach(b =>
        b.addEventListener("click", () => {
          State.mode = b.dataset.mode;
          document.querySelectorAll('[data-mode]').forEach(x => x.setAttribute("aria-selected", String(x === b)));
          el("#division-wrap").classList.toggle("show", State.mode === "division");
          this.rerender();
        }));
      el("#division-select").addEventListener("change", e => { State.division = e.target.value; this.rerender(); });

      // period select + date picker
      el("#period-select").addEventListener("change", e => { State.periodId = e.target.value; Render.renderActiveView(); });
      el("#date-jump").addEventListener("change", e => {
        const w = Time.weekForDate(e.target.value);
        if (w) { State.horizon = "weekly"; State.periodId = w.weekId; this.rerender(); }
      });

      // search
      el("#search").addEventListener("input", e => { State.filters.search = e.target.value; Render.renderActiveView(); });

      // theatre checkboxes
      el("#filter-theatres").addEventListener("change", e => {
        if (e.target.matches("input")) {
          const s = State.filters.theatres;
          e.target.checked ? s.add(e.target.value) : s.delete(e.target.value);
          Render.renderActiveView();
        }
      });

      // chip groups (delegated)
      const chipHandler = (containerSel, set) => el(containerSel).addEventListener("click", e => {
        const c = e.target.closest(".fchip"); if (!c) return;
        const on = c.getAttribute("aria-pressed") === "true";
        c.setAttribute("aria-pressed", String(!on));
        on ? set.delete(c.dataset.val) : set.add(c.dataset.val);
        Render.renderActiveView();
      });
      chipHandler("#filter-phases", State.filters.phases);
      chipHandler("#filter-trends", State.filters.trends);
      chipHandler("#filter-domains", State.filters.domains);

      // reset
      el("#reset-filters").addEventListener("click", () => {
        Filters.reset();
        document.querySelectorAll('#filter-theatres input').forEach(i => i.checked = false);
        document.querySelectorAll('.fchip').forEach(c => c.setAttribute("aria-pressed", "false"));
        el("#search").value = "";
        Render.renderActiveView();
      });

      // theme toggle
      el("#theme-toggle").addEventListener("click", () => {
        State.theme = State.theme === "light" ? "dark" : "light";
        document.documentElement.setAttribute("data-theme", State.theme);
        el("#theme-toggle").textContent = State.theme === "light" ? "🌙" : "☀️";
        Render.renderActiveView(); // re-theme charts
      });

      // exports
      el("#export-json").addEventListener("click", () => Export.json());
      el("#export-csv").addEventListener("click", () => Export.csv());
      el("#export-print").addEventListener("click", () => Export.print());
    },

    async init() {
      try {
        DB = await loadData();
      } catch (err) {
        el("#boot-error").style.display = "block";
        el("#boot-error").innerHTML =
          `<strong>Could not load sample-data.json.</strong> Browsers block <code>fetch()</code> from the <code>file://</code> protocol. ` +
          `Run a tiny static server in this folder and open via http, e.g.<br><code>python3 -m http.server 8000</code> then visit ` +
          `<code>http://localhost:8000/conflict-dashboard.html</code>. (Original error: ${esc(err.message)})`;
        return;
      }
      DB.theatres.forEach(t => THEATRE_BY_ID[t.id] = t);
      DB.divisions.forEach(d => DIV_BY_ID[d.id] = d);
      MONTHS = Agg.buildMonths();
      QUARTERS = Agg.buildQuarters();

      // header meta
      el("#meta-updated").textContent = Time.fmtDateTime(DB.meta.lastUpdated);

      this.buildFilterControls();
      this.wire();
      this.rerender();
    }
  };

  document.addEventListener("DOMContentLoaded", () => App.init());
})();
