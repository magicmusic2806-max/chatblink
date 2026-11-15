/**
 * Browser-level check of the room (group) voice call: two real Chromium contexts join the same call
 * in a request-only room and have to reach a connected peer-to-peer mesh with audio on both sides.
 *
 * Usage:  node tests/group-call-e2e.js [baseUrl]
 * Needs a running local server (npx wrangler dev --port 8787) and Playwright's Chromium.
 *
 * Audio is the fake microphone device on both sides, so this proves the mesh really forms: one
 * RTCPeerConnection per other participant, a live remote audio track, and the matching teardown.
 */
const { chromium } = require("playwright");
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
const cookiePair = response => {
  const pair = response.headers.get("set-cookie").split(";")[0], index = pair.indexOf("=");
  return { name: pair.slice(0, index), value: pair.slice(index + 1), url: BASE };
};
const cookieHeader = response => response.headers.get("set-cookie").split(";")[0];
const signup = async name => {
  const response = await post("/api/auth/signup", { username: name, age: 24, adultConfirmed: true });
  if (response.status !== 201) throw new Error(`signup failed: ${await response.text()}`);
  const body = await response.json();
  return { account: body, cookie: cookiePair(response), header: cookieHeader(response) };
};

// What the page itself believes about the call: one peer entry per other participant.
const callState = page => page.evaluate(() => ({
  inCall: Boolean(groupCall),
  callId: groupCall && groupCall.callId,
  peers: groupCall ? [...groupCall.peers.entries()].map(([userId, entry]) => ({ userId, connection: entry.peer.connectionState, ice: entry.peer.iceConnectionState, remoteAudio: entry.remote && entry.remote.srcObject ? entry.remote.srcObject.getAudioTracks().length : 0 })) : [],
  localAudio: groupCall ? groupCall.local.getAudioTracks().length : 0,
  muted: groupCall ? groupCall.muted : null,
  dockHidden: document.querySelector("#groupCall").hidden,
  people: [...document.querySelectorAll("#groupCallPeople .gc-person")].map(node => node.textContent),
  remoteElements: document.querySelectorAll("#groupCallAudio audio").length,
  button: document.querySelector("#groupCallButton").textContent
}));
const waitConnected = page => page.waitForFunction(() => Boolean(groupCall) && groupCall.peers.size > 0 && [...groupCall.peers.values()].every(entry => entry.peer.connectionState === "connected"), null, { timeout: 20000 });

