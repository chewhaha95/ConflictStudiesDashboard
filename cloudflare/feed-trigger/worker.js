/**
 * Hourly trigger for the watchlist feed sync.
 *
 * GitHub's own `schedule:` trigger runs this repository's workflows hours late
 * (or not at all), so a Cloudflare Worker cron fires the workflow instead by
 * calling the GitHub REST API "create a workflow dispatch event" endpoint.
 * Cloudflare cron triggers run on time.
 *
 * Bindings (Settings → Variables and Secrets on the Worker):
 *   GITHUB_TOKEN   secret — fine-grained token, this repository only,
 *                  permission "Actions: Read and write".
 *   GH_OWNER       var    — chewhaha95
 *   GH_REPO        var    — ConflictStudiesDashboard
 *   WORKFLOW_FILE  var    — sync-watchlist-feed.yml
 *   GH_REF         var    — main
 *   TRIGGER_KEY    secret — optional; enables a manual `POST /run` with
 *                  header `Authorization: Bearer <TRIGGER_KEY>` for testing.
 */

const API = "https://api.github.com";

async function dispatch(env) {
  for (const k of ["GITHUB_TOKEN", "GH_OWNER", "GH_REPO", "WORKFLOW_FILE"]) {
    if (!env[k]) throw new Error(`missing binding ${k}`);
  }
  const url = `${API}/repos/${env.GH_OWNER}/${env.GH_REPO}/actions/workflows/${env.WORKFLOW_FILE}/dispatches`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "csi-feed-trigger (Cloudflare Worker)",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ ref: env.GH_REF || "main" }),
  });
  if (res.status !== 204) {
    const body = await res.text().catch(() => "");
    throw new Error(`GitHub dispatch failed: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  return `dispatched ${env.WORKFLOW_FILE} on ${env.GH_REF || "main"} at ${new Date().toISOString()}`;
}

export default {
  // Cron trigger (wrangler.toml [triggers] / Worker → Settings → Triggers).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dispatch(env).then(m => console.log(m), e => { console.error(e.message); throw e; }));
  },

  // GET / → status line. POST /run with the TRIGGER_KEY → dispatch now (for testing).
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/run") {
      const auth = request.headers.get("Authorization") || "";
      if (!env.TRIGGER_KEY || auth !== `Bearer ${env.TRIGGER_KEY}`) return new Response("forbidden", { status: 403 });
      try { return new Response(await dispatch(env) + "\n"); }
      catch (e) { return new Response(e.message + "\n", { status: 502 }); }
    }
    return new Response(
      `csi-feed-trigger: dispatches ${env.WORKFLOW_FILE || "sync-watchlist-feed.yml"} in ` +
      `${env.GH_OWNER || "?"}/${env.GH_REPO || "?"} on the cron schedule.\n`,
      { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  },
};
