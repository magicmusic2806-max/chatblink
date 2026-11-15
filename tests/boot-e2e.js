/**
 * Boot and room-switch behaviour, the two flashes a remembered session used to show.
 *
 * Usage:  node tests/boot-e2e.js [baseUrl]
 * Needs a running local server (npx wrangler dev) and Playwright's Chromium.
 *
 * 1. A browser that holds a sign-in token but whose Worker request carried no session cookie (Safari's cookie
 *    policy, a cleared cookie jar, a cookie-blocking extension) used to paint the login shell and then swap to
 *    the app. The page now installs an inline guard in the head, before the body exists, so the login shell is
 *    never painted; this checks the guard is served, is installed, and is removed once the app is up.
 * 2. /api/auth/me hands the session cookie back when it authenticated the request from the token, so the next
 *    page load is rendered signed in.
 * 3. Opening a second room used to leave the previous room's messages on screen behind the opening animation.
 */
const { chromium } = require("playwright");
const WebSocket = require("ws");

const BASE = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/$/, "");
const stamp = Date.now().toString(36);
let passed = 0, failed = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ""}`); }
};

const post = (route, body, cookie = "") => fetch(BASE + route, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
const cookieOf = response => response.headers.get("set-cookie").split(";")[0];
const get = (route, headers = {}) => fetch(BASE + route, { headers, redirect: "manual" });

(async () => {
  console.log(`\nboot and room switch on ${BASE}`);
  const username = `boot_${stamp}`;
  const signup = await post("/api/auth/signup", { username, age: 24, adultConfirmed: true });
  const signedUp = await signup.json();
  const cookie = cookieOf(signup), token = signedUp.token;
  const marker = `stale-${stamp}`;
  const roomA = (await (await post("/api/rooms", { name: `Boot A ${stamp}`, vibe: "First room.", access: "open", theme: "ocean" }, cookie)).json()).room;
  const roomB = (await (await post("/api/rooms", { name: `Boot B ${stamp}`, vibe: "Second room.", access: "open", theme: "forest" }, cookie)).json()).room;
  if (!roomA?.id || !roomB?.id) throw new Error("room creation failed");

  /* ------------------------------------------------ the guard, and the cookie it heals */
  const shell = await (await get("/rooms")).text();
  ok("the page shell ships the boot guard", shell.includes("bootGuard") && shell.includes("nearby_auth_token"));
  const cookieOnly = await get("/api/auth/me", { Cookie: cookie });
  ok("a cookie session still answers /api/auth/me", cookieOnly.status === 200);
  const tokenOnly = await get("/api/auth/me", { Authorization: `Bearer ${token}` });
  const healed = tokenOnly.headers.getSetCookie ? tokenOnly.headers.getSetCookie().join(";") : tokenOnly.headers.get("set-cookie") || "";
  ok("a token-only session gets the cookie back", tokenOnly.status === 200 && healed.includes("nearby_session=") && healed.includes("Max-Age"), healed.slice(0, 80));

  const browser = await chromium.launch({ headless: true });
  const errors = [];
  try {
    /* ------------------------------------------- a browser with the token and no cookie */
    const tokenContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await tokenContext.addInitScript(value => localStorage.setItem("nearby_auth_token", value), token);
    const tokenPage = await tokenContext.newPage();
    tokenPage.on("pageerror", error => errors.push(error.message));
    // "commit" stops at the first byte: nothing has been parsed yet when the next call runs.
    await tokenPage.goto(`${BASE}/rooms`, { waitUntil: "commit" });
    await tokenPage.waitForSelector("#bootGuard", { state: "attached", timeout: 8000 });
    const hiddenAtBoot = await tokenPage.evaluate(() => {
      const auth = document.querySelector("#authView");
      return { guard: Boolean(document.querySelector("#bootGuard")), authDisplay: auth ? getComputedStyle(auth).display : "missing", authHidden: auth ? auth.hidden : null };
    });
    ok("the login shell cannot paint before the token is checked", hiddenAtBoot.authDisplay === "none", JSON.stringify(hiddenAtBoot));
    // The guard is only removed once the boot has decided which view belongs on screen, so its removal is the
    // moment the login shell would have been able to paint.
    await tokenPage.waitForSelector("#bootGuard", { state: "detached", timeout: 15000 });
    const afterBoot = await tokenPage.evaluate(() => ({
      authHidden: document.querySelector("#authView").hidden,
      appShown: !document.querySelector("#appView").hidden,
      guard: Boolean(document.querySelector("#bootGuard")),
      booting: document.documentElement.hasAttribute("data-booting")
    }));
    ok("the app is shown and the login shell stays hidden", afterBoot.authHidden && afterBoot.appShown, JSON.stringify(afterBoot));
    ok("the guard is removed once the boot knows", !afterBoot.guard && !afterBoot.booting, JSON.stringify(afterBoot));

    /* ------------------------------------------------------ a room switch shows no old room */
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const [cookieName, cookieValue] = cookie.split("=");
    await context.addCookies([{ name: cookieName, value: cookieValue, url: BASE }]);
    await context.addInitScript(() => localStorage.setItem("chatblink.pushPrompted", "1"));
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${BASE}/room/${roomA.id}`, { waitUntil: "domcontentloaded" });
    await page.locator("#chatPanel:not([hidden])").waitFor();
    await page.locator("#chatPanel[data-loaded]").waitFor({ timeout: 15000 });
    const socket = new WebSocket(`${BASE.replace(/^http/, "ws")}/?room=${encodeURIComponent(roomA.id)}`, { headers: { Cookie: cookie, Origin: BASE } });
    await new Promise((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    socket.send(JSON.stringify({ type: "message", kind: "text", content: marker }));
    await page.locator("#messageList", { hasText: marker }).waitFor({ timeout: 8000 });

    await page.goto(`${BASE}/rooms`, { waitUntil: "domcontentloaded" });
    const card = page.locator(`.room-card[data-room-id="${roomB.id}"]`);
    await card.waitFor({ timeout: 15000 });
    await card.click();
    const onSwitch = await page.evaluate(() => ({
      roomName: document.querySelector("#roomName").textContent,
      messages: document.querySelector("#messageList").textContent,
      loaded: document.querySelector("#chatPanel").hasAttribute("data-loaded"),
      loaderPresent: Boolean(document.querySelector("#roomLoader"))
    }));
    ok("the next room's header is what shows", onSwitch.roomName === `Boot B ${stamp}`, onSwitch.roomName);
    ok("the previous room's messages are gone at once", !onSwitch.messages.includes(`stale-${stamp}`), onSwitch.messages.slice(0, 120));
    ok("there is no opening animation over the room any more", !onSwitch.loaderPresent && onSwitch.loaded === false);
    await page.locator("#chatPanel[data-loaded]").waitFor({ timeout: 15000 });
    ok("the room is marked loaded once its history lands", await page.evaluate(() => document.querySelector("#chatPanel").hasAttribute("data-loaded")));
    ok("and the new room arrives with no trace of the old one", !(await page.locator("#messageList").innerText()).includes(`stale-${stamp}`));
    socket.close();
    ok("no page errors", errors.length === 0, errors.join(" | "));
  } finally {
    await browser.close();
    for (const room of [roomA, roomB]) await fetch(`${BASE}/api/rooms/${room.id}`, { method: "DELETE", headers: { Origin: BASE, Cookie: cookie } });
  }
  console.log(`\n${failed === 0 ? "ALL GOOD" : "FAILURES"} - ${passed} passed, ${failed} failed  (account: ${username})`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(error => { console.error(`\nboot test crashed: ${error instanceof Error ? error.message : error}`); process.exit(1); });