(async () => {
  console.log(`\nroom call e2e on ${BASE}`);
  const owner = await signup(`grp_owner_${stamp}`), guest = await signup(`grp_guest_${stamp}`);
  const room = (await (await post("/api/rooms", { name: `Group ${stamp}`, vibe: "Group call e2e.", access: "request", theme: "berry" }, owner.header)).json()).room;
  if (!room?.id) throw new Error("room creation failed");
  await post(`/api/rooms/${room.id}/request`, {}, guest.header);
  await post(`/api/rooms/${room.id}/requests/${guest.account.user.id}`, { action: "approve" }, owner.header);

  const browser = await chromium.launch({ headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  try {
    const contextA = await browser.newContext({ viewport: { width: 420, height: 900 } }), contextB = await browser.newContext({ viewport: { width: 420, height: 900 } });
    await contextA.addCookies([owner.cookie]); await contextB.addCookies([guest.cookie]);
    await contextA.grantPermissions(["microphone"], { origin: BASE }); await contextB.grantPermissions(["microphone"], { origin: BASE });
    const pageA = await contextA.newPage(), pageB = await contextB.newPage();
    for (const page of [pageA, pageB]) {
      await page.addInitScript(() => localStorage.setItem("chatblink.pushPrompted", "1"));
      await page.goto(`${BASE}/room/${room.id}`, { waitUntil: "domcontentloaded" });
      await page.locator("#chatPanel:not([hidden])").waitFor();
      await page.locator("#chatPanel[data-loaded]").waitFor({ timeout: 12000 });
    }

    const before = await callState(pageA);
    ok("the call button is offered in a private room and the dock is closed", !before.dockHidden === false && (await pageA.locator("#groupCallButton").isVisible()), JSON.stringify(before));

    await pageA.locator("#groupCallButton").click();
    await pageA.locator("#groupCall:not([hidden])").waitFor();
    const opened = await callState(pageA);
    ok("the creator joins alone and the dock lists them", opened.inCall && opened.people.length === 1 && opened.localAudio === 1, JSON.stringify(opened));

    await pageB.waitForFunction(() => document.querySelector("#groupCallButton").textContent.includes("Join call"), null, { timeout: 10000 });
    ok("the other member is offered the live call", (await pageB.locator("#groupCallButton").textContent()).includes("Join call (1)"));

    await pageB.locator("#groupCallButton").click();
    await pageB.locator("#groupCall:not([hidden])").waitFor();
    try { await Promise.all([waitConnected(pageA), waitConnected(pageB)]); }
    catch (error) { console.error("states", await callState(pageA), await callState(pageB)); throw error; }

    const both = await Promise.all([callState(pageA), callState(pageB)]);
    ok("both sides report one connected peer", both.every(state => state.peers.length === 1 && state.peers[0].connection === "connected"), JSON.stringify(both));
    ok("audio flows both ways", both.every(state => state.localAudio === 1 && state.peers[0].remoteAudio === 1), JSON.stringify(both));
    ok("each side shows two members in the dock", both.every(state => state.people.length === 2), JSON.stringify(both.map(state => state.people)));
    ok("the remote audio element is attached and playing", await pageA.evaluate(() => { const audio = document.querySelector("#groupCallAudio audio"); return Boolean(audio) && Boolean(audio.srcObject) && audio.srcObject.getAudioTracks().length === 1 && audio.paused === false; }), await pageA.evaluate(() => { const audio = document.querySelector("#groupCallAudio audio"); return audio ? { paused: audio.paused, readyState: audio.readyState, hiddenParent: audio.parentElement.hidden } : null; }));

    await pageA.locator("#groupCallMute").click();
    const muted = await callState(pageA);
    ok("mute flips the button and the local track", muted.muted === true && (await pageA.locator("#groupCallMute").textContent()).includes("Unmute"), JSON.stringify(muted));
    await pageA.locator("#groupCallMute").click();

    await pageA.screenshot({ path: path.join(os.tmpdir(), `chatblink-room-call-${stamp}.png`) });

    await pageA.locator("#groupCallLeave").click();
    await pageA.locator("#groupCall").waitFor({ state: "hidden" });
    await pageB.waitForFunction(() => document.querySelectorAll("#groupCallPeople .gc-person").length === 1, null, { timeout: 10000 });
    const afterLeave = await Promise.all([callState(pageA), callState(pageB)]);
    ok("leaving closes the dock and the peer on the leaving side", afterLeave[0].inCall === false && afterLeave[0].dockHidden, JSON.stringify(afterLeave[0]));
    ok("the member who stays sees them drop out of the call", afterLeave[1].peers.length === 0 && afterLeave[1].people.length === 1 && afterLeave[1].remoteElements === 0, JSON.stringify(afterLeave[1]));

    await pageB.locator("#groupCallLeave").click();
    await pageB.locator("#groupCall").waitFor({ state: "hidden" });
    ok("the last member leaving ends the call for the room", (await pageA.locator("#groupCallButton").textContent()).includes("Group call"), await pageA.locator("#groupCallButton").textContent());

    /* ------------------------------------------------- ending it as the host */
    await pageA.locator("#groupCallButton").click();
    await pageA.locator("#groupCall:not([hidden])").waitFor();
    await pageB.waitForFunction(() => document.querySelector("#groupCallButton").textContent.includes("Join call"), null, { timeout: 10000 });
    await pageB.locator("#groupCallButton").click();
    await pageB.locator("#groupCall:not([hidden])").waitFor();
    try { await Promise.all([waitConnected(pageA), waitConnected(pageB)]); }
    catch (error) { console.error("states", await callState(pageA), await callState(pageB)); throw error; }

    ok("only the starter is offered the end-call control", (await pageA.locator("#groupCallEnd").isVisible()) && (await pageB.locator("#groupCallEnd").isHidden()), JSON.stringify({ host: await pageA.locator("#groupCallEnd").isVisible(), guest: await pageB.locator("#groupCallEnd").isVisible() }));

    await pageA.locator("#groupCallEnd").click();
    await pageA.locator("#groupCall").waitFor({ state: "hidden" });
    await pageB.locator("#groupCall").waitFor({ state: "hidden" });
    await pageB.waitForFunction(() => document.querySelector("#groupCallButton").textContent.includes("Group call"), null, { timeout: 10000 });
    const afterEnd = await Promise.all([callState(pageA), callState(pageB)]);
    ok("ending the call hangs up for everybody", afterEnd.every(state => state.inCall === false && state.dockHidden && state.peers.length === 0), JSON.stringify(afterEnd));
    ok("the guest is told the host ended it", await pageB.evaluate(() => document.querySelector("#toast").textContent.includes("ended the room call")), await pageB.evaluate(() => document.querySelector("#toast").textContent));
  } finally {
    await browser.close();
    await fetch(`${BASE}/api/rooms/${room.id}`, { method: "DELETE", headers: { Origin: BASE, Cookie: owner.header } }).catch(() => {});
  }

  console.log(`\n${failed === 0 ? "ALL GOOD" : "FAILURES"} - ${passed} passed, ${failed} failed  (accounts: grp_*_${stamp})`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(error => { console.error(`\nroom-call e2e crashed: ${error instanceof Error ? error.message : error}`); process.exit(1); });
