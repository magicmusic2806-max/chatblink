/** Browser-level check for notification setup failure recovery and successful retry. */
const { chromium } = require("playwright");
const path = require("path"), os = require("os");

const BASE = (process.argv[2] || "http://127.0.0.1:8799").replace(/\/$/, ""), stamp = Date.now().toString(36);
const post = (route, body) => fetch(BASE + route, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify(body) });
const cookieOf = response => { const pair = response.headers.get("set-cookie").split(";")[0], index = pair.indexOf("="); return { name: pair.slice(0, index), value: pair.slice(index + 1), url: BASE }; };

(async () => {
  const signup = await post("/api/auth/signup", { username: `push_${stamp}`, age: 24, adultConfirmed: true });
  if (signup.status !== 201) throw new Error(`signup failed: ${await signup.text()}`);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addCookies([cookieOf(signup)]);
    const page = await context.newPage();
    await page.addInitScript(() => {
      let permission = "default";
      Object.defineProperty(Notification, "permission", { configurable: true, get: () => permission });
      Object.defineProperty(Notification, "requestPermission", { configurable: true, value: async () => { permission = "granted"; return permission; } });
      const mock = {
        getSubscription: async () => null,
        subscribe: async () => ({ toJSON: () => ({ endpoint: "https://push.example/chatblink-test", keys: { p256dh: "test-p256dh", auth: "test-auth" } }) })
      };
      const registration = { pushManager: mock };
      Object.defineProperty(Navigator.prototype, "serviceWorker", { configurable: true, get: () => ({ register: async () => registration, ready: Promise.resolve(registration), addEventListener: () => {} }) });
    });
    let configAttempts = 0, failNextConfig = false, failedConfigRequests = 0;
    await page.route("**/api/config", async route => {
      configAttempts++;
      if (failNextConfig) { failNextConfig = false; failedConfigRequests++; await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"temporary"}' }); }
      else await route.continue();
    });
    await page.goto(BASE + "/rooms", { waitUntil: "domcontentloaded" });
    const gate = page.locator("#pushGate"), allow = page.locator(".push-gate-allow"), note = page.locator(".push-gate-note");
    await gate.waitFor();

    failNextConfig = true;
    await allow.click();
    await page.waitForFunction(() => document.querySelector(".push-gate-allow")?.textContent === "Try again");
    const retryReady = await allow.isEnabled(), rememberedTooEarly = await page.evaluate(() => localStorage.getItem("chatblink.pushPrompted"));
    await page.screenshot({ path: path.join(os.tmpdir(), "chatblink-push-retry-mobile.png") });

    await allow.click();
    await gate.waitFor({ state: "hidden", timeout: 15000 });
    const flags = await page.evaluate(() => ({ enabled: localStorage.getItem("chatblink.pushEnabled"), prompted: localStorage.getItem("chatblink.pushPrompted") }));
    const good = retryReady && rememberedTooEarly === null && failedConfigRequests === 1 && flags.enabled === "1" && flags.prompted === "1";
    console.log(JSON.stringify({ retryReady, retryMessage: await note.textContent(), rememberedTooEarly, configAttempts, failedConfigRequests, flags, screenshot: "chatblink-push-retry-mobile.png", pass: good }));
    if (!good) process.exitCode = 1;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
