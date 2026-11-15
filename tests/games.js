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
// A socket that is already open has fired its "open" event before a listener could attach, which hangs the
// wait forever - so the state is checked first.
const open = ws => ws.readyState === WebSocket.OPEN ? Promise.resolve() : new Promise((resolve, reject) => {
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
  const ticOpen = gameById(await waitGame(peerSocket, tic.id, game => game.status === "playing"), tic.id);
  ok("approval seats the requester and starts the game", ticOpen.players.length === 2);
  ok("the object lists every free square for the side to move", ticOpen.moves.length === 9 && ticOpen.moves[0] === 0, JSON.stringify(ticOpen.moves));

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

  /* ------------------------------------------------------------- rematch */
  ownerSocket.inbox.length = 0;
  send(ownerSocket, { type: "game-restart", gameId: tic.id });
  const restarted = gameById(await waitGame(ownerSocket, tic.id, game => game.status === "playing"), tic.id);
  ok("the host can rematch a finished game", restarted.board.every(cell => cell === 0) && restarted.winnerId === null && restarted.players.length === 2, JSON.stringify(restarted.board));
  ok("the rematch alternates the opening seat", restarted.turn === peer.user.id, restarted.turn);

  // A rematch only ever follows a result, for the host as much as for the other player: a board still in play
  // has no winner to declare, so it is ended first.
  peerSocket.inbox.length = 0;
  send(peerSocket, { type: "game-restart", gameId: tic.id });
  ok("a board still in play cannot be restarted", /running/i.test((await waitFor(peerSocket, packet => packet.type === "game-error")).message));

  ownerSocket.inbox.length = 0;
  send(ownerSocket, { type: "game-restart", gameId: tic.id });
  ok("not even the host restarts a board still in play", /running/i.test((await waitFor(ownerSocket, packet => packet.type === "game-error")).message));

  peerSocket.inbox.length = 0;
  send(peerSocket, { type: "game-end", gameId: tic.id });
  ok("a player cannot end a running game", /host/i.test((await waitFor(peerSocket, packet => packet.type === "game-error")).message));

  ownerSocket.inbox.length = 0;
  send(ownerSocket, { type: "game-end", gameId: tic.id });
  ok("the host can end a running game", gameById(await waitGame(ownerSocket, tic.id, game => game.status === "ended"), tic.id).winnerId === null);

  // The player who is not the host asks for the rematch: being the host must not be the price of playing again.
  peerSocket.inbox.length = 0;
  send(peerSocket, { type: "game-restart", gameId: tic.id });
  const replay = gameById(await waitGame(peerSocket, tic.id, game => game.status === "playing"), tic.id);
  ok("the other player can rematch a finished game", replay.board.every(cell => cell === 0) && replay.players.length === 2 && replay.winnerId === null);
  ok("and the opening seat goes back to the first player", replay.turn === owner.user.id, replay.turn);

  ownerSocket.inbox.length = 0;
  send(ownerSocket, { type: "game-end", gameId: tic.id });
  await waitGame(ownerSocket, tic.id, game => game.status === "ended");

  // The other player clears the finished board: an absent host must not be the only one who can tidy up.
  peerSocket.inbox.length = 0;
  send(peerSocket, { type: "game-end", gameId: tic.id });
  const cleared = await waitFor(peerSocket, packet => packet.type === "game-state" && !gameById(packet, tic.id));
  ok("a player can clear a finished game without the host", Boolean(cleared));

  /* --------------------------------------------------------------- Reversi */
  ownerSocket.inbox.length = 0;
  send(ownerSocket, { type: "game-create", kind: "othello", policy: "open" });
  const othelloPacket = await waitFor(ownerSocket, packet => packet.type === "game-state" && packet.games.length === 2);
  const othello = othelloPacket.games.find(game => game.kind === "othello");
  ok("Reversi opens with the four-disc centre", othello.board.length === 64 && [27, 28, 35, 36].every(cell => othello.board[cell] !== 0), JSON.stringify(othello.board.filter(cell => cell !== 0).length));
  // Watching a board and then taking its seat must not leave the account counted as a spectator as well.
  ownerSocket.inbox.length = 0;
  send(peerSocket, { type: "game-watch", gameId: othello.id });
  await waitGame(ownerSocket, othello.id, game => game.spectators === 1);
  peerSocket.inbox.length = 0;
  send(peerSocket, { type: "game-join", gameId: othello.id });
  const othelloOpen = gameById(await waitGame(peerSocket, othello.id, game => game.status === "playing"), othello.id);
  ok("taking a seat stops counting you as a spectator", othelloOpen.spectators === 0, String(othelloOpen.spectators));
  ok("the object lists the four legal Reversi openings", JSON.stringify(othelloOpen.moves) === JSON.stringify([19, 26, 37, 44]), JSON.stringify(othelloOpen.moves));

  ownerSocket.inbox.length = 0;
  send(ownerSocket, { type: "game-move", gameId: othello.id, index: 0 });
  ok("a Reversi move that flips nothing is refused", /flips nothing/i.test((await waitFor(ownerSocket, packet => packet.type === "game-error")).message));

  // d3 (row 2, column 3 of the 8x8 grid) is legal for black on the standard opening: it flips d4.
  const flipped = await move(ownerSocket, othello.id, { index: 19 }, peer.user.id);
  const afterFlip = gameById(flipped, othello.id);
  ok("a legal Reversi move flips the bracketed disc", Boolean(afterFlip) && afterFlip.board[19] === 1 && afterFlip.board[27] === 1, JSON.stringify({ games: flipped.games.map(game => `${game.kind}:${game.status}`), board19: afterFlip?.board[19], board27: afterFlip?.board[27] }));
  ok("the turn passes to the other player", afterFlip?.turn === peer.user.id);
  ok("the legal moves follow the turn", afterFlip.moves.length > 0 && afterFlip.moves.every(cell => afterFlip.board[cell] === 0), JSON.stringify(afterFlip.moves));

  /* ---------------------------------------------------------- room list feed */
  ownerSocket.inbox.length = 0;
  send(ownerSocket, { type: "game-sync" });
  const synced = await waitFor(ownerSocket, packet => packet.type === "game-state");
  const list = await (await get("/api/games", peer.cookie)).json();
  const feedGames = (list.games || []).filter(game => game.roomId === room.id);
  const openInRoom = (synced.games || []).filter(game => game.status !== "ended");
  ok("the games feed lists every game still open in the room", feedGames.length === openInRoom.length && feedGames.every(game => game.status !== "ended"), `${feedGames.length}/${openInRoom.length}`);
  ok("a finished board is left out of the feed", feedGames.length < (synced.games || []).length, `${feedGames.length}/${(synced.games || []).length}`);
  ok("the games feed is closed to signed-out visitors", (await get("/api/games")).status === 401);
  ok("the dock can ask for every game in the room, finished ones included", (synced.games || []).length === feedGames.length + 1, JSON.stringify((synced.games || []).map(game => `${game.kind}:${game.status}`)));

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
  // A slot belongs to a game still being played. Finish the Reversi board, then have all four accounts open a
  // lobby: four running games, and the next create must be refused. The cap is checked before the one-seat
  // rule, so the refusal is about the room rather than the player.
  ownerSocket.inbox.length = 0;
  send(ownerSocket, { type: "game-end", gameId: othello.id });
  const othelloEnded = gameById(await waitGame(ownerSocket, othello.id, game => game.status === "ended"), othello.id);
  ok("a finished board offers no moves", othelloEnded.moves.length === 0, JSON.stringify(othelloEnded.moves));

  for (const ws of [ownerSocket, peerSocket, spareSocket, fourthSocket]) {
    send(ws, { type: "game-create", kind: "tic-tac-toe", policy: "open" });
    await sleep(400);
  }
  ownerSocket.inbox.length = 0;
  send(ownerSocket, { type: "game-create", kind: "connect-four", policy: "open" });
  const capped = await waitFor(ownerSocket, packet => packet.type === "game-error");
  ok("a room is capped at four games still running", /4 games/i.test(capped.message), capped.message);

  // Now the point of the rule: finish one of those lobbies and its slot comes back, even though the room still
  // holds finished boards - the exact state that used to leave a player with no way to start anything.
  spareSocket.inbox.length = 0;
  send(spareSocket, { type: "game-sync" });
  const spareGames = (await waitFor(spareSocket, packet => packet.type === "game-state")).games;
  const spareLobby = spareGames.find(game => game.hostId === spare.user.id && game.status !== "ended");
  ok("the room holds four lobbies plus the finished boards", spareGames.filter(game => game.status === "lobby").length === 4 && spareGames.some(game => game.status === "ended"), JSON.stringify(spareGames.map(game => `${game.kind}:${game.status}`)));
  send(spareSocket, { type: "game-end", gameId: spareLobby.id });
  await waitGame(spareSocket, spareLobby.id, game => game.status === "ended");
  spareSocket.inbox.length = 0;
  send(spareSocket, { type: "game-create", kind: "connect-four", policy: "open" });
  const reopened = await waitFor(spareSocket, packet => packet.type === "game-state" && packet.games.some(game => game.hostId === spare.user.id && game.kind === "connect-four" && game.status === "lobby"), 4000).catch(() => null);
  ok("a finished board frees its slot, so a full room still takes a new game", Boolean(reopened));
  const endedKept = (reopened ? reopened.games : []).filter(game => game.status === "ended");
  ok("only the newest finished boards are kept", endedKept.length <= 2, `${endedKept.length} kept`);

  /* ------------------------------------------------------ an abandoned seat */
  // A host who walks away must not strand the room: after the grace period the player who stayed wins, takes
  // the host role, and can both start something else and play the finished board again. The grace is 1500 ms
  // in this suite (AWAY_GRACE_MS).
  const awayRoom = (await (await post("/api/rooms", { name: `Away ${stamp}`, vibe: "abandon", access: "open", theme: "ocean" }, owner.cookie)).json()).room;
  const leaverSocket = socket(awayRoom.id, owner.cookie), stayerSocket = socket(awayRoom.id, peer.cookie);
  for (const ws of [leaverSocket, stayerSocket]) { await open(ws); await waitFor(ws, packet => packet.type === "history"); }
  leaverSocket.inbox.length = 0;
  send(leaverSocket, { type: "game-create", kind: "tic-tac-toe", policy: "open" });
  const awayGame = (await waitFor(leaverSocket, packet => packet.type === "game-state" && packet.games.length === 1)).games[0];
  send(stayerSocket, { type: "game-join", gameId: awayGame.id });
  await waitGame(stayerSocket, awayGame.id, game => game.status === "playing");
  stayerSocket.inbox.length = 0;
  leaverSocket.close();
  await sleep(2200);
  ok("the player who stayed is told they now run the board", stayerSocket.inbox.some(packet => packet.type === "game-host" && packet.gameId === awayGame.id));
  stayerSocket.inbox.length = 0;
  send(stayerSocket, { type: "game-sync" });
  const afterAway = await waitFor(stayerSocket, packet => packet.type === "game-state");
  const resolved = gameById(afterAway, awayGame.id);
  ok("a host who closes the tab hands the game to the player who stayed", resolved?.status === "ended" && resolved.winnerId === peer.user.id && resolved.reason === "left", JSON.stringify({ status: resolved?.status, reason: resolved?.reason, winner: resolved?.winnerId === peer.user.id }));
  ok("and the host role moves to the player who stayed", resolved?.hostId === peer.user.id, resolved?.hostId);
  stayerSocket.inbox.length = 0;
  send(stayerSocket, { type: "game-create", kind: "connect-four", policy: "open" });
  const freeAgain = await waitFor(stayerSocket, packet => packet.type === "game-state" && packet.games.some(game => game.kind === "connect-four" && game.status === "lobby"), 4000).catch(() => null);
  ok("and the staying player can start another game straight away", Boolean(freeAgain));
  // The finished board is still theirs to replay, and the seat of the player who left must not be restarted
  // as a ghost: the board reopens in the lobby for whoever joins next.
  stayerSocket.inbox.length = 0;
  send(stayerSocket, { type: "game-restart", gameId: awayGame.id });
  const revived = await waitFor(stayerSocket, packet => packet.type === "game-state" && gameById(packet, awayGame.id)?.status === "lobby", 4000).catch(() => null);
  const revivedGame = revived ? gameById(revived, awayGame.id) : null;
  ok("the stranded player can replay it, without the absent seat", Boolean(revivedGame) && revivedGame.players.length === 1 && revivedGame.players[0].id === peer.user.id, JSON.stringify(revivedGame?.players));
  ok("the empty seat is open to a new player", revivedGame?.hostId === peer.user.id && revivedGame?.status === "lobby", JSON.stringify({ host: revivedGame?.hostId === peer.user.id, status: revivedGame?.status }));

  // A board nobody is sitting at any more clears itself: end the one the stayer created, so the room holds a
  // finished result whose only player is about to close their tab.
  const spareBoard = (freeAgain?.games || []).find(game => game.kind === "connect-four" && game.status === "lobby" && game.hostId === peer.user.id);
  ok("the staying player's new board is theirs to end", Boolean(spareBoard), JSON.stringify((freeAgain?.games || []).map(game => `${game.kind}:${game.status}`)));
  if (spareBoard) {
    stayerSocket.inbox.length = 0;
    send(stayerSocket, { type: "game-end", gameId: spareBoard.id });
    await waitGame(stayerSocket, spareBoard.id, game => game.status === "ended").catch(() => null);
  }
  stayerSocket.close();
  await sleep(2200);
  const witnessSocket = socket(awayRoom.id, fourth.cookie);
  await open(witnessSocket);
  await waitFor(witnessSocket, packet => packet.type === "history");
  witnessSocket.inbox.length = 0;
  send(witnessSocket, { type: "game-sync" });
  const emptied = await waitFor(witnessSocket, packet => packet.type === "game-state");
  ok("every board its players left clears itself", (emptied.games || []).length === 0, JSON.stringify((emptied.games || []).map(game => `${game.kind}:${game.status}`)));
  witnessSocket.close();

  /* -------------------------------------------------------------- budgets */
  for (let index = 0; index < 25; index++) send(ownerSocket, { type: "game-sync" });
  await sleep(400);
  ownerSocket.inbox.length = 0;
  send(ownerSocket, { type: "message", kind: "text", content: "still typing after all that" });
  const echoed = await waitFor(ownerSocket, packet => packet.type === "message" && packet.message.content === "still typing after all that", 4000).catch(() => null);
  ok("a burst of game events does not spend the chat message window", Boolean(echoed));

  /* ------------------------------------------------------------- teardown */
  for (const ws of [ownerSocket, peerSocket, spareSocket, fourthSocket, privateSocket]) ws.close();
  await fetch(`${BASE}/api/rooms/${room.id}`, { method: "DELETE", headers: { Origin: ORIGIN, Cookie: owner.cookie } });
  await fetch(`${BASE}/api/rooms/${privateRoom.id}`, { method: "DELETE", headers: { Origin: ORIGIN, Cookie: owner.cookie } });
  await fetch(`${BASE}/api/rooms/${awayRoom.id}`, { method: "DELETE", headers: { Origin: ORIGIN, Cookie: owner.cookie } });

  console.log(`\n${failed === 0 ? "ALL GOOD" : "FAILURES"} - ${passed} passed, ${failed} failed  (accounts: gm_*_${stamp})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => { console.error(`\ngames test crashed: ${error instanceof Error ? error.message : error}`); process.exit(1); });
