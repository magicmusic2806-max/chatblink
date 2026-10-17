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
  alice.inbox.length = 0;
  await open(bob);
  await waitFor(bob, packet => packet.type === "history");
  const samePersonPresence = await waitFor(alice, packet => packet.type === "presence");
  ok("a second connection for one account still counts as one person", samePersonPresence.online === 1 && samePersonPresence.users.length === 1, `online=${samePersonPresence.online}`);

  const secondSignup = await post("/api/auth/signup", { username: `${USERNAME}_two`, age: 25, adultConfirmed: true });
  const secondAccount = await secondSignup.json(), secondCookie = cookieOf(secondSignup);
  ok("second realtime account is created", secondSignup.status === 201, `status ${secondSignup.status}`);
  const charlie = socket(roomId, secondCookie);
  alice.inbox.length = 0;
  await open(charlie);
  await waitFor(charlie, packet => packet.type === "history");
  const twoPeoplePresence = await waitFor(alice, packet => packet.type === "presence" && packet.online === 2);
  ok("two accounts raise the room count to two people", twoPeoplePresence.users.length === 2, `online=${twoPeoplePresence.online}`);

  const charlieOther = socket("__notify", secondCookie);
  await open(charlieOther);
  alice.inbox.length = 0; bob.inbox.length = 0; charlie.inbox.length = 0; charlieOther.inbox.length = 0;
  const callId = crypto.randomUUID();
  alice.send(JSON.stringify({ type: "call-offer", to: secondAccount.user.id, callId, mode: "video", sdp: { type: "offer", sdp: "v=0\r\n" } }));
  const offeredCall = await waitFor(charlie, packet => packet.type === "call-offer" && packet.callId === callId);
  await waitFor(charlieOther, packet => packet.type === "call-offer" && packet.callId === callId);
  ok("video call offers are relayed to the recipient", offeredCall.mode === "video" && offeredCall.from.id === account.user.id);
  charlie.send(JSON.stringify({ type: "call-answer", to: account.user.id, callId, sdp: { type: "answer", sdp: "v=0\r\n" } }));
  const answeredCall = await waitFor(alice, packet => packet.type === "call-answer" && packet.callId === callId);
  ok("call answers are relayed to the caller", answeredCall.from.id === secondAccount.user.id);
  const takenCall = await waitFor(charlieOther, packet => packet.type === "call-taken" && packet.callId === callId);
  ok("answering on one device dismisses the call on the recipient's other devices", takenCall.callId === callId);
  alice.send(JSON.stringify({ type: "call-ice", to: secondAccount.user.id, callId, candidate: { candidate: "candidate:test", sdpMid: "0", sdpMLineIndex: 0 } }));
  const relayedIce = await waitFor(charlie, packet => packet.type === "call-ice" && packet.callId === callId);
  ok("WebRTC ICE candidates are relayed", relayedIce.candidate.candidate === "candidate:test");
  charlie.send(JSON.stringify({ type: "call-end", to: account.user.id, callId }));
  const endedCall = await waitFor(alice, packet => packet.type === "call-end" && packet.callId === callId);
  ok("call hang-ups are relayed", endedCall.from.id === secondAccount.user.id);

  const text = `hello from the smoke test ${stamp}`;
  alice.send(JSON.stringify({ type: "message", kind: "text", content: text }));
  const echoed = await waitFor(alice, packet => packet.type === "message" && packet.message.content === text);
  ok("sender gets their own message echoed", echoed.message.kind === "text");
  const relayed = await waitFor(bob, packet => packet.type === "message" && packet.message.content === text);
  ok("message is broadcast to the other client", relayed.message.username === USERNAME);

  await post(`/api/dm/permissions/${secondAccount.user.id}`, { action: "request" }, cookie);
  await post(`/api/dm/permissions/${account.user.id}`, { action: "grant" }, secondCookie);
  const firstPermission = await fetch(`${BASE}/api/dm/permissions/${secondAccount.user.id}`, { headers: { Cookie: cookie } }).then(response => response.json());
  const secondPermission = await fetch(`${BASE}/api/dm/permissions/${account.user.id}`, { headers: { Cookie: secondCookie } }).then(response => response.json());
  ok("one accepted media request grants permission in both directions", firstPermission.canSend === true && secondPermission.canSend === true && !firstPermission.outgoingPending && !secondPermission.outgoingPending, `${JSON.stringify(firstPermission)} / ${JSON.stringify(secondPermission)}`);
  alice.inbox.length = 0; bob.inbox.length = 0; charlie.inbox.length = 0;
  alice.send(JSON.stringify({ type: "dm", to: secondAccount.user.id, kind: "image", content: `/uploads/${crypto.randomUUID()}.png` }));
  const senderDm = await waitFor(alice, packet => packet.type === "dm" && packet.kind === "image");
  const secondSenderDm = await waitFor(bob, packet => packet.type === "dm" && packet.kind === "image");
  const recipientDm = await waitFor(charlie, packet => packet.type === "dm" && packet.kind === "image");
  ok("DM events carry one stable id for client deduplication", Boolean(senderDm.id) && senderDm.id === secondSenderDm.id && senderDm.id === recipientDm.id);
  alice.inbox.length = 0; bob.inbox.length = 0; charlie.inbox.length = 0;
  charlie.send(JSON.stringify({ type: "dm", to: account.user.id, kind: "voice", content: `/uploads/${crypto.randomUUID()}.webm` }));
  const reverseDm = await waitFor(alice, packet => packet.type === "dm" && packet.kind === "voice");
  ok("the approver can send media back without another request", reverseDm.from.id === secondAccount.user.id && reverseDm.to === account.user.id);

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

  head("uploads");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64");
  const upload = await post("/api/upload", { kind: "image", data: png.toString("base64") }, cookie);
  const uploaded = await upload.json();
  ok("image upload returns 201", upload.status === 201, `status ${upload.status} ${JSON.stringify(uploaded)}`);
  ok("upload returns a /uploads/ url", typeof uploaded.url === "string" && uploaded.url.startsWith("/uploads/"), `${uploaded.url}`);
  const stored = await fetch(`${BASE}${uploaded.url}`);
  const storedBytes = Buffer.from(await stored.arrayBuffer());
  ok("uploaded file is served back", stored.status === 200, `status ${stored.status}`);
  ok("stored bytes match the upload byte for byte", storedBytes.equals(png), `${storedBytes.length} vs ${png.length} bytes`);
  ok("stored file keeps its content type", (stored.headers.get("content-type") || "") === "image/png", `${stored.headers.get("content-type")}`);
  const notAnImage = await post("/api/upload", { kind: "image", data: Buffer.from("this is not an image").toString("base64") }, cookie);
  ok("a non-image payload is rejected", notAnImage.status === 400, `status ${notAnImage.status}`);
  const oversized = await post("/api/upload", { kind: "image", data: Buffer.alloc(7 * 1024 * 1024).toString("base64") }, cookie);
  ok("an oversized image is rejected", oversized.status === 400, `status ${oversized.status}`);
  const anonymousUpload = await post("/api/upload", { kind: "image", data: png.toString("base64") });
  ok("anonymous upload is refused", anonymousUpload.status === 401 || anonymousUpload.status === 403, `status ${anonymousUpload.status}`);
  const missingFile = await fetch(`${BASE}/uploads/${stamp}-nope.png`);
  ok("a missing upload returns 404", missingFile.status === 404, `status ${missingFile.status}`);

  head("persistence");
  alice.close(); bob.close(); charlie.close(); charlieOther.close();
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
