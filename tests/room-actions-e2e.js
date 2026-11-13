/**
 * Browser-level check of reply, reactions and deletion inside a room, and of what a room card shows.
 *
 * Usage:  node tests/room-actions-e2e.js [baseUrl]
 * Needs a running local server (npx wrangler dev --port 8787) and Playwright's Chromium.
 *
 * The peer talks over a raw WebSocket so the page is always acting on somebody else's message - the
 * case that has to show tools (a member may not delete another member's message) and the case in
 * which a reply quote points at a message the viewer did not write.
 */
const { chromium } = require("playwright");
const WebSocket = require("ws");
const path = require("path");
const os = require("os");

const BASE = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/$/, "");
const stamp = Date.now().toString(36);
let passed = 0, failed = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ""}`); }
};

const post = (route, body, cookie = "") => fetch(BASE + route, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
const cookieOf = response => response.headers.get("set-cookie").split(";")[0];

(async () => {
  console.log(`\nroom actions e2e on ${BASE}`);
  const ownerSignup = await post("/api/auth/signup", { username: `ui_owner_${stamp}`, age: 24, adultConfirmed: true });
  const peerSignup = await post("/api/auth/signup", { username: `ui_peer_${stamp}`, age: 24, adultConfirmed: true });
  if (ownerSignup.status !== 201 || peerSignup.status !== 201) throw new Error("signup failed");
  const ownerCookie = cookieOf(ownerSignup), peerCookie = cookieOf(peerSignup);
  const owner = (await ownerSignup.json()).user, peer = (await peerSignup.json()).user;

  const created = await post("/api/rooms", { name: `Actions ${stamp}`, vibe: "Replies and reactions.", access: "open", theme: "forest" }, ownerCookie);
  const room = (await created.json()).room;
  if (created.status !== 201 || !room?.id) throw new Error("room creation failed");

  const browser = await chromium.launch({ headless: true });
  let peerSocket, privateRoom = null;
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
    const [name, value] = ownerCookie.split("=");
    await context.addCookies([{ name, value, url: BASE }]);
    await context.addInitScript(() => { localStorage.setItem("chatblink.pushPrompted", "1"); });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));

    peerSocket = new WebSocket(`${BASE.replace(/^http/, "ws")}/?room=${room.id}`, { headers: { Cookie: peerCookie, Origin: BASE } });
    const inbox = [];
    peerSocket.on("message", raw => { try { inbox.push(JSON.parse(raw)); } catch {} });
    await new Promise((resolve, reject) => { peerSocket.once("open", resolve); peerSocket.once("error", reject); });

    await page.goto(`${BASE}/room/${room.id}`, { waitUntil: "domcontentloaded" });
    await page.locator("#chatPanel:not([hidden])").waitFor();
    await page.locator("#roomLoader").waitFor({ state: "hidden", timeout: 12000 });

    peerSocket.send(JSON.stringify({ type: "message", kind: "text", content: "Peer message" }));
    const peerMessage = page.locator("#messageList .message:not(.me)", { hasText: "Peer message" });
    await peerMessage.waitFor();

    /* ------------------------------------------------------------ reply */
    await peerMessage.locator('.msg-tool[title="Reply"]').click();
    ok("choosing Reply opens the composer bar", await page.locator("#replyBar").isVisible());
    ok("the bar names the member being quoted", (await page.locator("#replyBarText").textContent()).includes(`ui_peer_${stamp}`));
    await page.locator("#chatInput").fill("Replying to you");
    await page.locator("#chatInput").press("Enter");
    const quote = page.locator("#messageList .message.me .msg-quote").first();
    await quote.waitFor();
    ok("the sent message carries a quote of the original", (await quote.textContent()).includes("Peer message"), await quote.textContent());
    ok("the composer bar closes after sending", await page.locator("#replyBar").isHidden());
    await quote.click();
    await page.waitForTimeout(250);
    ok("clicking the quote highlights the original", (await peerMessage.getAttribute("class")).includes("flash"));

    const echoedReply = inbox.find(packet => packet.type === "message" && packet.message.content === "Replying to you");
    ok("the quote travels to the other side as data", echoedReply?.message?.reply?.snippet === "Peer message" && echoedReply.message.reply.username === `ui_peer_${stamp}`, JSON.stringify(echoedReply?.message?.reply));

    /* -------------------------------------------------------- reactions */
    await peerMessage.locator('.msg-tool[title="Add a reaction"]').click();
    ok("the reaction picker opens", await peerMessage.locator(".reaction-picker").isVisible());
    ok("the picker offers exactly the six server reactions", (await peerMessage.locator(".reaction-picker button").count()) === 6);
    await peerMessage.locator('.reaction-picker button[title="React with 👍"]').click();
    const chip = peerMessage.locator(".reaction-chip");
    await chip.waitFor();
    ok("the reaction shows on the message", (await chip.textContent()).includes("👍") && (await chip.textContent()).includes("1"), await chip.textContent());
    await page.waitForTimeout(400);
    const reactionEvent = inbox.find(packet => packet.type === "message-reactions" && packet.reactions["👍"]);
    ok("the reaction is broadcast to the room", Boolean(reactionEvent) && reactionEvent.reactions["👍"].includes(owner.id), JSON.stringify(reactionEvent?.reactions));

    /* --------------------------------------------------------- deletion */
    const creatorTools = await peerMessage.locator(".msg-tool").count();
    ok("the room creator gets reply, react and delete on somebody else's message", creatorTools === 3, `tools ${creatorTools}`);
    ok("the delete control is offered to the creator", (await peerMessage.locator('.msg-tool[title="Delete for everyone"]').count()) === 1);

    await peerMessage.locator('.msg-tool[title="Delete for everyone"]').click();
    const confirm = page.locator("#confirmModal");
    ok("deleting asks for confirmation first", await confirm.isVisible());
    await page.locator("#confirmOk").click();
    await page.locator("#messageList .message.deleted").first().waitFor();
    const deletedText = await page.locator("#messageList .message.deleted").first().textContent();
    ok("the creator's delete replaces the message with a placeholder", deletedText.includes("Message deleted"), deletedText);
    await page.waitForTimeout(400);
    ok("the deletion is broadcast to the room", inbox.some(packet => packet.type === "message-deleted" && packet.by?.username === `ui_owner_${stamp}`));

    /* ------------------------------------------------------- room cards */
    privateRoom = (await (await post("/api/rooms", { name: `Quiet ${stamp}`, vibe: "Private by design.", access: "request", theme: "berry" }, ownerCookie)).json()).room;
    const privateSocket = new WebSocket(`${BASE.replace(/^http/, "ws")}/?room=${privateRoom.id}`, { headers: { Cookie: ownerCookie, Origin: BASE } });
    await new Promise((resolve, reject) => { privateSocket.once("open", resolve); privateSocket.once("error", reject); });
    await new Promise(resolve => setTimeout(resolve, 300));
    privateSocket.send(JSON.stringify({ type: "message", kind: "text", content: "Members only" }));
    await new Promise(resolve => setTimeout(resolve, 600));

    await page.goto(`${BASE}/rooms`, { waitUntil: "domcontentloaded" });
    const openCard = page.locator(`#roomsGrid .room-card[data-room-id="${room.id}"]`);
    await openCard.waitFor();
    ok("an open room card still has its three-line preview area", (await openCard.locator(".rc-preview").count()) === 1);
    const privateCard = page.locator(`#roomsGrid .room-card[data-room-id="${privateRoom.id}"]`);
    await privateCard.waitFor();
    ok("a request-only room card has no preview area at all", (await privateCard.locator(".rc-preview").count()) === 0);
    ok("the private card still says it is a private room", (await privateCard.textContent()).includes("Private room"));
    ok("the private card never mentions its messages", !(await privateCard.textContent()).includes("Members only"));
    await page.screenshot({ path: path.join(os.tmpdir(), `chatblink-room-cards-nopreview-${stamp}.png`) });
    privateSocket.close();

    /* ------------------------------------------------- bare page console */
    await page.goto(`${BASE}/room/${room.id}`, { waitUntil: "domcontentloaded" });
    await page.locator("#messageList .message").first().waitFor();
    await page.locator("#chatInput").fill("still alive");
    await page.locator("#chatInput").press("Enter");
    await page.locator("#messageList .message", { hasText: "still alive" }).waitFor();
    ok("the room keeps working after all of that", errors.length === 0, errors.join(" | "));
  } finally {
    peerSocket?.close();
    await browser.close();
    for (const id of [room.id, privateRoom?.id].filter(Boolean)) await fetch(`${BASE}/api/rooms/${id}`, { method: "DELETE", headers: { Origin: BASE, Cookie: ownerCookie } }).catch(() => {});
  }

  console.log(`\n${failed === 0 ? "ALL GOOD" : "FAILURES"} - ${passed} passed, ${failed} failed  (accounts: ui_*_${stamp}, peer ${peer.id})`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(error => { console.error(`\nroom-actions test crashed: ${error instanceof Error ? error.message : error}`); process.exit(1); });
