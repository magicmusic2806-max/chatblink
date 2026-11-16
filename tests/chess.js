/**
 * Chess: the rules that live on the server.
 *
 * Usage:  node tests/chess.js [baseUrl]
 * Needs a running local server:  npx wrangler dev --port 8795 --var CHESS_CLOCK_MS:4000
 * (tests/run-all.js starts it with that clock so a flag can fall in seconds.)
 *
 * Chess delegates move generation, castling, en passant, promotion, mate, stalemate and the threefold/50-move
 * draws to chess.js, so what is worth testing here is the wiring around it: the position the panel is given,
 * the refusals, promotion needing a piece, the clock ending a game on its own, resigning, agreeing a draw, and
 * colours swapping on a rematch. Every move is awaited by its *result* - waiting for any game-state packet can
 * resolve on the opponent's earlier move and let the next send race ahead of the board.
 */
const WebSocket = require("ws");

const BASE = (process.argv[2] || "http://127.0.0.1:8795").replace(/\/$/, "");
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
  headers: { "Content-Type": "application/json", Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body),
  redirect: "manual"
});
const signup = async username => {
  const response = await post("/api/auth/signup", { username, age: 24, adultConfirmed: true });
  return { status: response.status, cookie: cookieOf(response), user: (await response.json()).user };
};
function socket(room, cookie) {
  const ws = new WebSocket(`${WS_BASE}/?room=${encodeURIComponent(room)}`, { headers: { Origin: ORIGIN, Cookie: cookie } });
  ws.inbox = [];
  ws.setMaxListeners(0);
  ws.on("message", raw => { try { ws.inbox.push(JSON.parse(raw)); } catch {} });
  return ws;
}
const waitFor = (ws, predicate, ms = 8000) => new Promise((resolve, reject) => {
  const found = ws.inbox.find(predicate);
  if (found) return resolve(found);
  const timer = setTimeout(() => { cleanup(); reject(new Error("timeout waiting for socket event")); }, ms);
  const onMessage = () => { const hit = ws.inbox.find(predicate); if (hit) { cleanup(); resolve(hit); } };
  const cleanup = () => { clearTimeout(timer); ws.off("message", onMessage); };
  ws.on("message", onMessage);
  ws.once("error", error => { cleanup(); reject(error); });
});
const open = ws => ws.readyState === WebSocket.OPEN ? Promise.resolve() : new Promise((resolve, reject) => {
  ws.once("open", resolve);
  ws.once("error", reject);
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const send = (ws, event) => ws.send(JSON.stringify(event));
const newestGames = ws => [...ws.inbox].reverse().find(packet => packet.type === "game-state")?.games || [];
const gameById = (packet, id) => (packet?.games || []).find(game => game.id === id) || null;
const waitGame = (ws, id, predicate, ms = 8000) => waitFor(ws, packet => packet.type === "game-state" && predicate(gameById(packet, id)), ms);
// A move is proven by its result: the turn passing to the expected player, or the game ending.
async function apply(ws, id, from, to, predicate, promotion) {
  ws.inbox.length = 0;
  send(ws, { type: "game-move", gameId: id, from, to, ...(promotion ? { promotion } : {}) });
  return waitFor(ws, packet => packet.type === "game-error" || (packet.type === "game-state" && predicate(gameById(packet, id))));
}
const turnIs = expected => game => game?.turn === expected;
const ended = game => game?.status === "ended";

async function startGame(white, black) {
  white.inbox.length = 0;
  send(white, { type: "game-create", kind: "chess", policy: "open" });
  const created = await waitFor(white, packet => packet.type === "game-state" && packet.games.length === 1);
  const game = created.games[0];
  black.inbox.length = 0;
  send(black, { type: "game-join", gameId: game.id });
  const started = await waitFor(black, packet => packet.type === "game-state" && gameById(packet, game.id)?.status === "playing");
  return { game, view: gameById(started, game.id) };
}
// A finished board has to be cleared before the same two accounts can sit down again: one seat per person per
// room, and the cap counts the games still running.
async function clear(host, id) {
  host.inbox.length = 0;
  send(host, { type: "game-end", gameId: id });
  await waitFor(host, packet => packet.type === "game-state" && !gameById(packet, id)).catch(() => null);
  await sleep(120);
}

async function main() {
  console.log(`\nchess on ${BASE}`);
  const white = await signup(`ch_white_${stamp}`), black = await signup(`ch_black_${stamp}`);
  ok("two accounts sign up", white.status === 201 && black.status === 201, `${white.status}/${black.status}`);
  const created = await post("/api/rooms", { name: `Chess ${stamp}`, vibe: "Chess rules.", access: "open", theme: "ocean" }, white.cookie);
  const room = (await created.json()).room;
  ok("an open room is created", created.status === 201 && Boolean(room?.id), `status ${created.status}`);

  const whiteSocket = socket(room.id, white.cookie), blackSocket = socket(room.id, black.cookie);
  for (const ws of [whiteSocket, blackSocket]) { await open(ws); await waitFor(ws, packet => packet.type === "history"); }

  /* ---------------------------------------------------------------- the position the panel is given */
  let { game, view } = await startGame(whiteSocket, blackSocket);
  ok("a chess game seats both players and starts", view.status === "playing" && view.players.length === 2);
  ok("the board arrives as 64 squares in reading order", view.board.length === 64 && view.board[0] === "bR" && view.board[63] === "wR", JSON.stringify(view.board.slice(0, 4)));
  ok("the back ranks are in their standard order", view.board.slice(0, 8).join(",") === "bR,bN,bB,bQ,bK,bB,bN,bR" && view.board.slice(56, 64).join(",") === "wR,wN,wB,wQ,wK,wB,wN,wR", view.board.slice(56, 64).join(","));
  ok("white has the twenty legal opening moves", view.moves.length === 20, String(view.moves.length));
  ok("white moves first", view.turn === white.user.id);
  ok("both clocks start at the configured allowance", view.clock?.[white.user.id] > 0 && view.clock?.[black.user.id] > 0, JSON.stringify(view.clock));

  /* ---------------------------------------------------------------- refusals */
  blackSocket.inbox.length = 0;
  send(blackSocket, { type: "game-move", gameId: game.id, from: "e7", to: "e5" });
  ok("black cannot move first", /not your turn/i.test((await waitFor(blackSocket, packet => packet.type === "game-error")).message));

  whiteSocket.inbox.length = 0;
  send(whiteSocket, { type: "game-move", gameId: game.id, from: "e2", to: "e5" });
  ok("an illegal pawn jump is refused", /not legal/i.test((await waitFor(whiteSocket, packet => packet.type === "game-error")).message));

  whiteSocket.inbox.length = 0;
  send(whiteSocket, { type: "game-move", gameId: game.id, from: "zz", to: "e4" });
  ok("a square off the board is refused", /not on the board/i.test((await waitFor(whiteSocket, packet => packet.type === "game-error")).message));

  // A spectator cannot move anything, and cannot be created by watching.
  whiteSocket.inbox.length = 0;
  send(blackSocket, { type: "game-watch", gameId: game.id });
  await waitFor(blackSocket, packet => packet.type === "game-state").catch(() => null);

  /* ---------------------------------------------------------------- an opening, then castling */
  const first = await apply(whiteSocket, game.id, "e2", "e4", turnIs(black.user.id));
  ok("white's first move applies and passes the turn", first.type === "game-state");
  await apply(blackSocket, game.id, "e7", "e5", turnIs(white.user.id));
  await apply(whiteSocket, game.id, "g1", "f3", turnIs(black.user.id));
  await apply(blackSocket, game.id, "b8", "c6", turnIs(white.user.id));
  await apply(whiteSocket, game.id, "f1", "c4", turnIs(black.user.id));
  await apply(blackSocket, game.id, "g8", "f6", turnIs(white.user.id));
  const castled = await apply(whiteSocket, game.id, "e1", "g1", turnIs(black.user.id));
  const afterCastle = gameById(castled, game.id);
  ok("kingside castling moves the king and the rook together", afterCastle.board[62] === "wK" && afterCastle.board[61] === "wR", `g1=${afterCastle.board[62]} f1=${afterCastle.board[61]}`);
  ok("the last move is reported for the panel to mark", afterCastle.last?.from === "e1" && afterCastle.last?.to === "g1", JSON.stringify(afterCastle.last));

  /* ---------------------------------------------------------------- draw offer and agreement */
  whiteSocket.inbox.length = 0;
  send(whiteSocket, { type: "game-offer-draw", gameId: game.id });
  ok("a draw offer reaches the board", gameById(await waitFor(whiteSocket, packet => packet.type === "game-state" && gameById(packet, game.id)?.drawOffer), game.id).drawOffer === white.user.id);
  blackSocket.inbox.length = 0;
  send(blackSocket, { type: "game-accept-draw", gameId: game.id });
  const agreed = gameById(await waitFor(blackSocket, packet => packet.type === "game-state" && ended(gameById(packet, game.id))), game.id);
  ok("accepting the offer ends the game as a draw", agreed.reason === "agreed" && agreed.winnerId === null, `${agreed.reason}/${agreed.winnerId}`);
  await clear(whiteSocket, game.id);

  /* ---------------------------------------------------------------- resign */
  ({ game, view } = await startGame(whiteSocket, blackSocket));
  blackSocket.inbox.length = 0;
  send(blackSocket, { type: "game-resign", gameId: game.id });
  const resigned = gameById(await waitFor(blackSocket, packet => packet.type === "game-state" && ended(gameById(packet, game.id))), game.id);
  ok("resigning hands the game to the opponent", resigned.winnerId === white.user.id && resigned.reason === "resign", `${resigned.winnerId}/${resigned.reason}`);

  /* ---------------------------------------------------------------- promotion */
  whiteSocket.inbox.length = 0;
  send(whiteSocket, { type: "game-restart", gameId: game.id });
  const restarted = await waitFor(whiteSocket, packet => packet.type === "game-state" && gameById(packet, game.id)?.status === "playing");
  const rematch = gameById(restarted, game.id);
  ok("a rematch swaps colours so black moves first", rematch.players[0].id === black.user.id && rematch.turn === black.user.id, `${rematch.players[0].id === black.user.id}/${rematch.turn === black.user.id}`);
  ok("the rematch starts from the opening position with a fresh clock", rematch.board[0] === "bR" && rematch.clock[black.user.id] > 0);
  await clear(whiteSocket, game.id);

  // Promotion needs a walk to the eighth rank. Black hands over a knight and keeps g7/h8 in place, so white can
  // capture its way to h8: e5xf6, f6xg7, g7xh8.
  ({ game } = await startGame(whiteSocket, blackSocket));
  await apply(whiteSocket, game.id, "e2", "e4", turnIs(black.user.id));
  await apply(blackSocket, game.id, "g8", "f6", turnIs(white.user.id));
  await apply(whiteSocket, game.id, "e4", "e5", turnIs(black.user.id));
  await apply(blackSocket, game.id, "a7", "a6", turnIs(white.user.id));
  await apply(whiteSocket, game.id, "e5", "f6", turnIs(black.user.id));
  await apply(blackSocket, game.id, "a6", "a5", turnIs(white.user.id));
  await apply(whiteSocket, game.id, "f6", "g7", turnIs(black.user.id));
  await apply(blackSocket, game.id, "a5", "a4", turnIs(white.user.id));
  whiteSocket.inbox.length = 0;
  send(whiteSocket, { type: "game-move", gameId: game.id, from: "g7", to: "h8" });
  const needsPiece = await waitFor(whiteSocket, packet => packet.type === "game-error");
  ok("a promotion move without a piece is refused", /not legal/i.test(needsPiece.message), needsPiece.message);

  whiteSocket.inbox.length = 0;
  send(whiteSocket, { type: "game-move", gameId: game.id, from: "g7", to: "h8", promotion: "n" });
  // h8 is the last file of the top row: index 7, not 63 (which is h1).
  const promoted = gameById(await waitFor(whiteSocket, packet => packet.type === "game-state" && gameById(packet, game.id)?.board[7] === "wN"), game.id);
  ok("a promoting move lands the piece that was asked for", promoted?.board[7] === "wN", JSON.stringify(promoted?.board?.slice(0, 8)));
  await clear(whiteSocket, game.id);

  /* ---------------------------------------------------------------- a clock that runs out */
  ({ game } = await startGame(whiteSocket, blackSocket));
  // CHESS_CLOCK_MS is 4000 for this suite and nobody moves: the object's own alarm has to end it.
  await sleep(5400);
  whiteSocket.inbox.length = 0;
  send(whiteSocket, { type: "game-sync" });
  const flagged = gameById(await waitFor(whiteSocket, packet => packet.type === "game-state"), game.id);
  ok("a clock that runs out ends the game without a click", flagged?.status === "ended" && flagged?.reason === "time", `${flagged?.status}/${flagged?.reason}`);
  ok("the player who flagged loses on time", flagged?.winnerId === black.user.id, flagged?.winnerId);
  await clear(whiteSocket, game.id);

  /* ---------------------------------------------------------------- mate */
  ({ game } = await startGame(whiteSocket, blackSocket));
  await apply(whiteSocket, game.id, "f2", "f3", turnIs(black.user.id));
  await apply(blackSocket, game.id, "e7", "e5", turnIs(white.user.id));
  await apply(whiteSocket, game.id, "g2", "g4", turnIs(black.user.id));
  const mated = gameById(await apply(blackSocket, game.id, "d8", "h4", ended), game.id);
  ok("fool's mate is detected as checkmate", mated.reason === "checkmate" && mated.winnerId === black.user.id, `${mated.reason}/${mated.winnerId}`);
  ok("the mate is not also offered back to the loser as a tie", mated.reason !== "draw");
  await clear(whiteSocket, game.id);

  /* ---------------------------------------------------------------- the clock the host chooses */
  // The create form offers 5, 20, 40 minutes or no clock, and the object has to take the game's own allowance
  // rather than a default: a 20-minute game and a game with no clock at all both have to play.
  const startWith = async minutes => {
    whiteSocket.inbox.length = 0;
    send(whiteSocket, { type: "game-create", kind: "chess", policy: "open", minutes });
    const made = (await waitFor(whiteSocket, packet => packet.type === "game-state" && packet.games.length === 1)).games[0];
    blackSocket.inbox.length = 0;
    send(blackSocket, { type: "game-join", gameId: made.id });
    const running = gameById(await waitFor(blackSocket, packet => packet.type === "game-state" && gameById(packet, made.id)?.status === "playing"), made.id);
    return { id: made.id, view: running };
  };
  const ten = await startWith(10);
  ok("a 10-minute game carries ten minutes each", ten.view.clockMs === 600000 && ten.view.clock?.[black.user.id] === 600000, JSON.stringify(ten.view.clock));
  await clear(whiteSocket, ten.id);

  const twenty = await startWith(20);
  // The side to move is already a millisecond or two into its clock by the time the packet arrives, so the check is
  // "twenty minutes, minus at most a second" rather than an exact equality.
  const twentyWhite = twenty.view.clock?.[white.user.id], twentyBlack = twenty.view.clock?.[black.user.id];
  ok("a 20-minute game carries twenty minutes each", twenty.view.clockMs === 1200000 && twentyWhite > 1199000 && twentyWhite <= 1200000 && twentyBlack === 1200000, JSON.stringify(twenty.view.clock));
  await clear(whiteSocket, twenty.id);

  const untimed = await startWith(0);
  ok("a game created with no clock has no clock", untimed.view.clock === null && untimed.view.clockMs === 0, JSON.stringify(untimed.view.clock));
  const moved = gameById(await apply(whiteSocket, untimed.id, "e2", "e4", turnIs(black.user.id)), untimed.id);
  ok("a game with no clock still plays, and its clock never appears", moved.status === "playing" && moved.clock === null, `${moved.status}/${JSON.stringify(moved.clock)}`);
  await clear(whiteSocket, untimed.id);

  const odd = await startWith(5);
  ok("five minutes is no longer offered, so it falls back to the room default", odd.view.clockMs === 4000, JSON.stringify(odd.view.clockMs));
  await clear(whiteSocket, odd.id);

  whiteSocket.close(); blackSocket.close();
  await fetch(`${BASE}/api/rooms/${room.id}`, { method: "DELETE", headers: { Origin: ORIGIN, Cookie: white.cookie } });
  console.log(`\n${failed === 0 ? "ALL GOOD" : "FAILURES"} - ${passed} passed, ${failed} failed  (room: ${room.id})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => { console.error(`\nchess suite crashed: ${error instanceof Error ? error.message : error}`); process.exit(1); });
