/**
 * Room games: the dock, the join/request/watch rules and a whole Connect Four game.
 *
 * Usage:  node tests/games.js [baseUrl]
 * Needs a running local server:  npx wrangler dev --port 8787
 *
 * Every move is validated in the Durable Object, so this suite spends most of its checks on the
 * refusals as well as the deliveries: out-of-turn moves, a spectator moving, a join once the game has
 * started, and an approval from somebody who is not the host. It also pins the budget rule - a burst of
 * game events must not spend the chat message window - because a board that eats message quota would
 * mute the room it is being played in.
 */
const WebSocket = require("ws");

const BASE = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/$/, "");
const ORIGIN = BASE;
const WS_BASE = BASE.replace(/^http/, "ws");
const stamp = Date.now().toString(36);

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
const get = (path, cookie) => fetch(`${BASE}${path}`, { headers: cookie ? { Cookie: cookie } : {}, redirect: "manual" });
const signup = async username => {
  const response = await post("/api/auth/signup", { username, age: 24, adultConfirmed: true });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, cookie: cookieOf(response), user: body.user };
};
function socket(room, cookie) {
  const ws = new WebSocket(`${WS_BASE}/?room=${encodeURIComponent(room)}`, { headers: { Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}) } });
  ws.inbox = [];
  // waitFor attaches one-off listeners; the default cap of 10 fires on a chatty room.
  ws.setMaxListeners(0);
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
const send = (ws, event) => ws.send(JSON.stringify(event));
// The state a client renders from: the newest game-state in this socket's inbox.
const latestGame = ws => [...ws.inbox].reverse().find(packet => packet.type === "game-state");
const move = async (ws, gameId, column, expectTurn) => {
  // Clear first: a state packet from the previous move would otherwise satisfy the predicate instantly.
  ws.inbox.length = 0;
  send(ws, { type: "game-move", gameId, column });
  return waitFor(ws, packet => packet.type === "game-state" && packet.game && packet.game.status !== "lobby" && (expectTurn === undefined || packet.game.turn === expectTurn));
};

