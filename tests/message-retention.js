/**
 * Retention test for the amortized trim in ChatHub.addMessage.
 *
 * Usage:  node tests/message-retention.js [baseUrl]
 * Needs a running local server:  npx wrangler dev --port 8787
 *
 * The room history DELETE used to run on every insert (rescanning the room, ~MAX_MESSAGES rows
 * read per message). It now runs once per TRIM_INTERVAL inserts. This test proves the retention
 * guarantee is unchanged: push well past MAX_MESSAGES and the newest 100 must survive, exactly.
 *
 * The senders are split across 7 sockets because a single socket is limited to
 * MESSAGE_LIMIT_PER_WINDOW (20) messages per MESSAGE_WINDOW_MS (10s) - the window is per socket.
 */
const WebSocket = require("ws");

const BASE = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/$/, "");
const ORIGIN = BASE;
const WS_BASE = BASE.replace(/^http/, "ws");
const stamp = Date.now().toString(36);
const USERNAME = `retention_${stamp}`;
const SENDERS = 7;
const PER_SENDER = 20;                     // == MESSAGE_LIMIT_PER_WINDOW
const TOTAL = SENDERS * PER_SENDER;        // 140 > MAX_MESSAGES, so trimming must kick in
const CAPPED = 100;                        // == MAX_MESSAGES
const tag = n => `msg-${String(n).padStart(3, "0")}`;
const KEEP = process.env.KEEP === "1";   // leave the room behind so its SQLite rows can be inspected

let passed = 0, failed = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ""}`); }
};

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

async function main() {
  console.log(`\nretention: ${TOTAL} messages from ${SENDERS} sockets into one room`);

  const signup = await post("/api/auth/signup", { username: USERNAME, age: 24, adultConfirmed: true });
  ok("signup returns 201", signup.status === 201, `status ${signup.status}`);
  const cookie = cookieOf(signup);

  const created = await post("/api/rooms", { name: `Retention Room ${stamp}`, vibe: "Trim test.", access: "open", theme: "ocean" }, cookie);
  const createdBody = await created.json();
  const roomId = createdBody.room && createdBody.room.id;
  ok("room creation returns 201", created.status === 201, `status ${created.status} ${JSON.stringify(createdBody)}`);
  console.log(`  room: ${roomId}`);

  const sockets = [];
  for (let i = 0; i < SENDERS; i++) {
    const ws = socket(roomId, cookie);
    await open(ws);
    await waitFor(ws, packet => packet.type === "history");
    sockets.push(ws);
  }
  ok(`${SENDERS} sockets are in the room`, sockets.every(ws => ws.readyState === WebSocket.OPEN));

  let sent = 0;
  for (const ws of sockets) {
    for (let n = 0; n < PER_SENDER; n++) { sent++; ws.send(JSON.stringify({ type: "message", kind: "text", content: tag(sent) })); }
    await sleep(300);                      // keep arrival order deterministic across sockets
  }
  ok(`all ${TOTAL} messages were sent`, sent === TOTAL, `sent ${sent}`);

  const ack = await waitFor(sockets[0], packet => packet.type === "message" && packet.message.content === tag(TOTAL));
  ok("the last message was accepted and echoed", Boolean(ack));
  await sleep(1500);                       // let the Durable Object drain and trim

  const probe = socket(roomId, cookie);
  await open(probe);
  const history = await waitFor(probe, packet => packet.type === "history");
  const numbers = history.messages.map(message => Number(String(message.content).replace("msg-", ""))).filter(number => !Number.isNaN(number));

  ok(`history is capped at ${CAPPED}`, numbers.length === CAPPED, `got ${numbers.length} of ${history.messages.length} messages`);
  ok("the retained set is exactly the newest 100", numbers.length === CAPPED && Math.min(...numbers) === TOTAL - CAPPED + 1 && Math.max(...numbers) === TOTAL, `range ${Math.min(...numbers)}..${Math.max(...numbers)}`);
  ok("history is in chronological order", numbers.every((value, index) => index === 0 || numbers[index - 1] <= value));

  for (const ws of [...sockets, probe]) ws.close();
  await sleep(200);
  if (KEEP) {
    console.log(`  KEEP  room ${roomId} left in place for storage inspection`);
  } else {
    const removed = await fetch(`${BASE}/api/rooms/${roomId}`, { method: "DELETE", headers: { Origin: ORIGIN, Cookie: cookie } });
    ok("room with trimmed history can still be deleted", removed.status === 200, `status ${removed.status}`);
  }

  console.log(`\n${failed === 0 ? "ALL GOOD" : "FAILURES"} - ${passed} passed, ${failed} failed  (test account: ${USERNAME})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => { console.error(`\nretention test crashed: ${error.message}`); process.exit(1); });
