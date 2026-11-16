/**
 * Draw & Guess: turns, secrets, scoring and the clock.
 *
 * Usage:  node tests/draw.js [baseUrl]
 * Needs a running local server:  npx wrangler dev --port 8797 --var DRAW_SECONDS:20 --var DRAW_REVEAL_MS:400 --var DRAW_CHOOSE_MS:2000
 * (tests/run-all.js starts it that way, so a whole three-round game fits in a few seconds.)
 *
 * The rules this suite exists for: the drawer's word never travels in the broadcast state, a guess is checked
 * before it can reach the transcript, a correct guess scores the guesser and the drawer, guests score on their
 * own list, the turn ends when everyone has guessed, and the next drawer takes over after the reveal.
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
const newest = ws => [...ws.inbox].reverse().find(packet => packet.type === "game-state");
const gameById = (packet, id) => (packet?.games || []).find(game => game.id === id) || null;
const waitGame = (ws, id, predicate, ms = 8000) => waitFor(ws, packet => packet.type === "game-state" && predicate(gameById(packet, id)), ms);

async function main() {
  console.log(`\ndraw & guess on ${BASE}`);
  const alice = await signup(`dg_alice_${stamp}`), bob = await signup(`dg_bob_${stamp}`), cara = await signup(`dg_cara_${stamp}`);
  ok("three accounts sign up", [alice, bob, cara].every(account => account.status === 201));
  const created = await post("/api/rooms", { name: `Draw ${stamp}`, vibe: "Drawing.", access: "open", theme: "ocean" }, alice.cookie);
  const room = (await created.json()).room;
  ok("an open room is created", created.status === 201 && Boolean(room?.id), `status ${created.status}`);

  const aSocket = socket(room.id, alice.cookie), bSocket = socket(room.id, bob.cookie), cSocket = socket(room.id, cara.cookie);
  for (const ws of [aSocket, bSocket, cSocket]) { await open(ws); await waitFor(ws, packet => packet.type === "history"); }

  /* ------------------------------------------------------------ seats and the first turn */
  aSocket.inbox.length = 0;
  send(aSocket, { type: "game-create", kind: "draw-guess", policy: "open" });
  const createdGame = await waitFor(aSocket, packet => packet.type === "game-state" && packet.games.length === 1);
  const game = createdGame.games[0];
  ok("Draw & Guess seats up to eight players", game.seats === 8 && game.minSeats === 2, `${game.seats}/${game.minSeats}`);
  ok("one player is not enough to start it", game.status === "lobby", game.status);

  bSocket.inbox.length = 0;
  send(bSocket, { type: "game-join", gameId: game.id });
  const started = await waitGame(bSocket, game.id, view => view?.status === "playing");
  const firstTurn = gameById(started, game.id);
  ok("two players start the game, because two is its minimum", firstTurn.status === "playing");
  ok("the first turn asks the drawer for a word", firstTurn.round?.choosing === true, JSON.stringify(firstTurn.round));
  ok("the broadcast carries no word while it is being chosen", firstTurn.round?.word === null);
  ok("the word is masked, not empty", typeof firstTurn.round?.mask === "string");

  // The drawer's three words arrive privately.
  const wordPacket = await waitFor(aSocket, packet => packet.type === "game-word" && packet.gameId === game.id);
  ok("the drawer is offered three words", Array.isArray(wordPacket.options) && wordPacket.options.length === 3, JSON.stringify(wordPacket.options));
  ok("the other player is never sent the words", !bSocket.inbox.some(packet => packet.type === "game-word"), "leaked");

  // A spectator becomes the guest list (they may guess, and score separately).
  cSocket.inbox.length = 0;
  send(cSocket, { type: "game-watch", gameId: game.id });
  await waitGame(cSocket, game.id, view => view?.spectators >= 1).catch(() => null);

  /* ------------------------------------------------------------ choosing, drawing, refusals */
  const word = wordPacket.options[0];
  aSocket.inbox.length = 0;
  send(aSocket, { type: "game-pick-word", gameId: game.id, word });
  const picked = gameById(await waitGame(aSocket, game.id, view => view?.round?.choosing === false), game.id);
  ok("picking a word starts the turn clock", picked.round.choosing === false && picked.round.endsAt > Date.now(), JSON.stringify({ choosingUntil: picked.round.choosingUntil, endsAt: picked.round.endsAt }));
  ok("the mask shows the first letter and hides the rest", picked.round.mask.startsWith(word[0]) && picked.round.mask.includes("_") && !picked.round.mask.includes(word.slice(1)), picked.round.mask);
  ok("the word still does not travel in the broadcast", picked.round.word === null);

  bSocket.inbox.length = 0;
  send(bSocket, { type: "game-draw", gameId: game.id, stroke: { color: "#172033", size: 2, points: [[1, 1], [10, 10]] } });
  ok("a non-drawer cannot draw", /only the drawer/i.test((await waitFor(bSocket, packet => packet.type === "game-error")).message));

  aSocket.inbox.length = 0;
  send(aSocket, { type: "game-draw", gameId: game.id, stroke: { color: "#ef476f", size: 3, points: Array.from({ length: 400 }, (_, index) => [index, index]) } });
  const drawn = gameById(await waitGame(bSocket, game.id, view => (view?.strokes || []).length > 0), game.id);
  ok("the drawer's stroke reaches everyone", drawn.strokes.length === 1 && drawn.strokes[0].color === "#ef476f", JSON.stringify(drawn.strokes[0]?.points?.length));
  ok("a stroke is capped at 200 points and keeps its palette colour", drawn.strokes[0].points.length === 200 && drawn.strokes[0].color === "#ef476f", String(drawn.strokes[0].points.length));

  aSocket.inbox.length = 0;
  send(aSocket, { type: "game-draw", gameId: game.id, stroke: { color: "red", size: 99, points: [[-20, 4000]] } });
  const clamped = gameById(await waitGame(bSocket, game.id, view => (view?.strokes || []).length === 2), game.id);
  ok("an off-palette colour and out-of-range points are normalised", clamped.strokes[1].color === "#172033" && clamped.strokes[1].size === 2 && clamped.strokes[1].points[0][0] === 0 && clamped.strokes[1].points[0][1] === 1024, JSON.stringify(clamped.strokes[1]));

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
  // because the other player's earlier broadcast can still be in flight.
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
  ok("one guesser is not enough to end the turn while a guest is still guessing", afterBob.round.revealed === false, String(afterBob.round.revealed));

  // The guest counts too, and keeps a separate score.
  cSocket.inbox.length = 0;
  send(cSocket, { type: "message", kind: "text", content: word });
  const revealedPacket = await waitGame(aSocket, game.id, view => view?.round?.revealed === true);
  const revealed = gameById(revealedPacket, game.id);
  ok("everyone guessing ends the turn", revealed.round.revealed === true);
  ok("the reveal prints the word for the room", revealed.round.word === word, JSON.stringify(revealed.round.word));
  const guest = (revealed.guests || []).find(person => person.id === cara.user.id);
  ok("a guest who guessed is on the guest score list", Boolean(guest && guest.score > 0), JSON.stringify(revealed.guests));

  /* ------------------------------------------------------------ the next drawer */
  const nextTurn = gameById(await waitGame(aSocket, game.id, view => view?.round && view.round.drawerId === bob.user.id && view.round.choosing === true, 12000), game.id);
  ok("the next turn passes to the other player", nextTurn.round.drawerId === bob.user.id);
  ok("the canvas is cleared for the new turn", (nextTurn.strokes || []).length === 0, String((nextTurn.strokes || []).length));
  const bobWords = await waitFor(bSocket, packet => packet.type === "game-word" && packet.gameId === game.id && Array.isArray(packet.options), 8000);
  ok("the new drawer is offered words of their own", bobWords.options.length === 3);

  /* ------------------------------------------------------------ a drawer who never chooses */
  // DRAW_CHOOSE_MS is 6 s for this suite: the first word is taken for them instead of stalling the room.
  const autoPicked = gameById(await waitGame(aSocket, game.id, view => view?.round && view.round.drawerId === bob.user.id && view.round.choosing === false, 14000), game.id);
  ok("a drawer who never chooses gets the first word", autoPicked.round.choosing === false && autoPicked.round.endsAt > Date.now());

  /* ------------------------------------------------------------ play it out to a result */
  // Finish the auto-picked turn first so the loop below only ever starts clean turns.
  const autoWord = bobWords.options[0];
  for (const node of [aSocket, cSocket]) { node.inbox.length = 0; send(node, { type: "message", kind: "text", content: autoWord }); }
  await waitGame(aSocket, game.id, view => view?.round?.revealed === true, 8000);
  await sleep(600);

  // Two players, three rounds: six turns. Each turn the test draws a word from the drawer's own private packet,
  // picks it, and has the other people in the room guess it — exactly the loop a real game runs.
  let finished = null;
  for (let turn = 0; turn < 12; turn++) {
    const view = gameById(await waitGame(aSocket, game.id, item => item?.status === "ended" || (item?.round && !item.round.revealed && item.round.choosing), 12000), game.id);
    if (!view || view.status === "ended") { finished = view; break; }
    const drawerSocket = view.round.drawerId === alice.user.id ? aSocket : bSocket;
    const packet = await waitFor(drawerSocket, message => message.type === "game-word" && Array.isArray(message.options), 8000);
    const turnWord = packet.options[0];
    drawerSocket.inbox.length = 0;
    send(drawerSocket, { type: "game-pick-word", gameId: game.id, word: turnWord });
    await waitGame(aSocket, game.id, item => item?.round && item.round.choosing === false && !item.round.revealed, 6000);
    for (const node of [aSocket, bSocket, cSocket]) {
      if (node === drawerSocket) continue;
      node.inbox.length = 0;
      send(node, { type: "message", kind: "text", content: turnWord });
      await waitFor(node, packet2 => packet2.type === "message" || packet2.type === "game-error", 4000).catch(() => null);
    }
    await waitGame(aSocket, game.id, item => item?.status === "ended" || item?.round?.revealed, 6000);
    await sleep(520);
  }
  if (!finished || finished.status !== "ended") finished = gameById(await waitGame(aSocket, game.id, item => item?.status === "ended", 15000).catch(() => null), game.id);
  ok("three rounds end the game", finished?.status === "ended", finished?.status);
  ok("the result is decided on points, not a forfeit", ["points", "draw"].includes(finished?.reason), finished?.reason);
  const best = Math.max(...(finished?.players || []).map(player => player.score || 0));
  ok("somebody scored during the game", best > 0, String(best));
  if (finished?.reason === "points") {
    ok("the winner is the highest score", finished.players.find(player => player.id === finished.winnerId)?.score === best, `${finished.winnerId}/${best}`);
  } else ok("a tie reports no winner", finished?.winnerId === null);

  aSocket.close(); bSocket.close(); cSocket.close();
  await fetch(`${BASE}/api/rooms/${room.id}`, { method: "DELETE", headers: { Origin: ORIGIN, Cookie: alice.cookie } });
  console.log(`\n${failed === 0 ? "ALL GOOD" : "FAILURES"} - ${passed} passed, ${failed} failed  (room: ${room.id})`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(error => { console.error(`\ndraw & guess suite crashed: ${error instanceof Error ? error.message : error}`); process.exit(1); });
