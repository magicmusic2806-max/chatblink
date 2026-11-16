/**
 * Browser-level check of the games dock: its three pages, and the paths a stranded player used to have no way
 * through.
 *
 * Usage:  node tests/games-ui.js [baseUrl]
 * Needs a running local server (npx wrangler dev) and Playwright's Chromium.
 *
 * The panel has three pages behind one header: the board (with only the action it is waiting for), the people
 * (seats, scores, join requests) and the options (leave, end, clear, resign). This suite drives that navigation
 * with two real browsers, because the complaint being tested is a UI dead end, not a server rule: after the host
 * leaves a finished game the other player must still reach Rematch, and a rematch must not need the host.
 */
const { chromium } = require("playwright");

const BASE = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/$/, "");
const stamp = Date.now().toString(36);
let passed = 0, failed = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ""}`); }
};

const post = (route, body, cookie = "") => fetch(BASE + route, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
const cookieOf = response => response.headers.get("set-cookie").split(";")[0];

// One player per browser context: the dock only shows what that account may do, so both sides have to be real.
async function player(browser, cookie, room, errors) {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
  const [name, value] = cookie.split("=");
  await context.addCookies([{ name, value, url: BASE }]);
  await context.addInitScript(() => localStorage.setItem("chatblink.pushPrompted", "1"));
  const page = await context.newPage();
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${BASE}/room/${room}`, { waitUntil: "domcontentloaded" });
  await page.locator("#chatPanel:not([hidden])").waitFor();
  await page.locator("#chatPanel[data-loaded]").waitFor({ timeout: 15000 });
  return page;
}
const openDock = async page => {
  await page.locator("#gamesButton").click();
  await page.locator("#gamePane:not([hidden])").waitFor();
};
const dockText = page => page.locator("#gameBody").innerText();
// Waiting on the dock's own text rather than a locator keeps case-sensitivity: the board says "Your turn" in a
// state line, and only a real state check should match that.
const waitDock = (page, text) => page.waitForFunction(needle => document.querySelector("#gameBody")?.innerText.includes(needle), text, { timeout: 8000 })
  .catch(async error => { console.log(`  (waiting for "${text}" failed; dock says: ${JSON.stringify((await page.locator("#gamePane").innerText()).replace(/\s+/g, " ").slice(0, 220))})`); throw error; });
const openPeople = page => page.locator("#gamePanePeople").click();
const openOptions = page => page.locator("#gamePaneMenu").click();
const backToBoard = page => page.locator("#gamePaneBack").click();
// Back is two steps from a sub-page (to the board, then to the room's games), which is the whole navigation model.
const backToList = async page => { await backToBoard(page); await page.waitForTimeout(150); await backToBoard(page); await page.waitForTimeout(150); };
const rematchButton = page => page.locator('.game-icon-btn[aria-label="Rematch"]');

