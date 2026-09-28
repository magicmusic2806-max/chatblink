const { chromium } = require("playwright");

(async () => {
  const baseUrl = process.env.NEARBY_TEST_URL || "http://localhost:3100";
  const stamp = Date.now().toString(36);
  const formUser = `browser_flow_${stamp}`;
  const keyUser = `browser_key_${stamp}`;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.NEARBY_BROWSER_PATH });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  try {
    const keySignup = await fetch(`${baseUrl}/api/auth/signup`, { method: "POST", headers: { "Content-Type": "application/json", Origin: baseUrl }, body: JSON.stringify({ username: keyUser, age: 24, adultConfirmed: true }) });
    const keyData = await keySignup.json();
    if (!keyData.profileKey) throw new Error("Key account was not created");

    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.locator("#signupForm input[name=username]").fill(formUser);
    await page.locator("#signupForm input[name=age]").fill("24");
    await page.locator("#signupForm input[name=adultConfirmed]").check();
    await page.getByRole("button", { name: /Enter chatrooms/ }).click();
    await page.locator("#authView").waitFor({ state: "hidden" });
    await page.waitForURL("**/rooms");
    const landingUrl = new URL(page.url()).pathname;
    await page.locator("#roomsGrid .room-card").first().waitFor();
    const gridCount = await page.locator("#roomsGrid .room-card").count();
    await page.locator("#roomsView [data-action=profile]").click();
    await page.locator("#profileModal").waitFor({ state: "visible" });
    await page.locator("#profileName").filter({ hasText: formUser }).waitFor();
    const firstVisitUser = await page.locator("#profileName").textContent();
    await page.locator("[data-close-profile]").click();

    await page.locator("#roomsGrid .room-card:not(.create)").first().click();
    await page.locator("#chatPanel").waitFor({ state: "visible" });
    const firstRoomUrl = new URL(page.url()).pathname;

    await page.reload({ waitUntil: "networkidle" });
    await page.locator("#chatPanel").waitFor({ state: "visible" });
    const reloadRoomUrl = new URL(page.url()).pathname;

    await page.goto(`${baseUrl}/room/fun`, { waitUntil: "networkidle" });
    await page.locator("#chatPanel").waitFor({ state: "visible" });
    await page.locator("#roomName").filter({ hasText: "Fun" }).waitFor();
    const directRoom = await page.locator("#roomName").textContent();

    await page.locator("#chatPanel [data-action=menu]").click();
    await page.locator("#menuDrop [data-menu=logout]").click();
    await page.locator("#loginPane").waitFor({ state: "visible" });
    await page.locator("#loginForm input[name=key]").fill(keyData.profileKey.toLowerCase());
    await page.getByRole("button", { name: /Enter with profile key/ }).click();
    await page.locator("#authView").waitFor({ state: "hidden" });
    await page.waitForURL("**/rooms");
    const keyLandingUrl = new URL(page.url()).pathname;
    await page.locator("#roomsView [data-action=profile]").click();
    await page.locator("#profileModal").waitFor({ state: "visible" });
    await page.locator("#profileName").filter({ hasText: keyUser }).waitFor();
    const keyLoginUser = await page.locator("#profileName").textContent();
    process.stdout.write(JSON.stringify({ firstVisitUser, keyLoginUser, gridCount, landingUrl, firstRoomUrl, reloadRoomUrl, directRoom, keyLandingUrl }) + "\n");
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exit(1); });
