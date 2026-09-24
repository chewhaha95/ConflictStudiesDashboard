# Hourly feed trigger (Cloudflare Worker)

GitHub runs this repository's `schedule:` workflows hours late or skips them,
so the hourly feed sync is fired from a Cloudflare Worker cron instead. The
Worker calls GitHub's *create a workflow dispatch event* API once an hour;
the workflow itself is unchanged (its own `schedule:` stays as a fallback and
the sync's concurrency group absorbs any overlap).

## One-time setup (dashboard, about five minutes)

1. **GitHub token.** GitHub → Settings → Developer settings → Personal access
   tokens → Fine-grained tokens → Generate new token. Repository access:
   *Only select repositories* → `ConflictStudiesDashboard`. Permissions →
   Repository permissions → **Actions: Read and write** (Metadata: Read is
   added automatically). Choose an expiry (put a reminder in your calendar;
   the trigger stops silently when the token expires). Copy the token.
2. **Worker.** Cloudflare → Workers & Pages → Create → Create Worker → name
   `csi-feed-trigger` → Deploy. Then *Edit code*, replace the contents with
   `worker.js` from this folder, Deploy.
3. **Variables.** Worker → Settings → Variables and Secrets → add
   - `GITHUB_TOKEN` (type **Secret**) = the token from step 1
   - `GH_OWNER` = `chewhaha95`
   - `GH_REPO` = `ConflictStudiesDashboard`
   - `WORKFLOW_FILE` = `sync-watchlist-feed.yml`
   - `GH_REF` = `main`
   - optional `TRIGGER_KEY` (Secret) = any long random string, for manual tests
4. **Cron.** Worker → Settings → Triggers → Cron Triggers → Add → `7 * * * *`.

Cloudflare's free plan includes cron triggers and far more than the 720
requests a month this uses.

## Verify

- Worker → Logs (or *Begin log stream*) shows `dispatched sync-watchlist-feed.yml`
  after the next :07 UTC.
- GitHub → Actions → *Sync watchlist open-source feed* shows a run with event
  `workflow_dispatch` each hour.
- Manual test, if `TRIGGER_KEY` is set:
  `curl -X POST https://csi-feed-trigger.<your-subdomain>.workers.dev/run -H "Authorization: Bearer <TRIGGER_KEY>"`

## Command-line alternative

```
cd cloudflare/feed-trigger
npx wrangler login
npx wrangler secret put GITHUB_TOKEN
npx wrangler deploy
```
`wrangler.toml` carries the cron and the plain variables.
