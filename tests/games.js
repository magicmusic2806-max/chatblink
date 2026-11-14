/**
 * Room games: several per room, three kinds, and the join/request/watch rules.
 *
 * Usage:  node tests/games.js [baseUrl]
 * Needs a running local server:  npx wrangler dev --port 8787
 *
 * Every move is validated in the Durable Object, so most checks here are refusals as much as deliveries:
 * out-of-turn moves, a spectator moving, an occupied square, an impossible column, a Reversi move that
 * flips nothing, joining after the start, approving when you are not the host. It also covers the
 * multi-game rules (a room holds several games; one seat per person) and the budget rule - a burst of game
 * events must not spend the chat message window.
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
// Every game packet carries the whole list for the room, so a check is "the newest packet whose games
// contain what I am waiting for".
const newestGames = ws => [...ws.inbox].reverse().find(packet => packet.type === "game-state")?.games || null;
const gameById = (packet, id) => (packet?.games || []).find(game => game.id === id) || null;
const waitGame = (ws, id, predicate, ms = 6000) => waitFor(ws, packet => packet.type === "game-state" && predicate(gameById(packet, id)), ms);
const move = async (ws, id, payload, expectTurn) => {
  ws.inbox.length = 0;
  send(ws, { type: "game-move", gameId: id, ...payload });
  return waitFor(ws, packet => packet.type === "game-state" && (expectTurn === undefined || gameById(packet, id)?.turn === expectTurn));
};

async function main() {
  console.log(`\nroom games on ${BASE}`);

  const owner = await signup(`gm_owner_${stamp}`), peer = await signup(`gm_peer_${stamp}`), spare = await signup(`gm_spare_${stamp}`), fourth = await signup(`gm_four_${stamp}`);
  ok("four accounts sign up", [owner, peer, spare, fourth].every(account => account.status === 201), [owner, peer, spare, fourth].map(account => account.status).join("/"));

  const created = await post("/api/rooms", { name: `Games ${stamp}`, vibe: "Games test.", access: "open", theme: "ocean" }, owner.cookie);
  const room = (await created.json()).room;
  ok("an open room is created", created.status === 201 && Boolean(room?.id), `status ${created.status}`);

  const ownerSocket = socket(room.id, owner.cookie), peerSocket = socket(room.id, peer.cookie), spareSocket = socket(room.id, spare.cookie), fourthSocket = socket(room.id, fourth.cookie);
  for (const ws of [ownerSocket, peerSocket, spareSocket, fourthSocket]) { await open(ws); await waitFor(ws, packet => packet.type === "history"); }
  ok("a room with no game reports none on connect", !newestGames(ownerSocket));

  /* -------------------------------------------------- Connect Four: lobby */
  ownerSocket.inbox.length = 0; peerSocket.inbox.length = 0;
  send(ownerSocket, { type: "game-create", kind: "connect-four", policy: "open" });
  const createdFour = await waitFor(peerSocket, packet => packet.type === "game-state" && packet.games.length === 1);
  const four = createdFour.games[0];
  ok("starting a game seats the host and waits", four.status === "lobby" && four.players.length === 1 && four.players[0].id === owner.user.id, JSON.stringify(four.players));
  ok("the board arrives with its layout", four.layout?.type === "columns" && four.board.length === 42);

  send(spareSocket, { type: "game-watch", gameId: four.id });
  const watched = await waitGame(peerSocket, four.id, game => game.spectators === 1);
  ok("a member can watch without a seat", watched.games[0].spectators === 1 && watched.games[0].players.length === 1);

  peerSocket.inbox.length = 0;
  send(peerSocket, { type: "game-join", gameId: four.id });
  const started = await waitGame(peerSocket, four.id, game => game.status === "playing");
  ok("an open seat fills straight away and the game starts", gameById(started, four.id).players.length === 2);
  ok("the host moves first", gameById(started, four.id).turn === owner.user.id);

  /* ------------------------------------------------- refusals (Connect Four) */
  peerSocket.inbox.length = 0;
  send(peerSocket, { type: "game-move", gameId: four.id, column: 3 });
  const outOfTurn = await waitFor(peerSocket, packet => packet.type === "game-error");
  ok("a move out of turn is refused with a sentence", /not your turn/i.test(outOfTurn.message), outOfTurn.message);

  spareSocket.inbox.length = 0;
  send(spareSocket, { type: "game-move", gameId: four.id, column: 0 });
  ok("a spectator cannot move", /players can move/i.test((await waitFor(spareSocket, packet => packet.type === "game-error")).message));

  ownerSocket.inbox.length = 0;
  send(ownerSocket, { type: "game-move", gameId: four.id, column: 7 });
  ok("a column off the board is refused", /board/i.test((await waitFor(ownerSocket, packet => packet.type === "game-error")).message));

  spareSocket.inbox.length = 0;
  send(spareSocket, { type: "game-join", gameId: four.id });
  ok("joining a game that already started is refused", /started/i.test((await waitFor(spareSocket, packet => packet.type === "game-error")).message));

  /* -------------------------------------------------------- a Connect Four game */
  await move(ownerSocket, four.id, { column: 0 }, peer.user.id);
  await move(peerSocket, four.id, { column: 6 }, owner.user.id);
  await move(ownerSocket, four.id, { column: 0 }, peer.user.id);
  await move(peerSocket, four.id, { column: 6 }, owner.user.id);
  await move(ownerSocket, four.id, { column: 0 }, peer.user.id);
  await move(peerSocket, four.id, { column: 6 }, owner.user.id);
  ownerSocket.inbox.length = 0;
  send(ownerSocket, { type: "game-move", gameId: four.id, column: 0 });
  const finished = await waitGame(ownerSocket, four.id, game => game.status === "ended");
  const wonFour = gameById(finished, four.id);
  ok("four in a column ends the game", wonFour.reason === "four" && wonFour.winnerId === owner.user.id, JSON.stringify(wonFour.reason));
  ok("the winner's stack is on the board", [0, 1, 2, 3].every(row => wonFour.board[row] === 1), JSON.stringify(wonFour.board.slice(0, 6)));
  ok("the winner is credited a win", (wonFour.players.find(player => player.id === owner.user.id) || {}).score === 1);

  /* ------------------------------------- a second game in the same room (tic-tac-toe) */
  ownerSocket.inbox.length = 0;
  send(ownerSocket, { type: "game-create", kind: "tic-tac-toe", policy: "request" });
  const twoGames = await waitFor(ownerSocket, packet => packet.type === "game-state" && packet.games.length === 2);
  const tic = twoGames.games.find(game => game.kind === "tic-tac-toe");
  ok("a room can host a second game", Boolean(tic) && tic.layout.type === "grid" && tic.layout.size === 3 && tic.board.length === 9, JSON.stringify(twoGames.games.map(game => game.kind)));
  ok("the finished game is still listed", twoGames.games.some(game => game.id === four.id && game.status === "ended"));

  peerSocket.inbox.length = 0;
  send(peerSocket, { type: "game-request", gameId: tic.id });
  const pending = await waitGame(ownerSocket, tic.id, game => game.pending.length === 1);
  ok("a request waits for the host instead of taking the seat", gameById(pending, tic.id).players.length === 1);
  ok("the host is told who is asking", (await waitFor(ownerSocket, packet => packet.type === "game-request")).by?.id === peer.user.id);

  spareSocket.inbox.length = 0;
  send(spareSocket, { type: "game-approve", gameId: tic.id, userId: peer.user.id });
  ok("nobody but the host can approve", /host/i.test((await waitFor(spareSocket, packet => packet.type === "game-error")).message));

  ownerSocket.inbox.length = 0; peerSocket.inbox.length = 0;
  send(ownerSocket, { type: "game-approve", gameId: tic.id, userId: peer.user.id });
  ok("approval seats the requester and starts the game", gameById(await waitGame(peerSocket, tic.id, game => game.status === "playing"), tic.id).players.length === 2);

  // One seat per person: the host may not open a third game while this one is being played.
  ownerSocket.inbox.length = 0;
  send(ownerSocket, { type: "game-create", kind: "othello", policy: "open" });
  ok("you cannot start a second game while playing in this room", /playing in this room/i.test((await waitFor(ownerSocket, packet => packet.type === "game-error")).message));

  // Tic-tac-toe: the host takes a column of the 3x3 grid and wins.
  await move(ownerSocket, tic.id, { index: 0 }, peer.user.id);
  await move(peerSocket, tic.id, { index: 3 }, owner.user.id);
  await move(ownerSocket, tic.id, { index: 1 }, peer.user.id);
  await move(peerSocket, tic.id, { index: 4 }, owner.user.id);
  ownerSocket.inbox.length = 0;
  send(ownerSocket, { type: "game-move", gameId: tic.id, index: 0 });
  ok("an occupied square is refused", /taken/i.test((await waitFor(ownerSocket, packet => packet.type === "game-error")).message));
  ownerSocket.inbox.length = 0;
  send(ownerSocket, { type: "game-move", gameId: tic.id, index: 2 });
  const ticEnded = gameById(await waitGame(ownerSocket, tic.id, game => game.status === "ended"), tic.id);
  ok("a line of three ends tic-tac-toe", ticEnded.reason === "line" && ticEnded.winnerId === owner.user.id, ticEnded.reason);
  ok("the cells show the moves", [0, 1, 2].every(cell => ticEnded.board[cell] === 1), JSON.stringify(ticEnded.board));

  /* --------------------------------------------------------------- Reversi */
  ownerSocket.inbox.length = 0;
  send(ownerSocket, { type: "game-create", kind: "othello", policy: "open" });
  const othelloPacket = await waitFor(ownerSocket, packet => packet.type === "game-state" && packet.games.length === 3);
  const othello = othelloPacket.games.find(game => game.kind === "othello");
  ok("Reversi opens with the four-disc centre", othello.board.length === 64 && [27, 28, 35, 36].every(cell => othello.board[cell] !== 0), JSON.stringify(othello.board.filter(cell => cell !== 0).length));
  peerSocket.inbox.length = 0;
  send(peerSocket, { type: "game-join", gameId: othello.id });
  await waitGame(peerSocket, othello.id, game => game.status === "playing");

  ownerSocket.inbox.length = 0;
  send(ownerSocket, { type: "game-move", gameId: othello.id, index: 0 });
  ok("a Reversi move that flips nothing is refused", /flips nothing/i.test((await waitFor(ownerSocket, packet => packet.type === "game-error")).message));

  // d3 (row 2, column 3 of the 8x8 grid) is legal for black on the standard opening: it flips d4.
  const flipped = await move(ownerSocket, othello.id, { index: 19 }, peer.user.id);
  const afterFlip = gameById(flipped, othello.id);
  ok("a legal Reversi move flips the bracketed disc", Boolean(afterFlip) && afterFlip.board[19] === 1 && afterFlip.board[27] === 1, JSON.stringify({ games: flipped.games.map(game => `${game.kind}:${game.status}`), board19: afterFlip?.board[19], board27: afterFlip?.board[27] }));
  ok("the turn passes to the other player", afterFlip?.turn === peer.user.id);

  /* ---------------------------------------------------------- room list feed */
  const list = await (await get("/api/games", peer.cookie)).json();
  ok("the games feed lists every game in the room", (list.games || []).filter(game => game.roomId === room.id).length === 3, JSON.stringify((list.games || []).map(game => game.kind)));
  ok("the games feed is closed to signed-out visitors", (await get("/api/games")).status === 401);

  ownerSocket.inbox.length = 0;
  send(ownerSocket, { type: "game-sync" });
  const synced = await waitFor(ownerSocket, packet => packet.type === "game-state");
  ok("the dock can ask for every game in the room", (synced.games || []).length === 3, JSON.stringify((synced.games || []).map(game => game.kind)));

  const privateRoom = (await (await post("/api/rooms", { name: `Hidden ${stamp}`, vibe: "Private game.", access: "request", theme: "berry" }, owner.cookie)).json()).room;
  const privateSocket = socket(privateRoom.id, owner.cookie);
  await open(privateSocket);
  await waitFor(privateSocket, packet => packet.type === "history");
  privateSocket.inbox.length = 0;
  send(privateSocket, { type: "game-create", kind: "connect-four", policy: "open" });
  const hidden = await waitFor(privateSocket, packet => packet.type === "game-state" && packet.games.length === 1);
  const peerList = await (await get("/api/games", peer.cookie)).json();
  // Owner's rule: what a private room is playing is not visible from outside it.
  ok("a game in a private room is not advertised to outsiders", !(peerList.games || []).some(item => item.id === hidden.games[0].id));
  const ownerList = await (await get("/api/games", owner.cookie)).json();
  ok("but the room's own members see it", (ownerList.games || []).some(item => item.id === hidden.games[0].id));

  /* ------------------------------------------------------------- the cap */
  // This room already holds three games (two finished, one being played). A fourth is allowed, a fifth is
  // not - spare and fourth are not playing anything, so neither is blocked by the one-seat rule.
  ownerSocket.inbox.length = 0;
  send(spareSocket, { type: "game-create", kind: "tic-tac-toe", policy: "open" });
  const fourGames = await waitFor(ownerSocket, packet => packet.type === "game-state" && packet.games.length === 4);
  ok("a fourth game fits in the room", fourGames.games.length === 4, JSON.stringify(fourGames.games.map(game => game.kind)));
  fourthSocket.inbox.length = 0;
  send(fourthSocket, { type: "game-create", kind: "connect-four", policy: "open" });
  const capped = await waitFor(fourthSocket, packet => packet.type === "game-error");
  ok("a room is capped at four games", /4 games/i.test(capped.message), capped.message);

  /* -------------------------------------------------------------- budgets */
  for (let index = 0; index < 25; index++) send(ownerSocket, { type: "game-sync" });
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
