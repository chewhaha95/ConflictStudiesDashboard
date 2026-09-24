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
 *   8c. WATCHLIST      — conflict watchlist tracker + self-contained SVG map
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
    horizon: "watchlist",     // 'watchlist' | 'weekly' | 'monthly' | 'quarterly' | 'capabilities'
    periodId: null,           // active week/month/quarter id
    formationGroup: "ALL",    // monthly tab: 'ALL' | formation-group id
    monthlyEchelon: "ALL",    // monthly group panel: 'ALL' | Brigade | Battalion | Company
    capEvidencedOnly: true,   // capabilities: default to brief-evidenced contests/caps only (lean, trustworthy default)
    theme: "light",
    watchlist: {              // watchlist tab: filters + map focus + open rows
      tiers: new Set(), states: new Set(), hideIgnored: false,
      selected: null, region: "world", view: null, expanded: new Set()
    },
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
      if (State.horizon === "watchlist") { Watchlist.render(); return; }
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
      if (State.horizon === "watchlist") {
        this.download("conflict-watchlist.json", "application/json", JSON.stringify(Watchlist.exportObject(), null, 2));
        return;
      }
      if (State.horizon === "capabilities") {
        this.download("capabilities.json", "application/json", JSON.stringify(this.capabilitiesObject(), null, 2));
        return;
      }
      const obj = this.currentViewObject();
      this.download(`conflict-${State.horizon}-${obj.period.id}.json`, "application/json", JSON.stringify(obj, null, 2));
    },
    csv() {
      const q = (s) => `"${String(s == null ? "" : s).replace(/"/g, '""')}"`;
      if (State.horizon === "watchlist") {
        const rows = Watchlist.exportRows().map(r => r.map(q).join(","));
        this.download("conflict-watchlist.csv", "text/csv", [Watchlist.exportCols().join(","), ...rows].join("\n"));
        return;
      }
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
    briefMode: false,
    axisLen: 0,
    computeDynamics() {
      // Pick the signal source: brief evidence (live editions) when available,
      // else the seed weekly capability signals. In brief mode, heat/trend for
      // evidenced capabilities are DRIVEN BY THE BRIEF; capabilities the briefs
      // haven't named fall back to the declared analyst baseline.
      const briefMode = !!(DB.liveEditions && DB.liveEditions.length && DB.capabilityEvidence && Object.keys(DB.capabilityEvidence).length);
      this.briefMode = briefMode;
      let axis, idxOf = {}, signalsFor;
      if (briefMode) {
        axis = [...DB.liveEditions].sort((a, b) => String(a.weekEnd || "").localeCompare(String(b.weekEnd || ""))); // oldest→newest
        axis.forEach((e, i) => (idxOf[e.weekId] = i));
        signalsFor = (id) => (DB.capabilityEvidence[id] || [])
          .map(ev => ({ idx: idxOf[ev.weekId], t: ev.theatre, i: ev.intensity || 1 })).filter(s => s.idx != null);
      } else {
        axis = DB.weeklyReports;
        const sig = DB.weeklyCapabilitySignals || {};
        axis.forEach((w, i) => (idxOf[w.weekId] = i));
        signalsFor = (id) => Object.keys(sig).filter(k => k !== "_doc")
          .flatMap(wk => (sig[wk] || []).filter(s => s.id === id).map(s => ({ idx: idxOf[wk], t: s.t, i: s.i || 1 })));
      }
      const n = axis.length; this.axisLen = n;
      const wgt = i => 0.55 + 0.45 * (n > 1 ? i / (n - 1) : 1);   // recency weighting
      const rw = arr => arr.reduce((s, v, i) => s + v * wgt(i), 0);
      const m = {};
      DB.capabilities.forEach(c => {
        const weekly = new Array(n).fill(0), tw = {};
        signalsFor(c.id).forEach(s => { weekly[s.idx] += s.i; (tw[s.t] = tw[s.t] || new Array(n).fill(0))[s.idx] += s.i; });
        m[c.id] = { weekly, tw, signals: signalsFor(c.id).length };
      });
      // recency-weighted raw heat, then normalise to 0-100 across capabilities
      let max = 0; const raw = {};
      DB.capabilities.forEach(c => { const r = rw(m[c.id].weekly); raw[c.id] = r; if (r > max) max = r; });
      const scale = max > 0 ? 96 / max : 0;
      const half = Math.max(1, Math.floor(n / 2));
      DB.capabilities.forEach(c => {
        const d = m[c.id];
        d.basis = d.signals === 0 ? "model" : (briefMode ? "brief" : "signals");
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
    basisOf(c) { const d = this.dynamics[c.id]; return d ? d.basis : "model"; },
    theatreHeatOf(c, t) { const d = this.dynamics[c.id]; return d && d.byTheatre ? (d.byTheatre[t] || 0) : 0; },
    // Brief-derived evidence (traceable) for a capability. Scoped to the
    // capability's declared theatres of relevance to drop keyword false-positives
    // (the matcher can otherwise attribute a generic headline to the wrong cap).
    evidence(c) {
      const rows = (DB.capabilityEvidence && DB.capabilityEvidence[c.id]) || [];
      const scope = new Set(c.theatres || []);
      return scope.size ? rows.filter(r => scope.has(r.theatre)) : rows;
    },
    // "Observed" = backed by the ACTIVE observation source. In brief mode that is
    // ≥1 traceable brief evidence row; offline it is ≥1 seed signal (the brief
    // stand-in used only when no live editions are loaded).
    observed(c) { return this.briefMode ? this.evidence(c).length > 0 : this.observations(c) > 0; },
    isEvidenced(c) { return this.observed(c); },
    // How a capability's heat/trend is sourced, for honest labelling.
    obsSourceType(c) {
      if (!this.observed(c)) return "analyst-judged";
      return this.briefMode ? "brief-derived" : "seed-observed";
    },

    // ---- capability contests (the analytic unit) ----
    contestsAll() { return DB.capabilityContests || []; },
    measureOf(ct) { return this.byId(ct.measureCapId); },
    counterOf(ct) { return ct.counterCapId ? this.byId(ct.counterCapId) : null; },
    // A contest is brief-evidenced if its measure (or named counter) is observed.
    contestObserved(ct) {
      const m = this.measureOf(ct), c = this.counterOf(ct);
      return !!(m && this.observed(m)) || !!(c && this.observed(c));
    },
    // Combined, theatre-scoped brief evidence for a contest (measure ∪ counter).
    contestEvidence(ct) {
      const m = this.measureOf(ct), c = this.counterOf(ct);
      const rows = [...(m ? this.evidence(m) : []), ...(c ? this.evidence(c) : [])];
      const order = {}; (DB.liveEditions || []).slice().sort((a, b) => String(a.weekEnd || "").localeCompare(String(b.weekEnd || ""))).forEach((e, i) => (order[e.weekId] = i));
      return rows.sort((a, b) => (order[a.weekId] || 0) - (order[b.weekId] || 0));
    },
    contestHeat(ct) { const m = this.measureOf(ct); return m ? this.heatOf(m) : 0; },
    contestTrend(ct) { const m = this.measureOf(ct); return m ? this.trendOf(m) : "Steady"; },
    contestWeeks(ct) { return [...new Set(this.contestEvidence(ct).map(r => r.rangeLabel || r.weekId))]; },
    // The default-visible set: brief-evidenced contests unless the analyst-judged
    // toggle is on (capEvidencedOnly === false reveals not-yet-evidenced contests).
    contests() {
      const all = this.contestsAll();
      return State.capEvidencedOnly ? all.filter(ct => this.contestObserved(ct)) : all;
    },
    // Capability ids that participate in any contest (measure / counter / bypass).
    contestCapIds() {
      const s = new Set();
      this.contestsAll().forEach(ct => [ct.measureCapId, ct.counterCapId, ct.bypassCapId].forEach(id => id && s.add(id)));
      return s;
    },
    // Secondary INVENTORY: capabilities observed in the briefs but not yet part of
    // a contest narrative — kept out of the primary contest table to avoid mixing
    // object types. (Respects the brief-evidenced-only toggle via list().)
    inventory(list) {
      const inContest = this.contestCapIds();
      return this.heatRanking(list.filter(c => this.observed(c) && !inContest.has(c.id)));
    },

    // ---- contest observation stats & rule-based confidence ----
    // Unified observation stats for a contest, from the ACTIVE source: live brief
    // evidence rows when present, else the measure's seed signals (offline).
    contestStats(ct) {
      const m = this.measureOf(ct);
      const ev = this.contestEvidence(ct);
      const d = (m && this.dynamics[m.id]) || { weekly: [], tw: {}, signals: 0 };
      let weeks, theatres, obsCount, first, last, highConf;
      if (this.briefMode && ev.length) {
        const ws = [...new Set(ev.map(r => r.weekId))];
        weeks = ws.length;
        theatres = [...new Set(ev.map(r => r.theatre))];
        obsCount = ev.length;
        first = ev[0].rangeLabel || ev[0].weekId;
        last = ev[ev.length - 1].rangeLabel || ev[ev.length - 1].weekId;
        highConf = ev.some(r => r.confidence === "high");
      } else {
        const axis = DB.weeklyReports || [];
        const idx = (d.weekly || []).map((v, i) => v > 0 ? i : -1).filter(i => i >= 0);
        weeks = idx.length;
        theatres = Object.keys(d.tw || {});
        obsCount = d.signals || 0;
        first = idx.length ? (axis[idx[0]] || {}).weekId : null;
        last = idx.length ? (axis[idx[idx.length - 1]] || {}).weekId : null;
        highConf = false;
      }
      const counter = this.counterOf(ct);
      const bypass = ct.bypassCapId ? this.byId(ct.bypassCapId) : null;
      return {
        weeks, theatres, obsCount, first, last, highConf,
        counterObserved: !!(counter && this.observed(counter)),
        bypassObserved: !!(bypass && this.observed(bypass))
      };
    },
    // Rule-based confidence (0–8): weeks(≤3) + theatres(≤2) + counter-observed(1)
    // + bypass-evidenced(1) + a headline-level observation(1). High ≥6, Med ≥3, Low <3.
    contestConfidence(ct) {
      const s = this.contestStats(ct);
      const score = Math.min(s.weeks, 3) + Math.min(s.theatres.length, 2) +
        (s.counterObserved ? 1 : 0) + (s.bypassObserved ? 1 : 0) + (s.highConf ? 1 : 0);
      return { level: score >= 6 ? "High" : score >= 3 ? "Medium" : "Low", score };
    },
    // Evidence-discipline flag — guards against over-assertion.
    contestDiscipline(ct) {
      const s = this.contestStats(ct);
      if (!s.obsCount) return "Not yet evidenced";
      if (s.obsCount < 3 || s.theatres.length < 2 || !s.highConf) return "Observed but limited";
      return "Well evidenced";
    },
    // One-line evidence basis, e.g. "Supported by 5 brief observations across
    // Russia–Ukraine and Israel–Lebanon."
    contestEvidenceBasis(ct) {
      const s = this.contestStats(ct);
      if (!s.obsCount) return "No supporting observations in current reporting — analyst-judged only.";
      const names = s.theatres.map(t => (THEATRE_BY_ID[t] || {}).name || t);
      const where = names.length === 1 ? names[0] : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
      const src = this.briefMode ? "brief observation" : "seed observation";
      return `Supported by ${s.obsCount} ${src}${s.obsCount === 1 ? "" : "s"}${names.length ? ` across ${where}` : ""}.`;
    },
    formationChips(arr) {
      return (arr || []).map(f => `<span class="form-chip tip" tabindex="0">${esc(f)}<span class="tip-body">${esc((DB.capabilityDefs.formations || {})[f] || "")}</span></span>`).join("");
    },
    // Structured SAF actions (Emulate / Trial / Review / Do not assume) — only the
    // fields the analyst populated for this contest.
    safActionsBlock(saf) {
      if (!saf) return "";
      const rows = [
        ["Emulate", saf.emulate, "good"], ["Trial", saf.trial, "scaling"],
        ["Review", saf.review, "warn"], ["Do not assume", saf.doNotAssume, "bad"]
      ].filter(r => r[1]);
      return rows.map(([k, v, tone]) => `<div class="saf-row"><span class="saf-k saf-${tone}">${esc(k)}</span><span class="saf-v">${esc(v)}</span></div>`).join("");
    },
    disciplineBadge(d) {
      const tone = d === "Well evidenced" ? "good" : d === "Not yet evidenced" ? "bad" : "warn";
      return `<span class="disc disc-${tone} tip" tabindex="0">${esc(d)}<span class="tip-body">${esc((DB.capabilityDefs.evidenceDiscipline || {})[d] || "")}</span></span>`;
    },
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
        if (State.capEvidencedOnly && !this.isEvidenced(c)) return false;
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
    // Methodology tooltip for a metric (inputs / method / fallback) — single source
    // of truth is capabilityDefs.metrics, mirrored in the code comments above each use.
    metricTip(key) {
      const m = (DB.capabilityDefs.metrics || {})[key]; if (!m) return "";
      return `<span class="th-info tip" tabindex="0">ⓘ<span class="tip-body"><strong>${esc(m.label)}.</strong> Inputs: ${esc(m.inputs)} Method: ${esc(m.method)} Fallback: ${esc(m.fallback)}</span></span>`;
    },
    // Provenance pill — the three evidence tiers + model fallback.
    //   brief-derived (green)  = Layer 1, weekly-brief observation
    //   research-judged (indigo) = Layer 2, wider open-source research
    //   analyst-judged (amber) = interpretive synthesis, no research packet
    //   model-derived (grey)   = seed/placeholder
    srcBadge(type) {
      const map = { "brief-derived": ["src-brief", "Brief-derived"], "seed-observed": ["src-brief", "Brief-derived"],
        "research-judged": ["src-research", "Research-judged"],
        "analyst-judged": ["src-analyst", "Analyst-judged"], "model-derived": ["src-model", "Model-derived"] };
      const def = (DB.capabilityDefs.sourceTypes || {})[type === "seed-observed" ? "brief-derived" : type] || "";
      const [cls, label] = map[type] || ["src-model", type];
      return `<span class="src-badge ${cls} tip" tabindex="0">${esc(label)}<span class="tip-body">${esc(def)}</span></span>`;
    },
    // ---- Layer 2 research source packet ----
    researchById(id) { return (DB.researchSources || []).find(s => s.id === id); },
    researchPacket(ids) { return (ids || []).map(id => this.researchById(id)).filter(Boolean); },
    // Rule-based research confidence from the packet size (see capabilityDefs.researchConfidence).
    researchConfidence(ids) {
      const n = (ids || []).length;
      return n >= 3 ? "High" : n === 2 ? "Medium" : n === 1 ? "Low" : "—";
    },
    // "View research basis" drawer — the open-source studies behind a Layer-2 judgment.
    researchDrawer(ids, label) {
      const pk = this.researchPacket(ids);
      if (!pk.length) return `<span class="ev-badge ev-est" title="No research packet — analyst assertion only">Analyst assertion</span>`;
      const items = pk.map(s => `<div class="rs-item"><a href="${esc(s.url)}" target="_blank" rel="noopener"><strong>${esc(s.label)}</strong></a> <span class="rs-pub">${esc(s.publisher)}</span><div class="rs-note">${esc(s.note)}</div></div>`).join("");
      return `<details class="ev"><summary><span class="ev-badge ev-research">🔬 ${esc(label || "Research basis")} ×${pk.length}</span></summary><div class="ev-list rs-list">${items}</div></details>`;
    },
    judgmentBadge(j) {
      const def = (DB.capabilityDefs.judgments || {})[j] || { tone: "neutral", desc: "" };
      const label = { holding: "Holding", stressed: "Counter under strain", bypassed: "Counter bypassed", uncountered: "Currently uncountered" }[j] || j;
      return `<span class="judg judg-${def.tone} tip" tabindex="0">${esc(label)}<span class="tip-body">${esc(def.desc)}</span></span>`;
    },
    safActionBadge(a) {
      if (!a) return `<span class="muted-note">—</span>`;
      const def = (DB.capabilityDefs.safActions || {})[a] || "";
      const tone = { "Emulate": "good", "Trial": "scaling", "Review": "warn", "Do not assume": "bad", "Watch": "neutral" }[a] || "neutral";
      return `<span class="saf-act saf-${tone} tip" tabindex="0">${esc(a)}<span class="tip-body">${esc(def)}</span></span>`;
    },
    // "View supporting briefs" drawer for a set of evidence rows.
    evItem(x) {
      // Per-row match confidence (how the keyword was found): headline=high,
      // pill=medium, body=low. Surfaced so weak (body-only) hits are visible.
      const conf = x.confidence || "";
      const confChip = conf
        ? `<span class="ev-conf-dot ec-${esc(conf)}" title="Match confidence: ${esc(conf)}${x.where ? ` (keyword in ${esc(x.where)})` : ""}">${esc(conf)}</span>` : "";
      return `<div class="ev-item">${confChip}<span class="ev-meta">${esc(x.rangeLabel || x.weekId)} · ${esc(THEATRE_BY_ID[x.theatre] ? THEATRE_BY_ID[x.theatre].short : x.theatre)}</span> ${esc(x.headline)} ${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.source || "source")} ↗</a>` : ""}</div>`;
    },
    evDrawer(rows, observed, obsCount) {
      if (rows && rows.length) {
        return `<details class="ev"><summary><span class="ev-badge ev-yes">📎 View supporting briefs ×${rows.length}</span></summary><div class="ev-list">${rows.map(r => this.evItem(r)).join("")}</div></details>`;
      }
      if (observed) return `<span class="ev-badge ev-seed" title="Observed via seed signals offline — live brief links appear when editions are loaded">Seed ×${obsCount || 0}</span>`;
      return `<span class="ev-badge ev-est" title="Not yet evidenced in the loaded weekly briefs — analyst judgement">Not yet evidenced</span>`;
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
      el("#meta-range").textContent = "All loaded periods";

      const ranked = this.heatRanking(all);
      const obsType = this.briefMode ? "brief-derived" : "seed-observed";
      const contests = this.contests();
      const allContests = this.contestsAll();
      const dataTag = this.briefMode
        ? `<strong>Two-layer evidence:</strong> ① reporting-picture lines (most-observed / rising) are <strong>brief-derived</strong> from ${this.axisLen} live brief edition(s); ② capdev lines (stressed / bypassed / superseded) are <strong>research-judged</strong> from wider open-source research and tied to a source packet on each contest.`
        : `Offline preview — reporting picture from ${DB.weeklyReports.length} seed signal weeks; capdev lines are research-judged (see each contest's research basis).`;

      // ---- BLUF — split into the two evidence layers ----------------------
      // Layer 1 (brief-derived): what the weekly reporting shows — most-observed,
      // rising-in-reporting. Layer 2 (research-judged): capability-development
      // judgments (stressed / bypassed / superseded), tied to research packets.
      const TOP = 3;
      const mostObserved = ranked.slice(0, TOP).map(c => c.name);
      const rising = all.filter(c => this.trendOf(c) === "Rising").map(c => c.name);
      const fading = all.filter(c => ["Superseded", "Obsolete"].includes(c.lifecycle) || this.trendOf(c) === "Declining").map(c => c.name);
      const stressedCtr = contests.filter(ct => ct.operationalJudgment === "stressed" && this.counterOf(ct)).map(ct => this.counterOf(ct).name);
      const bypassCt = contests.filter(ct => ["bypassed", "uncountered"].includes(ct.operationalJudgment)).map(ct => this.measureOf(ct) ? this.measureOf(ct).name : ct.title);
      const uncCt = contests.filter(ct => ct.operationalJudgment === "uncountered").map(ct => this.measureOf(ct) ? this.measureOf(ct).name : ct.title);
      const bTag = `<span class="prov-tag pt-brief" title="Layer 1 — computed from weekly-brief observations">brief-derived</span>`;
      const rTag = `<span class="prov-tag pt-research" title="Layer 2 — wider open-source research, tied to a source packet">research-judged</span>`;
      const top = arr => [...new Set(arr)].slice(0, TOP).join(", ");
      const blufLine = (label, val, tag) => `<div class="bluf-line"><span class="bluf-k">${esc(label)}</span><span class="bluf-v">${esc(val || "—")}</span> ${tag}</div>`;
      let html = `<div class="card bluf-card card-pad section">
        <div class="bluf-label">BLUF — Capability Picture</div>
        <div class="bluf-layer-h">① Current reporting picture <span class="layer-src">${this.srcBadge("brief-derived")}</span></div>
        ${blufLine("Most observed in reporting", top(mostObserved), bTag)}
        ${blufLine("Rising in reporting", top(rising), bTag)}
        <div class="bluf-layer-h">② Broader capdev assessment <span class="layer-src">${this.srcBadge("research-judged")}</span></div>
        ${blufLine("Fading / superseded", top(fading), rTag)}
        ${blufLine("Most stressed counters", top(stressedCtr), rTag)}
        ${blufLine("Key bypasses", top(bypassCt), rTag)}
        ${blufLine("Uncountered / weakly countered", top(uncCt), rTag)}
        <div class="bluf-sub">${dataTag}</div>
      </div>`;

      // ---- filter chips: lifecycle + brief-evidenced/analyst toggle ----
      const lcChips = Object.keys(DB.capabilityDefs.lifecycle).map(lc =>
        `<button class="fchip lc-filter ${State.filters.lifecycle.has(lc) ? "on" : ""}" aria-pressed="${State.filters.lifecycle.has(lc)}" data-lc="${esc(lc)}">${esc(lc)}</button>`).join("");
      const obsCount = DB.capabilities.filter(c => this.observed(c)).length;
      const evChip = `<button class="fchip ev-filter ${State.capEvidencedOnly ? "on" : ""}" aria-pressed="${State.capEvidencedOnly}" id="cap-ev-only" title="When on, only brief-evidenced contests &amp; capabilities are shown. Turn off to reveal analyst-judged items that the current briefs haven't yet named.">${State.capEvidencedOnly ? "✓ " : ""}Brief-evidenced only (${obsCount})</button>`;
      html += `<div class="section"><div class="section-head"><h2>Capabilities &amp; Countermeasures</h2>
        <span class="hint">Limit to brief-evidenced items, or filter by lifecycle phase</span></div>
        <div class="lc-filter-row">${evChip}${lcChips}</div></div>`;

      // ---- summary cards (explainable) ----
      const kpi = (label, val, sub, tipKey, tipText) => `<div class="kpi"><div class="kpi-val">${val}</div><div class="kpi-label">${esc(label)} ${tipKey ? this.metricTip(tipKey) : (tipText ? `<span class="th-info tip" tabindex="0">ⓘ<span class="tip-body">${esc(tipText)}</span></span>` : "")}</div>${sub ? `<div class="kpi-sub">${esc(sub)}</div>` : ""}</div>`;
      html += `<div class="kpi-strip section">
        ${kpi("Tracked contests", contests.length, "measure ⇄ counter", null, "Capability contests with ≥1 brief observation on the measure or counter. Analyst-judged contests are hidden unless the toggle is off.")}
        ${kpi("Hot now", ranked.filter(c => this.heatOf(c) >= 60).length, "heat ≥ 60", "heat")}
        ${kpi("Rising", rising.length, "adoption ↑", "trend")}
        ${kpi("Currently uncountered", uncCt.length, "no counter evidenced", null, "Contests whose operational judgment is 'uncountered' — no effective countermeasure evidenced in current reporting.")}
        ${kpi("Bypassed counters", contests.filter(ct => ct.operationalJudgment === "bypassed" || (ct.operationalJudgment === "uncountered" && this.counterOf(ct))).length, "defeated by adaptation", null, "Contests where an adaptation defeats the named countermeasure (e.g. fibre-optic FPV vs EW).")}
        ${kpi("Stressed counters", new Set(stressedCtr).size, "under strain", null, "Distinct countermeasures judged 'under strain' across the tracked contests.")}
      </div>`;

      // ---- charts (only the brief-defensible ones) ----
      html += `<div class="section"><div class="section-head"><h2>Capability Analytics</h2>
        <span class="hint">Only charts defensible from brief observations are kept — time-to-counter &amp; category doughnuts were removed as un-sourced</span></div>
        <div class="card chart-card chart-wide" style="margin-bottom:14px"><h3>What's hot across the theatres</h3><div class="chart-sub">Brief-derived heat of leading capabilities, stacked by theatre of employment — re-scopes to the theatre filter</div><div class="chart-holder tall"><canvas id="cap-theatre-heat"></canvas></div>
          <div class="theatre-leaders">${this.theatreLeaders(all, this.selectedTheatreIds()).map(x =>
            `<div class="tl"><span class="tl-dot" style="background:${this.theatreColor(x.t)}"></span><span class="tl-theatre">${esc(THEATRE_BY_ID[x.t].name)}</span><span class="tl-label">hottest:</span> <strong>${esc(x.cap.name)}</strong> <span class="tl-heat">heat ${x.heat}</span> ${this.capTrend(this.trendOf(x.cap))} ${this.lcChip(x.cap.lifecycle)}</div>`).join("")}</div>
        </div>
        <div class="chart-grid">
          <div class="card chart-card"><h3>Proliferation by theatre</h3><div class="chart-sub">Count of observed capabilities per theatre (brief-derived)</div><div class="chart-holder"><canvas id="cap-theatre"></canvas></div></div>
          <div class="card chart-card"><h3>Observation activity over editions</h3><div class="chart-sub">Total brief observations per edition — adaptation tempo / reporting volume</div><div class="chart-holder"><canvas id="cap-activity"></canvas></div></div>
        </div></div>`;

      // ---- Measure ⇄ Countermeasure Cycles (the heart) --------------------
      const contestCards = contests.map(ct => this.contestCard(ct)).join("");
      const hiddenN = allContests.length - contests.length;
      html += `<div class="section"><div class="section-head"><h2>Measure ⇄ Countermeasure Cycles</h2>
        <span class="hint">Each contest: attack → what it threatens → countermeasure → observed effect → adaptation → judgment → SAF learning</span></div>
        <div class="cycle-grid">${contestCards || `<div class="empty">No brief-evidenced contests in the current filter. ${hiddenN ? "Turn off 'Brief-evidenced only' to see analyst-judged contests." : ""}</div>`}</div>
        ${(State.capEvidencedOnly && hiddenN > 0) ? `<div class="muted-note" style="margin-top:8px">${hiddenN} analyst-judged contest(s) hidden — not yet named in the loaded briefs. Turn off <em>Brief-evidenced only</em> to view.</div>` : ""}</div>`;

      // ---- PRIMARY TABLE: capability contests -----------------------------
      // Organised around contests, not standalone capabilities. Every row is a
      // well-formed contest (threatened function + judgment + effect authored),
      // so no "—" rows leak in. Ranked by the measure's heat.
      const rankedContests = [...contests].sort((a, b) => this.contestHeat(b) - this.contestHeat(a));
      const ctRows = rankedContests.map((ct, i) => {
        const m = this.measureOf(ct), c = this.counterOf(ct);
        const conf = this.contestConfidence(ct), s = this.contestStats(ct);
        const vs = c ? `${esc(m ? m.name : ct.measureCapId)} <span class="vs">vs</span> ${esc(c.name)}` : `${esc(m ? m.name : ct.measureCapId)} <span class="vs">vs</span> <span class="cc-uncountered">uncountered</span>`;
        const rConf = this.researchConfidence(ct.researchSourceIds);
        return `<tr>
          <td class="matrix-cell-num">${i + 1}</td>
          <td class="theatre-cell">${vs}<div style="font-size:11px;color:var(--text-faint)">heat ${this.contestHeat(ct)} · ${this.capTrend(this.contestTrend(ct))}</div></td>
          <td style="font-size:12px">${esc(ct.threatens || "—")}</td>
          <td>${this.judgmentBadge(ct.operationalJudgment)}</td>
          <td class="tip" tabindex="0"><strong>${esc(rConf)}</strong><span class="tip-body">${esc((DB.capabilityDefs.researchConfidence || {}).method || "")}</span></td>
          <td>${this.safActionBadge(ct.safAction)}</td>
          <td style="font-size:11px">${this.formationChips(ct.formationRelevance)}</td>
          <td class="ev-cell">${this.evDrawer(this.contestEvidence(ct), this.contestObserved(ct), s.obsCount)}</td>
          <td class="ev-cell">${this.researchDrawer(ct.researchSourceIds, "Research")}</td>
        </tr>`;
      }).join("");
      html += `<div class="section"><div class="section-head"><h2>Capability Contests</h2>
        <span class="hint">The primary table — attack ⇄ counter contests, ranked by heat. Judgment &amp; research confidence are <strong>research-judged</strong> (Layer 2); the reporting drawer is <strong>brief-derived</strong> (Layer 1).</span></div>
        <div class="card matrix-wrap"><table class="matrix"><thead><tr>
          <th>#</th><th>Contest (measure vs counter)</th><th>Threatened function</th>
          <th>Judgment ${this.srcBadge("research-judged")}</th>
          <th>Research confidence <span class="th-info tip" tabindex="0">ⓘ<span class="tip-body">${esc((DB.capabilityDefs.researchConfidence || {}).method || "")}</span></span></th>
          <th>SAF action</th><th>Formation</th><th>Reporting (briefs)</th><th>Research basis</th>
        </tr></thead><tbody>${ctRows || `<tr><td colspan="9"><div class="empty">No brief-evidenced contests in the current filter.</div></td></tr>`}</tbody></table></div></div>`;

      // ---- SECONDARY TABLE: capability inventory --------------------------
      // Standalone capabilities observed in the briefs that do NOT yet support a
      // contest narrative — kept separate so the primary table stays contest-pure.
      const inv = this.inventory(all);
      const invRows = inv.map((c, i) => {
        const heat = this.heatOf(c);
        return `<tr>
          <td class="matrix-cell-num">${i + 1}</td>
          <td class="theatre-cell">${esc(c.name)}<div style="font-size:11px;color:var(--text-faint)">${esc(c.aka)} · ${esc(c.category)}</div></td>
          <td><span class="role-tag role-${c.role.toLowerCase()}">${esc(c.role)}</span></td>
          <td style="font-size:12px">${esc(c.threatens || "—")}</td>
          <td>${this.theatreChips(c.theatres)}</td>
          <td>${this.lcChip(c.lifecycle)}</td>
          <td><div class="matrix-cell-num">${heat}</div><div class="progress-mini"><span style="width:${heat}%;background:${this.lcPalette[(DB.capabilityDefs.lifecycle[c.lifecycle] || {}).tone]}"></span></div></td>
          <td>${this.sparkline(c)}<div style="font-size:10px;color:var(--text-faint)">${this.observations(c)} obs</div></td>
          <td>${this.capTrend(this.trendOf(c))}</td>
          <td>${this.srcBadge(this.obsSourceType(c))}</td>
          <td class="ev-cell">${this.evDrawer(this.evidence(c), this.observed(c), this.observations(c))}</td>
        </tr>`;
      }).join("");
      html += `<div class="section"><div class="section-head"><h2>Capability Inventory</h2>
        <span class="hint">Observed in the briefs but not yet a full contest. Heat / trend / theatres are <strong>brief-derived</strong> (Layer 1); lifecycle is <strong>research-judged</strong> (Layer 2). Promoted into a contest once a countermeasure dynamic is evidenced.</span></div>
        <div class="card matrix-wrap"><table class="matrix"><thead><tr>
          <th>#</th><th>Capability</th><th>Role</th><th>Threatened function</th><th>Theatres</th>
          <th>Lifecycle ${this.srcBadge("research-judged")} ${this.metricTip("lifecycle")}</th><th>Heat ${this.metricTip("heat")}</th>
          <th>Activity (${this.briefMode ? this.axisLen + "&nbsp;ed" : "8&nbsp;wk"})</th>
          <th>Trend ${this.metricTip("trend")}</th><th>Source</th><th>Supporting briefs</th>
        </tr></thead><tbody>${invRows || `<tr><td colspan="11"><div class="empty">No standalone observed capabilities — all observed items are in a contest.</div></td></tr>`}</tbody></table></div></div>`;

      // ---- Supersession (graded: fully / partially / niche) — Layer 2 ----
      // Replacement / supersession is a capability-development judgment, so each
      // link carries a research-basis packet (research-judged) where authored.
      const supRows = this.supersession(all).map(s => {
        const grade = s.from.displacement || "Partially displaced";
        const tone = grade === "Fully superseded" ? "bad" : grade === "Still valid in niche" ? "good" : "warn";
        return `<div class="sup-row"><span class="sup-from">${esc(s.from.name)} ${this.lcChip(s.from.lifecycle)}</span>
          <span class="sup-arrow">→</span>
          <span class="sup-to">${s.to.map(t => `${esc(t.name)} ${this.lcChip(t.lifecycle)}`).join(" · ")}</span>
          <span class="sup-grade sg-${tone}">${esc(grade)}</span>
          <span class="sup-basis">${this.researchDrawer(s.from.displacementSources, "Research basis")}</span>
          ${s.from.niche ? `<div class="sup-niche">Niche: ${esc(s.from.niche)}</div>` : ""}</div>`;
      }).join("");
      html += `<div class="section"><div class="section-head"><h2>Supersession — What Replaced What ${this.srcBadge("research-judged")}</h2>
        <span class="hint">${this.metricTip("supersession")} A capability-development judgment — graded by how completely the older capability was displaced, with a research basis where authored.</span></div>
        <div class="card card-pad">${supRows || `<div class="empty">No supersession links in the current filter.</div>`}</div></div>`;

      // ---- Cross-theatre proliferation (enriched) ----
      // Only keep rows that meaningfully support ALL THREE columns (why it spreads /
      // what limits transfer / SAF relevance). Incomplete rows are dropped rather
      // than padded with "—".
      const diff = this.diffusion(all).filter(c => c.spreadWhy && c.transferLimits && c.safRelevance).map(c => `<tr>
        <td class="theatre-cell">${esc(c.name)}</td>
        <td>${this.theatreChips(c.theatres)}</td>
        <td style="font-size:12px;color:var(--text-muted)">${esc(c.spreadWhy)}</td>
        <td style="font-size:12px;color:var(--text-muted)">${esc(c.transferLimits)}</td>
        <td style="font-size:12px">${esc(c.safRelevance)}</td>
      </tr>`).join("");
      html += `<div class="section"><div class="section-head"><h2>Cross-Theatre Proliferation</h2>
        <span class="hint">Theatre count is ${this.metricTip("proliferation")} brief-derived; why-it-spreads / limits / SAF relevance are analyst-judged. Only rows that support all three are shown.</span></div>
        <div class="card matrix-wrap"><table class="cmp-table"><thead><tr><th>Capability</th><th>Theatres</th><th>Why it spreads</th><th>What limits transfer</th><th>SAF relevance</th></tr></thead>
        <tbody>${diff || `<tr><td colspan="5"><div class="empty">No fully-characterised multi-theatre capabilities in the current filter.</div></td></tr>`}</tbody></table></div></div>`;

      root.innerHTML = html;
      this.wire(root);
      this.renderCharts(all);
    },

    // Default SAF action when a capability has no authored one (role heuristic).
    defaultSaf(c) { return c.role === "Countermeasure" ? "Trial" : "Review"; },

    // One measure ⇄ countermeasure contest card.
    contestCard(ct) {
      const m = this.measureOf(ct), c = this.counterOf(ct);
      const heat = this.contestHeat(ct), trend = this.contestTrend(ct);
      const evRows = this.contestEvidence(ct);
      const obsBacked = this.contestObserved(ct);
      const obsCount = (m ? this.observations(m) : 0) + (c ? this.observations(c) : 0);
      const st = obsBacked ? (this.briefMode ? "brief-derived" : "seed-observed") : "analyst-judged";
      const tone = (DB.capabilityDefs.judgments[ct.operationalJudgment] || {}).tone || "neutral";
      const counterCell = c
        ? `${esc(c.name)} ${this.lcChip(c.lifecycle)}`
        : `<span class="cc-uncountered">⚠ ${esc(ct.countermeasureNote || "Countermeasure not yet evidenced in current weekly briefs")}</span>`;
      const s = this.contestStats(ct);
      const conf = this.contestConfidence(ct);
      const safBlock = this.safActionsBlock(ct.saf);
      const confTip = (DB.capabilityDefs.confidence || {}).method || "";
      const rConf = this.researchConfidence(ct.researchSourceIds);
      const rConfTip = (DB.capabilityDefs.researchConfidence || {}).method || "";
      const L1 = (DB.capabilityDefs.layers || {}).observation || "";
      const L2 = (DB.capabilityDefs.layers || {}).capdev || "";
      return `<article class="contest-card cj-${tone}">
        <div class="cc-head"><span class="cc-title">${esc(ct.title)}</span>
          <span class="cc-metrics">${heat ? `<span class="cc-heat">heat ${heat}</span>` : ""} ${this.capTrend(trend)} ${this.judgmentBadge(ct.operationalJudgment)} ${this.disciplineBadge(this.contestDiscipline(ct))}</span></div>
        ${ct.formationRelevance ? `<div class="cc-forms"><span class="cc-forms-k">Formation relevance</span> ${this.formationChips(ct.formationRelevance)}</div>` : ""}

        <div class="cc-layer cc-layer-1">
          <div class="cc-layer-h tip" tabindex="0">① Current reporting picture <span class="layer-src">${this.srcBadge(st)}</span><span class="tip-body">${esc(L1)}</span></div>
          <div class="cc-grid">
            <div class="cc-f"><div class="cc-h">Measure / attack</div><div class="cc-b">${m ? `${esc(m.name)} ${this.lcChip(m.lifecycle)}` : esc(ct.measureCapId)}</div></div>
            <div class="cc-f"><div class="cc-h">Threatened function</div><div class="cc-b">${esc(ct.threatens || "—")}</div></div>
            <div class="cc-f"><div class="cc-h">Countermeasure observed</div><div class="cc-b">${counterCell}</div></div>
            <div class="cc-f"><div class="cc-h">Observed effect (in reporting)</div><div class="cc-b">${esc(ct.observedEffect || "—")}</div></div>
          </div>
          <div class="cc-lineage">
            <span class="ln"><span class="ln-k">First seen</span> ${esc(s.first || "—")}</span>
            <span class="ln"><span class="ln-k">Last seen</span> ${esc(s.last || "—")}</span>
            <span class="ln"><span class="ln-k">Theatres</span> ${s.theatres.length ? this.theatreChips(s.theatres) : "—"}</span>
            <span class="ln"><span class="ln-k">Supporting weeks</span> ${s.weeks}</span>
            <span class="ln cc-conf tip" tabindex="0"><span class="ln-k">Obs. confidence</span> <strong>${esc(conf.level)}</strong> <span class="conf-score">(${conf.score}/8)</span><span class="tip-body">${esc(confTip)}</span></span>
          </div>
          <div class="cc-basis">${esc(this.contestEvidenceBasis(ct))} ${this.evDrawer(evRows, obsBacked, obsCount)}</div>
        </div>

        <div class="cc-layer cc-layer-2">
          <div class="cc-layer-h tip" tabindex="0">② Broader capability-development assessment <span class="layer-src">${this.srcBadge(ct.researchSourceIds && ct.researchSourceIds.length ? "research-judged" : "analyst-judged")}</span><span class="tip-body">${esc(L2)}</span></div>
          <div class="cc-grid">
            <div class="cc-f"><div class="cc-h">Operational judgment</div><div class="cc-b">${this.judgmentBadge(ct.operationalJudgment)} ${esc(ct.judgmentNote || "")}</div></div>
            <div class="cc-f"><div class="cc-h">Adaptation / bypass</div><div class="cc-b">${esc(ct.adaptationBypass || "—")}</div></div>
          </div>
          ${ct.capdevAssessment ? `<div class="cc-capdev">${esc(ct.capdevAssessment)}</div>` : ""}
          <div class="cc-basis">
            <span class="cc-conf tip" tabindex="0"><span class="ln-k">Research confidence</span> <strong>${esc(rConf)}</strong><span class="tip-body">${esc(rConfTip)}</span></span>
            ${this.researchDrawer(ct.researchSourceIds, "View research basis")}
          </div>
        </div>

        ${safBlock ? `<div class="cc-saf"><div class="cc-h">SAF learning ${this.srcBadge("analyst-judged")}</div><div class="saf-grid">${safBlock}</div></div>` : ""}
      </article>`;
    },

    wire(root) {
      root.querySelectorAll(".lc-filter").forEach(btn => btn.addEventListener("click", () => {
        const lc = btn.dataset.lc;
        State.filters.lifecycle.has(lc) ? State.filters.lifecycle.delete(lc) : State.filters.lifecycle.add(lc);
        this.render();
      }));
      const evBtn = root.querySelector("#cap-ev-only");
      if (evBtn) evBtn.addEventListener("click", () => { State.capEvidencedOnly = !State.capEvidencedOnly; this.render(); });
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

      // Proliferation by theatre — count of OBSERVED capabilities per theatre (brief-derived).
      const tIds = DB.theatres.map(t => t.id);
      const obsPerTheatre = tIds.map(id => list.filter(c => this.observed(c) && c.theatres.includes(id)).length);
      Charts.make("cap-theatre", {
        type: "bar",
        data: { labels: tIds.map(id => THEATRE_BY_ID[id].short),
          datasets: [{ label: "Observed capabilities", data: obsPerTheatre, backgroundColor: tIds.map(id => this.theatreColor(id)) }] },
        options: Object.assign(Charts.baseOpts(), { plugins: { legend: { display: false } } })
      });

      // Observation activity over editions — total brief observations per edition
      // (reporting volume / adaptation tempo). Brief-derived; the x-axis is the
      // loaded brief editions (or seed weeks offline).
      const n = this.axisLen || 0;
      const perEdition = new Array(n).fill(0);
      list.forEach(c => { const d = this.dynamics[c.id]; if (d && d.weekly) d.weekly.forEach((v, i) => (perEdition[i] += v)); });
      const labels = this.briefMode
        ? [...(DB.liveEditions || [])].sort((a, b) => String(a.weekEnd || "").localeCompare(String(b.weekEnd || ""))).map(e => e.rangeLabel || e.weekId)
        : (DB.weeklyReports || []).map(w => w.weekId);
      Charts.make("cap-activity", {
        type: "line",
        data: { labels, datasets: [{ label: "Brief observations", data: perEdition, borderColor: "#a01f2e", backgroundColor: "rgba(160,31,46,0.12)", fill: true, tension: 0.3 }] },
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

    // All citation URLs an insight carries (document sections, structured observed
    // blocks, or legacy sources + finding links) — used for the "N cited" count.
    citeUrls(i) {
      const u = [];
      (i.sections || []).forEach(s => (s.sources || []).forEach(c => c.url && u.push(c.url)));
      (i.observed || []).forEach(b => (b.sources || []).forEach(s => s.url && u.push(s.url)));
      (i.sources || []).forEach(s => s.url && u.push(s.url));
      (i.findings || []).forEach(f => f.url && u.push(f.url));
      return this.dedup(u);
    },
    citeLinks(sources) {
      return (sources || []).filter(s => s && s.url).map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label || "source")} ↗</a>`).join("");
    },

    insightCard(i) {
      const t = THEATRE_BY_ID[i.theatre];
      const tags = (i.tags || []).map(tg => `<span class="tag">#${esc(tg)}</span>`).join("");
      const conf = (i.confidence || "").toLowerCase();
      const confChip = i.confidence ? `<span class="tac-conf ev-conf conf-${esc(conf)}">${esc(i.confidence)} confidence</span>` : "";
      const head = `<div class="tac-head">
          ${this.echBadge(i.echelon)}
          <span class="tac-title">${esc(i.title)}</span>
          <span class="tac-meta"><span class="t-chip" title="${esc(t.name)}">${esc(t.short)}</span> ${esc(i.sourceWeek)} · ${esc(i.sourceDomain)}</span>
          ${confChip}
        </div>`;

      // Document-faithful render: each card reproduces exactly the labelled
      // sections its source report uses (Advance / Countermeasure / Success or
      // failure / Insights / To Consider / …) — no fixed lanes imposed.
      if (Array.isArray(i.sections) && i.sections.length) {
        const secs = i.sections.map(s => {
          const cites = this.citeLinks(s.sources);
          return `<section class="tac-sec sec-${esc(s.kind || "observed")}">
            <div class="tac-sec-h">${esc(s.label)}</div>
            ${s.text ? `<div class="tac-sec-b">${esc(s.text)}</div>` : ""}
            ${(s.bullets && s.bullets.length) ? `<ul class="tac-sec-list">${s.bullets.map(b => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}
            ${cites ? `<div class="tac-sec-cites"><span class="tac-sec-cites-k">Sources:</span> ${cites}</div>` : ""}
          </section>`;
        }).join("");
        return `<article class="tac-card">${head}
          <div class="tac-sections">${secs}</div>
          ${tags ? `<div class="tags">${tags}</div>` : ""}
        </article>`;
      }

      // Legacy render (groups not yet migrated to the document-section model).
      const sopBlock = `<div class="lane lane-sop"><div class="lane-h">4 · SOP / Training implication</div>
        <div class="sop-sub"><span class="sop-k">Train</span>${(i.train || []).length ? `<ul>${i.train.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p class="muted-note">—</p>`}</div>
        <div class="sop-sub"><span class="sop-k">Adjust SOPs</span>${(i.adjustSOP || []).length ? `<ul>${i.adjustSOP.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : `<p class="muted-note">—</p>`}</div></div>`;
      return `<article class="tac-card">${head}
        <div class="tac-fields">
          <div class="tfield tf-observed"><div class="tfield-h">1 · Observed in theatre</div>
            <div class="tfield-b">${esc(i.observedInTheatre || i.soWhat || "")}</div>
            ${this.citeLinks(i.sources) ? `<div class="obs-cites"><span class="obs-cites-k">Read the reporting:</span> ${this.citeLinks(i.sources)}</div>` : ""}</div>
          <div class="tfield tf-insights"><div class="tfield-h">2 · Insights</div>
            <div class="tfield-b">${esc(i.tacticalProblem || "")}</div></div>
        </div>
        <div class="tac-lanes">
          ${this.lane("3 · Experiment with", "lane-exp", i.experiment)}
          ${sopBlock}
        </div>
        <div class="tac-evidence">
          <div class="ev-h">Supporting findings <span class="ev-conf conf-${esc(conf)}">${esc(i.confidence || "—")} confidence</span></div>
          ${(i.findings && i.findings.length) ? `<ul class="ev-findings">${i.findings.map(f => `<li>${esc(f.text)} ${f.url ? `<a class="find-src" href="${esc(f.url)}" target="_blank" rel="noopener">— ${esc(f.source)} ↗</a>` : `<span class="find-src">— ${esc(f.source)}</span>`}</li>`).join("")}</ul>` : `<p class="muted-note">—</p>`}
        </div>
        ${tags ? `<div class="tags">${tags}</div>` : ""}
      </article>`;
    },

    overviewCard(g, gi) {
      const ech = this.echelonsPresent(gi);
      const srcN = this.dedup(gi.flatMap(i => this.citeUrls(i))).length;
      const takes = gi.slice(0, 3).map(i => `<li>${this.echBadge(i.echelon)} ${esc(i.title)}</li>`).join("");
      return `<button class="fg-card" data-group="${g.id}" aria-label="Open ${esc(g.name)} tactical learnings (${esc(g.short)})">
        <div class="fg-card-head"><span class="fg-card-name">${esc(g.name)}</span><span class="fg-card-aud">${esc(g.short)}</span></div>
        <div class="fg-card-counts">${gi.length} tactical learning${gi.length === 1 ? "" : "s"} · ${ech.join("/") || "—"} · ${srcN} cited</div>
        <div class="subhead">Top learnings</div>
        <ul class="dev-list tk-list">${takes || "<li class='muted-note'>No learnings this month.</li>"}</ul>
        <span class="fg-card-cta">Open tactical learnings →</span>
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

          <div class="section-head" style="margin-top:18px"><h2>Formation tactical learnings</h2>
            <span class="hint">Each card is a tactical decision: what was observed → the problem it creates → what to experiment with → SOP/training to adjust</span></div>
          <div class="ech-filter-wrap">${this.echelonFilter(gi)}</div>

          <div class="tac-grid">
            ${shown.length ? shown.map(i => this.insightCard(i)).join("") : `<div class="empty">No learnings at this echelon for ${esc(g.name)} this month.</div>`}
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

      const monthOpts = (MONTHS || []).map(m => `<option value="${m.id}" ${m.id === period.id ? "selected" : ""}>${esc(m.label)} · ${esc(Time.fmtRange(m.start, m.end))}</option>`).join("");
      html += `<div class="section fg-select-wrap">
        <div class="fg-sel">
          <label for="monthly-period-select" class="fg-select-label">Reporting month</label>
          <select id="monthly-period-select" aria-label="Select reporting month">${monthOpts}</select>
        </div>
        <div class="fg-sel">
          <label for="formation-group-select" class="fg-select-label">Formation group</label>
          <select id="formation-group-select" aria-label="Select formation group">
            <option value="ALL" ${sel === "ALL" ? "selected" : ""}>All Groups</option>
            ${this.groups().map(g => `<option value="${g.id}" ${sel === g.id ? "selected" : ""}>${esc(g.name)} — ${esc(g.short)}</option>`).join("")}
          </select>
        </div>
      </div>`;

      if (sel === "ALL") {
        html += `<div class="section"><div class="section-head"><h2>Formation tactical learnings</h2>
          <span class="hint">Select a formation group below — the whole card opens its learnings</span></div>
          <div class="fg-overview">${this.groups().map(g => this.overviewCard(g, this.byGroup(insights, g.id))).join("")}</div></div>`;
      } else {
        const g = this.groupById(sel) || this.groups()[0];
        html += this.groupPanel(g, this.byGroup(insights, g.id));
      }

      container.innerHTML = html;
      this.wire(container);
    },

    wire(root) {
      const msel = root.querySelector("#monthly-period-select");
      if (msel) msel.addEventListener("change", () => { State.periodId = msel.value; this.render(); });
      const sel = root.querySelector("#formation-group-select");
      if (sel) sel.addEventListener("change", () => { State.formationGroup = sel.value; State.monthlyEchelon = "ALL"; this.render(); });
      root.querySelectorAll("[data-group]").forEach(btn =>
        btn.addEventListener("click", () => { State.formationGroup = btn.getAttribute("data-group"); State.monthlyEchelon = "ALL"; this.render(); }));
      root.querySelectorAll(".ech-chip").forEach(btn =>
        btn.addEventListener("click", () => { State.monthlyEchelon = btn.getAttribute("data-ech"); this.render(); }));
    }
  };

  /* ----------------------------------------------------------------------
   * 8c. CONFLICT WATCHLIST  (attention tracker + map)
   *     Analyst-maintained register (watchlist.json) rendered as a decision
   *     page: where to spend attention, what moved, what changed, what to
   *     watch next, and what to ignore for now. All
   *     ranking / movement / change flags are DERIVED here (deterministic and
   *     explainable) — the register only stores the analyst's assessment.
   * -------------------------------------------------------------------- */
  const Watchlist = {
    DIMS: ["phase", "escalation", "tempo", "adaptation", "sgExposure"],
    TABLE_DIMS: ["escalation", "tempo", "adaptation"],      // dimensions shown as register columns
    colDesc(k) { return ((this.defs().columns || {})[k]) || ""; },
    levelDesc(d, v) { const def = this.defs().dimensions[d]; return def && def.levels && def.levels[v] ? def.levels[v] : ""; },
    TIER_R: { 1: 7, 2: 5.5, 3: 4.5 },          // marker radius by tier (map units at world zoom)
    NEAR_DAYS: 14,

    data() { return DB.watchlist || null; },
    meta() { return this.data().meta; },
    defs() { return this.data().definitions; },
    items() { return this.data() ? this.data().items : []; },
    byId(id) { return this.items().find(i => i.id === id); },
    stateDef(s) { return this.defs().states[s] || { order: 9, tone: "neutral", desc: "" }; },
    stateOrder() { return Object.keys(this.defs().states).sort((a, b) => this.stateDef(a).order - this.stateDef(b).order); },
    tone(t) { return `tone-${t || "neutral"}`; },
    fmtDate(s) { return s ? new Date(s).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—"; },
    today() { return Time.iso(new Date()); },
    daysBetween(a, b) { return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86400000); },

    // ---- comparison baseline (rolling window over per-review snapshots) ----
    // The register is reviewed daily, but every "changed since" comparison on
    // the page (state moves, changed dimensions, score bonuses) is made against
    // the register as it stood compareDays (default 7) days before the review
    // date. Each item carries `snapshots` (one per review); the baseline is the
    // newest snapshot at least compareDays old, or the oldest on file while the
    // register has not yet accrued a full window. Falls back to legacy prev /
    // prevState fields for a register without snapshots.
    compareDays() { return this.meta().compareDays || 7; },
    compareCutoff() { return Time.iso(new Date(new Date(this.meta().reviewDate).getTime() - this.compareDays() * 86400000)); },
    baseline(it) {
      const snaps = (it.snapshots || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
      const old = snaps.filter(s => s.date <= this.compareCutoff());
      const s = old.length ? old[old.length - 1] : snaps[0];
      if (!s) return { date: this.meta().previousReviewDate, state: it.prevState || it.state, dims: Object.fromEntries(this.DIMS.map(d => [d, it.dims[d] ? it.dims[d].prev : null])) };
      return { date: s.date, state: s.state, dims: Object.fromEntries(this.DIMS.map(d => [d, s[d] != null ? s[d] : null])) };
    },
    prevOf(it, d) { return this.baseline(it).dims[d]; },
    // Date the visible register is compared against (earliest baseline across items)
    compareDate(list) { const ds = (list || this.items()).map(it => this.baseline(it).date).filter(Boolean).sort(); return ds[0] || this.meta().previousReviewDate; },

    // ---- derived analytics --------------------------------------------
    changedDims(it) { return this.DIMS.filter(d => { const p = this.prevOf(it, d); return it.dims[d] && p != null && it.dims[d].now !== p; }); },
    movement(it) {
      const b = this.baseline(it);
      if (!b.state || b.state === it.state) return null;
      const a = this.stateDef(b.state).order, o = this.stateDef(it.state).order;
      return { from: b.state, to: it.state, dir: o < a ? "up" : "down", date: this.moveDate(it), since: b.date };
    },
    moveDate(it) {
      const h = it.history || [];
      const last = h[h.length - 1];
      return last && last.state === it.state ? last.date : this.meta().reviewDate;
    },
    // History moves inside the recent window (default 28 days before the review date)
    recentMoves(days) {
      const cutoff = new Date(this.meta().reviewDate).getTime() - (days || 28) * 86400000;
      const out = [];
      this.items().forEach(it => {
        const h = it.history || [];
        h.forEach((e, i) => {
          if (i === 0) return;   // the first entry is the baseline, not a move
          if (new Date(e.date).getTime() >= cutoff && h[i - 1].state !== e.state)
            out.push({ item: it, from: h[i - 1].state, to: e.state, date: e.date, note: e.note || "", dir: this.stateDef(e.state).order < this.stateDef(h[i - 1].state).order ? "up" : "down" });
        });
      });
      return out.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    },
    score(it) {
      const parts = [];
      const st = { Priority: 40, Active: 25, Watch: 10, Archive: 0 }[it.state]; parts.push({ label: `State ${it.state}`, pts: st == null ? 0 : st });
      const er = { Severe: 20, High: 15, Moderate: 8, Low: 2 }[it.dims.escalation.now]; parts.push({ label: `Escalation ${it.dims.escalation.now}`, pts: er == null ? 0 : er });
      const ch = this.changedDims(it).length; if (ch) parts.push({ label: `${ch} dimension${ch === 1 ? "" : "s"} changed`, pts: ch * 5 });
      const mv = this.movement(it); if (mv && mv.dir === "up") parts.push({ label: `Moved up (${mv.from} → ${mv.to})`, pts: 10 });
      const sg = { High: 8, Moderate: 4, Low: 0 }[it.dims.sgExposure.now]; parts.push({ label: `SG exposure ${it.dims.sgExposure.now}`, pts: sg == null ? 0 : sg });
      const tr = { 1: 6, 2: 3, 3: 0 }[it.tier]; parts.push({ label: `Tier ${it.tier}`, pts: tr == null ? 0 : tr });
      const f = this.feed(it); if (f && f.surge) parts.push({ label: "Live coverage surge", pts: 8 });
      return { total: parts.reduce((a, p) => a + p.pts, 0), parts };
    },
    rank(list) {
      return list.slice().sort((a, b) =>
        (a.ignore.flag - b.ignore.flag) || (this.score(b).total - this.score(a).total) || (a.tier - b.tier) || a.name.localeCompare(b.name));
    },
    dueStatus(due) {
      if (!due) return { cls: "undated", label: "Undated" };
      const d = this.daysBetween(this.today(), due);
      if (d < 0) return { cls: "passed", label: `Passed ${-d}d ago — confirm outcome` };
      if (d <= this.NEAR_DAYS) return { cls: "near", label: d === 0 ? "Today" : `In ${d}d` };
      return { cls: "later", label: `In ${d}d` };
    },
    nextDue(it) {
      const dated = (it.next || []).filter(n => n.due).sort((a, b) => a.due.localeCompare(b.due));
      return dated[0] || (it.next || [])[0] || null;
    },
    stale() {
      const m = this.meta();
      const days = this.daysBetween(m.reviewDate, this.today());
      const cadence = m.cadenceDays || 7;
      return { days, cadence, overdue: days > cadence * 1.5, nextDue: Time.iso(new Date(new Date(m.reviewDate).getTime() + cadence * 86400000)) };
    },
    quiet(it) { return !it.ignore.flag && !this.changedDims(it).length && !this.movement(it); },

    // ---- live open-source feed (watchlist-live.json, synced from GDELT) ------
    feed(it) { const lf = DB.watchlistLive; return lf && lf.items && lf.items[it.id] ? lf.items[it.id] : null; },
    feedMeta() { return DB.watchlistLive || null; },
    feedAge() { const lf = this.feedMeta(); if (!lf || !lf.syncedAt) return null; return Math.round((Date.now() - new Date(lf.syncedAt).getTime()) / 3600000); },
    sparkline(tl, w, h, granularity) {
      const vals = (tl || []).map(p => p.value); if (vals.length < 2) return "";
      const max = Math.max(1, ...vals);
      const step = w / (vals.length - 1);
      const pts = vals.map((v, i) => `${(i * step).toFixed(1)},${(h - 1 - (v / max) * (h - 2)).toFixed(1)}`).join(" ");
      const n = granularity === "week" ? 1 : 7;                     // points that make up "the last 7 days"
      const x0 = Math.max(0, vals.length - 1 - n) * step;
      const dots = granularity === "week" ? vals.map((v, i) => `<circle cx="${(i * step).toFixed(1)}" cy="${(h - 1 - (v / max) * (h - 2)).toFixed(1)}" r="1.8"/>`).join("") : "";
      return `<svg class="wl-spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true"><rect class="wl-spark-7d" x="${x0.toFixed(1)}" y="0" width="${(w - x0).toFixed(1)}" height="${h}"/><polyline points="${pts}"/>${dots}</svg>`;
    },
    feedCaption(f) { return f.granularity === "week" ? "Four weekly article counts (GDELT, English-language); shaded = last 7 days" : "30-day daily article counts (GDELT, English-language); shaded = last 7 days"; },
    feedCount(f) { return `${f.count7d}${f.capped ? "+" : ""}`; },
    feedItemAge(f) { return f && f.fetchedAt ? Math.round((Date.now() - new Date(f.fetchedAt).getTime()) / 3600000) : null; },
    feedSourceLabel(f) { return /rss/.test(f.source || "") ? (/gdelt/.test(f.source || "") ? "GDELT + Google News" : "Google News RSS") : "GDELT"; },
    feedCell(it) {
      const f = this.feed(it); if (!f) return `<td class="wl-feed-cell"><span class="muted-note">—</span></td>`;
      const d = f.prev7d ? Math.round((f.count7d - f.prev7d) / f.prev7d * 100) : null;
      return `<td class="wl-feed-cell" title="Open-source coverage (GDELT): ${this.feedCount(f)} articles in the last 7 days vs ${f.prev7d}${f.capped ? "+" : ""} the 7 days before${f.capped ? " (counts capped at 250 per window)" : ""}">${this.sparkline(f.timeline, 72, 20, f.granularity)}<div class="wl-feed-n"><b>${this.feedCount(f)}</b>/7d${d != null ? ` <span class="wl-feed-d ${d > 0 ? "up" : d < 0 ? "down" : ""}">${d > 0 ? "+" : ""}${d}%</span>` : ""}${f.surge ? ` <span class="wl-surge">surge</span>` : ""}${(() => { const h = this.feedItemAge(f); return h != null && h > 36 ? ` <span class="wl-feed-stale" title="This item last refreshed ${h}h ago">${Math.round(h / 24)}d old</span>` : ""; })()}</div></td>`;
    },
    // Live movement signal from the open-source feed: surges and sharp coverage changes
    // (last 7 days vs the 7 before). Refreshes with the feed; does not change states.
    coverageMoves(list) {
      return list.map(it => { const f = this.feed(it); if (!f || (!f.prev7d && !f.count7d)) return null;
        const d = f.prev7d ? Math.round((f.count7d - f.prev7d) / f.prev7d * 100) : (f.count7d ? 999 : 0);
        return { it, f, d }; }).filter(x => x && (x.f.surge || Math.abs(x.d) >= 50))
        .sort((p, q) => (q.f.surge - p.f.surge) || Math.abs(q.d) - Math.abs(p.d));
    },
    coverageMovesBlock(list) {
      const lf = this.feedMeta(); if (!lf) return "";
      const rows = this.coverageMoves(list).map(({ it, f, d }) =>
        `<li class="wl-mv-item minor wl-cov-item"><span class="wl-move ${d >= 0 ? "wl-move-up" : "wl-move-down"}">${d >= 0 ? "▲" : "▼"}</span> ${this.nameBtn(it)} <span class="wl-mv-path">coverage ${d >= 0 ? "+" : ""}${d === 999 ? "new" : d + "%"} · ${this.feedCount(f)} vs ${f.prev7d}${f.capped ? "+" : ""} articles${f.surge ? ` <span class="wl-surge">surge</span>` : ""}</span></li>`);
      const h = this.feedAge();
      return `<div class="wl-card-h sub">Live coverage moves <span class="briefs-live">● LIVE</span> <span class="wl-card-h-note">open-source feed, last 7 days vs the 7 before${h != null ? ` · synced ${h < 1 ? "under an hour" : h + "h"} ago` : ""}</span></div>
        ${rows.length ? `<ul class="wl-mv-list">${rows.join("")}</ul>` : `<p class="muted-note">No item is surging or moving by 50% or more this week.</p>`}
        <div class="muted-note wl-cov-note">A coverage move is a signal to look, not a state change: states move only at the daily review.</div>`;
    },
    feedBlock(it) {
      const f = this.feed(it), lf = this.feedMeta();
      if (!f) return `<div class="wl-d-block"><div class="wl-d-h">Latest open-source reporting</div><p class="muted-note">No live feed loaded — the feed syncs hourly from GDELT into <code>watchlist-live.json</code>.</p></div>`;
      const arts = this.feedArticles(f).slice(0, 8).map(x => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a><span class="wl-art-meta">${esc(x.domain)}${x.date ? " · " + esc(this.fmtDate(x.date)) : ""}</span></li>`).join("");
      return `<div class="wl-d-block wl-feed-block"><div class="wl-d-h">Latest open-source reporting <span class="briefs-live">● LIVE</span>${lf && lf.syncedAt ? ` · synced ${esc(Time.fmtDateTime(lf.syncedAt))}` : ""}</div>
        <div class="wl-feed-sum">${this.sparkline(f.timeline, 220, 36, f.granularity)}<div><b>${this.feedCount(f)}</b> articles in the last 7 days · <b>${f.prev7d}${f.capped ? "+" : ""}</b> the 7 days before${f.surge ? ` · <span class="wl-surge">coverage surge</span>` : ""}${f.capped ? ` · <span class="muted-note">counts capped at 250 per window</span>` : ""}<div class="muted-note">${esc(this.feedCaption(f))} · source: ${esc(this.feedSourceLabel(f))}${f.fetchedAt ? ` · this item refreshed ${esc(Time.fmtDateTime(f.fetchedAt))}` : ""}</div></div></div>
        ${arts ? `<ul class="wl-art-list">${arts}</ul>` : `<p class="muted-note">No title-matched articles in the last 7 days.</p>`}</div>`;
    },

    // ---- filters ---------------------------------------------------------
    filtered() {
      const f = State.watchlist;
      return this.items().filter(it =>
        (!f.tiers.size || f.tiers.has(String(it.tier))) &&
        (!f.states.size || f.states.has(it.state)) &&
        (!f.hideIgnored || !it.ignore.flag));
    },

    // ---- small render helpers -------------------------------------------
    stateChip(s, extra) { return `<span class="chip wl-state ${this.tone(this.stateDef(s).tone)}" title="${esc(this.stateDef(s).desc)}">${esc(s)}${extra || ""}</span>`; },
    tierTag(t) { return `<span class="wl-tier wl-tier-${t}" title="${esc((this.defs().tiers[t] || {}).name || "")}">T${t}</span>`; },
    moveGlyph(it) { const m = this.movement(it); return m ? `<span class="wl-move wl-move-${m.dir}" title="${esc(`${m.from} → ${m.to} (${this.fmtDate(m.date)})`)}">${m.dir === "up" ? "▲" : "▼"}</span>` : ""; },
    confChip(c) { return c ? `<span class="ev-conf conf-${esc(String(c).toLowerCase())}">${esc(c)}</span>` : ""; },
    nameBtn(it, cls) { return `<button class="wl-name ${cls || ""}" data-wl-open="${esc(it.id)}" title="Open ${esc(it.name)} in the register">${esc(it.name)}</button>`; },
    scoreChip(it) {
      const s = this.score(it);
      return `<span class="wl-score tip" tabindex="0">${s.total}<span class="tip-body"><strong>Attention score</strong><br>${s.parts.map(p => `${esc(p.label)}: +${p.pts}`).join("<br>")}<br><em>Total ${s.total}</em></span></span>`;
    },
    dimCell(it, d) {
      const v = it.dims[d]; if (!v) return `<td>—</td>`;
      const prev = this.prevOf(it, d), changed = prev != null && prev !== v.now;
      const lvl = this.levelDesc(d, v.now);
      const tip = (changed ? `${this.compareDays()} days ago: ${prev} → now: ${v.now}.` : `Unchanged over the last ${this.compareDays()} days (${v.now}).`) + (lvl ? ` ${v.now}: ${lvl}` : "");
      return `<td class="wl-dim ${changed ? "wl-chg" : ""}" title="${esc(tip)}">` +
        (changed ? `<span class="wl-prev">${esc(prev)}</span> → ` : "") + `<strong>${esc(v.now)}</strong></td>`;
    },
    // Chronological timeline of what has happened so far: the register's `timeline`
    // when present, else the state-history notes (minus the "Baseline:" prefix).
    timelineOf(it) {
      const src = Array.isArray(it.timeline) && it.timeline.length
        ? it.timeline.map(t => ({ date: t.date, text: t.text || "" }))
        : (it.history || []).map(h => ({ date: h.date, text: String(h.note || "").replace(/^Baseline:\s*/i, "") }));
      return src.filter(t => t.date && t.text).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    },
    // Feed articles newest first (the sync ranks them by relevance)
    feedArticles(f) { return ((f && f.articles) || []).slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))); },
    statusCell(it) {
      const st = it.status || {}; const ph = it.dims.phase || {};
      const phPrev = this.prevOf(it, "phase"), changed = phPrev != null && phPrev !== ph.now;
      const links = (st.sources || []).map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener" title="${esc(s.label)}">${esc(s.label)} ↗</a>`).join("");
      // Newest title-matched headline from the live feed (hourly sync) sits on top of the summary
      const f = this.feed(it), art = this.feedArticles(f)[0];
      const news = art ? `<div class="wl-status-news" title="Newest title-matched article in the live open-source feed (${esc(this.feedSourceLabel(f))}, synced hourly); a headline, not an assessment."><span class="wl-news-tag">Newest reporting${art.date ? " · " + esc(this.fmtDate(art.date)) : ""}</span> <a href="${esc(art.url)}" target="_blank" rel="noopener">${esc(art.title)}</a>${art.domain ? ` <span class="wl-art-meta">${esc(art.domain)}</span>` : ""}</div>` : "";
      return `<td class="wl-status">${news}<div class="wl-status-sum">${esc(st.summary || ph.now || "")}</div>${links ? `<div class="wl-status-links">${links}</div>` : ""}
        <div class="wl-phase-line" title="${esc(this.defs().dimensions.phase.desc || "")}">Phase: <b>${esc(ph.now || "—")}</b>${changed ? ` <span class="wl-prev">was: ${esc(phPrev)}</span>` : ""}</div></td>`;
    },

    // ---- MAP (self-contained SVG, equirectangular, no tiles) -------------
    Map: {
      W: 1000, LAT_MAX: 84, LAT_MIN: -58,
      H() { return Math.round((this.LAT_MAX - this.LAT_MIN) * this.W / 360); },
      px(lon) { return (lon + 180) * this.W / 360; },
      py(lat) { return (this.LAT_MAX - lat) * this.W / 360; },
      deg(d) { return d * this.W / 360; },     // degrees → map units (for zone radii)
      // Preset focus regions [lonWest, latNorth, lonEast, latSouth]
      REGIONS: {
        world:    { label: "World",        box: null },
        europe:   { label: "Europe",       box: [-12, 72, 62, 36] },
        mideast:  { label: "Middle East",  box: [24, 42, 66, 10] },
        sasia:    { label: "South Asia",   box: [58, 38, 100, 4] },
        indopac:  { label: "Indo-Pacific", box: [88, 46, 152, -12] },
        americas: { label: "Americas",     box: [-100, 35, -50, -5] }
      },
      regionFor(geo) {
        const order = ["mideast", "europe", "sasia", "indopac", "americas"];
        return order.find(k => { const b = this.REGIONS[k].box; return geo.lon >= b[0] && geo.lon <= b[2] && geo.lat <= b[1] && geo.lat >= b[3]; }) || "world";
      },
      viewBox(region) {
        const r = this.REGIONS[region] || this.REGIONS.world;
        if (!r.box) return [0, 0, this.W, this.H()];
        const [w, n, e, s] = r.box;
        let x = this.px(w), y = this.py(n), bw = this.px(e) - x, bh = this.py(s) - y;
        const aspect = this.W / this.H();
        if (bw / bh > aspect) { const nh = bw / aspect; y -= (nh - bh) / 2; bh = nh; }
        else { const nw = bh * aspect; x -= (nw - bw) / 2; bw = nw; }
        return [x, y, bw, bh].map(v => Math.round(v * 10) / 10);
      },
      pathFor(country) {
        return country.rings.map(r => "M" + r.map(([lon, lat]) => `${this.px(lon).toFixed(1)},${this.py(lat).toFixed(1)}`).join("L") + "Z").join("");
      },
      MIN_W: 30, MAX_W: 1000,
      // Clamp a free viewBox to sensible zoom and keep the map in frame
      clamp(vb) {
        const aspect = this.W / this.H();
        let w = Math.min(this.MAX_W, Math.max(this.MIN_W, vb[2]));
        let h = w / aspect;
        let x = Math.min(Math.max(vb[0], -w * 0.5), this.W - w * 0.5);
        let y = Math.min(Math.max(vb[1], -h * 0.5), this.H() - h * 0.5);
        return [x, y, w, h].map(v => Math.round(v * 100) / 100);
      },
      // Apply a viewBox to a rendered SVG without re-rendering: markers are counter-scaled
      applyView(svg, vb) {
        svg.setAttribute("viewBox", vb.join(" "));
        const k = vb[2] / this.W;
        svg.querySelectorAll(".wl-mk").forEach(g => g.setAttribute("transform", `scale(${k.toFixed(4)})`));
      },
      render(items, selected, region, view) {
        const world = DB.world && DB.world.countries ? DB.world.countries : [];
        const vb = view ? this.clamp(view) : this.viewBox(region);
        const k = vb[2] / this.W;                    // zoom factor (1 = world)
        // Which state colours each involved country (highest-priority state wins)
        const fill = {};
        items.forEach(it => (it.geo.countries || []).forEach(c => {
          const o = Watchlist.stateDef(it.state).order;
          if (!fill[c] || o < fill[c].order) fill[c] = { order: o, tone: Watchlist.stateDef(it.state).tone, id: it.id };
        }));
        const land = world.map(c => {
          const f = fill[c.id];
          return `<path class="wl-land ${f ? `wl-fill-${f.tone}` : ""}" d="${this.pathFor(c)}"${f ? ` data-wl-country="${esc(f.id)}"` : ""}><title>${esc(c.name)}</title></path>`;
        }).join("");
        const zones = items.flatMap(it => (it.geo.zones || []).map(z =>
          `<circle class="wl-zone wl-zone-${Watchlist.stateDef(it.state).tone}" cx="${this.px(z.lon).toFixed(1)}" cy="${this.py(z.lat).toFixed(1)}" r="${this.deg(z.r).toFixed(1)}"><title>${esc(z.label || it.name)}</title></circle>`)).join("");
        const markers = Watchlist.rank(items).reverse().map(it => {   // draw high-attention markers last (on top)
          const x = this.px(it.geo.lon), y = this.py(it.geo.lat);
          const r = Watchlist.TIER_R[it.tier] || 4.5;      // screen-constant: the .wl-mk group is counter-scaled by k
          const sel = selected === it.id;
          const mv = Watchlist.movement(it);
          const tone = Watchlist.stateDef(it.state).tone;
          const tip = `${it.name} · Tier ${it.tier} · ${it.state}${mv ? ` (${mv.dir === "up" ? "moved up" : "moved down"} from ${mv.from})` : ""} · Escalation ${it.dims.escalation.now}`;
          const lx = (it.geo.labelDx || 0), ly = (it.geo.labelDy || -12);
          const anchor = lx > 4 ? "start" : lx < -4 ? "end" : "middle";
          return `<g class="wl-marker wl-m-${tone} ${sel ? "selected" : ""} ${it.ignore.flag ? "ignored" : ""}" data-wl="${esc(it.id)}" tabindex="0" role="button" aria-label="${esc(tip)}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">
            <title>${esc(tip)}</title>
            <g class="wl-mk" transform="scale(${k.toFixed(4)})">
              ${sel ? `<circle class="wl-ring" cx="0" cy="0" r="${(r * 2.2).toFixed(1)}"/>` : ""}
              <circle class="wl-dot" cx="0" cy="0" r="${r.toFixed(1)}"/>
              ${mv ? `<text class="wl-mv wl-mv-${mv.dir}" x="${(r * 0.9).toFixed(1)}" y="${(-r * 0.9).toFixed(1)}" font-size="9">${mv.dir === "up" ? "▲" : "▼"}</text>` : ""}
              <text class="wl-label" x="${lx}" y="${ly}" font-size="11" text-anchor="${anchor}">${esc(it.short || it.name)}</text>
            </g>
          </g>`;
        }).join("");
        return `<svg class="wl-svg" viewBox="${vb.join(" ")}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Conflict watchlist map — scroll to zoom, drag to pan">
          <rect class="wl-sea" x="0" y="0" width="${this.W}" height="${this.H()}"/>
          <g class="wl-land-g">${land || `<text x="500" y="200" text-anchor="middle" class="wl-nomap">Base map unavailable — markers only</text>`}</g>
          <g class="wl-zones">${zones}</g>
          <g class="wl-markers">${markers}</g>
        </svg>`;
      }
    },

    // ---- sections ------------------------------------------------------------
    header(list) {
      const m = this.meta();
      const f = State.watchlist;
      const tierChips = Object.keys(this.defs().tiers).map(t =>
        `<button class="fchip wl-f-tier" aria-pressed="${f.tiers.has(t)}" data-tier="${t}" title="${esc(this.defs().tiers[t].desc)}">Tier ${t} · ${esc(this.defs().tiers[t].name)}</button>`).join("");
      const stateChips = this.stateOrder().map(s =>
        `<button class="fchip wl-f-state" aria-pressed="${f.states.has(s)}" data-state="${s}" title="${esc(this.stateDef(s).desc)}">${esc(s)}</button>`).join("");
      return `<div class="card card-pad wl-head">
        <div class="wl-head-row">
          <div>
            <div class="wl-title">${esc(m.title || "Conflict Watchlist")} <span class="wl-asof">— daily review as of ${esc(this.fmtDate(m.reviewDate))}</span></div>
          </div>
        </div>
        <div class="wl-filter-row">
          <span class="wl-filter-lbl">Tier</span><span class="chip-row">${tierChips}</span>
          <span class="wl-filter-lbl">State</span><span class="chip-row">${stateChips}</span>
          <button class="fchip wl-f-ignored" aria-pressed="${f.hideIgnored}" title="Hide items flagged ignore-for-now">Hide ignorable</button>
          ${(f.tiers.size || f.states.size || f.hideIgnored) ? `<button class="link-btn" data-wl-reset>Clear filters</button>` : ""}
        </div>
      </div>`;
    },

    attention(list) {
      const ranked = this.rank(list);
      const top = ranked.filter(i => !i.ignore.flag).slice(0, 5);
      const rest = ranked.length - top.length;
      const quietN = list.filter(i => this.quiet(i)).length;
      const ignored = list.filter(i => i.ignore.flag).length;
      const rows = top.map((it, i) => `<li class="wl-rank-item">
          <span class="wl-rank-n">${i + 1}</span>
          <div class="wl-rank-body">
            <div class="wl-rank-head">${this.nameBtn(it, "wl-name-lg")} ${this.tierTag(it.tier)} ${this.stateChip(it.state, this.moveGlyph(it))} ${this.scoreChip(it)}</div>
            <div class="wl-rank-why">${esc(it.whyNow || "")}</div>
          </div></li>`).join("");
      return `<div class="section"><div class="section-head"><h2>What deserves attention now?</h2><span class="hint">Ranked by the explainable attention score — hover a score for its breakdown</span></div>
        <div class="card bluf-card card-pad wl-bluf">
          <div class="bluf-label">Where to spend limited attention this week</div>
          ${top.length ? `<ol class="wl-rank">${rows}</ol>` : `<p class="muted-note">No items match the current filters.</p>`}
          <div class="bluf-sub">${rest > 0 ? `${rest} further item${rest === 1 ? "" : "s"} below the fold in the register. ` : ""}${quietN} quiet (no change, no move) · ${ignored} flagged ignore-for-now (see the ignore list below).</div>
        </div></div>`;
    },

    mapSection(list) {
      const f = State.watchlist;
      const regionBtns = Object.entries(this.Map.REGIONS).map(([k, r]) =>
        `<button class="fchip wl-region" aria-pressed="${!f.view && f.region === k}" data-region="${k}">${esc(r.label)}</button>`).join("");
      const legend = this.stateOrder().map(s => `<span class="wl-lg"><i class="wl-lg-dot wl-m-${this.stateDef(s).tone}"></i>${esc(s)}</span>`).join("") +
        `<span class="wl-lg"><i class="wl-lg-dot wl-lg-t1"></i>Tier 1 (large) → Tier 3 (small)</span><span class="wl-lg"><i class="wl-lg-zone"></i>Maritime / zone watch</span><span class="wl-lg">▲▼ state moved in the last ${this.compareDays()} days</span>`;
      const moves = list.filter(it => this.movement(it)).map(it => {
        const m = this.movement(it);
        return `<li class="wl-mv-item"><span class="wl-move wl-move-${m.dir}">${m.dir === "up" ? "▲" : "▼"}</span> ${this.nameBtn(it)} <span class="wl-mv-path">${this.stateChip(m.from)} → ${this.stateChip(m.to)}</span><div class="wl-mv-note">${esc(it.whyNow || "")}</div></li>`;
      });
      // Earlier moves: history moves in the last 90 days that sit before each item's comparison baseline
      const recent = this.recentMoves(90).filter(r => list.includes(r.item) && String(r.date) <= String(this.baseline(r.item).date));
      const recentRows = recent.map(r => `<li class="wl-mv-item minor"><span class="wl-move wl-move-${r.dir}">${r.dir === "up" ? "▲" : "▼"}</span> ${this.nameBtn(r.item)} <span class="wl-mv-path">${esc(r.from)} → ${esc(r.to)} · ${esc(this.fmtDate(r.date))}</span>${r.note ? `<div class="wl-mv-note">${esc(r.note)}</div>` : ""}</li>`);
      const board = this.stateOrder().map(s => {
        const col = this.rank(list.filter(i => i.state === s));
        return `<div class="wl-col wl-col-${this.stateDef(s).tone}"><div class="wl-col-h">${this.stateChip(s)} <span class="wl-col-n">${col.length}</span><div class="wl-col-desc">${esc(this.stateDef(s).desc)}</div></div>
          <div class="wl-col-body">${col.map(it => `<button class="wl-card-chip ${this.movement(it) ? "moved" : ""} ${it.ignore.flag ? "ignored" : ""}" data-wl-open="${esc(it.id)}">${this.tierTag(it.tier)} ${esc(it.name)} ${this.moveGlyph(it)}</button>`).join("") || `<div class="muted-note">—</div>`}</div></div>`;
      }).join("");
      return `<div class="section"><div class="section-head"><h2>Which theatres moved?</h2><span class="hint">Marker colour = monitoring state · size = tier · click a marker to open its register row</span></div>
        <div class="wl-map-grid">
          <div class="card card-pad wl-map-card">
            <div class="wl-map-tools"><span class="wl-filter-lbl">Focus</span><span class="chip-row">${regionBtns}</span>
              <span class="wl-zoom-tools"><button class="btn wl-zoom" data-zoom="in" title="Zoom in" aria-label="Zoom in">+</button><button class="btn wl-zoom" data-zoom="out" title="Zoom out" aria-label="Zoom out">−</button><button class="btn wl-zoom" data-zoom="reset" title="Reset to the selected focus" aria-label="Reset zoom">⟲</button><span class="wl-zoom-hint">scroll to zoom · drag to pan</span></span></div>
            <div class="wl-map-wrap ${f.view ? "custom" : ""}">${this.Map.render(list, f.selected, f.region, f.view)}</div>
            <div class="wl-legend">${legend}</div>
          </div>
          <div class="card card-pad wl-moves-card">
            <div class="wl-card-h">State moves in the last ${this.compareDays()} days <span class="wl-card-h-note">compared with ${esc(this.fmtDate(this.compareDate(list)))} · latest daily review ${esc(this.fmtDate(this.meta().reviewDate))}</span></div>
            ${moves.length ? `<ul class="wl-mv-list">${moves.join("")}</ul>` : `<p class="muted-note">No state moves in the last ${this.compareDays()} days.</p>`}
            <div class="wl-card-h sub">Earlier moves <span class="wl-card-h-note">last 90 days, before the comparison window · full history in each expanded row</span></div>
            ${recentRows.length ? `<ul class="wl-mv-list">${recentRows.join("")}</ul>` : `<p class="muted-note wl-mv-none">No earlier state moves in the last 90 days.</p>`}
            ${this.coverageMovesBlock(list)}
          </div>
        </div>
        <div class="wl-board">${board}</div>
      </div>`;
    },

    detail(it) {
      const chg = this.changedDims(it);
      const dimsLine = chg.length
        ? chg.map(d => `<span class="wl-chg-pill">${esc(this.defs().dimensions[d].short)}: ${esc(this.prevOf(it, d))} → <strong>${esc(it.dims[d].now)}</strong></span>`).join(" ")
        : `<span class="muted-note">No dimension changed in the last ${this.compareDays()} days.</span>`;
      const next = (it.next || []).map(n => {
        const ds = this.dueStatus(n.due);
        return `<li class="wl-ind"><span class="wl-ind-type">${esc(n.type)}</span> <span class="wl-due wl-due-${ds.cls}" title="${esc(n.due || "no date")}">${n.due ? esc(this.fmtDate(n.due)) + " · " : ""}${esc(ds.label)}</span><div class="wl-ind-text">${esc(n.text)}</div>${n.ifSeen ? `<div class="wl-ind-if">If seen → ${esc(n.ifSeen)}</div>` : ""}</li>`;
      }).join("");
      // "Timeline so far": a short chronological run of what has happened (register
      // `timeline` [{date, text}]; until the review writes one, the state-history
      // notes stand in). No state chips: the intent is a quick recap, not audit.
      const tl = this.timelineOf(it);
      const hist = tl.map((h, i) => `<li class="${i === tl.length - 1 ? "wl-tl-latest" : ""}"><span class="wl-hist-d">${esc(this.fmtDate(h.date))}</span> <span class="wl-tl-text">${esc(h.text)}</span></li>`).join("");
      return `<div class="wl-detail-grid">
        <div class="wl-d-block"><div class="wl-d-h">What materially changed</div>
          <div class="wl-chg-line">${dimsLine}</div>
          <ul class="wl-bullets">${(it.changes || []).map(c => `<li>${esc(c)}</li>`).join("")}</ul></div>
        <div class="wl-d-block"><div class="wl-d-h">What might happen next</div>${next ? `<ul class="wl-ind-list">${next}</ul>` : `<p class="muted-note">No indicators recorded.</p>`}</div>
        <div class="wl-d-block"><div class="wl-d-h">Ignore for now?</div>
          <p class="wl-d-p">${it.ignore.flag ? `<strong>Yes</strong> — ${it.ignore.reasons.map(r => `<span class="tag">${esc(r)}</span>`).join(" ")} ${esc(it.ignore.note || "")}` : `<strong>No</strong> — keep on the active watch.${it.ignore.note ? " " + esc(it.ignore.note) : ""}`}</p>
          <div class="wl-d-meta">Confidence ${this.confChip(it.confidence)} · Army learning value <strong>${esc(it.learningValue || "—")}</strong> · Region ${esc(it.region || "—")}</div></div>
        ${this.feedBlock(it)}
        <div class="wl-d-block wl-hist"><div class="wl-d-h">Timeline so far</div><ul class="wl-hist-list wl-tl-list">${hist || "<li class='muted-note'>—</li>"}</ul>
          ${(it.sources || []).length ? `<div class="wl-d-h sub">Sources (${it.sources.length})</div><ul class="wl-src-list">${it.sources.map(s => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label || s.url)} ↗</a></li>`).join("")}</ul>` : ""}
          <button class="btn wl-show-map" data-wl-map="${esc(it.id)}">📍 Show on map</button></div>
      </div>`;
    },

    register(list) {
      const ranked = this.rank(list);
      const f = State.watchlist;
      const dimHead = this.TABLE_DIMS.map(d => { const def = this.defs().dimensions[d]; const lv = def.levels ? Object.entries(def.levels).map(([k, v]) => `${k}: ${v}`).join("\n") : "";
        return `<th class="wl-th-help" title="${esc(`${def.label}. ${def.desc || ""}${lv ? "\n\n" + lv : ""}`)}">${esc(def.short)}</th>`; }).join("");
      const th = (k, label) => `<th class="wl-th-help" title="${esc(this.colDesc(k))}">${label}</th>`;
      const rows = ranked.map((it, i) => {
        const open = f.expanded.has(it.id);
        const nd = this.nextDue(it);
        const ds = nd ? this.dueStatus(nd.due) : null;
        const chg = this.changedDims(it).length;
        return `<tr class="wl-row ${open ? "open" : ""} ${f.selected === it.id ? "selected" : ""} ${it.ignore.flag ? "ignored" : ""}" data-wl-row="${esc(it.id)}" id="wl-row-${esc(it.id)}">
          <td class="wl-n">${i + 1}</td>
          <td>${this.tierTag(it.tier)}</td>
          <td class="theatre-cell"><button class="wl-expand" data-wl-toggle="${esc(it.id)}" aria-expanded="${open}" title="${open ? "Collapse" : "Expand"}">${open ? "▾" : "▸"}</button> ${esc(it.name)}</td>
          <td>${this.stateChip(it.state, this.moveGlyph(it))}</td>
          ${this.statusCell(it)}
          ${this.TABLE_DIMS.map(d => this.dimCell(it, d)).join("")}
          ${this.feedCell(it)}
          <td class="wl-next">${nd ? `<span class="wl-due wl-due-${ds.cls}">${nd.due ? esc(this.fmtDate(nd.due)) : "undated"}</span> <span class="wl-next-t">${esc(nd.text)}</span>` : "—"}</td>
          <td>${this.confChip(it.confidence)}</td>
          <td>${this.scoreChip(it)}</td>
        </tr>${open ? `<tr class="wl-detail-row" data-wl-detail="${esc(it.id)}"><td colspan="${9 + this.TABLE_DIMS.length}">${this.detail(it)}</td></tr>` : ""}`;
      }).join("");
      return `<div class="section"><div class="section-head"><h2>What materially changed?</h2><span class="hint">Register ordered by attention · highlighted cells changed since the previous review · hover a column header or a value for how it is defined · expand a row for changes, indicators, the ignore verdict, the latest reporting and the history</span>
          <div class="head-actions"><button class="btn" data-wl-expand-all>Expand all</button><button class="btn" data-wl-collapse-all>Collapse all</button></div></div>
        <div class="card matrix-wrap"><table class="matrix wl-register" id="wl-register"><thead><tr>
          <th>#</th>${th("tier", "Tier")}<th>Conflict</th>${th("state", "State")}${th("status", "Current status")}${dimHead}${th("coverage", "Coverage")}${th("nextIndicator", "Next indicator")}${th("confidence", "Conf.")}${th("attention", "Attn")}
        </tr></thead><tbody>${rows || `<tr><td colspan="${9 + this.TABLE_DIMS.length}" class="empty">No items match the current filters.</td></tr>`}</tbody></table></div></div>`;
    },

    indicators(list) {
      const ranked = this.rank(list);
      const all = [];
      ranked.forEach((it, r) => (it.next || []).forEach(n => all.push({ it, n, r })));
      const dated = all.filter(x => x.n.due).sort((a, b) => a.n.due.localeCompare(b.n.due) || a.r - b.r);
      const undated = all.filter(x => !x.n.due);
      const row = x => {
        const ds = this.dueStatus(x.n.due);
        return `<tr class="${x.it.ignore.flag ? "ignored" : ""}"><td class="wl-due-cell"><span class="wl-due wl-due-${ds.cls}">${x.n.due ? esc(this.fmtDate(x.n.due)) : "—"}</span><div class="wl-due-sub">${esc(ds.label)}</div></td>
          <td>${this.nameBtn(x.it)} ${this.tierTag(x.it.tier)}</td><td><span class="wl-ind-type">${esc(x.n.type)}</span></td><td>${esc(x.n.text)}</td><td class="wl-ifseen">${esc(x.n.ifSeen || "")}</td></tr>`;
      };
      return `<div class="section"><div class="section-head"><h2>What might happen next?</h2><span class="hint">Named events, thresholds, deadlines, mobilisation signs, force movements, diplomatic decisions and escalation indicators — dated first</span></div>
        <div class="card matrix-wrap"><table class="matrix wl-indicators" id="wl-indicators"><thead><tr><th>Due</th><th>Conflict</th><th>Type</th><th>Indicator to watch</th><th>If seen →</th></tr></thead>
        <tbody>${dated.map(row).join("")}${undated.length ? `<tr class="wl-sep"><td colspan="5">Undated indicators (trigger-based)</td></tr>${undated.map(row).join("")}` : ""}${!all.length ? `<tr><td colspan="5" class="empty">No indicators for the current filters.</td></tr>` : ""}</tbody></table></div></div>`;
    },

    ignoreSection(list) {
      const flagged = this.rank(list).filter(i => i.ignore.flag);
      const quiet = this.rank(list).filter(i => this.quiet(i));
      const trig = it => { const e = (it.next || []).find(n => /escalat|threshold|mobilis|force/i.test(n.type)) || (it.next || [])[0]; return e ? e.text : "—"; };
      const rows = flagged.map(it => `<li class="wl-ig-item"><div>${this.nameBtn(it)} ${this.tierTag(it.tier)} ${this.stateChip(it.state)} ${it.ignore.reasons.map(r => `<span class="tag">${esc(r)}</span>`).join(" ")}</div>
          <div class="wl-ig-note">${esc(it.ignore.note || "")}</div><div class="wl-ig-trig"><strong>Revisit trigger:</strong> ${esc(trig(it))}</div></li>`).join("");
      return `<div class="section"><div class="section-head"><h2>What can be ignored for now?</h2><span class="hint">Stable, repetitive, low-confidence, or no current Army learning value — with the trigger that would bring each back</span></div>
        <div class="card card-pad">
          ${rows ? `<ul class="wl-ig-list">${rows}</ul>` : `<p class="muted-note">Nothing is flagged ignore-for-now in the current filter.</p>`}
          ${quiet.length ? `<div class="wl-quiet"><strong>Quiet over the last ${this.compareDays()} days (not flagged):</strong> ${quiet.map(it => this.nameBtn(it)).join(", ")} — no dimension changed, no state move, Dashboard only.</div>` : ""}
        </div></div>`;
    },

    method() {
      const m = this.meta(), d = this.defs();
      return `<details class="wl-method"><summary>How this page derives its answers · how to update the register</summary>
        <div class="wl-method-body">
          <p><strong>Attention score.</strong> ${esc((d.attentionScore || {}).desc || "")}</p>
          <p><strong>Moved / changed.</strong> Every comparison is made against the register as it stood <code>compareDays</code> (${this.compareDays()}) days before the review date, taken from each item's per-review <code>snapshots</code> (the newest snapshot at least that old; the oldest on file until a full window has accrued). A state move is baseline state ≠ <code>state</code>; a changed dimension is baseline value ≠ <code>now</code>.</p>
          <p><strong>Criteria.</strong> ${this.DIMS.filter(d => d !== "phase").map(d => { const def = this.defs().dimensions[d]; return `<em>${esc(def.label)}</em> — ${esc(def.desc || "")} ${def.levels ? Object.entries(def.levels).map(([k, v]) => `<b>${esc(k)}</b>: ${esc(v)}`).join(" ") : ""}`; }).join("<br>")}</p>
          <p><strong>Live feed.</strong> ${esc((d.feed || {}).source || "")} ${esc((d.feed || {}).surgeRule || "")} ${esc((d.feed || {}).titleFilter || "")}</p>
          <p><strong>Automated review.</strong> The register itself is rewritten daily by a scheduled open-source review (see <code>docs/WATCHLIST-REVIEW.md</code>) and published directly from open sources; the weekly brief on the Weekly tab is neither shown here nor used as a source.</p>
          <p><strong>Updating.</strong> ${esc(m.notes || "")} Source file: <code>watchlist.json</code>.</p>
          <p><strong>Tiers.</strong> ${Object.entries(d.tiers).map(([k, t]) => `T${k} ${esc(t.name)} — ${esc(t.desc)}`).join(" · ")}</p>
          <p><strong>States.</strong> ${this.stateOrder().map(s => `${esc(s)} — ${esc(this.stateDef(s).desc)}`).join(" · ")}</p>
        </div></details>`;
    },

    // ---- top-level render + wiring ------------------------------------------
    render() {
      Charts.destroyAll();
      const container = el("#view-watchlist .view-body");
      if (!this.data()) {
        el("#meta-range").textContent = "—";
        container.innerHTML = `<div class="empty">watchlist.json could not be loaded. Add the register file next to the dashboard (see README) and reload.</div>`;
        return;
      }
      const m = this.meta();
      el("#meta-range").textContent = "—";   // block is hidden on the Watchlist tab (styles: body.watchlist-view)
      const list = this.filtered();
      container.innerHTML =
        this.header(list) +
        this.attention(list) +
        this.mapSection(list) +
        this.register(list) +
        this.indicators(list) +
        this.ignoreSection(list) +
        this.method();
      this.wire(container);
    },

    open(id, scroll) {
      State.watchlist.selected = id;
      State.watchlist.expanded.add(id);
      this.render();
      if (scroll) { const row = document.getElementById(`wl-row-${id}`); if (row && row.scrollIntoView) row.scrollIntoView({ behavior: "smooth", block: "center" }); }
    },

    wire(root) {
      const f = State.watchlist;
      root.querySelectorAll(".wl-f-tier").forEach(b => b.addEventListener("click", () => { const t = b.dataset.tier; f.tiers.has(t) ? f.tiers.delete(t) : f.tiers.add(t); this.render(); }));
      root.querySelectorAll(".wl-f-state").forEach(b => b.addEventListener("click", () => { const s = b.dataset.state; f.states.has(s) ? f.states.delete(s) : f.states.add(s); this.render(); }));
      const ig = root.querySelector(".wl-f-ignored"); if (ig) ig.addEventListener("click", () => { f.hideIgnored = !f.hideIgnored; this.render(); });
      const rs = root.querySelector("[data-wl-reset]"); if (rs) rs.addEventListener("click", () => { f.tiers.clear(); f.states.clear(); f.hideIgnored = false; this.render(); });
      root.querySelectorAll(".wl-region").forEach(b => b.addEventListener("click", () => { f.region = b.dataset.region; f.view = null; this.render(); }));
      this.wireMap(root);
      root.querySelectorAll(".wl-marker").forEach(g => {
        const act = () => { if (this._mapDragged) return; this.open(g.dataset.wl, true); };
        g.addEventListener("click", act);
        g.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); act(); } });
      });
      root.querySelectorAll("[data-wl-open]").forEach(b => b.addEventListener("click", () => this.open(b.getAttribute("data-wl-open"), true)));
      root.querySelectorAll("[data-wl-toggle]").forEach(b => b.addEventListener("click", () => {
        const id = b.getAttribute("data-wl-toggle");
        f.expanded.has(id) ? f.expanded.delete(id) : f.expanded.add(id);
        f.selected = id; this.render();
      }));
      root.querySelectorAll("[data-wl-map]").forEach(b => b.addEventListener("click", () => {
        const it = this.byId(b.getAttribute("data-wl-map")); if (!it) return;
        f.selected = it.id; f.region = this.Map.regionFor(it.geo); f.view = null; this.render();
        const map = document.querySelector(".wl-map-card"); if (map && map.scrollIntoView) map.scrollIntoView({ behavior: "smooth", block: "center" });
      }));
      const ea = root.querySelector("[data-wl-expand-all]"); if (ea) ea.addEventListener("click", () => { this.filtered().forEach(i => f.expanded.add(i.id)); this.render(); });
      const ca = root.querySelector("[data-wl-collapse-all]"); if (ca) ca.addEventListener("click", () => { f.expanded.clear(); this.render(); });
    },

    // ---- map pan / zoom (mouse wheel, drag, pinch, buttons) --------------------
    _mapDragged: false,
    wireMap(root) {
      const svg = root.querySelector("svg.wl-svg"); if (!svg) return;
      const f = State.watchlist, M = this.Map;
      const current = () => (svg.getAttribute("viewBox") || "").split(/\s+/).map(Number);
      const toSvg = (clientX, clientY) => {           // client px → map units
        const r = svg.getBoundingClientRect(), vb = current();
        const s = Math.max(vb[2] / (r.width || 1), vb[3] / (r.height || 1));      // meet: the larger scale applies
        const ox = (r.width - vb[2] / s) / 2, oy = (r.height - vb[3] / s) / 2;     // letterbox offsets
        return [vb[0] + (clientX - r.left - ox) * s, vb[1] + (clientY - r.top - oy) * s];
      };
      const set = vb => { f.view = M.clamp(vb); M.applyView(svg, f.view); root.querySelectorAll(".wl-region").forEach(b => b.setAttribute("aria-pressed", "false")); svg.closest(".wl-map-wrap").classList.add("custom"); };
      const zoomAt = (factor, cx, cy) => {            // keep the map point under (cx,cy) fixed
        const vb = current(); const [mx, my] = [cx, cy];
        const w = vb[2] * factor, h = vb[3] * factor;
        set([mx - (mx - vb[0]) * factor, my - (my - vb[1]) * factor, w, h]);
      };
      const zoomCentre = factor => { const vb = current(); zoomAt(factor, vb[0] + vb[2] / 2, vb[1] + vb[3] / 2); };
      svg.addEventListener("wheel", e => {
        e.preventDefault();
        const factor = Math.exp((e.deltaMode === 1 ? e.deltaY * 20 : e.deltaY) * 0.0018);   // >1 zooms out
        const [mx, my] = toSvg(e.clientX, e.clientY); zoomAt(factor, mx, my);
      }, { passive: false });
      svg.addEventListener("dblclick", e => { e.preventDefault(); const [mx, my] = toSvg(e.clientX, e.clientY); zoomAt(0.5, mx, my); });
      // drag to pan (one pointer) / pinch to zoom (two pointers)
      const ptrs = new Map(); let start = null, pinch = null;
      svg.addEventListener("pointerdown", e => {
        if (e.button != null && e.button !== 0) return;
        ptrs.set(e.pointerId, [e.clientX, e.clientY]);
        try { svg.setPointerCapture(e.pointerId); } catch (x) { /* jsdom */ }
        if (ptrs.size === 1) { start = { x: e.clientX, y: e.clientY, vb: current(), moved: false }; this._mapDragged = false; }
        if (ptrs.size === 2) { const p = [...ptrs.values()]; pinch = { d: Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]), vb: current() }; start = null; }
      });
      svg.addEventListener("pointermove", e => {
        if (!ptrs.has(e.pointerId)) return;
        ptrs.set(e.pointerId, [e.clientX, e.clientY]);
        if (pinch && ptrs.size === 2) {
          const p = [...ptrs.values()]; const d = Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]);
          const factor = pinch.d / Math.max(d, 1);
          const [mx, my] = toSvg((p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2);
          const vb = pinch.vb; set([mx - (mx - vb[0]) * factor, my - (my - vb[1]) * factor, vb[2] * factor, vb[3] * factor]);
          return;
        }
        if (!start) return;
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (!start.moved && Math.hypot(dx, dy) < 4) return;
        start.moved = true; this._mapDragged = true; svg.classList.add("dragging");
        const r = svg.getBoundingClientRect(), vb = start.vb;
        const s = Math.max(vb[2] / (r.width || 1), vb[3] / (r.height || 1));
        set([vb[0] - dx * s, vb[1] - dy * s, vb[2], vb[3]]);
      });
      const end = e => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null; if (!ptrs.size) { start = null; svg.classList.remove("dragging"); setTimeout(() => { this._mapDragged = false; }, 0); } };
      svg.addEventListener("pointerup", end); svg.addEventListener("pointercancel", end); svg.addEventListener("pointerleave", e => { if (!ptrs.size) svg.classList.remove("dragging"); });
      root.querySelectorAll(".wl-zoom").forEach(b => b.addEventListener("click", () => {
        const z = b.dataset.zoom;
        if (z === "reset") { f.view = null; this.render(); return; }
        zoomCentre(z === "in" ? 1 / 1.5 : 1.5);
      }));
    },

    // ---- export ----------------------------------------------------------------
    exportObject() {
      const m = this.meta();
      return {
        generatedAt: new Date().toISOString(), view: "watchlist",
        reviewDate: m.reviewDate, previousReviewDate: m.previousReviewDate, compareDays: this.compareDays(), comparedWith: this.compareDate(),
        note: "attentionScore, changedDims, movement and liveFeed are derived by the dashboard; the rest is the register.",
        items: this.rank(this.filtered()).map(it => Object.assign({}, it, {
          attentionScore: this.score(it).total, baseline: this.baseline(it), changedDims: this.changedDims(it), movement: this.movement(it), liveFeed: this.feed(it)
        }))
      };
    },
    exportRows() {
      return this.rank(this.filtered()).map(it => {
        const nd = this.nextDue(it), mv = this.movement(it), f7 = this.feed(it);
        return [it.tier, it.name, it.state, mv ? `${mv.from} → ${mv.to}` : "",
          ...this.DIMS.map(d => it.dims[d].now), this.changedDims(it).map(d => this.defs().dimensions[d].short).join("|"),
          (it.changes || []).join(" | "), nd ? (nd.due || "") : "", nd ? nd.text : "",
          it.ignore.flag ? "yes" : "no", it.ignore.reasons.join("|"),
          it.confidence, it.learningValue, this.score(it).total, (it.sources || []).map(s => s.url).join("|"),
          f7 ? f7.count7d : "", f7 ? f7.prev7d : "", f7 ? (f7.surge ? "yes" : "no") : ""];
      });
    },
    exportCols() { return ["tier", "conflict", "state", "stateMove", ...this.DIMS, "changedDims", "materialChanges", "nextDue", "nextIndicator", "ignoreForNow", "ignoreReasons", "confidence", "learningValue", "attentionScore", "sources", "coverage7d", "coveragePrev7d", "coverageSurge"]; }
  };

  const App = {
    setActiveView() {
      document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
      el(`#view-${State.horizon}`).classList.add("active");
      el(`.tab-btn[data-horizon="${State.horizon}"]`).classList.add("active");
      // Monthly & Capabilities are full-width pages — hide the left filter rail
      // (Weekly keeps it). Both carry their own inline controls instead.
      document.body.classList.toggle("monthly-view", State.horizon === "monthly");
      document.body.classList.toggle("capabilities-view", State.horizon === "capabilities");
      document.body.classList.toggle("watchlist-view", State.horizon === "watchlist");
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
      if (State.horizon === "watchlist") {
        const m = DB.watchlist && DB.watchlist.meta;
        sel.innerHTML = `<option>${m ? "Review as of " + esc(Watchlist.fmtDate(m.reviewDate)) : "Watchlist"}</option>`;
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
      this.updateLastUpdated();
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
            DB.liveSiteUrl = lw.sourceUrl || null;   // the brief site (pages.dev)
            DB.liveWeek = eds[0];   // newest = the "● LIVE" edition
            DB.capabilityEvidence = lw.capabilityEvidence || {};   // brief-derived, traceable
          }
        }
      } catch (e) { /* no live editions available — use seed */ }

      // Conflict watchlist register (analyst-maintained) + compact base map for the
      // Watchlist tab. Both optional: the tab explains itself if the register is
      // missing, and the map falls back to markers-only without the base map.
      try {
        const r = await fetch("watchlist.json", { cache: "no-store" });
        if (r.ok) { const wl = await r.json(); if (wl && Array.isArray(wl.items) && wl.meta && wl.definitions) DB.watchlist = wl; }
      } catch (e) { /* no watchlist — tab shows guidance */ }
      try {
        const r = await fetch("watchlist-live.json", { cache: "no-store" });
        if (r.ok) { const lf = await r.json(); if (lf && lf.__live && lf.items) DB.watchlistLive = lf; }
      } catch (e) { /* no live feed — register only */ }
      try {
        const r = await fetch("assets/world-110m.json", { cache: "no-store" });
        if (r.ok) { const w = await r.json(); if (w && Array.isArray(w.countries)) DB.world = w; }
      } catch (e) { /* no base map — markers only */ }

      // Compute capability heat/trend AFTER live editions load, so brief evidence
      // can drive it (with the analyst model as fallback).
      Caps.computeDynamics();

      // header meta
      this.updateLastUpdated();

      this.buildFilterControls();
      this.wire();
      this.rerender();
    },

    // "Last updated" = the newest real sync among the sources the active tab draws on:
    // the Watchlist tab uses only its open-source feed and review; the other tabs use
    // the brief sync and the seed data.
    updateLastUpdated() {
      (() => {
        const onWatchlist = State.horizon === "watchlist";
        const cands = (onWatchlist ? [] : [{ t: DB.liveSyncedAt, what: "brief sync" }]).concat([
          { t: DB.watchlistLive && DB.watchlistLive.syncedAt, what: "open-source feed sync" },
          { t: DB.watchlist && DB.watchlist.meta && DB.watchlist.meta.reviewDate ? DB.watchlist.meta.reviewDate + "T00:00:00Z" : null, what: "watchlist review" },
          { t: DB.meta.lastUpdated, what: "seed data" }
        ]).filter(c => c.t && !isNaN(new Date(c.t))).sort((p, q) => new Date(q.t) - new Date(p.t));
        const top = cands[0]; if (!top) return;
        el("#meta-updated").textContent = Time.fmtDateTime(top.t);
        el("#meta-updated").title = cands.map(c => `${c.what}: ${Time.fmtDateTime(c.t)}`).join("\n");
        const lbl = el("#meta-updated").previousElementSibling; if (lbl) lbl.textContent = `Last updated · ${top.what}`;
      })();
    }
  };

  document.addEventListener("DOMContentLoaded", () => App.init());
})();
