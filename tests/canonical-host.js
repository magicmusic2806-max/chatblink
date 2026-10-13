/**
 * Canonical-host suite: the apex answers, www always redirects to it.
 *
 * Usage:  node tests/canonical-host.js
 *
 * This drives the Worker's fetch handler directly with synthetic URLs. It cannot go through
 * `wrangler dev`: the dev server builds request.url from the custom domain in wrangler.jsonc rather
 * than from the requested host, so the alias never appears locally and no hostname-based branch can
 * be exercised through it. The host is only real at the edge, which is why tests/prod-check.js
 * asserts the same redirect against https://www.chatblink.chat once the domain exists.
 */
const APEX = "https://chatblink.chat";

// Enough of rooms.html for servePage's string surgery to work, so a non-www host really does serve.
const ROOMS_HTML = `<!doctype html><html><head><title>Chatblink</title></head><body>`
  + `<main class="auth-shell" id="authView"></main><main class="app" id="appView" hidden></main>`
  + `<script src="/multi-room.js"></script></body></html>`;

const mockEnv = extra => ({
  PUBLIC_ORIGIN: APEX,
  ASSETS: { fetch: async () => new Response(ROOMS_HTML, { status: 200, headers: { "Content-Type": "text/html" } }) },
  // A stub that answers 418 rather than throwing, so a route that wrongly runs before the redirect
  // shows up as an unexpected status instead of a crash.
  HUB: { idFromName: () => "hub", get: () => ({ fetch: async () => new Response("hub", { status: 418 }) }) },
  ...extra
});

let failures = 0;
const ok = (label, condition, detail = "") => {
  if (condition) console.log(`  PASS  ${label}${detail ? ` (${detail})` : ""}`);
  else { failures++; console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ""}`); }
};

const call = (worker, url, init, env) => worker.fetch(new Request(url, init), env || mockEnv());

async function main() {
  const worker = (await import("../worker/index.js")).default;
  console.log("\n== canonical host ==");

  // Hosts that are not the alias must be untouched.
  const apex = await call(worker, `${APEX}/`);
  ok("the apex serves the app instead of redirecting", apex.status === 200 && !apex.headers.get("location"), `status ${apex.status}`);

  const apexRoom = await call(worker, `${APEX}/rooms`);
  ok("the apex serves inner pages", apexRoom.status === 200 && !apexRoom.headers.get("location"), `status ${apexRoom.status}`);

  const preview = await call(worker, "https://chatblink.chatblink.workers.dev/");
  ok("the workers.dev preview host is not redirected", preview.status === 200 && !preview.headers.get("location"), `status ${preview.status}`);

  const plain = await call(worker, "http://127.0.0.1:8799/");
  ok("a plain local request is not redirected", plain.status === 200 && !plain.headers.get("location"), `status ${plain.status}`);

  // www is the alias: redirect, never serve.
  const wwwHome = await call(worker, "https://www.chatblink.chat/");
  ok("www redirects to the apex", wwwHome.status === 301 && wwwHome.headers.get("location") === `${APEX}/`, `${wwwHome.status} -> ${wwwHome.headers.get("location")}`);

  const wwwPage = await call(worker, "https://www.chatblink.chat/rooms?mode=signup");
  ok("the redirect keeps the path and query string", wwwPage.headers.get("location") === `${APEX}/rooms?mode=signup`, `${wwwPage.status} -> ${wwwPage.headers.get("location")}`);

  const wwwHead = await call(worker, "https://www.chatblink.chat/", { method: "HEAD" });
  ok("HEAD on www is a 301 too", wwwHead.status === 301, `status ${wwwHead.status}`);

  const wwwSecure = await call(worker, "http://www.chatblink.chat/");
  ok("a plain-http www request is sent to https", wwwSecure.headers.get("location") === `${APEX}/`, `${wwwSecure.status} -> ${wwwSecure.headers.get("location")}`);

  const wwwUpload = await call(worker, "https://www.chatblink.chat/uploads/00000000-0000-0000-0000-000000000000.png");
  ok("www canonicalises upload links as well", wwwUpload.headers.get("location") === `${APEX}/uploads/00000000-0000-0000-0000-000000000000.png`, `${wwwUpload.status} -> ${wwwUpload.headers.get("location")}`);

  // A permanent redirect with a body-dropping status would turn this POST into a GET.
  const wwwPost = await call(worker, "https://www.chatblink.chat/api/rooms", { method: "POST" });
  ok("a POST on www gets a method-preserving 308", wwwPost.status === 308, `status ${wwwPost.status}`);

  const wwwUpgrade = await call(worker, "https://www.chatblink.chat/", { headers: { Upgrade: "websocket" } });
  ok("a websocket upgrade on www is redirected before the socket branch", wwwUpgrade.status === 301, `status ${wwwUpgrade.status}`);

  // Forcing http to https is the zone's Always Use HTTPS setting, not code here - that also covers
  // the static assets which bypass this Worker - so a plain-http apex request is simply served.
  const apexHttp = await call(worker, "http://chatblink.chat/rooms?mode=signup");
  ok("a plain-http apex request is served, not redirected", apexHttp.status === 200 && !apexHttp.headers.get("location"), `status ${apexHttp.status}`);

  // `wrangler dev` hands the Worker the configured custom domain rather than the requested host,
  // over http. Both shapes must reach the app untouched, or local development bounces to the live
  // site - which is exactly what an earlier version of this redirect did.
  const devLocal = await call(worker, "http://chatblink.chat/", { headers: { Host: "127.0.0.1:8799" } });
  const devApex = await call(worker, "http://chatblink.chat/");
  ok("neither shape of a wrangler dev request is redirected", devLocal.status === 200 && devApex.status === 200 && !devApex.headers.get("location"), `${devLocal.status} / ${devApex.status}`);

  // A missing or malformed PUBLIC_ORIGIN must leave the Worker behaving as before, not 500.
  const noOrigin = await call(worker, "https://www.chatblink.chat/", null, mockEnv({ PUBLIC_ORIGIN: undefined }));
  ok("a worker with no PUBLIC_ORIGIN does not redirect", noOrigin.status === 200 && !noOrigin.headers.get("location"), `status ${noOrigin.status}`);

  const badOrigin = await call(worker, "https://www.chatblink.chat/", null, mockEnv({ PUBLIC_ORIGIN: "chatblink.chat" }));
  ok("a malformed PUBLIC_ORIGIN does not redirect or crash", badOrigin.status === 200 && !badOrigin.headers.get("location"), `status ${badOrigin.status}`);

  console.log(`\n${failures ? `${failures} canonical host check(s) failed` : "all canonical host checks passed"}`);
  process.exit(failures ? 1 : 0);
}

main().catch(error => { console.error(`canonical host suite crashed: ${error.message}`); process.exit(1); });