(async () => {
  console.log(`\ngames dock e2e on ${BASE}`);
  const hostName = `gd_host_${stamp}`, guestName = `gd_guest_${stamp}`;
  const hostSignup = await post("/api/auth/signup", { username: hostName, age: 24, adultConfirmed: true });
  const guestSignup = await post("/api/auth/signup", { username: guestName, age: 24, adultConfirmed: true });
  if (hostSignup.status !== 201 || guestSignup.status !== 201) throw new Error("signup failed");
  const hostCookie = cookieOf(hostSignup), guestCookie = cookieOf(guestSignup);
  const room = (await (await post("/api/rooms", { name: `Dock ${stamp}`, vibe: "Games dock.", access: "open", theme: "ocean" }, hostCookie)).json()).room;
  if (!room?.id) throw new Error("room creation failed");

  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    const host = await player(browser, hostCookie, room.id, errors);
    const rival = await player(browser, guestCookie, room.id, errors);

    await openDock(host);
    ok("the Games button opens the dock with the create form", (await dockText(host)).includes("Nobody is playing here yet"));
    // The reason for the split: playing never hides the conversation. At phone width the two stack, and the
    // chat keeps its 60% of the height.
    const split = await host.evaluate(() => {
      const pane = document.querySelector("#gamePane").getBoundingClientRect();
      const messages = document.querySelector("#messageList").getBoundingClientRect();
      const chat = document.querySelector("#chatSplit").getBoundingClientRect();
      return { pane: Math.round(pane.height), messages: Math.round(messages.height), chat: Math.round(chat.height) };
    });
    ok("the game panel sits beside the chat instead of over it", split.pane > 0 && split.messages > 0, JSON.stringify(split));
    ok("the split is 60/40 in the chat's favour", Math.abs(split.pane / split.chat - 0.4) < 0.06, JSON.stringify(split));
    await host.locator('.game-kind[data-kind="tic-tac-toe"]').click();
    await host.locator('.game-policy input[value="open"]').check();
    await host.locator(".game-create button.primary").click();
    await waitDock(host, "Waiting for a player");
    ok("the board page opens without a row of seat cards", await host.locator(".game-seats").count() === 0, "seats on the board");
    await openPeople(host);
    await waitDock(host, "Open seat");
    ok("the people glyph shows the seats and the open seat", (await dockText(host)).includes("Open seat"), (await dockText(host)).slice(0, 160));
    await openOptions(host);
    await waitDock(host, "End game");
    ok("a board waiting for a player offers no restart", !(await dockText(host)).includes("Rematch") && (await dockText(host)).includes("End game"), (await dockText(host)).slice(0, 160));
    await backToBoard(host);
    await waitDock(host, "Waiting for a player");

    // The other player joins through the same dock, in a second browser.
    await openDock(rival);
    await rival.locator(".game-list-row").first().waitFor();
    await rival.locator(".game-list-row").first().click();
    await rival.locator(".game-join").click();
    await waitDock(host, "Your turn");
    await waitDock(rival, `Waiting for ${hostName}`);
    ok("the joining player starts the game for both", (await dockText(rival)).includes(`Waiting for ${hostName}`), (await dockText(rival)).slice(0, 160));
    await openOptions(rival);
    ok("a board in play offers no restart to either player", await rival.locator(".game-actions button", { hasText: /restart|rematch/i }).count() === 0 && !(await dockText(rival)).includes("Rematch"));
    await backToBoard(rival);
    ok("the player to move sees every legal square marked", await host.locator(".grid-cell.legal").count() === 9);
    ok("the player waiting sees none marked", await rival.locator(".grid-cell.legal").count() === 0);

    // Host takes the top row; the other player answers in the middle row. Every click has to land on a square
    // the dock left enabled, so this also proves the legal moves came from the object.
    await host.locator(".grid-cell").nth(0).click(); await waitDock(rival, "Your turn");
    await rival.locator(".grid-cell").nth(3).click(); await waitDock(host, "Your turn");
    await host.locator(".grid-cell").nth(1).click(); await waitDock(rival, "Your turn");
    await rival.locator(".grid-cell").nth(4).click(); await waitDock(host, "Your turn");
    await host.locator(".grid-cell").nth(2).click();
    await waitDock(host, `${hostName} wins`);
    const won = await host.locator(".game-result").innerText();
    ok("a finished board says who won, right above the rematch", won.includes(`${hostName} wins`), won);
    ok("the rematch is a glyph beside the result, for both players", await rematchButton(host).count() === 1 && await rematchButton(rival).count() === 1);

    // No history: the room lists the games being played, so the host going back finds the create form, not the
    // board that just finished. The result stays on the screen that was open (the rival is still looking at it).
    await host.locator("#gamePaneBack").click();
    await waitDock(host, "Nobody is playing here yet");
    ok("a finished board is not kept in the list", !(await dockText(host)).includes(`${hostName} won`), (await dockText(host)).slice(0, 200));

    // The player who lost asks for the rematch from the board screen: the host role is not the price of playing
    // again, and the rematch is a running game, so it appears in the host's list straight away.
    await rematchButton(rival).click();
    await waitDock(rival, "Your turn");
    ok("the player who is not the host can rematch", await rival.locator(".grid-cell.legal").count() === 9);
    await host.locator(".game-list-row").first().waitFor();
    ok("the rematch is listed as a running game", !(await dockText(host)).includes("Nobody is playing here yet"), (await dockText(host)).slice(0, 200));
    await host.locator(".game-list-row").first().click();
    await waitDock(host, `Waiting for ${guestName}`);
    ok("and the opening seat has moved to them", (await dockText(host)).includes(`Waiting for ${guestName}`));

    // A drawn board: nine squares, no line, and the dock has to say so instead of inventing a winner.
    await rival.locator(".grid-cell").nth(0).click(); await waitDock(host, "Your turn");
    await host.locator(".grid-cell").nth(4).click(); await waitDock(rival, "Your turn");
    await rival.locator(".grid-cell").nth(1).click(); await waitDock(host, "Your turn");
    await host.locator(".grid-cell").nth(7).click(); await waitDock(rival, "Your turn");
    await rival.locator(".grid-cell").nth(5).click(); await waitDock(host, "Your turn");
    await host.locator(".grid-cell").nth(3).click(); await waitDock(rival, "Your turn");
    await rival.locator(".grid-cell").nth(6).click(); await waitDock(host, "Your turn");
    await host.locator(".grid-cell").nth(2).click(); await waitDock(rival, "Your turn");
    await rival.locator(".grid-cell").nth(8).click();
    await waitDock(rival, "It's a tie");
    const tied = await rival.locator(".game-result").innerText();
    ok("a drawn board says it is a tie", tied.includes("It's a tie"), tied);
    ok("and the tie offers a rematch too", await rematchButton(rival).count() === 1);

    // The host rematches, then walks out of the running game: the other player wins it and keeps the controls.
    await rematchButton(host).click();
    await waitDock(host, "Your turn");
    await openOptions(host);
    await host.locator(".game-actions button", { hasText: "Leave" }).click();
    await waitDock(rival, `${guestName} wins`);
    ok("leaving a running game hands it to the player who stayed", (await dockText(rival)).includes(`${guestName} wins`));
    ok("the player who stayed can still rematch", await rematchButton(rival).count() === 1);
    await rematchButton(rival).click();
    await waitDock(rival, "Waiting for a player");
    await openPeople(rival);
    const lobby = await dockText(rival);
    ok("the replay drops the seat of the player who left", lobby.includes("Open seat") && lobby.includes(hostName) === false, lobby.slice(0, 160));
    ok("the reopened board has no restart of its own", await rival.locator('.game-icon-btn[aria-label="Rematch"]').count() === 0);
    await openPeople(host);
    await waitDock(host, "Open seat");
    ok("the other player's dock shows the replay waiting for an opponent", (await dockText(host)).includes("Open seat"));

    // And the room is never closed to a new game: the create form is still reachable.
    await backToList(host);
    await waitDock(host, "Start another game");
    ok("a fresh game is still one tap away", (await dockText(host)).includes("Start another game"));

    ok("neither page logged an error", errors.length === 0, errors.join(" | "));
  } finally {
    await browser.close();
    await fetch(`${BASE}/api/rooms/${room.id}`, { method: "DELETE", headers: { Origin: BASE, Cookie: hostCookie } });
  }
  console.log(`\n${failed === 0 ? "ALL GOOD" : "FAILURES"} - ${passed} passed, ${failed} failed  (room: ${room.id})`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(error => { console.error(`\ngames dock test crashed: ${error instanceof Error ? error.message : error}`); process.exit(1); });
