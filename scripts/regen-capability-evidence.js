#!/usr/bin/env node
"use strict";
/* =========================================================================
 * regen-capability-evidence.js — re-derive weekly-live.json's
 * capabilityEvidence from the editions ALREADY stored in the file, using the
 * current matcher (scripts/lib/capability-evidence.js) and seed capabilities.
 *
 * Use this after tightening the matcher or editing capability `match` keywords
 * / theatres, to refresh the live data WITHOUT re-fetching the source site.
 * The scheduled sync (sync-weekly.js) uses the same library, so the result is
 * identical to the next live sync.
 * ========================================================================= */
const fs = require("fs");
const path = require("path");
const { deriveCapabilityEvidence } = require("./lib/capability-evidence");

const LIVE = path.resolve(__dirname, "..", "weekly-live.json");
const SEED = path.resolve(__dirname, "..", "sample-data.json");

if (!fs.existsSync(LIVE)) { console.error("weekly-live.json not present — nothing to regenerate."); process.exit(0); }
const live = JSON.parse(fs.readFileSync(LIVE, "utf8"));
const seed = JSON.parse(fs.readFileSync(SEED, "utf8"));
const editions = Array.isArray(live.editions) ? live.editions : (live.theatres ? [live] : []);

const before = Object.values(live.capabilityEvidence || {}).reduce((s, a) => s + a.length, 0);
live.capabilityEvidence = deriveCapabilityEvidence(editions, seed.capabilities);
const after = Object.values(live.capabilityEvidence).reduce((s, a) => s + a.length, 0);

fs.writeFileSync(LIVE, JSON.stringify(live, null, 2) + "\n");
const byConf = { high: 0, medium: 0, low: 0 };
Object.values(live.capabilityEvidence).forEach(a => a.forEach(r => (byConf[r.confidence] = (byConf[r.confidence] || 0) + 1)));
console.log(`✓ capabilityEvidence regenerated: ${before} → ${after} rows across ${Object.keys(live.capabilityEvidence).length} capabilities.`);
console.log(`  confidence: high ${byConf.high} · medium ${byConf.medium} · low ${byConf.low}`);
