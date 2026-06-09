"use strict";
/* =========================================================================
 * capability-evidence.js — derive traceable, brief-grounded capability
 * evidence from parsed weekly-brief editions.
 *
 * This is the SINGLE source of truth for the matcher, shared by:
 *   - scripts/sync-weekly.js               (cron: live editions → weekly-live.json)
 *   - scripts/regen-capability-evidence.js (offline: re-derive from stored editions)
 *
 * Precision rules (each row records exactly how it was matched, so weak hits
 * are transparent rather than hidden):
 *   1. THEATRE RELEVANCE — a capability is only credited in a theatre it is
 *      declared to operate in (capability.theatres). This removes cross-theatre
 *      keyword collisions (e.g. the Russian "Oreshnik" headline matching the
 *      Iran ballistic-missile capability in the Russia–Ukraine theatre).
 *   2. CONFIDENCE BY LOCATION — a keyword in the development HEADLINE is high
 *      confidence (intensity 3); in a PILL, medium (2); in BODY text only, low
 *      (intensity 1). Confidence is stored on every row.
 *   3. WEAK SINGLE-KEYWORD GUARD — a BODY-only hit whose only matched keyword
 *      is a GENERIC term (e.g. "drone", "missile") does NOT count as evidence.
 *      A specific keyword (a proper noun, a model name, or a multi-word phrase)
 *      still counts in the body at low confidence, because briefs frequently
 *      describe a system in the prose while the headline omits its name.
 * ========================================================================= */

// Broad terms that, matched ALONE in body text, are too generic to substantiate
// a capability. (A specific keyword alongside them, or a headline/pill hit, still
// counts.) Kept deliberately small — most seed keywords are already specific.
const GENERIC = new Set([
  "drone", "drones", "missile", "missiles", "rocket", "rockets", "bomb", "bombs",
  "gun", "guns", "naval", "strike", "strikes", "attack", "attacks", "shell", "shelling"
]);

// A keyword is "specific" if it is multi-word (a phrase) or a single distinctive
// token that is not in the generic stop-list.
function isSpecific(kw) {
  return kw.includes(" ") || kw.includes("-") || !GENERIC.has(kw);
}

/**
 * Derive capabilityEvidence from editions.
 * @param {Array}  editions      parsed editions ({ weekId, rangeLabel, sourceUrl, theatres:{ id:{ developments:[...] } } })
 * @param {Array}  capabilities  seed capabilities ({ id, theatres:[...], match:[...] })
 * @returns {Object} { capId: [ { weekId, rangeLabel, theatre, headline, intensity, where, confidence, keyword, matchCount, url, source } ] }
 */
function deriveCapabilityEvidence(editions, capabilities) {
  const out = {};
  (capabilities || []).forEach(c => { if ((c.match || []).length) out[c.id] = []; });

  (editions || []).forEach(ed => {
    Object.entries(ed.theatres || {}).forEach(([t, e]) => {
      (e.developments || []).forEach(dev => {
        const headline = (dev.headline || "").toLowerCase();
        const pillTxt = (dev.pills || []).join(" ").toLowerCase();
        const bodyTxt = [...(dev.paragraphs || []), ...(dev.implicationBullets || [])].join(" ").toLowerCase();

        (capabilities || []).forEach(c => {
          const kws = c.match || []; if (!kws.length) return;
          // (1) theatre relevance
          if ((c.theatres || []).length && !c.theatres.includes(t)) return;

          const inH = kws.filter(k => headline.includes(k));
          const inP = kws.filter(k => pillTxt.includes(k));
          const inB = kws.filter(k => bodyTxt.includes(k));

          let where, intensity, confidence, matched;
          if (inH.length) { where = "headline"; intensity = 3; confidence = "high"; matched = inH; }
          else if (inP.length) { where = "pill"; intensity = 2; confidence = "medium"; matched = inP; }
          else if (inB.length) {
            // (3) body-only: drop if the only matched keyword(s) are all generic
            if (!inB.some(isSpecific)) return;
            where = "body"; intensity = 1; confidence = "low"; matched = inB;
          } else return;

          const src = (dev.sources && dev.sources[0]) || (e.sourceLinks && e.sourceLinks[0]) || { label: "brief edition", url: ed.sourceUrl };
          out[c.id].push({
            weekId: ed.weekId, rangeLabel: ed.rangeLabel, theatre: t, headline: dev.headline,
            intensity, where, confidence, keyword: matched[0], matchCount: matched.length,
            url: src.url, source: src.label
          });
        });
      });
    });
  });

  // keep only capabilities that actually have evidence
  Object.keys(out).forEach(id => { if (!out[id].length) delete out[id]; });
  return out;
}

module.exports = { deriveCapabilityEvidence, GENERIC, isSpecific };
