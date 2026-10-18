/** Browser-level check for dark-first theming, light-mode persistence, and responsive layout. */
const { chromium } = require("playwright");
const path = require("path"), os = require("os");

const BASE = (process.argv[2] || "http://127.0.0.1:8799").replace(/\/$/, ""), stamp = Date.now().toString(36);
const post = (route, body) => fetch(BASE + route, { method: "POST", headers: { "Content-Type": "application/json", Origin: BASE }, body: JSON.stringify(body) });
const cookieOf = response => { const pair = response.headers.get("set-cookie").split(";")[0], index = pair.indexOf("="); return { name: pair.slice(0, index), value: pair.slice(index + 1), url: BASE }; };
const themeState = page => page.evaluate(() => ({ theme: document.documentElement.dataset.theme, saved: localStorage.getItem("chatblink.theme"), meta: document.querySelector("#themeColor").content, label: document.querySelector("#themeToggleLabel").textContent, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }));

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } }), page = await context.newPage();
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.locator("#authView:not([hidden])").waitFor();
    const firstVisit = await themeState(page);
    await page.screenshot({ path: path.join(os.tmpdir(), "chatblink-theme-dark-auth-mobile.png") });

    await page.locator("#themeToggle").click();
    await page.waitForTimeout(350);
    const lightSelected = await themeState(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    const lightReloaded = await themeState(page);
    await page.screenshot({ path: path.join(os.tmpdir(), "chatblink-theme-light-auth-mobile.png") });

    const signup = await post("/api/auth/signup", { username: `theme_${stamp}`, age: 24, adultConfirmed: true });
    if (signup.status !== 201) throw new Error(`signup failed: ${await signup.text()}`);
    await context.addCookies([cookieOf(signup)]);
    await page.evaluate(() => localStorage.setItem("chatblink.pushPrompted", "1"));
    await page.goto(BASE + "/rooms", { waitUntil: "domcontentloaded" });
    await page.locator("#roomsView:not([hidden])").waitFor();
    const appLight = await themeState(page);
    await page.locator("#themeToggle").click();
    await page.waitForTimeout(350);
    const appDark = await themeState(page);
    await page.screenshot({ path: path.join(os.tmpdir(), "chatblink-theme-dark-rooms-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.screenshot({ path: path.join(os.tmpdir(), "chatblink-theme-dark-rooms-desktop.png"), fullPage: true });

    const good = firstVisit.theme === "dark" && firstVisit.saved === null && firstVisit.meta === "#080d17" && firstVisit.label === "Light" && !firstVisit.overflow
      && lightSelected.theme === "light" && lightSelected.saved === "light" && lightSelected.meta === "#f4f7fb" && lightSelected.label === "Dark"
      && lightReloaded.theme === "light" && lightReloaded.saved === "light" && !lightReloaded.overflow
      && appLight.theme === "light" && appDark.theme === "dark" && appDark.saved === "dark" && appDark.meta === "#080d17" && !appDark.overflow;
    console.log(JSON.stringify({ firstVisit, lightSelected, lightReloaded, appLight, appDark, screenshots: ["chatblink-theme-dark-auth-mobile.png", "chatblink-theme-light-auth-mobile.png", "chatblink-theme-dark-rooms-mobile.png", "chatblink-theme-dark-rooms-desktop.png"], pass: good }));
    if (!good) process.exitCode = 1;
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
