/**
 * Draw & Guess: seats, turns, secrets, scoring and the clock.
 *
 * Usage:  node tests/draw.js [baseUrl]
 * Needs a running local server:  npx wrangler dev --port 8797 --var DRAW_SECONDS:20 --var DRAW_REVEAL_MS:400 --var DRAW_CHOOSE_MS:2000
 * (tests/run-all.js starts it that way, so a whole three-round game fits in a few seconds.)
 *
 * The rules this suite exists for: a game of two to eight seats gathers in its lobby until the host starts it (the
 * second person to arrive used to start a two-player round for everybody), the drawer's word never travels in the
 * broadcast state and reaches the drawer even when the object picks it for them, a stroke travels as one stroke
 * rather than as the whole drawing, a guess is checked before it can reach the transcript, a correct guess scores
 * the guesser and the drawer, guests score on their own list, the turn ends when everyone has guessed, one player
 * leaving a bigger game does not end it, and the next drawer takes over after the reveal.
 */
const WebSocket = require("ws");

const BASE = (process.argv[2] || "http://127.0.0.1:8797").replace(/\/$/, "");
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
const gameById = (packet, id) => (packet?.games || []).find(game => game.id === id) || null;
const waitGame = (ws, id, predicate, ms = 8000) => waitFor(ws, packet => packet.type === "game-state" && predicate(gameById(packet, id)), ms);
const waitStroke = (ws, id, count, ms = 8000) => waitFor(ws, packet => packet.type === "game-stroke" && packet.gameId === id && packet.seq === count, ms);

