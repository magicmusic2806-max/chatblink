/**
 * Quota-budget test: the per-user daily caps that protect the account-wide free allowances
 * (100k Durable Object rows written/day, 1,000 KV writes/day).
 *
 * Usage:  node tests/quota-caps.js [baseUrl]
 * Needs a server started with deliberately small budgets, e.g.
 *   npx wrangler dev --port 8801 --var MESSAGE_DAILY_CAP:25 --var UPLOAD_DAILY_CAP:2
 *
 * What it proves:
 *  - the per-connection window still drops the 21st message in a burst, and a dropped message
 *    does not spend daily budget
 *  - the daily message budget is counted per user across connections, not per connection
 *  - the daily budget is per user: a second account is unaffected
 *  - uploads past the daily budget get a 429 instead of consuming KV writes
 */
const WebSocket = require("ws");

const BASE = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/$/, "");
const ORIGIN = BASE;
const WS_BASE = BASE.replace(/^http/, "ws");
const stamp = Date.now().toString(36);

const MESSAGE_CAP = Number(process.env.MESSAGE_DAILY_CAP || 25);   // must match the server's var
const UPLOAD_CAP = Number(process.env.UPLOAD_DAILY_CAP || 2);      // must match the server's var
const WINDOW_LIMIT = 20;                                           // MESSAGE_LIMIT_PER_WINDOW
const HOLDER = `capholder_${stamp}`;
const BYSTANDER = `capother_${stamp}`;

let passed = 0, failed = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ""}`); }
};

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
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
const waitFor = (ws, predicate, ms = 6000) => new Promise((resolve, reject) => {
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
const seen = (ws, prefix) => ws.inbox.filter(packet => packet.type === "message" && String(packet.message.content).startsWith(prefix));
const say = (ws, content) => ws.send(JSON.stringify({ type: "message", kind: "text", content }));

async function signup(username) {
  const response = await post("/api/auth/signup", { username, age: 24, adultConfirmed: true });
  return { status: response.status, cookie: cookieOf(response), body: await response.json() };
}

async function main() {
  console.log(`\nbudgets: MESSAGE_DAILY_CAP=${MESSAGE_CAP} UPLOAD_DAILY_CAP=${UPLOAD_CAP} (server must match)`);

  const holder = await signup(HOLDER);
  ok("first account signs up", holder.status === 201, `status ${holder.status}`);
  const created = await post("/api/rooms", { name: `Cap Room ${stamp}`, vibe: "Budget test.", access: "open", theme: "ocean" }, holder.cookie);
  const createdBody = await created.json();
  const roomId = createdBody.room && createdBody.room.id;
  ok("open room is created", created.status === 201 && Boolean(roomId), `status ${created.status}`);

  console.log("\nper-connection window");
  const first = socket(roomId, holder.cookie);
  await open(first);
  await waitFor(first, packet => packet.type === "history");
  for (let n = 1; n <= WINDOW_LIMIT + 1; n++) say(first, `w-${String(n).padStart(2, "0")}`);
  await sleep(1500);
  const windowEchoes = seen(first, "w-");
  ok(`a burst is held to ${WINDOW_LIMIT} messages per connection`, windowEchoes.length === WINDOW_LIMIT, `got ${windowEchoes.length}`);
  ok(`the ${WINDOW_LIMIT + 1}st message of a burst is dropped`, !first.inbox.some(packet => packet.message && packet.message.content === `w-${String(WINDOW_LIMIT + 1).padStart(2, "0")}`));

  console.log("\nper-user daily message budget");
  const second = socket(roomId, holder.cookie);          // same account, fresh connection => fresh window
  await open(second);
  await waitFor(second, packet => packet.type === "history");
  const remaining = MESSAGE_CAP - WINDOW_LIMIT;
  for (let n = 1; n <= remaining; n++) say(second, `d-${String(n).padStart(2, "0")}`);
  await sleep(1500);
  ok(`the rest of the daily budget (${remaining}) is accepted`, seen(second, "d-").length === remaining, `got ${seen(second, "d-").length}`);
  say(second, "d-over");
  await sleep(900);
  ok("the message past the daily budget is dropped", !second.inbox.some(packet => packet.message && packet.message.content === "d-over"));
  ok("...and it was the daily budget, not the connection window", seen(second, "d-").length === remaining);

  console.log("\nper-user, not global");
  const other = await signup(BYSTANDER);
  ok("second account signs up", other.status === 201, `status ${other.status}`);
  const bystander = socket(roomId, other.cookie);
  await open(bystander);
  await waitFor(bystander, packet => packet.type === "history");
  say(bystander, "o-01");
  await waitFor(bystander, packet => packet.type === "message" && packet.message.content === "o-01", 3000);
  ok("a different account can still send in the same room", seen(bystander, "o-").length === 1);

  console.log("\ndaily upload budget");
  for (let n = 1; n <= UPLOAD_CAP; n++) {
    const response = await post("/api/upload", { kind: "image", data: PNG }, other.cookie);
    ok(`upload ${n} of ${UPLOAD_CAP} is accepted`, response.status === 201, `status ${response.status}`);
  }
  const over = await post("/api/upload", { kind: "image", data: PNG }, other.cookie);
  const overBody = await over.json();
  ok(`upload ${UPLOAD_CAP + 1} is refused with 429`, over.status === 429, `status ${over.status}`);
  ok("the refusal names the daily limit (not a transient rate limit)", /today's upload limit/i.test(overBody.error || ""), JSON.stringify(overBody));

  const holderUpload = await post("/api/upload", { kind: "image", data: PNG }, holder.cookie);
  ok("the other account's upload budget is untouched", holderUpload.status === 201, `status ${holderUpload.status}`);

  for (const ws of [first, second, bystander]) ws.close();
  await sleep(200);
  await fetch(`${BASE}/api/rooms/${roomId}`, { method: "DELETE", headers: { Origin: ORIGIN, Cookie: holder.cookie } });

  console.log(`\n${failed === 0 ? "ALL GOOD" : "FAILURES"} - ${passed} passed, ${failed} failed  (test accounts: ${HOLDER}, ${BYSTANDER})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => { console.error(`\nquota test crashed: ${error.message}`); process.exit(1); });
