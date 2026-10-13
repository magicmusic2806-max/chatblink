/**
 * End-to-end smoke test for the Cloudflare Worker port of Chatblink.
 *
 * Usage:  node tests/worker-smoke.js [baseUrl]
 * Needs a running local server:  npx wrangler dev --port 8787
 *
 * Covers: static/app serving, signup, profile-key login, cookie session,
 * room listing + creation + deletion, websocket history/broadcast/persistence,
 * catalog validation and origin/authorization guards.
 */
const fs = require("fs");
const crypto = require("crypto");
const WebSocket = require("ws");

const BASE = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/$/, "");
const ORIGIN = BASE.replace(/^http/, "http");
const WS_BASE = BASE.replace(/^http/, "ws");
const stamp = Date.now().toString(36);
const USERNAME = `smoke_${stamp}`;

let passed = 0, failed = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ""}`); }
};
const head = label => console.log(`\n${label}`);

const cookieOf = response => {
  const raw = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie")].filter(Boolean);
  return raw.map(value => value.split(";")[0]).join("; ");
};
const post = (path, body, cookie) => fetch(`${BASE}${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Origin": ORIGIN, ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body),
  redirect: "manual"
});

function socket(room, cookie) {
  const ws = new WebSocket(`${WS_BASE}/?room=${encodeURIComponent(room)}`, { headers: { Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}) } });
  ws.inbox = [];
  ws.on("message", raw => { try { ws.inbox.push(JSON.parse(raw)); } catch {} });
  return ws;
}
const waitFor = (ws, predicate, ms = 4000) => new Promise((resolve, reject) => {
  const found = ws.inbox.find(predicate);
  if (found) return resolve(found);
  const timer = setTimeout(() => { cleanup(); reject(new Error("timeout waiting for socket event")); }, ms);
  const onMessage = () => { const hit = ws.inbox.find(predicate); if (hit) { cleanup(); resolve(hit); } };
  const cleanup = () => { clearTimeout(timer); ws.off("message", onMessage); };
  ws.on("message", onMessage);
  ws.once("error", error => { cleanup(); reject(error); });
});
const open = ws => new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
  ws.once("unexpected-response", (_request, response) => reject(new Error(`handshake rejected: ${response.statusCode}`)));
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  head("app shell + health");
  const home = await fetch(`${BASE}/`);
  const html = await home.text();
  ok("GET / returns 200", home.status === 200, `status ${home.status}`);
  ok("GET / serves the signed-out app shell", html.includes('id="appView"') && html.includes("/multi-room.js"));
  ok("GET / injects a cache-busted client version", /multi-room\.js\?v=\d+/.test(html));
  const config = await fetch(`${BASE}/api/config`);
  ok("GET /api/config returns 200 JSON", config.status === 200 && (await config.json()) !== null);
  const missing = await fetch(`${BASE}/definitely-not-a-route-${stamp}`);
  ok("unknown path returns 404", missing.status === 404, `status ${missing.status}`);

  head("signup + session");
  const signup = await post("/api/auth/signup", { username: USERNAME, age: 24, adultConfirmed: true });
  const account = await signup.json();
  ok("signup returns 201", signup.status === 201, `status ${signup.status} ${JSON.stringify(account)}`);
  ok("signup issues a profile key", typeof account.profileKey === "string" && account.profileKey.length > 10);
  ok("signup sets a session cookie", /nearby_session=/.test(cookieOf(signup)));
  const cookie = cookieOf(signup);
  ok("new account is not an admin", account.user && account.user.role === "user");

  const weak = await post("/api/auth/signup", { username: "a", age: 12, adultConfirmed: false });
  ok("signup rejects bad input with 400", weak.status === 400, `status ${weak.status}`);

  const me = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } });
  const meBody = await me.json();
  ok("cookie authenticates /api/auth/me", me.status === 200 && meBody.user.username === USERNAME, JSON.stringify(meBody));

  const anon = await fetch(`${BASE}/api/users`);
  ok("protected route rejects anonymous callers", anon.status === 401, `status ${anon.status}`);
  const noOrigin = await fetch(`${BASE}/api/rooms`, { method: "POST", headers: { "Content-Type": "application/json", "Origin": "http://evil.example", Cookie: cookie }, body: JSON.stringify({ name: "Evil Origin Room" }) });
  ok("cross-site POST is rejected", noOrigin.status === 403, `status ${noOrigin.status}`);
  const noCookieOrigin = await fetch(`${BASE}/api/rooms`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "No Cookie Room" }) });
  ok("unauthenticated POST is rejected", noCookieOrigin.status === 401 || noCookieOrigin.status === 403, `status ${noCookieOrigin.status}`);

  const relogin = await post("/api/auth/login", { key: account.profileKey });
  ok("profile key logs the account back in", relogin.status === 200, `status ${relogin.status}`);
  const badKey = await post("/api/auth/login", { key: "not-a-real-key" });
  ok("bogus profile key is rejected", badKey.status === 401, `status ${badKey.status}`);

  // Migration parity: a device token / entry link minted by the OLD Node server
  // (HMAC-SHA256 over the raw AUTH_SECRET bytes) must still authenticate here.
  const devVars = fs.existsSync(".dev.vars") ? fs.readFileSync(".dev.vars", "utf8") : "";
  const secretLine = devVars.split(/\r?\n/).find(line => line.startsWith("AUTH_SECRET="));
  if (!secretLine) {
    console.log("  SKIP  legacy device token (no .dev.vars AUTH_SECRET found)");
  } else {
    const secret = secretLine.slice("AUTH_SECRET=".length).trim();
    const legacyToken = (userId, expiresAt) => {
      const payload = `device.${userId}.0.${expiresAt}`;
      return `${payload}.${crypto.createHmac("sha256", secret).update(payload).digest("base64url")}`;
    };
    const entering = await fetch(`${BASE}/enter`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Origin": ORIGIN },
      body: new URLSearchParams({ token: legacyToken(account.user.id, Date.now() + 3600000) }).toString(),
      redirect: "manual"
    });
    const entered = await entering.text();
    ok("legacy device token still signs the account in", /nearby_session=/.test(cookieOf(entering)) && entered.includes(USERNAME), `status ${entering.status}`);
    const tampered = await fetch(`${BASE}/enter`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Origin": ORIGIN },
      body: new URLSearchParams({ token: `${legacyToken(account.user.id, Date.now() + 3600000)}x` }).toString(),
      redirect: "manual"
    });
    const tamperedBody = await tampered.text();
    ok("tampered device token is refused", !/nearby_session=/.test(cookieOf(tampered)) && !tamperedBody.includes(USERNAME), `status ${tampered.status}`);
    const expired = await fetch(`${BASE}/enter`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Origin": ORIGIN },
      body: new URLSearchParams({ token: legacyToken(account.user.id, Date.now() - 1000) }).toString(),
      redirect: "manual"
    });
    ok("expired device token is refused", !/nearby_session=/.test(cookieOf(expired)), `status ${expired.status}`);
  }

  const admin = await fetch(`${BASE}/api/admin/users`, { headers: { Cookie: cookie } });
  ok("admin route is closed to normal users", admin.status === 403, `status ${admin.status}`);

  head("rooms");
  const roomsResponse = await fetch(`${BASE}/api/rooms`, { headers: { Cookie: cookie } });
  const { rooms } = await roomsResponse.json();
  ok("seven built-in rooms are present", Array.isArray(rooms) && rooms.filter(room => room.builtIn).length === 7, `got ${rooms && rooms.length}`);
  ok("built-in rooms are marked enterable", rooms.every(room => room.canEnter === true));

  const roomName = `Smoke Room ${stamp}`;
  const created = await post("/api/rooms", { name: roomName, vibe: "Automated smoke test room.", access: "open", theme: "ocean" }, cookie);
  const createdBody = await created.json();
  const roomId = createdBody.room && createdBody.room.id;
  ok("room creation returns 201", created.status === 201, `status ${created.status} ${JSON.stringify(createdBody)}`);
  ok("creator is flagged as owner", Boolean(roomId) && createdBody.room.isOwner === true);
  const tooShort = await post("/api/rooms", { name: "ab" }, cookie);
  ok("too-short room name is rejected", tooShort.status === 400, `status ${tooShort.status}`);
  const online = await fetch(`${BASE}/api/rooms/online`, { headers: { Cookie: cookie } });
  ok("online counts endpoint responds", online.status === 200);

  head("realtime");
  const alice = socket(roomId, cookie);
  await open(alice);
  const history = await waitFor(alice, packet => packet.type === "history");
  ok("joined room and received history", Array.isArray(history.messages));
  ok("history reports presence", Array.isArray(history.users) && history.online >= 1, `online=${history.online}`);

  const bob = socket(roomId, cookie);
  await open(bob);
  await waitFor(bob, packet => packet.type === "history");
  const presence = await waitFor(alice, packet => packet.type === "presence" && packet.online >= 2);
  ok("second client raises the presence count", presence.online === 2, `online=${presence.online}`);

  const text = `hello from the smoke test ${stamp}`;
  alice.send(JSON.stringify({ type: "message", kind: "text", content: text }));
  const echoed = await waitFor(alice, packet => packet.type === "message" && packet.message.content === text);
  ok("sender gets their own message echoed", echoed.message.kind === "text");
  const relayed = await waitFor(bob, packet => packet.type === "message" && packet.message.content === text);
  ok("message is broadcast to the other client", relayed.message.username === USERNAME);

  alice.send(JSON.stringify({ type: "message", kind: "emoji", content: "🚫not-in-catalog🚫" }));
  alice.inbox.length = 0;
  await sleep(600);
  ok("emoji outside the room catalog is dropped", !alice.inbox.some(packet => packet.type === "message"));

  alice.send(JSON.stringify({ type: "message", kind: "text", content: "x".repeat(900) }));
  const clipped = await waitFor(bob, packet => packet.type === "message" && packet.message.content.startsWith("xxxx"));
  ok("over-long text is truncated to 500 chars", clipped.message.content.length === 500, `len=${clipped.message.content.length}`);

  const outsider = socket(roomId);
  const outsiderError = await new Promise(resolve => { outsider.once("error", resolve); outsider.once("open", () => resolve(null)); });
  ok("anonymous websocket into a room is refused", outsiderError !== null);

  head("persistence");
  alice.close(); bob.close();
  await sleep(400);
  const rejoin = socket(roomId, cookie);
  await open(rejoin);
  const replay = await waitFor(rejoin, packet => packet.type === "history");
  ok("messages survive a reconnect", replay.messages.some(message => message.content === text));
  ok("history is capped at 100 messages", replay.messages.length <= 100);
  rejoin.close();

  head("cleanup + db durability");
  const removed = await fetch(`${BASE}/api/rooms/${roomId}`, { method: "DELETE", headers: { Origin: ORIGIN, Cookie: cookie } });
  ok("room can be deleted by its owner", removed.status === 200, `status ${removed.status}`);
  const gone = await fetch(`${BASE}/api/rooms/${roomId}`, { headers: { Cookie: cookie } });
  ok("deleted room is gone", gone.status === 404 || gone.status === 400, `status ${gone.status}`);

  console.log(`\n${failed === 0 ? "ALL GOOD" : "FAILURES"} - ${passed} passed, ${failed} failed  (test account: ${USERNAME})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => { console.error(`\nsmoke test crashed: ${error.message}`); process.exit(1); });
