/** Mobile browser flow for email verification, reset, and login while profile-key auth remains visible. */
const { chromium } = require("playwright");
const path = require("path"), os = require("os");

const BASE = (process.argv[2] || "http://127.0.0.1:8799").replace(/\/$/, ""), stamp = Date.now().toString(36);
const email = `${stamp}@browser.chatblink.test`, username = `email_${stamp}`, firstPassword = "browser-password-42", nextPassword = "browser-password-84";
const post = async (route, body) => { const response = await fetch(BASE + route, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify(body) }); return { response, body: await response.json() }; };

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } }), page = await context.newPage();
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.locator("#signupPane.active").waitFor();
    const initial = await page.evaluate(() => ({ email: Boolean(document.querySelector("#emailSignupForm input[name=email]")), password: Boolean(document.querySelector("#emailSignupForm input[name=password]")), keyTab: Boolean(document.querySelector('[data-tab="key"]')), overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }));
    await page.screenshot({ path: path.join(os.tmpdir(), "chatblink-email-signup-mobile.png") });

    const signup = await post("/api/auth/email/signup", { username, email, password: firstPassword, age: 24, adultConfirmed: true });
    if (signup.response.status !== 202 || !signup.body.verificationToken) throw new Error(`email signup failed: ${JSON.stringify(signup.body)}`);
    await page.goto(`${BASE}/verify-email?token=${encodeURIComponent(signup.body.verificationToken)}`, { waitUntil: "domcontentloaded" });
    await page.locator("#appView:not([hidden])").waitFor();
    const verified = await page.evaluate(() => ({ app: !document.querySelector("#appView").hidden, keySaved: Boolean(localStorage.getItem("nearby_pending_profile_key")) }));

    const forgot = await post("/api/auth/email/forgot", { email });
    if (forgot.response.status !== 200 || !forgot.body.resetToken) throw new Error(`reset request failed: ${JSON.stringify(forgot.body)}`);
    await page.goto(`${BASE}/reset-password?token=${encodeURIComponent(forgot.body.resetToken)}`, { waitUntil: "domcontentloaded" });
    await page.locator("#resetPane.active").waitFor();
    const resetTab = await page.locator("[data-tab].active").getAttribute("data-tab");
    await page.locator('#resetPane input[name="password"]').fill(nextPassword);
    await page.screenshot({ path: path.join(os.tmpdir(), "chatblink-password-reset-mobile.png") });
    await Promise.all([page.waitForURL(/mode=login/), page.locator("#resetPane form").evaluate(form => form.requestSubmit())]);
    await page.locator("#loginPane.active").waitFor();
    const resetNotice = await page.locator("#authNotice").textContent();
    await page.locator('#emailLoginForm input[name="email"]').fill(email);
    await page.locator('#emailLoginForm input[name="password"]').fill(nextPassword);
    await Promise.all([page.waitForNavigation(), page.locator("#emailLoginForm").evaluate(form => form.requestSubmit())]);
    await page.locator("#appView:not([hidden])").waitFor();
    const loggedIn = await page.evaluate(() => !document.querySelector("#appView").hidden);
    const pass = initial.email && initial.password && initial.keyTab && !initial.overflow && verified.app && verified.keySaved && resetTab === "login" && /password updated/i.test(resetNotice || "") && loggedIn;
    console.log(JSON.stringify({ initial, verified, resetTab, resetNotice, loggedIn, screenshots: ["chatblink-email-signup-mobile.png", "chatblink-password-reset-mobile.png"], pass }));
    if (!pass) process.exitCode = 1;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
