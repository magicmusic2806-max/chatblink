/** Browser-level check for compact room messages and three-line room-card previews. */
const { chromium } = require("playwright");
const WebSocket = require("ws");
const path = require("path"), os = require("os");

const BASE = (process.argv[2] || "http://127.0.0.1:8799").replace(/\/$/, ""), stamp = Date.now().toString(36);
const post = (route, body, cookie = "") => fetch(BASE + route, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
const cookieOf = response => response.headers.get("set-cookie").split(";")[0];

(async () => {
  const peerSignup = await post("/api/auth/signup", { username: `design_peer_${stamp}`, age: 24, adultConfirmed: true });
  if (peerSignup.status !== 201) throw new Error(`peer signup failed: ${await peerSignup.text()}`);
  const peerCookie = cookieOf(peerSignup), peerUser = (await peerSignup.json()).user;
  const signup = await post("/api/auth/signup", { username: `design_${stamp}`, age: 24, adultConfirmed: true }), cookie = cookieOf(signup);
  if (signup.status !== 201) throw new Error(`signup failed: ${await signup.text()}`);
  const user = (await signup.json()).user;
  const created = await post("/api/rooms", { name: `Design ${stamp}`, vibe: "Browser design verification.", access: "open", theme: "forest" }, cookie), room = (await created.json()).room;
  if (created.status !== 201 || !room?.id) throw new Error("room creation failed");
  const browser = await chromium.launch({ headless: true }); let peerSocket;
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const [name, value] = cookie.split("="); await context.addCookies([{ name, value, url: BASE }]);
    await context.addInitScript(() => localStorage.setItem("chatblink.pushPrompted", "1"));
    const page = await context.newPage();
    await page.goto(`${BASE}/room/${room.id}`, { waitUntil: "domcontentloaded" });
    await page.locator("#chatPanel:not([hidden])").waitFor(); await page.locator("#roomLoader").waitFor({ state: "hidden", timeout: 10000 });
    peerSocket = new WebSocket(`${BASE.replace(/^http/, "ws")}/?room=${room.id}`, { headers: { Cookie: peerCookie, Origin: BASE } });
    await new Promise((resolve, reject) => { peerSocket.once("open", resolve); peerSocket.once("error", reject); });
    for (let index = 1; index <= 4; index++) { await page.locator("#chatInput").fill(`Compact message ${index}`); await page.locator("#chatInput").press("Enter"); }
    await page.locator("#messageList .message").nth(3).waitFor();
    peerSocket.send(JSON.stringify({ type: "message", kind: "text", content: "Incoming sky message" }));
    await page.locator("#messageList .message:not(.me) .bubble.text").waitFor();
    const compactCount = await page.locator("#messageList .message.compact").count();
    const roomOwnStyle = await page.locator("#messageList .message.me .bubble.text").first().evaluate(element => { const style = getComputedStyle(element), rect = element.getBoundingClientRect(); return { background: style.backgroundColor, color: style.color, left: Math.round(rect.left) }; });
    const roomOtherStyle = await page.locator("#messageList .message:not(.me) .bubble.text").evaluate(element => { const style = getComputedStyle(element), rect = element.getBoundingClientRect(); return { background: style.backgroundColor, color: style.color, left: Math.round(rect.left) }; });
    await page.screenshot({ path: path.join(os.tmpdir(), "chatblink-room-dense-mobile.png") });
    await page.locator('#chatPanel [data-action="dms"]').click();
    const peer = page.locator("#peopleList .people-item", { hasText: `design_peer_${stamp}` }); await peer.waitFor(); await peer.click();
    await page.locator("#dmInput").fill("My orange message"); await page.locator("#dmInput").press("Enter");
    const dmOwn = page.locator("#dmMessages .dm-message.me").last(); await dmOwn.waitFor();
    peerSocket.send(JSON.stringify({ type: "dm", to: user.id, kind: "text", content: "Their sky message" }));
    const dmOther = page.locator("#dmMessages .dm-message:not(.me)").last(); await dmOther.waitFor();
    const dmOwnStyle = await dmOwn.evaluate(element => { const style = getComputedStyle(element), rect = element.getBoundingClientRect(); return { background: style.backgroundColor, color: style.color, align: style.alignSelf, left: Math.round(rect.left) }; });
    const dmOtherStyle = await dmOther.evaluate(element => { const style = getComputedStyle(element), rect = element.getBoundingClientRect(); return { background: style.backgroundColor, color: style.color, align: style.alignSelf, left: Math.round(rect.left) }; });
    await page.screenshot({ path: path.join(os.tmpdir(), "chatblink-dm-two-sided-mobile.png") });
    await page.locator('#dmsView [data-action="rooms"]').click();
    const card = page.locator(`#roomsGrid .room-card[data-room-id="${room.id}"]`); await card.waitFor();
    const preview = await card.locator(".rc-preview-line span").allTextContents();
    await card.scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(os.tmpdir(), "chatblink-room-cards-mobile.png") });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({ path: path.join(os.tmpdir(), "chatblink-room-cards-desktop.png"), fullPage: true });
    const ownColours = style => style.background === "rgb(196, 123, 67)" && style.color === "rgb(32, 19, 10)", otherColours = style => style.background === "rgb(40, 126, 170)" && style.color === "rgb(255, 255, 255)";
    const good = compactCount === 3 && ownColours(roomOwnStyle) && otherColours(roomOtherStyle) && roomOwnStyle.left > roomOtherStyle.left && ownColours(dmOwnStyle) && otherColours(dmOtherStyle) && dmOwnStyle.align === "flex-end" && dmOtherStyle.align === "flex-start" && dmOwnStyle.left > dmOtherStyle.left && preview.length === 3 && preview[0] === "Compact message 3" && preview[2] === "Incoming sky message";
    console.log(JSON.stringify({ compactCount, roomOwnStyle, roomOtherStyle, dmOwnStyle, dmOtherStyle, peer: peerUser.username, preview, mobile: "chatblink-room-cards-mobile.png", dm: "chatblink-dm-two-sided-mobile.png", desktop: "chatblink-room-cards-desktop.png", pass: good }));
    if (!good) process.exitCode = 1;
  } finally {
    peerSocket?.close();
    await browser.close();
    await fetch(`${BASE}/api/rooms/${room.id}`, { method: "DELETE", headers: { Origin: BASE, Cookie: cookie } }).catch(() => {});
  }
})().catch(error => { console.error(error); process.exit(1); });
