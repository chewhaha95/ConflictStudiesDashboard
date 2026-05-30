#!/bin/bash
# SessionStart hook: install the dev dependency (jsdom) and smoke-test the
# dashboard so tests can run in this session. Synchronous + idempotent.
set -euo pipefail

cd "$CLAUDE_PROJECT_DIR"

echo "[session-start] Installing dev dependencies (jsdom)…"
# Prefer `npm install` (not `ci`) so the container's cached state is reused.
npm install --no-fund --no-audit --silent

echo "[session-start] Running app smoke test…"
npm test

echo "[session-start] Dashboard smoke test passed."
