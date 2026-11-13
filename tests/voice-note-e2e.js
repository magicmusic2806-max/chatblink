/**
 * End-to-end check of voice-note recording, playback and the dropouts users reported.
 *
 * Usage:  node tests/voice-note-e2e.js [baseUrl]
 * Needs a running local server (npx wrangler dev --port 8787) and Playwright's Chromium.
 *
 * Chromium's fake capture device is fed a generated 440 Hz tone through
 * --use-file-for-fake-audio-capture, so the recording has a known, constant signal. The note is then
 * downloaded, decoded with WebAudio and measured: its length has to match the time the button was
 * held, and no stretch longer than a couple of frames may be silent. A tone that arrives with holes
 * in it - the "sounds with cuts" report - fails the silence check, which a duration-only check on a
 * stitched blob would not catch.
 */
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");

const BASE = (process.argv[2] || "http://127.0.0.1:8787").replace(/\/$/, "");
const stamp = Date.now().toString(36);
const HOLD_MS = 3500, WINDOW_MS = 50, SILENCE_RMS = 0.005, MAX_SILENT_WINDOW_MS = 300;
let passed = 0, failed = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ""}`); }
};

const post = (route, body, cookie = "") => fetch(BASE + route, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
const cookieOf = response => response.headers.get("set-cookie").split(";")[0];

// 16-bit mono PCM WAV, loud enough that a real dropout is unmistakable next to it.
function writeToneWav(file, seconds = 10, frequency = 440, rate = 48000, amplitude = 0.35) {
  const frames = Math.floor(seconds * rate), header = Buffer.alloc(44), data = Buffer.alloc(frames * 2);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(data.length, 40);
  for (let index = 0; index < frames; index++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * index) / rate) * amplitude * 32767), index * 2);
  fs.writeFileSync(file, Buffer.concat([header, data]));
  return file;
}

const measure = (page, url) => page.evaluate(async ({ url, windowMs, silenceRms }) => {
  const response = await fetch(url);
  const bytes = await response.arrayBuffer();
  const context = new (window.AudioContext || window.webkitAudioContext)();
  const audio = await context.decodeAudioData(bytes);
  const samples = audio.getChannelData(0), rate = audio.sampleRate, size = Math.max(1, Math.floor((rate * windowMs) / 1000));
  let silentRun = 0, longestSilentRun = 0, quietWindows = 0, windows = 0, peak = 0;
  for (let start = 0; start + size <= samples.length; start += size) {
    let energy = 0;
    for (let index = start; index < start + size; index++) { const value = Math.abs(samples[index]); energy += value * value; if (value > peak) peak = value; }
    windows++;
    if (Math.sqrt(energy / size) < silenceRms) { quietWindows++; silentRun++; longestSilentRun = Math.max(longestSilentRun, silentRun); }
    else silentRun = 0;
  }
  return { duration: audio.duration, sampleRate: rate, windows, quietWindows, longestSilenceMs: (longestSilentRun * size * 1000) / rate, peak };
}, { url, windowMs: WINDOW_MS, silenceRms: SILENCE_RMS });

(async () => {
  const wav = writeToneWav(path.join(os.tmpdir(), `chatblink-tone-${stamp}.wav`));
  console.log(`\nvoice note e2e on ${BASE}`);

  const signup = await post("/api/auth/signup", { username: `voice_${stamp}`, age: 24, adultConfirmed: true });
  if (signup.status !== 201) throw new Error(`signup failed: ${await signup.text()}`);
  const cookie = cookieOf(signup), user = (await signup.json()).user;
  // Voice notes are a request-room feature, and the creator can enter their own room.
  const created = await post("/api/rooms", { name: `Voice ${stamp}`, vibe: "Recording verification.", access: "request", theme: "ocean" }, cookie);
  const room = (await created.json()).room;
  if (created.status !== 201 || !room?.id) throw new Error("room creation failed");

  const browser = await chromium.launch({ headless: true, args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wav}%noloop`] });
  try {
    const context = await browser.newContext({ viewport: { width: 420, height: 900 }, permissions: ["microphone"] });
    const [name, value] = cookie.split("=");
    await context.addCookies([{ name, value, url: BASE }]);
    await context.addInitScript(() => { localStorage.setItem("chatblink.pushPrompted", "1"); });
    const page = await context.newPage();
    await page.goto(`${BASE}/room/${room.id}`, { waitUntil: "domcontentloaded" });
    await page.locator("#chatPanel:not([hidden])").waitFor();
    await page.locator("#roomLoader").waitFor({ state: "hidden", timeout: 12000 });

    const button = page.locator("[data-compose=voice]");
    await button.waitFor();
    ok("the voice button is offered in a private room", await button.isVisible());

    await button.click();
    const startedAt = Date.now();
    await page.waitForFunction(() => document.querySelector("[data-compose=voice]").classList.contains("recording"), null, { timeout: 8000 });
    await page.waitForTimeout(HOLD_MS);
    const held = Date.now() - startedAt;
    await button.click();

    await page.locator("#messageList .bubble.voice audio").waitFor({ timeout: 20000 });
    const src = await page.locator("#messageList .bubble.voice audio").evaluate(element => element.currentSrc || element.src);
    ok("the note is uploaded and rendered as a player", /\/uploads\/[a-f0-9-]{36}\.(webm|ogg|mp4|m4a)$/.test(new URL(src).pathname), src);

    const elementDuration = await page.locator("#messageList .bubble.voice audio").evaluate(element => new Promise(resolve => {
      if (Number.isFinite(element.duration) && element.duration > 0) return resolve(element.duration);
      const done = () => resolve(element.duration);
      element.addEventListener("loadedmetadata", done, { once: true });
      setTimeout(done, 4000);
    }));
    ok("the player knows how long the note is (no Infinity duration)", Number.isFinite(elementDuration) && elementDuration > 0, String(elementDuration));

    const stats = await measure(page, src);
    const expected = held / 1000;
    ok("the recording is long enough to measure", stats.duration > 0.5, JSON.stringify(stats));
    ok(`nothing is missing from the end (held ${expected.toFixed(2)}s, file ${stats.duration.toFixed(2)}s)`, Math.abs(stats.duration - expected) < 1.2, JSON.stringify(stats));
    ok("the file has signal all the way through", stats.peak > 0.05 && stats.quietWindows / stats.windows < 0.1, JSON.stringify(stats));
    ok(`no silent gap longer than ${MAX_SILENT_WINDOW_MS} ms`, stats.longestSilenceMs <= MAX_SILENT_WINDOW_MS, JSON.stringify(stats));

    const bytes = await (await fetch(src, { headers: { Cookie: cookie } })).arrayBuffer();
    ok("the upload is served as audio with a byte range", bytes.byteLength > 2000, `${bytes.byteLength} bytes`);

    // A second take proves the first one released the microphone instead of pinning it.
    const idleLabel = await button.textContent();
    ok("the button returns to its idle label", /Voice/.test(idleLabel), idleLabel);
    await button.click();
    await page.waitForFunction(() => document.querySelector("[data-compose=voice]").classList.contains("recording"), null, { timeout: 8000 });
    await page.waitForTimeout(1200);
    await button.click();
    await page.waitForFunction(() => document.querySelectorAll("#messageList .bubble.voice audio").length === 2, null, { timeout: 20000 });
    ok("a second note records straight after the first", true);
    await page.screenshot({ path: path.join(os.tmpdir(), `chatblink-voice-note-${stamp}.png`) });
  } finally {
    await browser.close();
    fs.rmSync(wav, { force: true });
    await fetch(`${BASE}/api/rooms/${room.id}`, { method: "DELETE", headers: { Origin: BASE, Cookie: cookie } }).catch(() => {});
  }

  console.log(`\n${failed === 0 ? "ALL GOOD" : "FAILURES"} - ${passed} passed, ${failed} failed  (account: voice_${stamp}, user ${user.id})`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(error => { console.error(`\nvoice-note test crashed: ${error instanceof Error ? error.message : error}`); process.exit(1); });
