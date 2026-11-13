/**
 * Replies, reactions and deletion in a room, plus the private-room preview rule.
 *
 * Usage:  node tests/message-actions.js [baseUrl]
 * Needs a running local server:  npx wrangler dev --port 8787
 *
 * Everything here goes through the real surface a browser uses: the room WebSocket for sending,
 * replying, reacting and deleting, and /api/rooms for what a room card is allowed to show.
 *
 * The admin-only half (promoting an account to mod, then deleting somebody else's message as a mod)
 * needs the account named "dynamic", which is the one name the server auto-promotes. It can only be
 * created once per database, so on a second run against the same local state that section is skipped
 * rather than failed - the creator path covers the same code with the same check.
 */
const WebSocket = require("ws");

const BASE = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/$/, "");
const ORIGIN = BASE;
const WS_BASE = BASE.replace(/^http/, "ws");
const stamp = Date.now().toString(36);
const SKIP = process.env.SKIP_ADMIN === "1";

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
const post = (path, body, cookie) => fetch(`${BASE}${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "Origin": ORIGIN, ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body),
  redirect: "manual"
});
const get = (path, cookie, headers = {}) => fetch(`${BASE}${path}`, { headers: { "Origin": ORIGIN, ...(cookie ? { Cookie: cookie } : {}), ...headers }, redirect: "manual" });
const signup = async username => {
  const response = await post("/api/auth/signup", { username, age: 24, adultConfirmed: true });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body, cookie: cookieOf(response), user: body.user };
};
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
const roomsOf = async cookie => (await get("/api/rooms", cookie).then(response => response.json())).rooms || [];

async function main() {
  console.log(`\nmessage actions on ${BASE}`);

  const owner = await signup(`act_owner_${stamp}`), peer = await signup(`act_peer_${stamp}`), stranger = await signup(`act_third_${stamp}`);
  ok("three accounts sign up", owner.status === 201 && peer.status === 201 && stranger.status === 201, `${owner.status}/${peer.status}/${stranger.status}`);

  const created = await post("/api/rooms", { name: `Actions ${stamp}`, vibe: "Reply, react, delete.", access: "open", theme: "ocean" }, owner.cookie);
  const room = (await created.json()).room;
  ok("open room is created", created.status === 201 && Boolean(room?.id), `status ${created.status}`);

  const ownerSocket = socket(room.id, owner.cookie), peerSocket = socket(room.id, peer.cookie), strangerSocket = socket(room.id, stranger.cookie);
  for (const ws of [ownerSocket, peerSocket, strangerSocket]) { await open(ws); await waitFor(ws, packet => packet.type === "history"); }

  /* --------------------------------------------------------------- reply */
  ownerSocket.send(JSON.stringify({ type: "message", kind: "text", content: "Original message" }));
  const first = await waitFor(peerSocket, packet => packet.type === "message" && packet.message.content === "Original message");
  const firstId = first.message.id;
  ok("a plain message carries no quote and no reactions", first.message.reply === null && Object.keys(first.message.reactions || {}).length === 0, JSON.stringify(first.message));

  peerSocket.send(JSON.stringify({ type: "message", kind: "text", content: "Quoting you", replyTo: firstId }));
  const reply = await waitFor(peerSocket, packet => packet.type === "message" && packet.message.content === "Quoting you");
  ok("a reply stores the parent id and a snapshot of it", reply.message.reply?.id === firstId && reply.message.reply?.username === owner.user.username && reply.message.reply?.snippet === "Original message", JSON.stringify(reply.message.reply));

  peerSocket.send(JSON.stringify({ type: "message", kind: "text", content: "Bogus quote", replyTo: "no-such-message" }));
  const bogus = await waitFor(peerSocket, packet => packet.type === "message" && packet.message.content === "Bogus quote");
  ok("an unknown parent id sends a normal message instead of failing", bogus.message.reply === null);

  ownerSocket.send(JSON.stringify({ type: "message", kind: "text", content: "x".repeat(600) }));
  const longText = await waitFor(peerSocket, packet => packet.type === "message" && String(packet.message.content).startsWith("xxx"));
  ok("long text is still capped at 500 characters", longText.message.content.length === 500, `got ${longText.message.content.length}`);

  /* ----------------------------------------------------------- reactions */
  // Each step clears the inbox first: waitFor scans what already arrived, and every reaction event
  // for the same message looks alike.
  const reactionWith = (ws, count) => waitFor(ws, packet => packet.type === "message-reactions" && packet.messageId === firstId && Array.isArray(packet.reactions["👍"]) && packet.reactions["👍"].length === count);

  ownerSocket.inbox.length = 0;
  peerSocket.send(JSON.stringify({ type: "react", messageId: firstId, emoji: "👍" }));
  const reacted = await reactionWith(ownerSocket, 1);
  ok("a reaction is broadcast to the room", reacted.reactions["👍"][0] === peer.user.id, JSON.stringify(reacted.reactions));

  peerSocket.inbox.length = 0;
  ownerSocket.send(JSON.stringify({ type: "react", messageId: firstId, emoji: "👍" }));
  const second = await reactionWith(peerSocket, 2);
  ok("a second account adds to the same reaction", second.reactions["👍"].length === 2);

  ownerSocket.inbox.length = 0;
  peerSocket.send(JSON.stringify({ type: "react", messageId: firstId, emoji: "👍" }));
  const withdrawn = await reactionWith(ownerSocket, 1);
  ok("reacting twice with the same emoji removes that account's reaction", withdrawn.reactions["👍"][0] === owner.user.id, JSON.stringify(withdrawn.reactions));

  peerSocket.inbox.length = 0;
  peerSocket.send(JSON.stringify({ type: "react", messageId: firstId, emoji: "🚀" }));
  peerSocket.send(JSON.stringify({ type: "react", messageId: "no-such-message", emoji: "👍" }));
  await sleep(700);
  ok("an emoji outside the fixed set is ignored", !peerSocket.inbox.some(packet => packet.type === "message-reactions"), JSON.stringify(peerSocket.inbox.filter(packet => packet.type === "message-reactions")));

  /* ------------------------------------------------------------- deletion */
  peerSocket.send(JSON.stringify({ type: "message", kind: "text", content: "Delete me" }));
  const target = await waitFor(ownerSocket, packet => packet.type === "message" && packet.message.content === "Delete me");
  const targetId = target.message.id;

  strangerSocket.inbox.length = 0;
  strangerSocket.send(JSON.stringify({ type: "delete-message", messageId: targetId }));
  await sleep(700);
  ok("a member without rights cannot delete somebody else's message", !strangerSocket.inbox.some(packet => packet.type === "message-deleted"), JSON.stringify(strangerSocket.inbox.filter(packet => packet.type === "message-deleted")));

  ownerSocket.send(JSON.stringify({ type: "delete-message", messageId: targetId }));
  const deleted = await waitFor(peerSocket, packet => packet.type === "message-deleted" && packet.messageId === targetId);
  ok("the room creator can delete any message in their room", deleted.messageId === targetId && deleted.by?.username === owner.user.username);

  const probe = socket(room.id, peer.cookie);
  await open(probe);
  const history = await waitFor(probe, packet => packet.type === "history");
  const deletedRow = history.messages.find(message => message.id === targetId);
  ok("a deleted message keeps its slot with no content", Boolean(deletedRow) && deletedRow.deleted === true && deletedRow.content === "", JSON.stringify(deletedRow));
  ok("history keeps the quote inside the reply", history.messages.find(message => message.id === reply.message.id)?.reply?.id === firstId);
  probe.close();

  peerSocket.send(JSON.stringify({ type: "message", kind: "text", content: "Own message" }));
  const own = await waitFor(peerSocket, packet => packet.type === "message" && packet.message.content === "Own message");
  peerSocket.send(JSON.stringify({ type: "delete-message", messageId: own.message.id }));
  const ownDeleted = await waitFor(peerSocket, packet => packet.type === "message-deleted" && packet.messageId === own.message.id);
  ok("the author can delete their own message", ownDeleted.by?.id === peer.user.id);

  /* ------------------------------------------------- private room previews */
  const privateRoom = (await (await post("/api/rooms", { name: `Private ${stamp}`, vibe: "No previews here.", access: "request", theme: "berry" }, owner.cookie)).json()).room;
  await post(`/api/rooms/${privateRoom.id}/request`, {}, peer.cookie);
  const pending = await get(`/api/rooms/${privateRoom.id}/requests`, owner.cookie).then(response => response.json());
  ok("the request shows up for the creator", pending.requests?.some(person => person.id === peer.user.id));
  await post(`/api/rooms/${privateRoom.id}/requests/${peer.user.id}`, { action: "approve" }, owner.cookie);

  const privateSocket = socket(privateRoom.id, peer.cookie);
  await open(privateSocket);
  await waitFor(privateSocket, packet => packet.type === "history");
  peerSocket.inbox.length = 0;
  privateSocket.send(JSON.stringify({ type: "message", kind: "text", content: "Secret plan" }));
  await waitFor(privateSocket, packet => packet.type === "message" && packet.message.content === "Secret plan");
  await sleep(500);
  ok("a private room publishes no live room-preview event", !peerSocket.inbox.some(packet => packet.type === "room-preview" && packet.roomId === privateRoom.id), JSON.stringify(peerSocket.inbox.filter(packet => packet.type === "room-preview")));

  const ownerPrivate = (await roomsOf(owner.cookie)).find(item => item.id === privateRoom.id);
  const peerPrivate = (await roomsOf(peer.cookie)).find(item => item.id === privateRoom.id);
  ok("the creator's private room card carries no preview", Array.isArray(ownerPrivate?.preview) && ownerPrivate.preview.length === 0, JSON.stringify(ownerPrivate?.preview));
  ok("an approved member's private room card carries no preview", peerPrivate?.canEnter === true && Array.isArray(peerPrivate.preview) && peerPrivate.preview.length === 0, JSON.stringify(peerPrivate?.preview));

  const openCard = (await roomsOf(peer.cookie)).find(item => item.id === room.id);
  ok("an open room card still shows its recent messages", Array.isArray(openCard?.preview) && openCard.preview.length > 0, JSON.stringify(openCard?.preview));
  ok("a deleted message never appears on a room card", !openCard.preview.some(message => message.id === targetId));

  /* ------------------------------------------------------- upload ranges */
  // A minimal WebM header is enough for the type sniffer: magic bytes plus padding.
  const bytes = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(400, 7)]);
  const uploaded = await post("/api/upload", { kind: "voice", data: bytes.toString("base64") }, peer.cookie);
  const uploadedBody = await uploaded.json().catch(() => ({}));
  ok("a voice note uploads", uploaded.status === 201 && Boolean(uploadedBody.url), `status ${uploaded.status} ${JSON.stringify(uploadedBody)}`);
  if (uploadedBody.url) {
    const full = await get(uploadedBody.url, peer.cookie);
    const fullBytes = Buffer.from(await full.arrayBuffer());
    ok("the upload is served whole", full.status === 200 && fullBytes.length === bytes.length && full.headers.get("accept-ranges") === "bytes");
    const partial = await get(uploadedBody.url, peer.cookie, { Range: "bytes=10-19" });
    const partialBytes = Buffer.from(await partial.arrayBuffer());
    ok("a byte range is honoured with 206", partial.status === 206 && partialBytes.length === 10 && partial.headers.get("content-range") === `bytes 10-19/${bytes.length}`, `${partial.status} ${partial.headers.get("content-range")}`);
    ok("the ranged bytes are the right ones", Buffer.compare(partialBytes, bytes.subarray(10, 20)) === 0);
    const openEnded = await get(uploadedBody.url, peer.cookie, { Range: "bytes=395-" });
    ok("an open-ended range runs to the end", openEnded.status === 206 && (await openEnded.arrayBuffer()).byteLength === 9, `${openEnded.status} ${openEnded.headers.get("content-range")} of ${bytes.length}`);
    const invalid = await get(uploadedBody.url, peer.cookie, { Range: `bytes=${bytes.length + 10}-` });
    ok("an unsatisfiable range answers 416", invalid.status === 416, `status ${invalid.status}`);
  }

  /* --------------------------------------------------------- admin and mod */
  if (SKIP) skip("mod deletion (SKIP_ADMIN=1)");
  else {
    const admin = await signup("dynamic");
    if (admin.status !== 201) skip(`mod deletion (the "dynamic" admin account could not be created: ${admin.status} ${JSON.stringify(admin.body)})`);
    else {
      const promoted = await post(`/api/admin/role/${peer.user.id}`, { role: "mod" }, admin.cookie);
      ok("the admin promotes the peer to mod", promoted.status === 200 && (await promoted.json()).user?.role === "mod");
      const modSocket = socket(room.id, peer.cookie);
      await open(modSocket);
      const modHistory = await waitFor(modSocket, packet => packet.type === "history");
      const ownerMessageId = modHistory.messages.find(message => message.content === "Original message")?.id;
      modSocket.send(JSON.stringify({ type: "delete-message", messageId: ownerMessageId }));
      const modDeleted = await waitFor(modSocket, packet => packet.type === "message-deleted" && packet.messageId === ownerMessageId).catch(() => null);
      ok("a mod can delete the room creator's message", Boolean(modDeleted) && modDeleted.by?.role === "mod", JSON.stringify(modDeleted));
      modSocket.close();
    }
  }

  for (const ws of [ownerSocket, peerSocket, strangerSocket, privateSocket]) ws.close();
  await sleep(200);
  for (const id of [room.id, privateRoom.id]) await fetch(`${BASE}/api/rooms/${id}`, { method: "DELETE", headers: { Origin: ORIGIN, Cookie: owner.cookie } }).catch(() => {});

  console.log(`\n${failed === 0 ? "ALL GOOD" : "FAILURES"} - ${passed} passed, ${failed} failed, ${skipped} skipped  (accounts: act_*_${stamp})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => { console.error(`\nmessage-actions test crashed: ${error.message}`); process.exit(1); });
