/**
 * The room-list notice board: public read, admin-only write, and the live push to open tabs.
 *
 * Usage:  node tests/notice-board.js [baseUrl]
 * Needs a running local server.
 *
 * The positive path needs the account the server auto-promotes to admin (`dynamic`), which can only be
 * created once per database; on a database that already has it that part reports SKIP, and the
 * negative cases (anonymous and non-admin writes) always run.
 */
const WebSocket = require("ws");

const BASE = (process.argv[2] || "http://localhost:8787").replace(/\/$/, "");
const WS_BASE = BASE.replace(/^http/, "ws");
const stamp = Date.now().toString(36);
let passed = 0, failed = 0, skipped = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ""}`); }
};
const skip = label => { skipped++; console.log(`  SKIP  ${label}`); };
const cookieOf = response => {
  const raw = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie")].filter(Boolean);
  return raw.map(value => value.split(";")[0]).join("; ");
};
const post = (path, body, cookie) => fetch(`${BASE}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
const get = (path, cookie) => fetch(`${BASE}${path}`, { headers: { ...(cookie ? { Cookie: cookie } : {}) } });
const signup = async username => {
  const response = await post("/api/auth/signup", { username, age: 24, adultConfirmed: true });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, cookie: cookieOf(response), user: body.user, body };
};
function socket(cookie) {
  const ws = new WebSocket(`${WS_BASE}/?room=__notify`, { headers: { Origin: BASE, ...(cookie ? { Cookie: cookie } : {}) } });
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

(async () => {
  console.log(`\nnotice board on ${BASE}`);

  const reader = await signup(`notice_${stamp}`);
  ok("a normal account signs up", reader.status === 201, `status ${reader.status}`);

  const anonymous = await get("/api/notice");
  const anonymousBody = await anonymous.json();
  ok("the board is readable without signing in", anonymous.status === 200 && Boolean(anonymousBody.notice), `status ${anonymous.status}`);
  ok("a hidden notice never leaks its text", anonymousBody.notice.visible === false && anonymousBody.notice.message === "", JSON.stringify(anonymousBody.notice));

  const anonymousWrite = await post("/api/notice", { message: "hacked", visible: true });
  ok("an anonymous write is refused", anonymousWrite.status === 401, `status ${anonymousWrite.status}`);
  const memberWrite = await post("/api/notice", { message: "not mine to post", visible: true }, reader.cookie);
  ok("a normal member cannot write the board", memberWrite.status === 403, `status ${memberWrite.status}`);

  const admin = await signup("dynamic");
  if (admin.status !== 201) {
    skip(`admin write path (the "dynamic" admin already exists: ${admin.status} ${JSON.stringify(admin.body).slice(0, 80)})`);
  } else {
    const watcher = socket(reader.cookie);
    await new Promise((resolve, reject) => { watcher.once("open", resolve); watcher.once("error", reject); });

    const message = `Update ${stamp}: voice notes are smoother and room calls have an end button.`;
    const published = await post("/api/notice", { message, visible: true }, admin.cookie);
    ok("the admin publishes a notice", published.status === 200 && (await published.clone().json().catch(() => ({}))).notice?.visible === true, `status ${published.status}`);
    const live = await waitFor(watcher, packet => packet.type === "notice-changed" && packet.notice && packet.notice.visible).catch(() => null);
    ok("open room lists hear about it immediately", Boolean(live) && live.notice.message === message, JSON.stringify(live && live.notice));

    const visible = await (await get("/api/notice", reader.cookie)).json();
    ok("a visible notice is public", visible.notice.visible === true && visible.notice.message === message, JSON.stringify(visible.notice));

    const hidden = await post("/api/notice", { message, visible: false }, admin.cookie);
    ok("the admin can hide it with the same message", hidden.status === 200 && (await hidden.json()).notice.visible === false);
    const afterHide = await (await get("/api/notice", reader.cookie)).json();
    ok("a hidden notice keeps its text out of the public read", afterHide.notice.visible === false && afterHide.notice.message === "", JSON.stringify(afterHide.notice));

    const empty = await post("/api/notice", { message: "   ", visible: true }, admin.cookie);
    ok("showing an empty notice is refused", empty.status === 400, `status ${empty.status}`);

    watcher.close();
  }

  console.log(`\n${failed === 0 ? "ALL GOOD" : "FAILURES"} - ${passed} passed, ${failed} failed, ${skipped} skipped  (account: notice_${stamp})`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(error => { console.error(`\nnotice test crashed: ${error.message}`); process.exit(1); });
