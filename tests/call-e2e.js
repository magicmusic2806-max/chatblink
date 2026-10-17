/**
 * Browser-level WebRTC check. Start `npx wrangler dev --port 8799`, then run:
 *   npm run test:calls
 */
const { chromium } = require("playwright");
const path = require("path"), os = require("os");

const BASE = (process.argv[2] || "http://127.0.0.1:8799").replace(/\/$/, "");
const stamp = Date.now().toString(36);
const post = (path, body) => fetch(BASE + path, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify(body) });
const cookie = response => { const pair = response.headers.get("set-cookie").split(";")[0], index = pair.indexOf("="); return { name: pair.slice(0, index), value: pair.slice(index + 1), url: BASE }; };
const signup = async name => { const response = await post("/api/auth/signup", { username: name, age: 24, adultConfirmed: true }); const account = await response.json(); if (response.status !== 201) throw new Error(`signup failed: ${JSON.stringify(account)}`); return { account, cookie: cookie(response) }; };
const waitConnected = page => page.waitForFunction(() => document.querySelector("#callStatus")?.textContent.startsWith("Connected"), null, { timeout: 15000 });
const peerState = page => page.evaluate(() => ({ status: document.querySelector("#callStatus")?.textContent, hidden: document.querySelector("#callOverlay")?.hidden, trace: window.__callTrace, call: currentCall && { role: currentCall.role, candidates: currentCall.candidates.length, local: currentCall.peer?.localDescription?.type, remote: currentCall.peer?.remoteDescription?.type, connection: currentCall.peer?.connectionState, ice: currentCall.peer?.iceConnectionState, signaling: currentCall.peer?.signalingState } }));
async function connectBoth(pageA, pageB) { try { await Promise.all([waitConnected(pageA), waitConnected(pageB)]); } catch (error) { console.error("peer states", await peerState(pageA), await peerState(pageB)); throw error; } }

(async () => {
  const first = await signup(`call_first_${stamp}`), second = await signup(`call_second_${stamp}`);
  const browser = await chromium.launch({ headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
  try {
    const contextA = await browser.newContext({ viewport: { width: 390, height: 844 } }), contextB = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await contextA.addCookies([first.cookie]); await contextB.addCookies([second.cookie]);
    await contextA.grantPermissions(["microphone", "camera"], { origin: BASE }); await contextB.grantPermissions(["microphone", "camera"], { origin: BASE });
    const pageA = await contextA.newPage(), pageB = await contextB.newPage();
    for (const page of [pageA, pageB]) await page.addInitScript(() => localStorage.setItem("chatblink.pushPrompted", "1"));
    await Promise.all([pageA.goto(BASE + "/dms", { waitUntil: "domcontentloaded" }), pageB.goto(BASE + "/dms", { waitUntil: "domcontentloaded" })]);
    await Promise.all([pageA.locator("#dmsView:not([hidden])").waitFor(), pageB.locator("#dmsView:not([hidden])").waitFor()]);
    for (const page of [pageA, pageB]) await page.evaluate(() => { window.__callTrace = []; const original = handleCallSignal; handleCallSignal = async event => { window.__callTrace.push(event.type); return original(event); }; const originalFail = failCall; failCall = message => { window.__callTrace.push("fail:" + message); return originalFail(message); }; });
    await pageA.evaluate(person => openDm(person), second.account.user); await pageB.evaluate(person => openDm(person), first.account.user);
    await Promise.all([
      pageA.screenshot({ path: path.join(os.tmpdir(), "chatblink-dm-mobile.png"), fullPage: true }),
      pageB.screenshot({ path: path.join(os.tmpdir(), "chatblink-dm-desktop.png"), fullPage: true })
    ]);

    await pageA.locator("#dmVoiceCall").click();
    await pageB.locator("#callOverlay:not([hidden])").waitFor();
    await pageB.locator("#callAccept").click();
    await connectBoth(pageA, pageB);
    const voice = await Promise.all([pageA, pageB].map(page => page.evaluate(() => ({ state: currentCall.peer.connectionState, localAudio: currentCall.local.getAudioTracks().length, remoteAudio: document.querySelector("#callRemoteVideo").srcObject.getAudioTracks().length }))));
    await pageA.locator("#callHangup").click();
    await pageB.locator("#callOverlay").waitFor({ state: "hidden" });

    await pageB.locator("#dmVideoCall").click();
    await pageA.locator("#callOverlay:not([hidden])").waitFor();
    await pageA.locator("#callAccept").click();
    await connectBoth(pageA, pageB);
    await Promise.all([pageA.waitForTimeout(350), pageB.waitForTimeout(350)]);
    const video = await Promise.all([pageA, pageB].map(page => page.evaluate(() => ({ state: currentCall.peer.connectionState, localVideo: currentCall.local.getVideoTracks().length, remoteVideo: document.querySelector("#callRemoteVideo").srcObject.getVideoTracks().length, identityOpacity: getComputedStyle(document.querySelector(".call-identity")).opacity, controlsVisible: !document.querySelector("#callControls").hidden && document.querySelector("#callHangup").getBoundingClientRect().height > 0 }))));
    await pageA.screenshot({ path: path.join(os.tmpdir(), "chatblink-video-call-mobile.png") });
    await pageB.locator("#callHangup").click();
    await pageA.locator("#callOverlay").waitFor({ state: "hidden" });

    const voiceGood = voice.every(item => item.state === "connected" && item.localAudio === 1 && item.remoteAudio === 1);
    const videoGood = video.every(item => item.state === "connected" && item.localVideo === 1 && item.remoteVideo === 1 && item.identityOpacity === "0" && item.controlsVisible);
    console.log(JSON.stringify({ voice: voiceGood, video: videoGood, voicePeers: voice, videoPeers: video }));
    if (!voiceGood || !videoGood) process.exitCode = 1;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