async function main() {
  console.log(`\ndraw & guess on ${BASE}`);
  const alice = await signup(`dg_alice_${stamp}`), bob = await signup(`dg_bob_${stamp}`);
  const cara = await signup(`dg_cara_${stamp}`), dave = await signup(`dg_dave_${stamp}`);
  ok("four accounts sign up", [alice, bob, cara, dave].every(account => account.status === 201));
  const created = await post("/api/rooms", { name: `Draw ${stamp}`, vibe: "Drawing.", access: "open", theme: "ocean" }, alice.cookie);
  const room = (await created.json()).room;
  ok("an open room is created", created.status === 201 && Boolean(room?.id), `status ${created.status}`);

  const aSocket = socket(room.id, alice.cookie), bSocket = socket(room.id, bob.cookie);
  const cSocket = socket(room.id, cara.cookie), dSocket = socket(room.id, dave.cookie);
  for (const ws of [aSocket, bSocket, cSocket, dSocket]) { await open(ws); await waitFor(ws, packet => packet.type === "history"); }

  /* ------------------------------------------------------------ seats, and the lobby that waits for the host */
  aSocket.inbox.length = 0;
  send(aSocket, { type: "game-create", kind: "draw-guess", policy: "open" });
  const createdGame = await waitFor(aSocket, packet => packet.type === "game-state" && packet.games.length === 1);
  const game = createdGame.games[0];
  ok("Draw & Guess seats up to eight players", game.seats === 8 && game.minSeats === 2, `${game.seats}/${game.minSeats}`);
  ok("one player is not enough to start it", game.status === "lobby", game.status);

  bSocket.inbox.length = 0;
  send(bSocket, { type: "game-join", gameId: game.id });
  const twoSeated = gameById(await waitGame(bSocket, game.id, view => view?.players.length === 2), game.id);
  ok("two players fill a two-seat game but not this one", twoSeated.status === "lobby", twoSeated.status);

  // The third seat is real: the game used to start the moment a second player arrived, so a third was always told
  // it had already started and Draw & Guess was a two-player game wearing an eight-seat label.
  cSocket.inbox.length = 0;
  send(cSocket, { type: "game-join", gameId: game.id });
  const threeSeated = gameById(await waitGame(cSocket, game.id, view => view?.players.length === 3), game.id);
  ok("a third player takes the third seat", threeSeated.players.length === 3 && threeSeated.status === "lobby", `${threeSeated.players.length} ${threeSeated.status}`);

  cSocket.inbox.length = 0;
  send(cSocket, { type: "game-start", gameId: game.id });
  ok("a player who is not the host cannot start it", /only the host/i.test((await waitFor(cSocket, packet => packet.type === "game-error")).message));

  aSocket.inbox.length = 0;
  send(aSocket, { type: "game-start", gameId: game.id });
  const started = gameById(await waitGame(aSocket, game.id, view => view?.status === "playing"), game.id);
  ok("the host starts it with everybody seated", started.status === "playing" && started.players.length === 3, `${started.status}/${started.players.length}`);
  ok("the first turn asks the drawer for a word", started.round?.choosing === true, JSON.stringify(started.round));
  ok("the broadcast carries no word while it is being chosen", started.round?.word === null);
  ok("the word is masked, not empty", typeof started.round?.mask === "string");

  // The drawer's three words arrive privately.
  const wordPacket = await waitFor(aSocket, packet => packet.type === "game-word" && packet.gameId === game.id);
  ok("the drawer is offered three words", Array.isArray(wordPacket.options) && wordPacket.options.length === 3, JSON.stringify(wordPacket.options));
  ok("the other players are never sent the words", !bSocket.inbox.some(packet => packet.type === "game-word") && !cSocket.inbox.some(packet => packet.type === "game-word"), "leaked");

  // A spectator becomes the guest list (they may guess, and score separately).
  dSocket.inbox.length = 0;
  send(dSocket, { type: "game-watch", gameId: game.id });
  await waitGame(dSocket, game.id, view => view?.spectators >= 1).catch(() => null);
  ok("a spectator joins the guest list", gameById(await waitGame(dSocket, game.id, view => view?.spectators >= 1), game.id).spectators === 1);

  /* ------------------------------------------------------------ choosing, drawing, refusals */
  const word = wordPacket.options[0];
  aSocket.inbox.length = 0;
  send(aSocket, { type: "game-pick-word", gameId: game.id, word });
  const picked = gameById(await waitGame(aSocket, game.id, view => view?.round?.choosing === false), game.id);
  ok("picking a word starts the turn clock", picked.round.choosing === false && picked.round.endsAt > Date.now(), JSON.stringify({ choosingUntil: picked.round.choosingUntil, endsAt: picked.round.endsAt }));
  ok("the mask shows the first letter and hides the rest", picked.round.mask.startsWith(word[0]) && picked.round.mask.includes("_") && !picked.round.mask.includes(word.slice(1)), picked.round.mask);
  ok("the word still does not travel in the broadcast", picked.round.word === null);
  ok("the turn starts with nobody having guessed", Array.isArray(picked.guessed) && picked.guessed.length === 0, JSON.stringify(picked.guessed));

  bSocket.inbox.length = 0;
  send(bSocket, { type: "game-draw", gameId: game.id, stroke: { color: "#172033", size: 2, points: [[1, 1], [10, 10]] } });
  ok("a non-drawer cannot draw", /only the drawer/i.test((await waitFor(bSocket, packet => packet.type === "game-error")).message));

  // A stroke is broadcast as a stroke: the whole drawing must not be re-sent per line.
  bSocket.inbox.length = 0;
  aSocket.inbox.length = 0;
  send(aSocket, { type: "game-draw", gameId: game.id, stroke: { color: "#ef476f", size: 3, points: Array.from({ length: 400 }, (_, index) => [index, index]) } });
  const strokePacket = await waitStroke(bSocket, game.id, 1);
  ok("the drawer's stroke reaches everyone as one stroke", strokePacket.stroke?.color === "#ef476f", JSON.stringify(strokePacket.stroke?.color));
  ok("a stroke is capped at 200 points and keeps its palette colour", strokePacket.stroke.points.length === 200, String(strokePacket.stroke.points.length));
  ok("a stroke does not re-send the whole drawing", !bSocket.inbox.some(packet => packet.type === "game-state" && (gameById(packet, game.id)?.strokes || []).some(stroke => stroke.color === "#ef476f")), "a game-state carried the drawing");

  aSocket.inbox.length = 0;
  send(aSocket, { type: "game-draw", gameId: game.id, stroke: { color: "red", size: 99, points: [[-20, 4000]] } });
  const clamped = (await waitStroke(bSocket, game.id, 2)).stroke;
  ok("an off-palette colour and out-of-range points are normalised", clamped.color === "#172033" && clamped.size === 2 && clamped.points[0][0] === 0 && clamped.points[0][1] === 1024, JSON.stringify(clamped));

  // The full state still carries the drawing, so a client that just synced can paint it.
  aSocket.inbox.length = 0;
  send(aSocket, { type: "game-sync" });
  const synced = gameById(await waitFor(aSocket, packet => packet.type === "game-state"), game.id);
  ok("a sync still carries the whole drawing and its sequence", (synced.strokes || []).length === 2 && synced.strokeSeq === 2, `${(synced.strokes || []).length}/${synced.strokeSeq}`);

  // Undo takes back the drawer's last line on every screen, and only the drawer may do it.
  bSocket.inbox.length = 0;
  send(bSocket, { type: "game-undo", gameId: game.id });
  ok("a guesser cannot undo the drawer's work", /only the drawer/i.test((await waitFor(bSocket, packet => packet.type === "game-error")).message));
  aSocket.inbox.length = 0;
  bSocket.inbox.length = 0;
  send(aSocket, { type: "game-undo", gameId: game.id });
  const undone = await waitFor(bSocket, packet => packet.type === "game-undo" && packet.gameId === game.id, 5000).catch(() => null);
  ok("the drawer's undo reaches the room", Boolean(undone), JSON.stringify(undone));
  ok("undo moves the stroke sequence on rather than backwards", undone?.seq === 3, JSON.stringify(undone?.seq));
  aSocket.inbox.length = 0;
  send(aSocket, { type: "game-sync" });
  const afterUndo = gameById(await waitFor(aSocket, packet => packet.type === "game-state"), game.id);
  ok("undo leaves one line of the two", (afterUndo.strokes || []).length === 1, String((afterUndo.strokes || []).length));

  /* ------------------------------------------------------------ guesses */
  bSocket.inbox.length = 0;
  send(bSocket, { type: "message", kind: "text", content: "no idea at all" });
  const wrong = await waitFor(bSocket, packet => packet.type === "message" && packet.message.content === "no idea at all");
  ok("a wrong guess is an ordinary message", wrong.message.kind === "text");

  // A message that merely contains the letters of the word is not a guess ("concatenate" is not "cat").
  bSocket.inbox.length = 0;
  send(bSocket, { type: "message", kind: "text", content: `xx${word}xx` });
  const notGuess = await waitFor(bSocket, packet => packet.type === "message" || packet.type === "game-error");
  ok("letters inside a longer word do not count as a guess", notGuess.type === "message" && notGuess.message.kind === "text", JSON.stringify(notGuess).slice(0, 120));

  // The drawer cannot spoil the round by typing the answer. Wait for *its own* refusal rather than "any packet",
  // because another player's broadcast can still be in flight.
  aSocket.inbox.length = 0;
  send(aSocket, { type: "message", kind: "text", content: `it is a ${word}` });
  const refused = await Promise.race([
    waitFor(aSocket, packet => packet.type === "game-error", 4000).then(() => "refused").catch(() => "timeout"),
    sleep(900).then(() => "posted")
  ]);
  ok("the drawer saying the word is refused instead of posted", refused === "refused" && !aSocket.inbox.some(packet => packet.type === "message" && packet.message?.content === `it is a ${word}`), refused);

  // A whole sentence containing the word is a guess: the message turns into the highlighted line, never posted.
  bSocket.inbox.length = 0;
  send(bSocket, { type: "message", kind: "text", content: `is it ${word.toUpperCase()}? I think so` });
  const correct = await waitFor(bSocket, packet => packet.type === "message" && packet.message.kind === "system");
  ok("a sentence containing the word counts as a guess", correct.message.content === `${bob.user.username} guessed the word`, correct.message.content);
  ok("the sentence itself is never posted", !bSocket.inbox.some(packet => packet.type === "message" && packet.message.kind !== "system" && String(packet.message.content || "").toLowerCase().includes(word.toLowerCase())));
  ok("the word itself never appears in a message", !bSocket.inbox.some(packet => packet.type === "message" && String(packet.message.content || "").toLowerCase().includes(word.toLowerCase())));

  const afterBob = gameById(await waitGame(aSocket, game.id, view => (view?.players || []).some(player => player.id === bob.user.id && player.score > 0)), game.id);
  const bobScore = afterBob.players.find(player => player.id === bob.user.id).score;
  const aliceScore = afterBob.players.find(player => player.id === alice.user.id).score;
  ok("the guesser is paid", bobScore > 0, String(bobScore));
  ok("the drawer is paid for a correct guess", aliceScore >= 50, String(aliceScore));
  ok("the guess is credited on the seat list", afterBob.guessed.includes(bob.user.id), JSON.stringify(afterBob.guessed));
  ok("two players and a guest still guessing keep the turn open", afterBob.round.revealed === false, String(afterBob.round.revealed));

  // The guest counts too, and keeps a separate score.
  dSocket.inbox.length = 0;
  send(dSocket, { type: "message", kind: "text", content: word });
  const withGuest = gameById(await waitGame(aSocket, game.id, view => (view?.guessed || []).length === 2), game.id);
  ok("a guest's guess is credited to the turn", withGuest.guessed.includes(dave.user.id), JSON.stringify(withGuest.guessed));
  ok("the turn stays open while a player is still guessing", withGuest.round.revealed === false, JSON.stringify(withGuest.guessed));

  // The third player guesses, and only then is everybody in.
  cSocket.inbox.length = 0;
  send(cSocket, { type: "message", kind: "text", content: word });
  const everyone = gameById(await waitGame(aSocket, game.id, view => view?.round?.revealed === true), game.id);
  ok("everybody guessing ends the turn", everyone.round.revealed === true);
  ok("the reveal prints the word for the room", everyone.round.word === word, JSON.stringify(everyone.round.word));
  const guest = (everyone.guests || []).find(person => person.id === dave.user.id);
  ok("a guest who guessed is on the guest score list", Boolean(guest && guest.score > 0), JSON.stringify(everyone.guests));

  /* ------------------------------------------------------------ the next drawer */
  const nextTurn = gameById(await waitGame(aSocket, game.id, view => view?.round && view.round.drawerId === bob.user.id && view.round.choosing === true, 12000), game.id);
  ok("the next turn passes to the next player", nextTurn.round.drawerId === bob.user.id);
  ok("the canvas is cleared for the new turn", (nextTurn.strokes || []).length === 0, String((nextTurn.strokes || []).length));
  const bobWords = await waitFor(bSocket, packet => packet.type === "game-word" && packet.gameId === game.id && Array.isArray(packet.options), 8000);
  ok("the new drawer is offered words of their own", bobWords.options.length === 3);

  /* ------------------------------------------------------------ a drawer who never chooses */
  // DRAW_CHOOSE_MS is 6 s for this suite: the first word is taken for them instead of stalling the room, and the
  // drawer has to be told which one - a word they never learn is a turn nobody can draw.
  const autoPicked = gameById(await waitGame(aSocket, game.id, view => view?.round && view.round.drawerId === bob.user.id && view.round.choosing === false, 14000), game.id);
  ok("a drawer who never chooses gets the first word", autoPicked.round.choosing === false && autoPicked.round.endsAt > Date.now());
  const autoWordPacket = await waitFor(bSocket, packet => packet.type === "game-word" && packet.gameId === game.id && typeof packet.word === "string", 4000).catch(() => null);
  ok("the drawer is told the word the object picked for them", autoWordPacket?.word === bobWords.options[0].toLowerCase(), JSON.stringify(autoWordPacket));

  /* ------------------------------------------------------------ one player leaving a bigger game */
  // With three players, one leaving is not the end of the game - it used to end it for everybody and hand the win
  // to whoever happened to be first in the list.
  cSocket.inbox.length = 0;
  send(cSocket, { type: "game-leave", gameId: game.id });
  const afterLeave = gameById(await waitGame(aSocket, game.id, view => view?.players.length === 2), game.id);
  ok("a player leaving a three-player game does not end it", afterLeave.status === "playing" && afterLeave.reason === null, `${afterLeave.status}/${afterLeave.reason}`);
  ok("the seat that left is gone from the list", !afterLeave.players.some(player => player.id === cara.user.id));

  // The guest leaves too, so the rest of the game only waits on the players who are still seated.
  dSocket.inbox.length = 0;
  send(dSocket, { type: "game-leave", gameId: game.id });
  await sleep(300);

  /* ------------------------------------------------------------ play it out to a result */
  // Two players, three rounds. Every pass asks both sockets for the truth (`game-sync`), which also re-sends the
  // drawer's words privately. A turn that is still in the choosing window is picked and guessed; a turn that is
  // already running (an auto-picked one) is finished by guessing its word. Nothing waits on a transient state like
  // the 400 ms reveal, which a slow runner can miss.
  const sockets = new Map([[alice.user.id, aSocket], [bob.user.id, bSocket]]);
  let finished = null;
  for (let turn = 0; turn < 24; turn++) {
    for (const node of sockets.values()) { node.inbox.length = 0; send(node, { type: "game-sync" }); }
    const state = gameById(await waitFor(aSocket, packet => packet.type === "game-state", 8000), game.id);
    if (!state) continue;
    if (state.status === "ended") { finished = state; break; }
    if (!state.round || state.round.revealed) { await sleep(300); continue; }
    const drawerId = state.round.drawerId, drawerSocket = sockets.get(drawerId);
    if (!drawerSocket) { await sleep(300); continue; }
    // The drawer's private packet holds either the three words of a fresh turn or the word of a running one.
    const words = await waitFor(drawerSocket, packet => packet.type === "game-word" && packet.gameId === game.id, 8000).catch(() => null);
    if (!words) { await sleep(300); continue; }
    const turnWord = String(words.options ? words.options[0] : words.word || "").toLowerCase();
    if (!turnWord) { await sleep(300); continue; }
    if (state.round.choosing) {
      drawerSocket.inbox.length = 0;
      send(drawerSocket, { type: "game-pick-word", gameId: game.id, word: turnWord });
      await waitFor(aSocket, packet => packet.type === "game-state" && gameById(packet, game.id)?.round?.choosing === false, 8000).catch(() => null);
    }
    for (const [userId, node] of sockets) {
      if (userId === drawerId) continue;
      node.inbox.length = 0;
      send(node, { type: "message", kind: "text", content: turnWord });
      await waitFor(node, packet => packet.type === "message" || packet.type === "game-error", 5000).catch(() => null);
    }
    await sleep(400);
  }
  if (!finished || finished.status !== "ended") finished = gameById(await waitGame(aSocket, game.id, item => item?.status === "ended", 15000).catch(() => null), game.id);
  ok("three rounds end the game", finished?.status === "ended", finished?.status);
  ok("the result is decided on points, not a forfeit", ["points", "draw"].includes(finished?.reason), finished?.reason);
  const best = Math.max(...(finished?.players || []).map(player => player.score || 0));
  ok("somebody scored during the game", best > 0, String(best));
  if (finished?.reason === "points") {
    ok("the winner is the highest score, with no win added on top", finished.players.find(player => player.id === finished.winnerId)?.score === best, `${finished.winnerId}/${best}`);
  } else ok("a tie reports no winner", finished?.winnerId === null);

  for (const ws of [aSocket, bSocket, cSocket, dSocket]) ws.close();
  await fetch(`${BASE}/api/rooms/${room.id}`, { method: "DELETE", headers: { Origin: ORIGIN, Cookie: alice.cookie } });
  console.log(`\n${failed === 0 ? "ALL GOOD" : "FAILURES"} - ${passed} passed, ${failed} failed  (room: ${room.id})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => { console.error(`\ndraw & guess suite crashed: ${error instanceof Error ? error.message : error}`); process.exit(1); });
