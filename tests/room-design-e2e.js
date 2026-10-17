/** Browser-level check for compact room messages and three-line room-card previews. */
const { chromium } = require("playwright");
const path = require("path"), os = require("os");

const BASE = (process.argv[2] || "http://127.0.0.1:8799").replace(/\/$/, ""), stamp = Date.now().toString(36);
const post = (route, body, cookie = "") => fetch(BASE + route, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
const cookieOf = response => response.headers.get("set-cookie").split(";")[0];

(async () => {
  const signup = await post("/api/auth/signup", { username: `design_${stamp}`, age: 24, adultConfirmed: true }), cookie = cookieOf(signup);
  if (signup.status !== 201) throw new Error(`signup failed: ${await signup.text()}`);
  const created = await post("/api/rooms", { name: `Design ${stamp}`, vibe: "Browser design verification.", access: "open", theme: "forest" }, cookie), room = (await created.json()).room;
  if (created.status !== 201 || !room?.id) throw new Error("room creation failed");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const [name, value] = cookie.split("="); await context.addCookies([{ name, value, url: BASE }]);
    await context.addInitScript(() => localStorage.setItem("chatblink.pushPrompted", "1"));
    const page = await context.newPage();
    await page.goto(`${BASE}/room/${room.id}`, { waitUntil: "domcontentloaded" });
    await page.locator("#chatPanel:not([hidden])").waitFor(); await page.locator("#roomLoader").waitFor({ state: "hidden", timeout: 10000 });
    for (let index = 1; index <= 4; index++) { await page.locator("#chatInput").fill(`Compact message ${index}`); await page.locator("#chatInput").press("Enter"); }
    await page.locator("#messageList .message").nth(3).waitFor();
    const compactCount = await page.locator("#messageList .message.compact").count();
    await page.screenshot({ path: path.join(os.tmpdir(), "chatblink-room-dense-mobile.png") });
    await page.locator('#chatPanel [data-action="rooms"]').click();
    const card = page.locator(`#roomsGrid .room-card[data-room-id="${room.id}"]`); await card.waitFor();
    const preview = await card.locator(".rc-preview-line span").allTextContents();
    await card.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(os.tmpdir(), "chatblink-room-cards-mobile.png") });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({ path: path.join(os.tmpdir(), "chatblink-room-cards-desktop.png"), fullPage: true });
    const good = compactCount === 3 && preview.length === 3 && preview[0] === "Compact message 2" && preview[2] === "Compact message 4";
    console.log(JSON.stringify({ compactCount, preview, mobile: "chatblink-room-cards-mobile.png", desktop: "chatblink-room-cards-desktop.png", pass: good }));
    if (!good) process.exitCode = 1;
  } finally {
    await browser.close();
    await fetch(`${BASE}/api/rooms/${room.id}`, { method: "DELETE", headers: { Origin: BASE, Cookie: cookie } }).catch(() => {});
  }
})().catch(error => { console.error(error); process.exit(1); });
