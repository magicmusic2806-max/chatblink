/**
 * Read-only production check for the live domain: HTTP routes, asset serving and the WebSocket
 * upgrade path through to the Durable Object.
 *
 * Creates no accounts, rooms or messages, so it is safe to run against production:
 *   node tests/prod-check.js [baseUrl]        # defaults to https://chatblink.chat
 *
 * It answers "is the domain actually being served by the Worker?", which is the question that
 * matters after a cutover — a suspended host with the domain still pointed at it looks healthy
 * from inside Cloudflare but 503s for users. It also checks that www redirects to the apex.
 */
const WebSocket = require("ws");

const BASE = (process.argv[2] || "https://chatblink.chat").replace(/\/$/, "");
const HOST = new URL(BASE).host;
let failures = 0;
const ok = (label, condition, detail = "") => {
  if (condition) console.log(`  PASS  ${label}${detail ? ` (${detail})` : ""}`);
  else { failures++; console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ""}`); }
};
// For things only the Cloudflare dashboard can change, so the gap stays visible without failing.
const warn = message => console.log(`  WARN  ${message}`);

const get = async path => { const response = await fetch(`${BASE}${path}`, { redirect: "manual" }); return { response, body: await response.text() }; };

// Resolves with what the handshake did: 101 + history, a rejection status, or a failure.
const handshake = (room, origin) => new Promise(resolve => {
  const ws = new WebSocket(`wss://${HOST}/?room=${encodeURIComponent(room)}`, { headers: { Origin: origin } });
  const timer = setTimeout(() => { try { ws.terminate(); } catch {} resolve({ result: "timeout" }); }, 12000);
  const done = value => { clearTimeout(timer); try { ws.close(); } catch {} resolve(value); };
  ws.on("message", raw => { let packet; try { packet = JSON.parse(raw); } catch { return; } if (packet.type === "history") done({ result: "history", messages: (packet.messages || []).length, online: packet.online }); });
  ws.on("unexpected-response", (_request, response) => done({ result: "rejected", status: response.statusCode }));
  ws.on("error", error => done({ result: "error", message: error.message }));
});

async function main() {
  console.log(`\n== ${BASE} ==`);

  const home = await get("/");
  ok("GET / is 200", home.response.status === 200, `status ${home.response.status}`);
  ok("home is the Chatblink app shell", /<title>\s*Chatblink/i.test(home.body) || /multi-room\.js/.test(home.body));
  const version = (home.body.match(/multi-room\.js\?v=(\d+)/) || [])[1];
  ok("home serves a cache-busted client bundle", Boolean(version), `v=${version}`);
  ok("no suspended-host routing header", !home.response.headers.get("x-render-routing"), home.response.headers.get("x-render-routing") || "");

  const config = await get("/api/config");
  ok("GET /api/config is 200 JSON served by the Durable Object", config.response.status === 200 && config.body.includes("giphyApiKey"), config.body.trim().slice(0, 60));

  const roomsPage = await get("/rooms");
  ok("GET /rooms is 200", roomsPage.response.status === 200, `status ${roomsPage.response.status}`);

  const asset = await get("/multi-room.js");
  ok("client bundle is served", asset.response.status === 200 && asset.body.length > 10000, `${asset.body.length} bytes`);

  const missing = await get("/uploads/00000000-0000-0000-0000-000000000000.png");
  ok("unknown upload is a 404", missing.response.status === 404, `status ${missing.response.status}`);

  // Host-based behaviour exists only at the edge: locally `wrangler dev` answers whatever host you
  // ask for, from the custom domain in wrangler.jsonc, so these are pointless against a local URL.
  if (HOST === "chatblink.chat") {
    const alias = await fetch(`https://www.${HOST}/rooms?mode=signup`, { redirect: "manual" });
    ok("www redirects to the apex and keeps the path", alias.status === 301 && alias.headers.get("location") === `https://${HOST}/rooms?mode=signup`, `${alias.status} -> ${alias.headers.get("location")}`);

    const followed = await fetch(`https://www.${HOST}/`);
    ok("following that redirect lands on the apex", followed.status === 200 && followed.url.startsWith(`https://${HOST}/`), `${followed.status} ${followed.url}`);

    // Only the zone's Always Use HTTPS setting can do this (it also covers the static assets that
    // bypass the Worker), so it is reported rather than failed while the setting is off.
    const plain = await fetch(`http://${HOST}/`, { redirect: "manual" });
    if (plain.status === 200) warn(`http://${HOST}/ is served over plaintext - turn on SSL/TLS -> Edge Certificates -> Always Use HTTPS (and HSTS)`);
    else ok("plain-http requests are redirected to https at the edge", plain.status === 301 || plain.status === 308, `status ${plain.status}`);
  } else {
    console.log("  SKIP  www alias and edge-https checks (only meaningful against the apex)");
  }

  // A session is required for every socket, so the correct answer here is a refusal - what it
  // proves is that the upgrade reached the Worker and the Durable Object ran its own checks.
  const unknownRoom = await handshake("__no_such_room__", BASE);
  ok("websocket upgrade reaches the Durable Object and is refused", unknownRoom.result === "rejected" && unknownRoom.status === 403, JSON.stringify(unknownRoom));

  const anonymous = await handshake("casual", BASE);
  ok("an anonymous socket is refused even for an open built-in room", anonymous.result === "rejected" && anonymous.status === 403, JSON.stringify(anonymous));

  const crossSite = await handshake("casual", "https://evil.example");
  ok("a cross-site websocket origin is refused", crossSite.result === "rejected" && crossSite.status === 403, JSON.stringify(crossSite));

  console.log(`\n${failures ? `${failures} FAILED` : "prod check: all good"}`);
  console.log("An authenticated socket (101 + history) still needs a real session - sign in as a\ntest account and open one room in two tabs to confirm live delivery.\n");
  process.exit(failures ? 1 : 0);
}

main().catch(error => { console.error(`prod check crashed: ${error.message}`); process.exit(1); });
