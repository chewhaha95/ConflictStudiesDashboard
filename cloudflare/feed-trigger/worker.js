/**
 * Daily trigger for the watchlist feed sync (21:07 UTC = 05:07 SGT).
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
 *   TRIGGER_KEY    secret — enables a manual `POST /run` and the `POST /screen`
 *                  relevance screen, both with header
 *                  `Authorization: Bearer <TRIGGER_KEY>`.
 *   AI             binding — Workers AI (Settings → Bindings → Workers AI), used
 *                  by `POST /screen` to judge headline relevance on the free
 *                  daily allowance. SCREEN_MODEL (var, optional) overrides the
 *                  model, default @cf/meta/llama-3.1-8b-instruct.
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

// Headline relevance screen on Workers AI. Body: {system, user}; returns the
// model's text (expected to be JSON {"keep": [...]}); the feed script parses it.
async function screen(request, env) {
  if (!env.AI) return new Response(JSON.stringify({ error: "no AI binding on this Worker" }), { status: 501, headers: { "Content-Type": "application/json" } });
  let body; try { body = await request.json(); } catch (e) { return new Response('{"error":"bad json"}', { status: 400 }); }
  const model = env.SCREEN_MODEL || "@cf/meta/llama-3.1-8b-instruct";
  const out = await env.AI.run(model, {
    messages: [{ role: "system", content: String(body.system || "") + ' Respond with JSON only, exactly of the form {"keep": [indices]}.' }, { role: "user", content: String(body.user || "") }],
    max_tokens: 300, temperature: 0,
  });
  const text = typeof out === "string" ? out : (out && (out.response || (out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content))) || "";
  return new Response(JSON.stringify({ model, text }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export default {
  // Cron trigger (wrangler.toml [triggers] / Worker → Settings → Triggers).
  // Daily: the owner chose one refresh a day over hourly to save usage. If the
  // dashboard's Cron Trigger is still the old hourly one, only the run in the
  // FEED_HOUR_UTC hour (default 21 = 05:07 SGT) dispatches; the rest are skipped.
  async scheduled(event, env, ctx) {
    const hour = new Date(event.scheduledTime || Date.now()).getUTCHours();
    const want = Number(env.FEED_HOUR_UTC ?? 21);
    if (hour !== want) { console.log(`skipped: daily feed runs at ${want}:07 UTC, this fire was ${hour}:xx`); return; }
    ctx.waitUntil(dispatch(env).then(m => console.log(m), e => { console.error(e.message); throw e; }));
  },

  // GET / → status line. POST /run with the TRIGGER_KEY → dispatch now (for testing).
  async fetch(request, env) {
    const url = new URL(request.url);
    const auth = request.headers.get("Authorization") || "";
    const authed = !!env.TRIGGER_KEY && auth === `Bearer ${env.TRIGGER_KEY}`;
    if (request.method === "POST" && url.pathname === "/run") {
      if (!authed) return new Response("forbidden", { status: 403 });
      try { return new Response(await dispatch(env) + "\n"); }
      catch (e) { return new Response(e.message + "\n", { status: 502 }); }
    }
    if (request.method === "POST" && url.pathname === "/screen") {
      if (!authed) return new Response("forbidden", { status: 403 });
      try { return await screen(request, env); }
      catch (e) { return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: { "Content-Type": "application/json" } }); }
    }
    return new Response(
      `csi-feed-trigger: dispatches ${env.WORKFLOW_FILE || "sync-watchlist-feed.yml"} in ` +
      `${env.GH_OWNER || "?"}/${env.GH_REPO || "?"} on the cron schedule.\n`,
      { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
  },
};
