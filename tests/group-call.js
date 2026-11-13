/**
 * Room (group) call signaling over the room socket.
 *
 * Usage:  node tests/group-call.js [baseUrl]
 * Needs a running local server:  npx wrangler dev --port 8787
 *
 * Audio never touches this server: it keeps the participant list for one call per room and relays
 * offers, answers and ICE candidates between members of that call. This suite drives the relay with
 * three accounts - two participants and one member who is in the room but not in the call - and
 * checks the refusals as hard as the deliveries.
 */
const WebSocket = require("ws");

const BASE = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/$/, "");
const ORIGIN = BASE;
const WS_BASE = BASE.replace(/^http/, "ws");
const stamp = Date.now().toString(36);
const OFFER = { type: "offer", sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\n" };

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
const signup = async username => {
  const response = await post("/api/auth/signup", { username, age: 24, adultConfirmed: true });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, cookie: cookieOf(response), user: body.user };
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

async function main() {
  console.log(`\nroom call signalling on ${BASE}`);

  const owner = await signup(`gc_owner_${stamp}`), peer = await signup(`gc_peer_${stamp}`), spare = await signup(`gc_spare_${stamp}`);
  ok("three accounts sign up", owner.status === 201 && peer.status === 201 && spare.status === 201, `${owner.status}/${peer.status}/${spare.status}`);

  const created = await post("/api/rooms", { name: `Call ${stamp}`, vibe: "Group call test.", access: "request", theme: "ocean" }, owner.cookie);
  const room = (await created.json()).room;
  ok("a request-only room is created", created.status === 201 && Boolean(room?.id), `status ${created.status}`);
  for (const member of [peer, spare]) {
    await post(`/api/rooms/${room.id}/request`, {}, member.cookie);
    await post(`/api/rooms/${room.id}/requests/${member.user.id}`, { action: "approve" }, owner.cookie);
  }

  const ownerSocket = socket(room.id, owner.cookie), peerSocket = socket(room.id, peer.cookie), spareSocket = socket(room.id, spare.cookie);
  for (const ws of [ownerSocket, peerSocket, spareSocket]) { await open(ws); await waitFor(ws, packet => packet.type === "history"); }

  /* --------------------------------------------------------------- opening */
  ownerSocket.send(JSON.stringify({ type: "group-call-join" }));
  const opened = await waitFor(ownerSocket, packet => packet.type === "group-call-joined");
  ok("the creator opens a call and gets its id", Boolean(opened.callId) && opened.participants.length === 1 && opened.hostId === owner.user.id, JSON.stringify(opened));
  const announced = await waitFor(peerSocket, packet => packet.type === "group-call-state" && packet.active && packet.callId === opened.callId);
  ok("everybody in the room is told a call is live", announced.participants.length === 1 && announced.participants[0].id === owner.user.id);

  /* ---------------------------------------------------------------- joining */
  peerSocket.inbox.length = 0;
  peerSocket.send(JSON.stringify({ type: "group-call-join" }));
  const joined = await waitFor(peerSocket, packet => packet.type === "group-call-joined");
  ok("a member joins the existing call", joined.callId === opened.callId && joined.participants.length === 2 && joined.hostId === owner.user.id, JSON.stringify(joined));
  const twoOfUs = await waitFor(ownerSocket, packet => packet.type === "group-call-state" && packet.participants?.length === 2);
  ok("the member list reaches the other side", twoOfUs.participants.some(person => person.id === peer.user.id));

  /* -------------------------------------------------------------- signalling */
  peerSocket.send(JSON.stringify({ type: "group-call-offer", callId: opened.callId, to: owner.user.id, sdp: OFFER }));
  const offer = await waitFor(ownerSocket, packet => packet.type === "group-call-offer");
  ok("an offer is relayed to the named participant", offer.from === peer.user.id && offer.sdp?.type === "offer" && offer.callId === opened.callId, JSON.stringify(offer));

  ownerSocket.send(JSON.stringify({ type: "group-call-answer", callId: opened.callId, to: peer.user.id, sdp: { type: "answer", sdp: OFFER.sdp } }));
  const answer = await waitFor(peerSocket, packet => packet.type === "group-call-answer");
  ok("the answer comes back the other way", answer.from === owner.user.id && answer.sdp?.type === "answer");

  peerSocket.send(JSON.stringify({ type: "group-call-ice", callId: opened.callId, to: owner.user.id, candidate: { candidate: "candidate:1 1 udp 2113937151 10.0.0.1 5000 typ host", sdpMid: "0", sdpMLineIndex: 0 } }));
  const ice = await waitFor(ownerSocket, packet => packet.type === "group-call-ice");
  ok("an ICE candidate is relayed with its fields intact", ice.candidate?.candidate.startsWith("candidate:1") && ice.candidate.sdpMLineIndex === 0, JSON.stringify(ice));

  /* ---------------------------------------------------------------- refusals */
  ownerSocket.inbox.length = 0;
  peerSocket.send(JSON.stringify({ type: "group-call-ice", callId: opened.callId, to: owner.user.id, candidate: { candidate: "x".repeat(5000) } }));
  peerSocket.send(JSON.stringify({ type: "group-call-offer", callId: opened.callId, to: owner.user.id, sdp: { type: "answer", sdp: OFFER.sdp } }));
  peerSocket.send(JSON.stringify({ type: "group-call-offer", callId: "not-this-call", to: owner.user.id, sdp: OFFER }));
  // The spare member is in the room but never joined the call, so it may not signal into it.
  spareSocket.send(JSON.stringify({ type: "group-call-offer", callId: opened.callId, to: owner.user.id, sdp: OFFER }));
  await sleep(800);
  ok("oversized candidates, wrong SDP types, a stale call id and a non-participant are all dropped", !ownerSocket.inbox.some(packet => ["group-call-ice", "group-call-offer"].includes(packet.type)), JSON.stringify(ownerSocket.inbox.filter(packet => packet.type.startsWith("group-call"))));

  /* ----------------------------------------------------------------- leaving */
  ownerSocket.inbox.length = 0;
  peerSocket.send(JSON.stringify({ type: "group-call-leave", callId: opened.callId }));
  const left = await waitFor(ownerSocket, packet => packet.type === "group-call-left");
  ok("leaving removes the member and tells the rest", left.userId === peer.user.id);
  await waitFor(ownerSocket, packet => packet.type === "group-call-state" && packet.participants?.length === 1);

  // A second tab in the same room must not take the member out of the call when it closes, and the
  // last tab closing must - both without any leave message from the client.
  const secondPeer = socket(room.id, peer.cookie);
  await open(secondPeer);
  await waitFor(secondPeer, packet => packet.type === "history");
  secondPeer.send(JSON.stringify({ type: "group-call-join" }));
  await waitFor(secondPeer, packet => packet.type === "group-call-joined");
  await waitFor(ownerSocket, packet => packet.type === "group-call-state" && packet.participants?.length === 2);
  ownerSocket.inbox.length = 0;
  secondPeer.close();
  await sleep(900);
  ok("closing one of two tabs keeps the member in the call", !ownerSocket.inbox.some(packet => packet.type === "group-call-left" && packet.userId === peer.user.id), JSON.stringify(ownerSocket.inbox.filter(packet => packet.type.startsWith("group-call"))));

  ownerSocket.inbox.length = 0;
  peerSocket.close();
  const dropped = await waitFor(ownerSocket, packet => packet.type === "group-call-left" && packet.userId === peer.user.id, 8000).catch(() => null);
  ok("closing the last tab removes the member without a leave message", Boolean(dropped), JSON.stringify(ownerSocket.inbox.filter(packet => packet.type === "group-call-left")));

  spareSocket.inbox.length = 0;
  ownerSocket.close();
  const ended = await waitFor(spareSocket, packet => packet.type === "group-call-state" && packet.active === false, 8000).catch(() => null);
  ok("the call disappears when the last participant leaves", Boolean(ended));

  /* ------------------------------------------------- rooms where it is closed */
  const openRoom = (await (await post("/api/rooms", { name: `Open ${stamp}`, vibe: "No calls here.", access: "open", theme: "forest" }, owner.cookie)).json()).room;
  const openSocket = socket(openRoom.id, owner.cookie);
  await open(openSocket);
  await waitFor(openSocket, packet => packet.type === "history");
  openSocket.send(JSON.stringify({ type: "group-call-join" }));
  await sleep(700);
  ok("an open room has no room call", !openSocket.inbox.some(packet => packet.type.startsWith("group-call")), JSON.stringify(openSocket.inbox.filter(packet => packet.type.startsWith("group-call"))));

  const builtInSocket = socket("casual", owner.cookie);
  await open(builtInSocket);
  await waitFor(builtInSocket, packet => packet.type === "history");
  builtInSocket.send(JSON.stringify({ type: "group-call-join" }));
  await sleep(700);
  ok("a built-in room has no room call", !builtInSocket.inbox.some(packet => packet.type.startsWith("group-call")));

  for (const ws of [spareSocket, openSocket, builtInSocket]) ws.close();
  await sleep(200);
  for (const id of [room.id, openRoom.id]) await fetch(`${BASE}/api/rooms/${id}`, { method: "DELETE", headers: { Origin: ORIGIN, Cookie: owner.cookie } }).catch(() => {});

  console.log(`\n${failed === 0 ? "ALL GOOD" : "FAILURES"} - ${passed} passed, ${failed} failed  (accounts: gc_*_${stamp})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => { console.error(`\nroom-call test crashed: ${error.message}`); process.exit(1); });