async function main() {
  console.log(`\nroom games on ${BASE}`);

  const owner = await signup(`gm_owner_${stamp}`), peer = await signup(`gm_peer_${stamp}`), spare = await signup(`gm_spare_${stamp}`);
  ok("three accounts sign up", [owner, peer, spare].every(account => account.status === 201), [owner, peer, spare].map(account => account.status).join("/"));

  const created = await post("/api/rooms", { name: `Games ${stamp}`, vibe: "Games test.", access: "open", theme: "ocean" }, owner.cookie);
  const room = (await created.json()).room;
  ok("an open room is created", created.status === 201 && Boolean(room?.id), `status ${created.status}`);

  const ownerSocket = socket(room.id, owner.cookie), peerSocket = socket(room.id, peer.cookie), spareSocket = socket(room.id, spare.cookie);
  for (const ws of [ownerSocket, peerSocket, spareSocket]) { await open(ws); await waitFor(ws, packet => packet.type === "history"); }

  /* ------------------------------------------------------------------ lobby */
  ok("a room with no game reports none on connect", !latestGame(ownerSocket));

  ownerSocket.inbox.length = 0; peerSocket.inbox.length = 0;
  send(ownerSocket, { type: "game-create", kind: "connect-four", policy: "open" });
  const opened = await waitFor(peerSocket, packet => packet.type === "game-state" && packet.game);
  const game = opened.game;
  ok("starting a game seats the host and waits", game.status === "lobby" && game.players.length === 1 && game.players[0].id === owner.user.id, JSON.stringify(game));
  ok("an open game is marked open", game.policy === "open" && game.seats === 2);

  send(spareSocket, { type: "game-watch", gameId: game.id });
  const watched = await waitFor(peerSocket, packet => packet.type === "game-state" && packet.game && packet.game.spectators === 1);
  ok("a member can watch without a seat", watched.game.spectators === 1 && watched.game.players.length === 1);

  peerSocket.inbox.length = 0;
  send(peerSocket, { type: "game-join", gameId: game.id });
  const started = await waitFor(peerSocket, packet => packet.type === "game-state" && packet.game && packet.game.status === "playing");
  ok("an open seat fills straight away and the game starts", started.game.players.length === 2 && started.game.players[1].id === peer.user.id, JSON.stringify(started.game.players));
  ok("the host moves first", started.game.turn === owner.user.id);

  /* ------------------------------------------------------------ refusals */
  peerSocket.inbox.length = 0;
  send(peerSocket, { type: "game-move", gameId: game.id, column: 3 });
  const outOfTurn = await waitFor(peerSocket, packet => packet.type === "game-error");
  ok("a move out of turn is refused with a sentence", /not your turn/i.test(outOfTurn.message), outOfTurn.message);
  await sleep(200);
  ok("the refused move never reached the board", !peerSocket.inbox.some(packet => packet.type === "game-state" && packet.game.board.some(cell => cell !== 0)));

  spareSocket.inbox.length = 0;
  send(spareSocket, { type: "game-move", gameId: game.id, column: 0 });
  const spectatorMove = await waitFor(spareSocket, packet => packet.type === "game-error");
  ok("a spectator cannot move", /players can move/i.test(spectatorMove.message), spectatorMove.message);

  ownerSocket.inbox.length = 0;
  send(ownerSocket, { type: "game-move", gameId: game.id, column: 7 });
  const badColumn = await waitFor(ownerSocket, packet => packet.type === "game-error");
  ok("a column off the board is refused", Boolean(badColumn.message));

  spareSocket.inbox.length = 0;
  send(spareSocket, { type: "game-join", gameId: game.id });
  const full = await waitFor(spareSocket, packet => packet.type === "game-error" && /started/i.test(packet.message));
  ok("joining a game that already started is refused", /started/i.test(full.message), full.message);

  /* --------------------------------------------------------------- a whole game */
  // The host stacks four discs in column 0 while the peer answers in column 6. Board index = column * 6 + row.
  ownerSocket.inbox.length = 0; peerSocket.inbox.length = 0;
  await move(ownerSocket, game.id, 0, peer.user.id);
  await move(peerSocket, game.id, 6, owner.user.id);
  await move(ownerSocket, game.id, 0, peer.user.id);
  await move(peerSocket, game.id, 6, owner.user.id);
  await move(ownerSocket, game.id, 0, peer.user.id);
  await move(peerSocket, game.id, 6, owner.user.id);
  send(ownerSocket, { type: "game-move", gameId: game.id, column: 0 });
  const finished = await waitFor(ownerSocket, packet => packet.type === "game-state" && packet.game && packet.game.status === "ended");
  ok("four in a column ends the game", finished.game.reason === "four" && finished.game.winnerId === owner.user.id, JSON.stringify(finished.game));
  ok("the winner's stack is on the board", [0, 1, 2, 3].every(row => finished.game.board[row] === 1), JSON.stringify(finished.game.board.slice(0, 6)));
  ok("the winner is credited a win", (finished.game.players.find(player => player.id === owner.user.id) || {}).score === 1);
  const watcherSawEnd = await waitFor(spareSocket, packet => packet.type === "game-state" && packet.game && packet.game.status === "ended");
  ok("the spectator is told how it ended", watcherSawEnd.game.winnerId === owner.user.id);

  /* ------------------------------------------------------- request to join */
  ownerSocket.inbox.length = 0; peerSocket.inbox.length = 0; spareSocket.inbox.length = 0;
  send(ownerSocket, { type: "game-create", kind: "connect-four", policy: "request" });
  const second = (await waitFor(ownerSocket, packet => packet.type === "game-state" && packet.game && packet.game.status === "lobby")).game;
  ok("a finished game can be replaced by a new one", second.id !== game.id && second.policy === "request");

  send(peerSocket, { type: "game-request", gameId: second.id });
  const pending = await waitFor(ownerSocket, packet => packet.type === "game-state" && packet.game && packet.game.pending.length === 1);
  ok("a request waits for the host instead of taking the seat", pending.game.pending[0].id === peer.user.id && pending.game.players.length === 1, JSON.stringify(pending.game.pending));
  const notified = await waitFor(ownerSocket, packet => packet.type === "game-request");
  ok("the host is told who is asking", notified.by?.id === peer.user.id);

  spareSocket.inbox.length = 0;
  send(spareSocket, { type: "game-approve", gameId: second.id, userId: peer.user.id });
  const notHost = await waitFor(spareSocket, packet => packet.type === "game-error");
  ok("nobody but the host can approve", /host/i.test(notHost.message), notHost.message);

  ownerSocket.inbox.length = 0; peerSocket.inbox.length = 0;
  send(ownerSocket, { type: "game-approve", gameId: second.id, userId: peer.user.id });
  const approved = await waitFor(peerSocket, packet => packet.type === "game-state" && packet.game && packet.game.status === "playing");
  ok("approval seats the requester and starts the game", approved.game.players.length === 2 && approved.game.pending.length === 0);
  ok("the requester hears that they are in", Boolean(await waitFor(peerSocket, packet => packet.type === "game-approved")));

  /* ----------------------------------------------------------------- leaves */
  ownerSocket.inbox.length = 0; peerSocket.inbox.length = 0;
  send(peerSocket, { type: "game-leave", gameId: second.id });
  const forfeited = await waitFor(ownerSocket, packet => packet.type === "game-state" && packet.game && packet.game.status === "ended");
  ok("leaving a running game forfeits it", forfeited.game.reason === "left" && forfeited.game.winnerId === owner.user.id, JSON.stringify(forfeited.game));

  send(ownerSocket, { type: "game-end", gameId: second.id });
  const closed = await waitFor(peerSocket, packet => packet.type === "game-state" && packet.game === null);
  ok("the host can clear the finished game from the room", closed.game === null);

  /* ------------------------------------------------------------- the game list */
  send(ownerSocket, { type: "game-create", kind: "connect-four", policy: "open" });
  const listed = await waitFor(ownerSocket, packet => packet.type === "game-state" && packet.game && packet.game.status === "lobby");
  const list = await (await get("/api/games", peer.cookie)).json();
  const entry = (list.games || []).find(item => item.id === listed.game.id);
  ok("the games card lists the game with its room and seats", Boolean(entry) && entry.roomName.startsWith("Games ") && entry.seats === 2 && entry.players === 1, JSON.stringify(list.games));
  ok("the games card is closed to signed-out visitors", (await get("/api/games")).status === 401);

  // Opening the dock asks the server for the truth instead of trusting what the client last heard; this
  // is the check that keeps a stale or hibernated view from saying "nobody is playing here".
  ownerSocket.inbox.length = 0;
  send(ownerSocket, { type: "game-sync" });
  const synced = await waitFor(ownerSocket, packet => packet.type === "game-state");
  ok("the dock can ask for the current game", Boolean(synced.game) && synced.game.id === listed.game.id, JSON.stringify(synced.game?.id));

  const privateRoom = (await (await post("/api/rooms", { name: `Hidden ${stamp}`, vibe: "Private game.", access: "request", theme: "berry" }, owner.cookie)).json()).room;
  const privateSocket = socket(privateRoom.id, owner.cookie);
  await open(privateSocket);
  await waitFor(privateSocket, packet => packet.type === "history");
  privateSocket.inbox.length = 0;
  send(privateSocket, { type: "game-create", kind: "connect-four", policy: "open" });
  const hidden = await waitFor(privateSocket, packet => packet.type === "game-state" && packet.game);
  const peerList = await (await get("/api/games", peer.cookie)).json();
  // Owner's rule: what a private room is playing is not visible from outside it.
  ok("a game in a private room is not advertised to outsiders", !(peerList.games || []).some(item => item.id === hidden.game.id), JSON.stringify(peerList.games));
  const ownerList = await (await get("/api/games", owner.cookie)).json();
  ok("but the room's own members see it", (ownerList.games || []).some(item => item.id === hidden.game.id));

  /* ------------------------------------------------------------ budgets */
  // 25 game events in a row would blow the 20-per-10s chat window if games were counted there.
  for (let index = 0; index < 25; index++) send(ownerSocket, { type: "game-watch", gameId: listed.game.id });
  await sleep(400);
  ownerSocket.inbox.length = 0;
  send(ownerSocket, { type: "message", kind: "text", content: "still typing after all that" });
  const echoed = await waitFor(ownerSocket, packet => packet.type === "message" && packet.message.content === "still typing after all that", 4000).catch(() => null);
  ok("a burst of game events does not spend the chat message window", Boolean(echoed));

  /* ------------------------------------------------------------- teardown */
  for (const ws of [ownerSocket, peerSocket, spareSocket, privateSocket]) ws.close();
  await fetch(`${BASE}/api/rooms/${room.id}`, { method: "DELETE", headers: { Origin: ORIGIN, Cookie: owner.cookie } });
  await fetch(`${BASE}/api/rooms/${privateRoom.id}`, { method: "DELETE", headers: { Origin: ORIGIN, Cookie: owner.cookie } });

  console.log(`\n${failed === 0 ? "ALL GOOD" : "FAILURES"} - ${passed} passed, ${failed} failed  (accounts: gm_*_${stamp})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => { console.error(`\ngames test crashed: ${error instanceof Error ? error.message : error}`); process.exit(1); });
