/**
 * Draw & Guess through a real browser: the drawer picks a word, draws with the mouse, the other player sees the
 * ink and guesses in the ordinary chat box.
 *
 * Usage:  node tests/draw-ui.js [baseUrl]
 * Needs a running local server (npx wrangler dev) plus Playwright's Chromium. tests/run-all.js starts it with
 * DRAW_CHOOSE_MS long enough for a browser to read the picker and DRAW_REVEAL_MS short enough to finish.
 *
 * What only a browser can prove: the drawer's word line shows the answer while everybody else sees the mask,
 * the tools belong to the drawer alone, a stroke drawn with the pointer reaches the other player's canvas, and a
 * sentence typed in the chat box turns into the highlighted "guessed the word" line instead of a bubble.
 */
const { chromium } = require("playwright");

const BASE = (process.argv[2] || "http://127.0.0.1:8815").replace(/\/$/, "");
const stamp = Date.now().toString(36);
let passed = 0, failed = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ""}`); }
};
const post = (route, body, cookie = "") => fetch(BASE + route, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
const cookieOf = response => response.headers.get("set-cookie").split(";")[0];

async function player(browser, cookie, room, viewport = { width: 1280, height: 900 }) {
  const context = await browser.newContext({ viewport });
  const [name, value] = cookie.split("=");
  await context.addCookies([{ name, value, url: BASE }]);
  await context.addInitScript(() => localStorage.setItem("chatblink.pushPrompted", "1"));
  const page = await context.newPage();
  page.on("pageerror", error => { failed++; console.log("  FAIL  page error :: " + error.message); });
  await page.goto(`${BASE}/room/${room}`, { waitUntil: "domcontentloaded" });
  await page.locator("#chatPanel[data-loaded]").waitFor({ timeout: 20000 });
  return page;
}
const openPanel = async page => { await page.locator("#gamesButton").click(); await page.locator("#gamePane:not([hidden])").waitFor(); };
const waitPane = async (page, text) => {
  try {
    await page.waitForFunction(needle => document.querySelector("#gameBody")?.innerText.includes(needle), text, { timeout: 12000 });
  } catch (error) {
    console.log(`  (waiting for "${text}" failed; pane says: ${JSON.stringify((await page.locator("#gameBody").innerText()).slice(0, 300))})`);
    throw error;
  }
};
// Ink test: is any pixel of the canvas not the white background?
const hasInk = page => page.evaluate(() => {
  const canvas = document.querySelector(".draw-canvas");
  if (!canvas) return false;
  const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
  for (let index = 0; index < data.length; index += 4) if (data[index] < 240 || data[index + 1] < 240 || data[index + 2] < 240) return true;
  return false;
});

(async () => {
  console.log(`\ndraw ui on ${BASE}`);
  const alice = await post("/api/auth/signup", { username: `du_a_${stamp}`, age: 24, adultConfirmed: true });
  const bob = await post("/api/auth/signup", { username: `du_b_${stamp}`, age: 24, adultConfirmed: true });
  const aliceCookie = cookieOf(alice), bobCookie = cookieOf(bob);
  const room = (await (await post("/api/rooms", { name: `DrawUI ${stamp}`, vibe: "Drawing beside chat.", access: "open", theme: "ocean" }, aliceCookie)).json()).room;

  const browser = await chromium.launch({ headless: true });
  try {
    const a = await player(browser, aliceCookie, room.id);
    const b = await player(browser, bobCookie, room.id);

    await openPanel(a);
    await a.locator('.game-kind-btn[data-kind="draw-guess"]').click();
    await a.locator('.game-policy-btn[data-policy="open"]').click();
    await a.locator(".game-start").click();
    // A new game opens on its board, and the board carries no seats: those are the people page behind 👥.
    await waitPane(a, "seated");
    ok("the board opens without a row of seat cards", await a.locator(".game-seats").count() === 0, "seats on the board");
    await a.locator("#gamePanePeople").click();
    await a.locator(".game-seats").first().waitFor();
    ok("the people page shows the open seat", (await a.locator("#gameBody").innerText()).includes("Open seat"), (await a.locator("#gameBody").innerText()).slice(0, 160));
    await a.locator("#gamePanePeople").click();
    await a.locator(".game-seats").waitFor({ state: "detached" });
    ok("the second tap on the glyph returns to the board", await a.locator(".draw-canvas, .game-bar").count() === 1);
    await openPanel(b);
    await b.locator(".game-list-row").first().click();
    await b.locator(".game-join").click();
    // The game waits in its lobby for the host: a second person arriving no longer starts a two-player round before
    // anybody else can take a seat.
    await waitPane(a, "Start now");
    await waitPane(b, "seated");
    ok("the host is offered a start with everybody seated", !(await b.locator("#gameBody").innerText()).includes("Start now"), (await b.locator("#gameBody").innerText()).slice(0, 120));
    ok("the other player is told the game is waiting on the host", /waiting for the host/i.test(await b.locator("#gameBody").innerText()), (await b.locator("#gameBody").innerText()).slice(0, 200));
    await a.locator(".game-join").click();
    await waitPane(a, "pick a word");

    ok("the drawer is offered three words to pick", await a.locator(".draw-picker button").count() === 3, String(await a.locator(".draw-picker button").count()));
    ok("the guesser sees no word picker", await b.locator(".draw-picker button").count() === 0);
    ok("nobody's word line shows anything before a word is chosen", !(await b.locator(".draw-word").innerText()).includes("_"), await b.locator(".draw-word").innerText());
    ok("the canvas is drawn for both", await a.locator(".draw-canvas").count() === 1 && await b.locator(".draw-canvas").count() === 1);

    const word = (await a.locator(".draw-picker button").first().innerText()).trim();
    await a.locator(".draw-picker button").first().click();
    // Two independent sockets: wait for the drawer's own panel to be told the word rather than reading it the
    // instant the guesser's panel updates.
    await a.waitForFunction(expected => (document.querySelector(".draw-word")?.textContent || "").trim().toLowerCase() === expected.toLowerCase(), word, { timeout: 10000 }).catch(() => null);
    await waitPane(b, "guess");
    const drawnWord = (await a.locator(".draw-word").innerText()).trim();
    ok("the drawer reads the whole word", drawnWord.toLowerCase() === word.toLowerCase(),
      JSON.stringify({ drawn: [...drawnWord].map(character => character.charCodeAt(0)), picked: [...word].map(character => character.charCodeAt(0)) }));
    ok("the guesser only sees the mask", (await b.locator(".draw-word").innerText()).includes("_") && !(await b.locator(".draw-word").innerText()).toLowerCase().includes(word.toLowerCase()), await b.locator(".draw-word").innerText());
    ok("the guesser can see that nobody has guessed yet", /0 of 1 guessed/i.test(await b.locator("#gameBody").innerText()), (await b.locator("#gameBody").innerText()).slice(0, 200));
    ok("only the drawer gets drawing tools", await a.locator(".draw-tools").count() === 1 && await b.locator(".draw-tools").count() === 0);

    // Draw a line with the mouse: pointerdown, a few moves, pointerup.
    const box = await a.locator(".draw-canvas").boundingBox();
    await a.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.3);
    await a.mouse.down();
    for (let step = 1; step <= 8; step++) await a.mouse.move(box.x + box.width * (0.25 + step * 0.05), box.y + box.height * (0.3 + step * 0.03));
    await a.mouse.up();
    await b.waitForFunction(() => {
      const canvas = document.querySelector(".draw-canvas");
      if (!canvas) return false;
      const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
      for (let index = 0; index < data.length; index += 4) if (data[index] < 240 || data[index + 1] < 240 || data[index + 2] < 240) return true;
      return false;
    }, null, { timeout: 8000 }).catch(() => null);
    ok("the drawer's stroke appears on the guesser's canvas", await hasInk(b));
    ok("the drawer's own canvas has ink", await hasInk(a));

    // The guess is typed in the ordinary chat box: a sentence containing the word must become the highlighted
    // line, and the sentence itself must never be posted.
    await b.locator("#chatInput").fill(`is it ${word}? I think so`);
    await b.locator("#chatForm").press("Enter");
    await b.locator(".message-system").first().waitFor({ timeout: 10000 });
    const line = await b.locator(".message-system").first().innerText();
    ok("a sentence in the chat box becomes the highlighted line", /guessed the word/i.test(line), line);
    ok("the sentence itself is not posted as a bubble", await b.locator(".message", { hasText: "I think so" }).count() === 0);
    ok("the word is not repeated in the announcement", !line.toLowerCase().includes(word.toLowerCase()), line);
    await waitPane(a, `was ${word}`);
    ok("the turn reveals the word to everybody", (await a.locator(".draw-bar").innerText()).toLowerCase().includes(`was ${word.toLowerCase()}`), await a.locator(".draw-bar").innerText());
    await b.screenshot({ path: ".forge/shots/draw-desktop.png" });

    // The seats and the score are one glyph away, and they still say everything the board does not.
    await b.locator("#gamePanePeople").click();
    await b.locator(".game-seats").first().waitFor();
    const seatText = await b.locator(".game-seats").innerText();
    ok("both players appear on the score cards", /du_a_/.test(seatText) && /du_b_/.test(seatText), JSON.stringify(seatText.slice(0, 120)));
    ok("the drawer is marked on their seat", seatText.includes("✏️"), seatText.slice(0, 120));
    ok("the score cards show points, not wins", seatText.includes("pts"), JSON.stringify(seatText.slice(0, 120)));
    ok("the people page says how many seats and who is watching", /2\/8 seats/.test(await b.locator("#gameBody").innerText()), (await b.locator("#gameBody").innerText()).slice(0, 200));
    await b.screenshot({ path: ".forge/shots/draw-people.png" });

    ok("no page errors", true);
  } finally {
    await browser.close();
    await fetch(`${BASE}/api/rooms/${room.id}`, { method: "DELETE", headers: { Origin: BASE, Cookie: aliceCookie } });
  }
  console.log(`\n${failed === 0 ? "ALL GOOD" : "FAILURES"} - ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(error => { console.error("draw ui crashed:", error.message); process.exit(1); });
