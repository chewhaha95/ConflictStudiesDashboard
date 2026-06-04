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
    horizon: "weekly",        // 'weekly' | 'monthly' | 'quarterly' | 'capabilities'
    periodId: null,           // active week/month/quarter id
    formationGroup: "ALL",    // monthly tab: 'ALL' | formation-group id
    monthlyEchelon: "ALL",    // monthly group panel: 'ALL' | Brigade | Battalion | Company
    theme: "light",
    filters: {
      theatres:  new Set(),   // empty => all
      phases:    new Set(),
      trends:    new Set(),
      domains:   new Set(),
      lifecycle: new Set(),   // capabilities view: lifecycle status filter
      search:    ""
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
      State.filters.lifecycle.clear();
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
      if (State.horizon === "weekly") {
        if (DB.liveEditions) return DB.liveEditions.find(e => e.weekId === State.periodId) || DB.liveEditions[0];
        return DB.weeklyReports.find(w => w.weekId === State.periodId);
      }
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
      const showScore = State.horizon !== "weekly";   // weekly mirrors the brief (no status score)
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
              ${showScore ? `<div class="progress-mini" title="Conflict status score ${e.conflictStatusScore}/100"><span style="width:${e.conflictStatusScore}%;background:${this.scoreColor(e.conflictStatusScore)}"></span></div>` : ""}
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

      // Weekly tab mirrors the brief: verbatim development blocks (domain pills →
      // headline → narrative → "Implication [...]"), no six-domain breakdown.
      const isWeekly = State.horizon === "weekly";
      const briefDev = (d) => `
        <div class="brief-dev">
          ${(d.pills || []).length ? `<div class="brief-pills">${d.pills.map(p => `<span class="pill">${esc(p)}</span>`).join("")}</div>` : ""}
          <div class="brief-headline">${esc(d.headline)}</div>
          ${(d.paragraphs || []).map(p => `<p class="brief-narr">${esc(p)}</p>`).join("")}
          ${(d.implicationBullets || []).length ? `<div class="brief-impl">
            <div class="brief-impl-label">${esc(d.implicationLabel || ("Implication [" + pillDomain + "]"))}</div>
            <ul>${d.implicationBullets.map(b => `<li>${esc(b)}</li>`).join("")}</ul>
          </div>` : ""}
        </div>`;

      let keyDevSection;
      if (isWeekly) {
        const devs = (e.developments && e.developments.length) ? e.developments : [{
          pills: [pillDomain],
          headline: e.selectedDevelopmentPill.headline,
          paragraphs: [e.selectedDevelopmentPill.rationale],
          implicationLabel: `Implication [${pillDomain}]`,
          implicationBullets: [implication]
        }];
        const seedList = (!e.developments && (e.keyDevelopments || []).length > 1)
          ? `<div class="subhead">Key developments</div><ul class="dev-list">${devList}</ul>` : "";
        keyDevSection = seedList + devs.map(briefDev).join("");
      } else {
        keyDevSection = `
            <div class="subhead">Key developments</div>
            <ul class="dev-list">${devList}</ul>
            ${persistent}

            <details class="domains" open>
              <summary>Domain Analysis — six domains (development pill marked ★)</summary>
              <div class="domain-grid">${domainGrid}</div>
            </details>

            <div class="dev-pill">
              <span class="pill-flag tip" tabindex="0">★ Development Pill — Implication
                <span class="tip-body">The single most significant analytical domain for this period — named after the six-domain analysis above.</span>
              </span>
              <div class="pill-domain">${esc(pillDomain)}</div>
              <div class="pill-headline">${esc(e.selectedDevelopmentPill.headline)}</div>
              <div class="pill-rationale">${esc(e.selectedDevelopmentPill.rationale)}</div>
              <div class="pill-implication"><strong>Implication (${esc(pillDomain)}):</strong> ${esc(implication)}</div>
              ${tailor ? `<div class="pill-rationale"><em>${esc(div.name)} reads this primarily through ${esc(pillDomain)}.</em></div>` : ""}
            </div>`;
      }

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
              ${isWeekly ? "" : `<div class="kv"><div class="k">Status score</div><div class="v">${e.conflictStatusScore}/100</div></div>`}
            </div>

            ${keyDevSection}

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
      // Capabilities & Countermeasures is a cross-cutting analytics view,
      // not tied to a weekly/monthly/quarterly period.
      if (State.horizon === "capabilities") { Caps.render(); return; }
      if (State.horizon === "monthly") { Monthly.render(); return; }
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

      // brief-edition banner (weekly tab, synced from the brief site)
      if (DB.liveEditions && DB.liveEditions.includes(period)) {
        const isLatest = period === DB.liveEditions[0];
        const src = period.sourceUrl || DB.liveWeek.sourceUrl;
        html += `<div class="note-banner live-banner">` +
          (isLatest
            ? `<strong>● LIVE</strong> — current edition synced from <a href="${esc(src)}" target="_blank" rel="noopener">conflictstudiesandinsights.pages.dev</a>${DB.liveSyncedAt ? ` · last synced ${esc(Time.fmtDateTime(DB.liveSyncedAt))}` : ""}.`
            : `<strong>Archived edition</strong> · ${esc(period.rangeLabel || "")} — from <a href="${esc(src)}" target="_blank" rel="noopener">the brief archive</a>.`) +
          ` Use the Period selector to browse other editions.</div>`;
      }

      // mode banner
      if (State.mode === "division") {
        const d = DIV_BY_ID[State.division];
        html += `<div class="note-banner"><strong>Division View — ${esc(d.name)}.</strong> ${esc(d.doctrinalAssumption)} Lens: ${esc(d.lens)}</div>`;
      }

      html += this.bluf(period, watchLabel);

      html += `<div class="section"><div class="section-head"><h2>Conflict Status Chart</h2>
        <span class="hint">Theatre · Phase · Trend · Progress to date · Conflict Status — click a header to sort</span></div>${this.statusMatrix(period, ids)}</div>`;

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
      Charts.destroyAll();   // clear any charts from a previous view
      this.wireCardEvents(container);
      this.wireSortable(container, period);
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
          const showScore = State.horizon !== "weekly";
          tbody.innerHTML = ids.map(id => {
            const e = period.theatres[id], t = THEATRE_BY_ID[id];
            return `<tr><td class="theatre-cell">${esc(t.name)}<div style="font-size:11px;color:var(--text-faint)">${esc(t.region)}</div></td>
              <td>${this.phaseTag(e.phase)}</td><td>${this.trendChip(e.trend)}</td>
              <td><div style="font-size:12px;max-width:280px">${esc(e.progressToDate)}</div>${showScore ? `<div class="progress-mini" title="Conflict status score ${e.conflictStatusScore}/100"><span style="width:${e.conflictStatusScore}%;background:${this.scoreColor(e.conflictStatusScore)}"></span></div>` : ""}</td>
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
    }
    // (Capabilities-tab charts are built in the Caps module; the Weekly/Monthly/
    //  Quarterly tabs intentionally have no charts.)
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
    // Capabilities view exports the filtered capability set
    capabilitiesObject() {
      return {
        generatedAt: new Date().toISOString(),
        view: "capabilities",
        mode: State.mode,
        division: State.mode === "division" ? DIV_BY_ID[State.division].name : null,
        note: "computedHeat & computedTrend are derived from weekly capability observations.",
        capabilities: Caps.list().map(c => Object.assign({}, c, {
          computedHeat: Caps.heatOf(c), computedTrend: Caps.trendOf(c), observations: Caps.observations(c)
        }))
      };
    },
    json() {
      if (State.horizon === "capabilities") {
        this.download("capabilities.json", "application/json", JSON.stringify(this.capabilitiesObject(), null, 2));
        return;
      }
      const obj = this.currentViewObject();
      this.download(`conflict-${State.horizon}-${obj.period.id}.json`, "application/json", JSON.stringify(obj, null, 2));
    },
    csv() {
      const q = (s) => `"${String(s == null ? "" : s).replace(/"/g, '""')}"`;
      if (State.horizon === "capabilities") {
        const cols = ["name", "aka", "category", "role", "domain", "theatres", "lifecycle", "computedHeat", "computedTrend", "observations", "vector", "counteredBy", "supersededBy", "timeToCounterDays", "confidence"];
        const rows = Caps.list().map(c => [
          c.name, c.aka, c.category, c.role, c.domain, c.theatres.join("|"), c.lifecycle, Caps.heatOf(c), Caps.trendOf(c), Caps.observations(c),
          c.vector, (c.counteredBy || []).map(id => Caps.name(id)).join("|"),
          (c.supersededBy || []).map(id => Caps.name(id)).join("|"), c.timeToCounterDays, c.confidence
        ].map(q).join(","));
        this.download("capabilities.csv", "text/csv", [cols.join(","), ...rows].join("\n"));
        return;
      }
      const obj = this.currentViewObject();
      const cols = ["theatre", "phase", "trend", "progressToDate", "conflictStatusScore", "statusLabel", "developmentPillDomain", "developmentPillHeadline", "watchAreas"];
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
  /* ----------------------------------------------------------------------
   * 8b. CAPABILITIES & COUNTERMEASURES  (measure–countermeasure observatory)
   *     Tracks capabilities as first-class objects: lifecycle, heat, the
   *     measure⇄countermeasure web, proliferation across theatres, supersession
   *     chains, and adaptation tempo (time-to-counter). Answers "what's hot,
   *     what's rising, and what has been superseded".
   * -------------------------------------------------------------------- */
  const Caps = {
    lcPalette: {
      emerging: "#1f5fa8", scaling: "#8a5a00", peak: "#a01f2e",
      maturing: "#5a6679", superseded: "#1d6b4c", obsolete: "#8a93a3"
    },
    byId(id) { return DB.capabilities.find(c => c.id === id); },
    name(id) { const c = this.byId(id); return c ? c.name : id; },

    // Computed dynamics: heat & trend are derived from the weekly capability
    // signals, NOT stored. Heat = recency-weighted sum of observation intensity,
    // normalised 0-100 across capabilities. Trend = recent-half vs earlier-half
    // activity. Falls back to the declared baseline only if a capability has no
    // observations. Call once after data load (App.init).
    dynamics: {},
    computeDynamics() {
      const weeks = DB.weeklyReports, n = weeks.length;
      const sig = DB.weeklyCapabilitySignals || {};
      const wgt = i => 0.55 + 0.45 * (n > 1 ? i / (n - 1) : 1);   // recency weighting
      const rw = arr => arr.reduce((s, v, i) => s + v * wgt(i), 0);
      const m = {};
      DB.capabilities.forEach(c => (m[c.id] = { weekly: new Array(n).fill(0), tw: {}, signals: 0 }));
      weeks.forEach((w, idx) => (sig[w.weekId] || []).forEach(s => {
        const d = m[s.id]; if (!d) return;
        d.weekly[idx] += (s.i || 1); d.signals++;
        (d.tw[s.t] = d.tw[s.t] || new Array(n).fill(0))[idx] += (s.i || 1);
      }));
      // recency-weighted raw heat, then normalise to 0-100 across capabilities
      let max = 0; const raw = {};
      DB.capabilities.forEach(c => { const r = rw(m[c.id].weekly); raw[c.id] = r; if (r > max) max = r; });
      const scale = max > 0 ? 96 / max : 0;
      const half = Math.max(1, Math.floor(n / 2));
      DB.capabilities.forEach(c => {
        const d = m[c.id];
        d.heat = d.signals === 0 ? c.heat : Math.round(raw[c.id] * scale);
        // per-theatre heat contribution (segments sum to total heat)
        d.byTheatre = {};
        Object.keys(d.tw).forEach(t => (d.byTheatre[t] = Math.round(rw(d.tw[t]) * scale)));
        const earlier = d.weekly.slice(0, half).reduce((a, b) => a + b, 0);
        const recent = d.weekly.slice(n - half).reduce((a, b) => a + b, 0);
        d.earlier = earlier; d.recent = recent;
        if (d.signals === 0) d.trend = c.trend;
        else if (recent > earlier * 1.25 + 0.5) d.trend = "Rising";
        else if (recent < earlier * 0.75) d.trend = "Declining";
        else d.trend = "Steady";
      });
      this.dynamics = m;
    },
    theatreHeatOf(c, t) { const d = this.dynamics[c.id]; return d && d.byTheatre ? (d.byTheatre[t] || 0) : 0; },
    // Theatres in scope = the active theatre filter, or all five if none set
    selectedTheatreIds() {
      return State.filters.theatres.size
        ? DB.theatres.filter(t => State.filters.theatres.has(t.id)).map(t => t.id)
        : DB.theatres.map(t => t.id);
    },
    scopedHeat(c, tids) { return tids.reduce((s, t) => s + this.theatreHeatOf(c, t), 0); },
    theatreColor(id) { return Charts.palette[DB.theatres.findIndex(t => t.id === id) % Charts.palette.length]; },
    // The hottest capability in each (in-scope) theatre, by per-theatre heat
    theatreLeaders(list, tids) {
      return tids.map(t => {
        let best = null, bh = -1;
        list.forEach(c => { const h = this.theatreHeatOf(c, t); if (h > bh) { bh = h; best = c; } });
        return { t, cap: best, heat: bh };
      }).filter(x => x.cap && x.heat > 0);
    },
    heatOf(c) { const d = this.dynamics[c.id]; return d ? d.heat : c.heat; },
    trendOf(c) { const d = this.dynamics[c.id]; return d ? d.trend : c.trend; },
    observations(c) { const d = this.dynamics[c.id]; return d ? d.signals : 0; },
    // Inline SVG sparkline of weekly observation intensity (shows heat is computed)
    sparkline(c) {
      const d = this.dynamics[c.id]; if (!d) return "";
      const w = 64, h = 16, max = Math.max(1, ...d.weekly), n = d.weekly.length;
      const pts = d.weekly.map((v, i) => `${(i / (n - 1)) * (w - 2) + 1},${h - 1 - (v / max) * (h - 3)}`).join(" ");
      const tone = (DB.capabilityDefs.lifecycle[c.lifecycle] || {}).tone || "maturing";
      return `<svg class="sparkline lc-stroke-${tone}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline points="${pts}" fill="none" stroke-width="1.5"/></svg>`;
    },

    // Apply the shared theatre/domain/search filters + the lifecycle filter
    list() {
      const f = State.filters;
      const q = f.search.trim().toLowerCase();
      return DB.capabilities.filter(c => {
        if (f.theatres.size && !c.theatres.some(t => f.theatres.has(t))) return false;
        if (f.domains.size && !f.domains.has(c.domain)) return false;
        if (f.lifecycle.size && !f.lifecycle.has(c.lifecycle)) return false;
        if (q && ![c.name, c.aka, c.category, c.note, c.saf, c.role, c.vector]
          .join(" ").toLowerCase().includes(q)) return false;
        return true;
      });
    },

    // ---- derived analytics ----
    heatRanking(list) { return [...list].sort((a, b) => this.heatOf(b) - this.heatOf(a)); },
    lifecycleDist(list) {
      const o = {}; Object.keys(DB.capabilityDefs.lifecycle).forEach(k => o[k] = 0);
      list.forEach(c => o[c.lifecycle]++); return o;
    },
    vectorDist(list) {
      const o = {}; Object.keys(DB.capabilityDefs.vectors).forEach(k => o[k] = 0);
      list.forEach(c => o[c.vector]++); return o;
    },
    theatreAdoption(list) {
      const o = {};
      DB.theatres.forEach(t => { o[t.id] = {}; Object.keys(DB.capabilityDefs.lifecycle).forEach(k => o[t.id][k] = 0); });
      list.forEach(c => c.theatres.forEach(t => { if (o[t]) o[t][c.lifecycle]++; }));
      return o;
    },
    pairs(list) {
      return list.filter(c => c.role !== "Countermeasure" && c.counteredBy && c.counteredBy.length)
        .map(c => ({ measure: c, counters: c.counteredBy.map(id => this.byId(id)).filter(Boolean) }))
        .sort((a, b) => this.heatOf(b.measure) - this.heatOf(a.measure));
    },
    uncountered(list) {
      return this.heatRanking(list.filter(c => c.role !== "Countermeasure" && (!c.counteredBy || !c.counteredBy.length)));
    },
    supersession(list) {
      return list.filter(c => c.supersededBy && c.supersededBy.length)
        .map(c => ({ from: c, to: c.supersededBy.map(id => this.byId(id)).filter(Boolean) }));
    },
    diffusion(list) {
      return list.filter(c => c.theatres.length > 1).sort((a, b) => b.theatres.length - a.theatres.length || this.heatOf(b) - this.heatOf(a));
    },
    adaptationTempo(list) {
      const m = list.filter(c => typeof c.timeToCounterDays === "number");
      const avg = m.length ? Math.round(m.reduce((s, c) => s + c.timeToCounterDays, 0) / m.length) : 0;
      return { items: [...m].sort((a, b) => a.timeToCounterDays - b.timeToCounterDays), avg };
    },

    // ---- small UI helpers ----
    lcChip(lc) {
      const tone = (DB.capabilityDefs.lifecycle[lc] || {}).tone || "maturing";
      const tip = (DB.capabilityDefs.lifecycle[lc] || {}).desc || "";
      return `<span class="lc-chip lc-${tone} tip" tabindex="0">${esc(lc)}<span class="tip-body">${esc(tip)}</span></span>`;
    },
    capTrend(t) {
      const map = { Rising: ["↑", "bad"], Steady: ["→", "neutral"], Declining: ["↓", "good"] };
      const [arrow, tone] = map[t] || ["→", "neutral"];
      return `<span class="trend tone-${tone}"><span class="arrow">${arrow}</span>${esc(t)}</span>`;
    },
    theatreChips(ids) {
      return ids.map(id => `<span class="t-chip" title="${esc(THEATRE_BY_ID[id].name)}">${esc(THEATRE_BY_ID[id].short)}</span>`).join("");
    },
    capChipLink(c) {
      return `<span class="cap-ref lc-dot-${(DB.capabilityDefs.lifecycle[c.lifecycle] || {}).tone}">${esc(c.name)}</span>`;
    },

    // Is this capability a priority domain for the active division?
    isDivPriority(c) {
      if (State.mode !== "division") return false;
      const div = DIV_BY_ID[State.division];
      return div.emphasizedDomains.includes(c.domain);
    },

    render() {
      const root = el("#view-capabilities .view-body");
      const all = this.list();
      const div = State.mode === "division" ? DIV_BY_ID[State.division] : null;

      el("#meta-range").textContent = "All loaded periods";

      // ---- dynamic BLUF ----
      const ranked = this.heatRanking(all);
      const hot = ranked.slice(0, 4).map(c => c.name);
      const rising = all.filter(c => this.trendOf(c) === "Rising").map(c => c.name);
      const fading = all.filter(c => ["Superseded", "Obsolete"].includes(c.lifecycle) || this.trendOf(c) === "Declining").map(c => c.name);
      const tempo = this.adaptationTempo(all);
      const unc = this.uncountered(all);

      let html = "";
      if (div) {
        html += `<div class="note-banner"><strong>Division View — ${esc(div.name)}.</strong> ${esc(div.doctrinalAssumption)} ` +
          `Capabilities in this division's priority domains (${esc(div.emphasizedDomains.join(", "))}) are flagged ★.</div>`;
      }

      html += `<div class="card bluf-card card-pad section">
        <div class="bluf-label">BLUF — Capability Picture</div>
        <p><strong>Hot now:</strong> ${esc(hot.join(", ") || "—")}.
        <strong>Rising:</strong> ${esc(rising.slice(0, 5).join(", ") || "—")}.
        <strong>Fading / superseded:</strong> ${esc(fading.slice(0, 5).join(", ") || "—")}.</p>
        <div class="bluf-sub">${all.length} capabilities tracked · mean time-to-counter ${tempo.avg} days · ${unc.length} currently un-countered measure(s)</div>
      </div>`;

      // ---- lifecycle filter chips ----
      const lcChips = Object.keys(DB.capabilityDefs.lifecycle).map(lc =>
        `<button class="fchip lc-filter ${State.filters.lifecycle.has(lc) ? "on" : ""}" aria-pressed="${State.filters.lifecycle.has(lc)}" data-lc="${esc(lc)}">${esc(lc)}</button>`).join("");
      html += `<div class="section"><div class="section-head"><h2>Capabilities &amp; Countermeasures</h2>
        <span class="hint">Theatre / domain / search filters apply from the sidebar</span></div>
        <div class="lc-filter-row">${lcChips}</div></div>`;

      // ---- KPI strip ----
      const kpi = (label, val, sub) => `<div class="kpi"><div class="kpi-val">${val}</div><div class="kpi-label">${esc(label)}</div>${sub ? `<div class="kpi-sub">${esc(sub)}</div>` : ""}</div>`;
      html += `<div class="kpi-strip section">
        ${kpi("Tracked", all.length, "capabilities")}
        ${kpi("Hot (Peak)", ranked.filter(c => c.lifecycle === "Peak").length, "dominant now")}
        ${kpi("Rising", rising.length, "adoption ↑")}
        ${kpi("Un-countered", unc.length, "no effective counter")}
        ${kpi("Adaptation tempo", tempo.avg + "d", "mean time-to-counter")}
      </div>`;

      // ---- charts ----
      html += `<div class="section"><div class="section-head"><h2>Capability Analytics</h2></div>
        <div class="card chart-card chart-wide" style="margin-bottom:14px"><h3>What's hot across the five theatres</h3><div class="chart-sub">Computed heat of leading capabilities, stacked by theatre of employment — re-scopes to the theatre filter</div><div class="chart-holder tall"><canvas id="cap-theatre-heat"></canvas></div>
          <div class="theatre-leaders">${this.theatreLeaders(all, this.selectedTheatreIds()).map(x =>
            `<div class="tl"><span class="tl-dot" style="background:${this.theatreColor(x.t)}"></span><span class="tl-theatre">${esc(THEATRE_BY_ID[x.t].name)}</span><span class="tl-label">hottest:</span> <strong>${esc(x.cap.name)}</strong> <span class="tl-heat">heat ${x.heat}</span> ${this.capTrend(this.trendOf(x.cap))} ${this.lcChip(x.cap.lifecycle)}</div>`).join("")}</div>
        </div>
        <div class="chart-grid">
          <div class="card chart-card"><h3>Heat index (top capabilities)</h3><div class="chart-sub">Current employment intensity, coloured by lifecycle</div><div class="chart-holder"><canvas id="cap-heat"></canvas></div></div>
          <div class="card chart-card"><h3>Lifecycle distribution</h3><div class="chart-sub">Where tracked capabilities sit in their lifecycle</div><div class="chart-holder"><canvas id="cap-lifecycle"></canvas></div></div>
          <div class="card chart-card"><h3>Proliferation by theatre</h3><div class="chart-sub">Capabilities observed per theatre, stacked by lifecycle</div><div class="chart-holder"><canvas id="cap-theatre"></canvas></div></div>
          <div class="card chart-card"><h3>Proliferation vector</h3><div class="chart-sub">How capabilities spread</div><div class="chart-holder"><canvas id="cap-vector"></canvas></div></div>
          <div class="card chart-card"><h3>Adaptation tempo (time-to-counter)</h3><div class="chart-sub">Days from first use to an effective countermeasure — shorter = faster co-evolution</div><div class="chart-holder"><canvas id="cap-tempo"></canvas></div></div>
        </div></div>`;

      // ---- measure ⇄ countermeasure cycles (shown above the leaderboard) ----
      const pairCards = this.pairs(all).map(p => `
        <div class="cycle-card">
          <div class="cycle-measure">${this.lcChip(p.measure.lifecycle)} <strong>${esc(p.measure.name)}</strong>
            ${typeof p.measure.timeToCounterDays === "number" ? `<span class="ttc">countered in ~${p.measure.timeToCounterDays}d</span>` : ""}</div>
          <div class="cycle-arrow">countered by →</div>
          <div class="cycle-counters">${p.counters.map(c => `<span class="counter-chip">${esc(c.name)} ${this.lcChip(c.lifecycle)}</span>`).join("")}</div>
        </div>`).join("");
      const uncCards = this.uncountered(all).map(c =>
        `<span class="counter-chip warn">${esc(c.name)} ${this.lcChip(c.lifecycle)}</span>`).join("");
      html += `<div class="section"><div class="section-head"><h2>Measure ⇄ Countermeasure Cycles</h2>
        <span class="hint">The action–reaction duel and how fast each measure was countered</span></div>
        ${uncCards ? `<div class="card card-pad" style="margin-bottom:12px"><div class="subhead" style="margin-top:0">⚠ Currently un-countered measures — watch closely</div><div class="chip-wrap">${uncCards}</div></div>` : ""}
        <div class="cycle-grid">${pairCards || `<div class="empty">No measure–countermeasure pairs in the current filter.</div>`}</div></div>`;

      // ---- heat leaderboard ----
      const rows = ranked.map((c, i) => {
        const star = this.isDivPriority(c) ? '<span class="prio" title="Priority domain for this division">★</span> ' : "";
        const heat = this.heatOf(c);
        return `<tr>
          <td class="matrix-cell-num">${i + 1}</td>
          <td class="theatre-cell">${star}${esc(c.name)}<div style="font-size:11px;color:var(--text-faint)">${esc(c.aka)} · ${esc(c.category)}</div></td>
          <td><span class="role-tag role-${c.role.toLowerCase()}">${esc(c.role)}</span></td>
          <td>${esc(c.domain)}</td>
          <td>${this.theatreChips(c.theatres)}</td>
          <td>${this.lcChip(c.lifecycle)}</td>
          <td><div class="matrix-cell-num">${heat}</div><div class="progress-mini"><span style="width:${heat}%;background:${this.lcPalette[(DB.capabilityDefs.lifecycle[c.lifecycle] || {}).tone]}"></span></div></td>
          <td>${this.sparkline(c)}<div style="font-size:10px;color:var(--text-faint)">${this.observations(c)} obs</div></td>
          <td>${this.capTrend(this.trendOf(c))}</td>
        </tr>`;
      }).join("");
      const lifeTip = Object.entries(DB.capabilityDefs.lifecycle).sort((a, b) => (a[1].rank || 0) - (b[1].rank || 0))
        .map(([n, d]) => `${n}: ${d.desc}`).join(" ");
      html += `<div class="section"><div class="section-head"><h2>Heat Leaderboard</h2>
        <span class="hint">Heat &amp; adoption are computed from ${DB.weeklyReports.length} weeks of observations — recency-weighted intensity, normalised 0–100; trend = recent vs earlier weeks</span></div>
        <div class="card matrix-wrap"><table class="matrix"><thead><tr>
          <th>#</th><th>Capability</th><th>Role</th><th>Domain</th><th>Theatres</th>
          <th>Lifecycle <span class="th-info tip" tabindex="0">ⓘ<span class="tip-body">${esc(lifeTip)} (hover any chip for its definition.)</span></span></th>
          <th>Heat <span class="th-info tip" tabindex="0">ⓘ<span class="tip-body">Recency-weighted sum of weekly employment intensity (1–3), normalised 0–100 across capabilities; recent weeks weigh ×0.55→×1.0, so the busiest ≈96.</span></span></th>
          <th>Activity (8&nbsp;wk)</th>
          <th>Adoption <span class="th-info tip" tabindex="0">ⓘ<span class="tip-body">Recent half of weeks vs earlier half: Rising &gt; 1.25×, Declining &lt; 0.75×, else Steady.</span></span></th>
        </tr></thead><tbody>${rows || `<tr><td colspan="9"><div class="empty">No capabilities match the filters.</div></td></tr>`}</tbody></table></div></div>`;

      // ---- supersession chains ----
      const supRows = this.supersession(all).map(s =>
        `<div class="sup-row"><span class="sup-from">${esc(s.from.name)} ${this.lcChip(s.from.lifecycle)}</span>
          <span class="sup-arrow">superseded by →</span>
          <span class="sup-to">${s.to.map(t => `${esc(t.name)} ${this.lcChip(t.lifecycle)}`).join(" · ")}</span></div>`).join("");
      html += `<div class="section"><div class="section-head"><h2>Supersession — What Replaced What</h2>
        <span class="hint">The capability "tech tree": measures displaced by newer ones</span></div>
        <div class="card card-pad">${supRows || `<div class="empty">No supersession links in the current filter.</div>`}</div></div>`;

      // ---- cross-theatre proliferation / diffusion ----
      const diff = this.diffusion(all).map(c => `<tr>
        <td class="theatre-cell">${esc(c.name)}</td>
        <td>${this.theatreChips(c.theatres)}</td>
        <td>${esc(c.vector)}</td>
        <td>${this.lcChip(c.lifecycle)}</td>
        <td style="font-size:12px;color:var(--text-muted)">${esc(c.note)}</td>
      </tr>`).join("");
      html += `<div class="section"><div class="section-head"><h2>Cross-Theatre Proliferation</h2>
        <span class="hint">Capabilities observed in more than one theatre, and how they spread</span></div>
        <div class="card matrix-wrap"><table class="cmp-table"><thead><tr><th>Capability</th><th>Theatres</th><th>Vector</th><th>Lifecycle</th><th>Diffusion note</th></tr></thead>
        <tbody>${diff || `<tr><td colspan="5"><div class="empty">No multi-theatre capabilities in the current filter.</div></td></tr>`}</tbody></table></div></div>`;

      root.innerHTML = html;
      this.wire(root);
      this.renderCharts(all);
    },

    wire(root) {
      root.querySelectorAll(".lc-filter").forEach(btn => btn.addEventListener("click", () => {
        const lc = btn.dataset.lc;
        State.filters.lifecycle.has(lc) ? State.filters.lifecycle.delete(lc) : State.filters.lifecycle.add(lc);
        this.render();
      }));
    },

    renderCharts(list) {
      Charts.destroyAll();
      const lcKeys = Object.keys(DB.capabilityDefs.lifecycle);
      const lcColor = lc => this.lcPalette[DB.capabilityDefs.lifecycle[lc].tone];

      // What's hot across the five theatres — top capabilities, stacked by theatre.
      // Re-scopes to the active theatre filter and ranks by heat within scope.
      const tids = this.selectedTheatreIds();
      const topT = list.map(c => ({ c, sh: this.scopedHeat(c, tids) }))
        .filter(x => x.sh > 0).sort((a, b) => b.sh - a.sh).slice(0, 10).map(x => x.c);
      Charts.make("cap-theatre-heat", {
        type: "bar",
        data: {
          labels: topT.map(c => c.name),
          datasets: tids.map(t => ({
            label: THEATRE_BY_ID[t].short, data: topT.map(c => this.theatreHeatOf(c, t)),
            backgroundColor: this.theatreColor(t)
          }))
        },
        options: Object.assign(Charts.baseOpts(), {
          indexAxis: "y",
          plugins: { legend: { position: "top", labels: { color: Charts.css("--text-muted"), boxWidth: 12, font: { size: 10 } } },
            tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.parsed.x} heat` } } },
          scales: {
            x: Object.assign(Charts.baseOpts().scales.x, { stacked: true, title: { display: true, text: "Computed heat", color: Charts.css("--text-muted") } }),
            y: Object.assign(Charts.baseOpts().scales.y, { stacked: true })
          }
        })
      });

      // Heat — horizontal bar, top 12
      const top = this.heatRanking(list).slice(0, 12);
      Charts.make("cap-heat", {
        type: "bar",
        data: { labels: top.map(c => c.name), datasets: [{ label: "Heat", data: top.map(c => this.heatOf(c)), backgroundColor: top.map(c => lcColor(c.lifecycle)) }] },
        options: Object.assign(Charts.baseOpts(), { indexAxis: "y", plugins: { legend: { display: false } } })
      });

      // Lifecycle doughnut
      const ld = this.lifecycleDist(list);
      const lk = lcKeys.filter(k => ld[k] > 0);
      Charts.make("cap-lifecycle", {
        type: "doughnut",
        data: { labels: lk, datasets: [{ data: lk.map(k => ld[k]), backgroundColor: lk.map(lcColor) }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "right", labels: { color: Charts.css("--text-muted"), font: { size: 10 }, boxWidth: 12 } } } }
      });

      // Proliferation by theatre — stacked bar by lifecycle
      const ta = this.theatreAdoption(list);
      const tIds = DB.theatres.map(t => t.id);
      Charts.make("cap-theatre", {
        type: "bar",
        data: { labels: tIds.map(id => THEATRE_BY_ID[id].short),
          datasets: lcKeys.map(lc => ({ label: lc, data: tIds.map(id => ta[id][lc]), backgroundColor: lcColor(lc) })) },
        options: Object.assign(Charts.baseOpts(), {
          scales: { x: Object.assign(Charts.baseOpts().scales.x, { stacked: true }), y: Object.assign(Charts.baseOpts().scales.y, { stacked: true }) }
        })
      });

      // Vector doughnut
      const vd = this.vectorDist(list);
      const vk = Object.keys(vd).filter(k => vd[k] > 0);
      const vColors = ["#a01f2e", "#1f5fa8", "#8a5a00", "#1d6b4c"];
      Charts.make("cap-vector", {
        type: "doughnut",
        data: { labels: vk, datasets: [{ data: vk.map(k => vd[k]), backgroundColor: vk.map((_, i) => vColors[i % vColors.length]) }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "right", labels: { color: Charts.css("--text-muted"), font: { size: 10 }, boxWidth: 12 } } } }
      });

      // Adaptation tempo — bar of time-to-counter
      const tt = this.adaptationTempo(list).items;
      Charts.make("cap-tempo", {
        type: "bar",
        data: { labels: tt.map(c => c.name), datasets: [{ label: "Days to counter", data: tt.map(c => c.timeToCounterDays), backgroundColor: tt.map(c => lcColor(c.lifecycle)) }] },
        options: Object.assign(Charts.baseOpts(), { plugins: { legend: { display: false } } })
      });
    }
  };

  /* ----------------------------------------------------------------------
   * 8c. MONTHLY — Formation Learning view
   *     Not a recap of 4 weekly reports: it transforms extracted insights
   *     (monthlyInsights) into selectable formation-group learning panels.
   *     A group's panel is computed from its insights for the selected month
   *     (insight.sourceWeek ∈ month.weekIds), partitioned by workedOrFailed
   *     and rolled into worked / failed / adaptation / training / commander
   *     questions / theatres / linked-insight cards.
   * -------------------------------------------------------------------- */
  /* ----------------------------------------------------------------------
   * 8c. MONTHLY — Tactical Learning view (per formation group)
   *     Transforms weekly-brief-derived insights (monthlyInsights) into
   *     tactical, echelon-level learnings: what brigades / battalions /
   *     companies should EXPERIMENT with, TRAIN, or ADJUST in SOPs — each
   *     backed by cited articles from the brief for a deeper look.
   * -------------------------------------------------------------------- */
  const Monthly = {
    ECHELONS: ["Brigade", "Battalion", "Company"],
    groups() { return DB.formationGroups || []; },
    groupById(id) { return this.groups().find(g => g.id === id); },
    forMonth(period) { return DB.monthlyInsights.filter(i => period.weekIds.includes(i.sourceWeek)); },
    byGroup(list, gid) { return list.filter(i => i.group === gid); },
    dedup(arr) { return [...new Set(arr.filter(Boolean))]; },
    topTheatres(list) {
      const m = {}; list.forEach(i => (m[i.theatre] = (m[i.theatre] || 0) + 1));
      return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ id, name: THEATRE_BY_ID[id].name, short: THEATRE_BY_ID[id].short, n }));
    },
    topTags(list) {
      const m = {}; list.forEach(i => (i.tags || []).forEach(t => (m[t] = (m[t] || 0) + 1)));
      return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([t]) => t);
    },
    echelonsPresent(gi) { return this.ECHELONS.filter(e => gi.some(i => i.echelon === e)); },

    assessment(g, gi) {
      if (!gi.length) return `No tactical insights were extracted for ${g.name} this month.`;
      const ech = this.echelonsPresent(gi).join(", ") || "all echelons";
      const th = this.topTheatres(gi).slice(0, 2).map(t => t.name).join(" and ") || "multiple theatres";
      const tg = this.topTags(gi).slice(0, 3).join(", ") || "cross-domain adaptation";
      const srcN = this.dedup(gi.flatMap(i => (i.sources || []).map(s => s.url))).length;
      return `${gi.length} tactical learning${gi.length === 1 ? "" : "s"} for ${g.short} this month, spanning ${ech} level, ` +
        `drawn chiefly from ${th} and centring on ${tg}. ${srcN} cited article${srcN === 1 ? "" : "s"} support a deeper look.`;
    },

    echBadge(e) { return `<span class="ech-badge ech-${e.toLowerCase()}">${esc(e)}</span>`; },

    lane(title, cls, items) {
      return `<div class="lane ${cls}"><div class="lane-h">${esc(title)}</div>` +
        (items && items.length ? `<ul>${items.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p class="muted-note">—</p>`) + `</div>`;
    },

    insightCard(i) {
      const t = THEATRE_BY_ID[i.theatre];
      const sources = (i.sources || []).map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)} ↗</a>`).join("");
      const tags = (i.tags || []).map(tg => `<span class="tag">#${esc(tg)}</span>`).join("");
      return `<article class="tac-card">
        <div class="tac-head">
          ${this.echBadge(i.echelon)}
          <span class="tac-title">${esc(i.title)}</span>
          <span class="tac-meta">${esc(t.short)} · ${esc(i.sourceWeek)} · ${esc(i.sourceDomain)} · ${esc(i.confidence)} conf.</span>
        </div>
        <p class="tac-sowhat">${esc(i.soWhat)}</p>
        ${(i.findings && i.findings.length) ? `<div class="tac-findings">
          <div class="lane-h">Findings from cited research</div>
          <ul>${i.findings.map(f => `<li>${esc(f.text)} <span class="find-src">— ${esc(f.source)}</span></li>`).join("")}</ul>
        </div>` : ""}
        <div class="tac-lanes">
          ${this.lane("Experiment with", "lane-exp", i.experiment)}
          ${this.lane("Train", "lane-train", i.train)}
          ${this.lane("Adjust SOPs", "lane-sop", i.adjustSOP)}
        </div>
        ${sources ? `<div class="tac-sources"><span class="src-k">Cited articles</span>${sources}</div>` : ""}
        ${tags ? `<div class="tags">${tags}</div>` : ""}
      </article>`;
    },

    overviewCard(g, gi) {
      const ech = this.echelonsPresent(gi);
      const srcN = this.dedup(gi.flatMap(i => (i.sources || []).map(s => s.url))).length;
      const takes = gi.slice(0, 3).map(i => `<li>${this.echBadge(i.echelon)} ${esc(i.title)}</li>`).join("");
      return `<button class="fg-card" data-group="${g.id}">
        <div class="fg-card-head"><span class="fg-card-name">${esc(g.name)}</span><span class="fg-card-aud">${esc(g.short)}</span></div>
        <div class="fg-card-counts">${gi.length} tactical insight${gi.length === 1 ? "" : "s"} · ${ech.join("/") || "—"} · ${srcN} cited</div>
        <div class="subhead">Top learnings</div>
        <ul class="dev-list tk-list">${takes || "<li class='muted-note'>No insights this month.</li>"}</ul>
        <span class="fg-card-cta">View tactical learnings →</span>
      </button>`;
    },

    echelonFilter(gi) {
      const counts = {}; this.ECHELONS.forEach(e => (counts[e] = gi.filter(i => i.echelon === e).length));
      const chip = (val, label, n) => `<button class="fchip ech-chip ${State.monthlyEchelon === val ? "on" : ""}" aria-pressed="${State.monthlyEchelon === val}" data-ech="${val}">${esc(label)}${n != null ? ` (${n})` : ""}</button>`;
      return `<div class="chip-row ech-filter">` +
        chip("ALL", "All echelons", gi.length) +
        this.ECHELONS.map(e => chip(e, e, counts[e])).join("") + `</div>`;
    },

    groupPanel(g, gi) {
      const shown = State.monthlyEchelon === "ALL" ? gi : gi.filter(i => i.echelon === State.monthlyEchelon);
      return `
        <div class="section">
          <div class="section-head"><h2>${esc(g.name)}</h2>
            <div class="head-actions"><button class="btn" data-group="ALL">← All groups</button></div></div>
          <div class="note-banner fg-audience-banner"><strong>Audience — ${esc(g.short)}</strong> (${esc(g.audience.join(", "))}). Tactical focus: ${esc(g.focus)}</div>

          <div class="card card-pad section"><div class="subhead" style="margin-top:0">Monthly assessment</div>
            <p style="margin:0">${esc(this.assessment(g, gi))}</p></div>

          <div class="section">
            <div class="subhead">Filter by echelon</div>
            ${this.echelonFilter(gi)}
          </div>

          <div class="tac-grid">
            ${shown.length ? shown.map(i => this.insightCard(i)).join("") : `<div class="empty">No insights at this echelon for ${esc(g.name)} this month.</div>`}
          </div>
        </div>`;
    },

    render() {
      const period = Render.currentPeriod();
      const container = el("#view-monthly .view-body");
      if (!period) { container.innerHTML = `<div class="empty">No monthly period available.</div>`; return; }
      el("#meta-range").textContent = Time.fmtRange(period.start, period.end);

      const insights = this.forMonth(period);
      const bluf = (DB.monthlyBlufByMonth && DB.monthlyBlufByMonth[period.id]) ||
        `Tactical-learning roll-up for ${period.label}, distilled from the month's weekly briefs.`;
      const sel = State.formationGroup;

      let html = `<div class="card bluf-card card-pad section">
        <div class="bluf-label">Monthly BLUF — Tactical Learning</div>
        <p>${esc(bluf)}</p>
        <div class="bluf-sub">${esc(period.label)} · ${esc(Time.fmtRange(period.start, period.end))} · ${insights.length} tactical insight${insights.length === 1 ? "" : "s"} extracted from ${period.weekIds.length} weekly briefs · cite the linked articles for a deeper look</div>
      </div>`;

      html += `<div class="section fg-select-wrap">
        <label for="formation-group-select" class="fg-select-label">Select Formation Group</label>
        <select id="formation-group-select" aria-label="Select formation group">
          <option value="ALL" ${sel === "ALL" ? "selected" : ""}>All Groups</option>
          ${this.groups().map(g => `<option value="${g.id}" ${sel === g.id ? "selected" : ""}>${esc(g.name)} — ${esc(g.short)}</option>`).join("")}
        </select>
      </div>`;

      if (sel === "ALL") {
        html += `<div class="section"><div class="section-head"><h2>Formation Group Overview</h2>
          <span class="hint">Pick a group above, or click a card, for its tactical learnings</span></div>
          <div class="fg-overview">${this.groups().map(g => this.overviewCard(g, this.byGroup(insights, g.id))).join("")}</div></div>`;
      } else {
        const g = this.groupById(sel) || this.groups()[0];
        html += this.groupPanel(g, this.byGroup(insights, g.id));
      }

      container.innerHTML = html;
      this.wire(container);
    },

    wire(root) {
      const sel = root.querySelector("#formation-group-select");
      if (sel) sel.addEventListener("change", () => { State.formationGroup = sel.value; State.monthlyEchelon = "ALL"; this.render(); });
      root.querySelectorAll("[data-group]").forEach(btn =>
        btn.addEventListener("click", () => { State.formationGroup = btn.getAttribute("data-group"); State.monthlyEchelon = "ALL"; this.render(); }));
      root.querySelectorAll(".ech-chip").forEach(btn =>
        btn.addEventListener("click", () => { State.monthlyEchelon = btn.getAttribute("data-ech"); this.render(); }));
    }
  };

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
      // The Capabilities view spans all periods — disable the period picker.
      if (State.horizon === "capabilities") {
        sel.innerHTML = `<option>All periods (cross-cutting)</option>`;
        sel.disabled = true;
        return;
      }
      sel.disabled = false;
      let opts = [];
      if (State.horizon === "weekly") {
        if (DB.liveEditions) {
          // All brief editions: current (● LIVE) + past archived, newest first
          opts = DB.liveEditions.map((e, i) => ({ id: e.weekId, label: `${i === 0 ? "● LIVE · " : ""}${e.rangeLabel || Time.fmtRange(e.weekStart, e.weekEnd)}` }));
        } else {
          opts = DB.weeklyReports.map(w => ({ id: w.weekId, label: `${w.weekId} · ${Time.fmtRange(w.weekStart, w.weekEnd)}` }));
        }
      } else if (State.horizon === "monthly")
        opts = MONTHS.map(m => ({ id: m.id, label: `${m.label} · ${Time.fmtRange(m.start, m.end)}` }));
      else
        opts = QUARTERS.map(qr => ({ id: qr.id, label: `${qr.label} · ${Time.fmtRange(qr.start, qr.end)}` }));

      // default: newest brief edition for weekly (if present), else latest period
      if (!opts.find(o => o.id === State.periodId)) {
        State.periodId = (State.horizon === "weekly" && DB.liveEditions) ? DB.liveEditions[0].weekId : opts[opts.length - 1].id;
      }
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
    },

    wire() {
      // horizon tabs
      document.querySelectorAll(".tab-btn").forEach(b =>
        b.addEventListener("click", () => { State.horizon = b.dataset.horizon; this.rerender(); }));

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

      // mobile: collapsible filters panel
      const ft = el("#filters-toggle");
      if (ft) ft.addEventListener("click", () => {
        const sb = document.querySelector(".sidebar");
        const open = sb.classList.toggle("filters-open");
        ft.setAttribute("aria-expanded", String(open));
        ft.querySelector(".ft-caret").textContent = open ? "▴" : "▾";
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
      Caps.computeDynamics();   // derive capability heat & trend from weekly observations

      // Live weekly editions (current + archived past + future), synced from the
      // brief site into weekly-live.json by .github/workflows/sync-weekly.yml.
      // Optional — fall back to seed data. Supports the multi-edition shape
      // ({ editions: [...] }) and the legacy single-edition shape.
      try {
        const r = await fetch("weekly-live.json", { cache: "no-store" });
        if (r.ok) {
          const lw = await r.json();
          let eds = Array.isArray(lw && lw.editions) ? lw.editions : (lw && lw.__live && lw.theatres ? [lw] : []);
          eds = eds.filter(e => e && e.theatres && Object.keys(e.theatres).length);
          if (eds.length) {
            eds.sort((a, b) => String(b.weekEnd || "").localeCompare(String(a.weekEnd || "")));
            DB.liveEditions = eds;
            DB.liveSyncedAt = lw.syncedAt || null;
            DB.liveWeek = eds[0];   // newest = the "● LIVE" edition
          }
        }
      } catch (e) { /* no live editions available — use seed */ }

      // header meta
      el("#meta-updated").textContent = Time.fmtDateTime(DB.meta.lastUpdated);

      this.buildFilterControls();
      this.wire();
      this.rerender();
    }
  };

  document.addEventListener("DOMContentLoaded", () => App.init());
})();
