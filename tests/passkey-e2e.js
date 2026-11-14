/**
 * Browser-level passkey flow: fingerprint sign-in as the everyday door.
 *
 * Usage:  node tests/passkey-e2e.js [baseUrl]
 * Needs a running local server and Playwright's Chromium. Chromium's virtual authenticator stands in
 * for a fingerprint sensor (WebAuthn.addVirtualAuthenticator through CDP), so the whole ceremony -
 * registration, assertion, counter - runs against real browser crypto with no hardware.
 *
 * The base URL must be a localhost origin: a WebAuthn rpId cannot be an IP address, so 127.0.0.1 is
 * rewritten to localhost here.
 */
const { chromium } = require("playwright");

const requested = (process.argv[2] || "http://localhost:8787").replace(/\/$/, "");
const BASE = requested.replace("//127.0.0.1", "//localhost");
const stamp = Date.now().toString(36);
let passed = 0, failed = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ""}`); }
};

const waitForSession = async (page, status) => {
  for (let attempt = 0; attempt < 60; attempt++) {
    const current = await page.evaluate(async () => (await fetch("/api/auth/me")).status);
    if (current === status) return true;
    await page.waitForTimeout(150);
  }
  return false;
};

(async () => {
  console.log(`\npasskey e2e on ${BASE}`);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 420, height: 900 } });
    const page = await context.newPage();
    page.on("pageerror", error => console.log("  PAGEERROR", error.message));
    await page.addInitScript(() => localStorage.setItem("chatblink.pushPrompted", "1"));
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.locator("#authView:not([hidden])").waitFor();

    // A virtual authenticator with user verification: this is the fingerprint sensor for the test.
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    ok("a virtual authenticator is attached", Boolean(authenticatorId));
    await page.locator('[data-switch="key"]').click();
    await page.locator("#passkeyLogin").waitFor({ state: "visible", timeout: 10000 });
    ok("the login pane offers a fingerprint button", await page.locator("#passkeyLogin").isVisible());
    await page.locator('[data-switch="signup"]').click();

    // Sign up with a profile key, then enter the rooms.
    const username = `pk_${stamp}`;
    await page.locator("#signupForm input[name=username]").fill(username);
    await page.locator("#signupForm input[name=age]").fill("24");
    await page.locator("#signupForm input[name=adultConfirmed]").check();
    await page.locator("#signupForm button[type=submit]").click();
    await page.locator("#newKeyCard:not([hidden])").waitFor({ timeout: 15000 });
    const profileKey = (await page.locator("#profileKeyValue").textContent()).trim();
    ok("signup hands over a profile key", /^CHATBLINK-[A-Z0-9-]+$/.test(profileKey), profileKey.slice(0, 18));
    await page.locator("#enterRoomsNow").click();
    await page.locator("#roomsGrid .room-card").first().waitFor({ timeout: 15000 });

    // The options request carries the platform-only selection. It is fetched before the panel opens:
    // asking again would replace the challenge cookie the panel has already prefetched.
    const registerOptions = await page.evaluate(async () => {
      const response = await fetch("/api/auth/passkey/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "register", origin: location.origin }) });
      const payload = await response.json();
      return payload.options && payload.options.authenticatorSelection;
    });
    ok("registration is limited to this device's platform authenticator", registerOptions && registerOptions.authenticatorAttachment === "platform" && registerOptions.userVerification === "required", JSON.stringify(registerOptions));

    // Account safety lives in the menu.
    await page.locator('[data-action="menu"]:visible').first().click();
    await page.locator('#menuDrop [data-menu="safety"]').click();
    await page.locator("#safetyModal:not([hidden])").waitFor();
    await page.locator("#safetyBody .safety-card").first().waitFor();
    const accountText = await page.locator("#safetyBody").textContent();
    ok("the panel shows the account details", accountText.includes(`@${username}`), accountText.slice(0, 120));
    ok("the panel lists no passkey yet", accountText.includes("No passkey yet"));

    const panelCopy = await page.locator("#safetyBody").textContent();
    ok("the panel never points at another device", !/another device|other device|phone or laptop/i.test(panelCopy), panelCopy.slice(0, 160));
    ok("the registration challenge is prefetched for the click", await page.evaluate(() => Boolean(freshRegisterOptions())));
    await page.locator("#safetyAddPasskey").click();
    await page.waitForFunction(() => document.querySelectorAll("#safetyBody .safety-passkey").length === 1, null, { timeout: 15000 });
    ok("adding this device creates a passkey", (await page.locator("#safetyBody .safety-passkey").count()) === 1);
    ok("the passkey is marked as this device", (await page.locator("#safetyBody .safety-passkey b").first().textContent()) === "This device");
    await page.locator("#safetyClose").click();

    // Sign out, then in with the passkey alone.
    await page.locator('[data-action="menu"]:visible').first().click();
    await page.locator('#menuDrop [data-menu="logout"]').click();
    await page.locator("#authView:not([hidden])").waitFor();
    await waitForSession(page, 401);
    await page.locator("#passkeyLogin").waitFor();
    const loginOptions = await page.evaluate(async () => {
      const response = await fetch("/api/auth/passkey/options", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "login", origin: location.origin }) });
      const payload = await response.json();
      return payload.options && { attachment: payload.options.authenticatorAttachment, allow: payload.options.allowCredentials, uv: payload.options.userVerification };
    });
    ok("sign-in is limited to this device's platform authenticator", loginOptions.attachment === "platform" && loginOptions.uv === "required", JSON.stringify(loginOptions));
    await page.locator("#passkeyLogin").click();
    // The guest room list is on screen already, so wait on the session itself rather than on the grid.
    await waitForSession(page, 200);
    const sessionAfterPasskey = await page.evaluate(async () => ({ me: (await fetch("/api/auth/me")).status, rooms: (await fetch("/api/rooms")).status }));
    ok("the fingerprint button signs the account in", sessionAfterPasskey.me === 200, JSON.stringify(sessionAfterPasskey));

    // Remove it from the safety panel, then the button can no longer sign in.
    await page.locator('[data-action="menu"]:visible').first().click();
    await page.locator('#menuDrop [data-menu="safety"]').click();
    await page.locator("#safetyBody .safety-passkey").first().waitFor();
    await page.locator("#safetyBody .safety-remove").first().click();
    await page.locator("#confirmModal:not([hidden])").waitFor();
    await page.locator("#confirmOk").click();
    await page.waitForFunction(() => document.querySelectorAll("#safetyBody .safety-passkey").length === 0, null, { timeout: 15000 });
    ok("the passkey can be removed", (await page.locator("#safetyBody").textContent()).includes("No passkey yet"));
    await page.locator("#safetyClose").click();

    await page.locator('[data-action="menu"]:visible').first().click();
    await page.locator('#menuDrop [data-menu="logout"]').click();
    await page.locator("#authView:not([hidden])").waitFor();
    await waitForSession(page, 401);
    await page.locator('#passkeyLogin').click();
    await page.waitForFunction(() => document.querySelector("#toast").textContent.length > 0, null, { timeout: 15000 });
    const toastText = await page.locator("#toast").textContent();
    ok("with no passkey left the button fails soft", /passkey|device/i.test(toastText), toastText);
    ok("and the visitor stays on the login screen", await page.locator("#authView:not([hidden])").isVisible());

    // The key still gets them back in.
    await page.locator("#loginForm input[name=key]").fill(profileKey);
    await page.locator("#loginForm button[type=submit]").click();
    await page.locator("#roomsGrid .room-card").first().waitFor({ timeout: 15000 });
    ok("the profile key still signs in afterwards", await page.evaluate(async () => (await fetch("/api/auth/me")).status === 200));

    await page.screenshot({ path: ".forge/shots/passkey-rooms.png" });

    // A browser that reports no platform authenticator must not be offered the door at all: that is the
    // case where the browser itself would start suggesting "use a phone instead". Headless Chromium
    // always claims to have one, so the answer is stubbed to exercise our own gate.
    const plain = await browser.newContext({ viewport: { width: 420, height: 900 } });
    const bare = await plain.newPage();
    await bare.addInitScript(() => {
      if (window.PublicKeyCredential) PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable = async () => false;
    });
    await bare.goto(BASE, { waitUntil: "domcontentloaded" });
    await bare.locator("#authView:not([hidden])").waitFor();
    await bare.locator('[data-switch="key"]').click();
    await bare.waitForTimeout(600);
    ok("a device without a platform authenticator gets no fingerprint button", await bare.locator("#passkeyLogin").isHidden());
    await plain.close();

    // When the OS credential manager refuses, the person gets a sentence they can act on instead of
    // Chromium's "unknown error occurred while talking to the credential manager".
    await page.locator('[data-action="menu"]:visible').first().click();
    await page.locator('#menuDrop [data-menu="safety"]').click();
    await page.locator("#safetyAddPasskey").waitFor();
    const refusal = await page.evaluate(async () => {
      const original = navigator.credentials.create.bind(navigator.credentials);
      navigator.credentials.create = async () => { const error = new Error("unknown error occurred while talking to the credentials manager"); error.name = "UnknownError"; throw error; };
      try { await addPasskey(); } finally { navigator.credentials.create = original; }
      return document.querySelector("#toast").textContent;
    });
    ok("a credential-manager refusal is explained in plain words", /credential manager refused/.test(refusal) && /Windows Hello|Touch ID|screen lock/.test(refusal), refusal);
    await page.locator(".modal-close, #safetyClose").first().click().catch(() => {});

    // A platform provider that refuses resident keys: Android answers NotReadableError for every create()
    // that so much as prefers one, which is what public/passkey-check.html narrowed down on the reporting
    // phone. Chromium's virtual authenticator accepts resident keys happily, so the refusal is stubbed;
    // the fallback options, the stored credential and the sign-in that names its id are all real.
    // Last in the suite on purpose: signing out here bumps the account's tokenVersion and ends every
    // other session for it, and the page above is still signed in until this point.
    const residentContext = await browser.newContext({ viewport: { width: 420, height: 900 } });
    const phone = await residentContext.newPage();
    phone.on("pageerror", error => console.log("  PAGEERROR", error.message));
    await phone.addInitScript(() => {
      localStorage.setItem("chatblink.pushPrompted", "1");
      const create = navigator.credentials.create.bind(navigator.credentials);
      navigator.credentials.create = async options => {
        const selection = options && options.publicKey && options.publicKey.authenticatorSelection;
        if (selection && selection.residentKey) {
          const error = new Error("An unknown error occurred while talking to the credential manager.");
          error.name = "NotReadableError";
          throw error;
        }
        return create(options);
      };
      const get = navigator.credentials.get.bind(navigator.credentials);
      navigator.credentials.get = async options => {
        // Recorded so the test can see that sign-in named the credential instead of asking for a
        // discoverable one that this device never stored.
        window.__namedCredentials = options && options.publicKey ? (options.publicKey.allowCredentials || []).length : -1;
        return get(options);
      };
    });
    await phone.goto(BASE, { waitUntil: "domcontentloaded" });
    await phone.locator("#authView:not([hidden])").waitFor();
    const phoneCdp = await residentContext.newCDPSession(phone);
    await phoneCdp.send("WebAuthn.enable");
    await phoneCdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: false, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
    await phone.locator('[data-switch="key"]').click();
    await phone.locator("#loginForm input[name=key]").fill(profileKey);
    await phone.locator("#loginForm button[type=submit]").click();
    await phone.locator("#roomsGrid .room-card").first().waitFor({ timeout: 15000 });

    await phone.locator('[data-action="menu"]:visible').first().click();
    await phone.locator('#menuDrop [data-menu="safety"]').click();
    await phone.locator("#safetyAddPasskey").waitFor();
    await phone.locator("#safetyAddPasskey").click();
    await phone.waitForFunction(() => document.querySelectorAll("#safetyBody .safety-passkey").length === 1, null, { timeout: 20000 });
    ok("a device that refuses resident keys still gets a passkey", (await phone.locator("#safetyBody .safety-passkey").count()) === 1);
    ok("and the toast says that passkey stays on this device", /stays on this device/.test(await phone.locator("#toast").textContent()), await phone.locator("#toast").textContent());
    await phone.locator("#safetyClose").click();

    await phone.locator('[data-action="menu"]:visible').first().click();
    await phone.locator('#menuDrop [data-menu="logout"]').click();
    await phone.locator("#authView:not([hidden])").waitFor();
    await waitForSession(phone, 401);
    await phone.locator("#passkeyLogin").click();
    await waitForSession(phone, 200);
    const namedCredentials = await phone.evaluate(() => window.__namedCredentials);
    ok("sign-in names the stored credential", namedCredentials >= 1, String(namedCredentials));
    ok("a device-bound passkey signs the account in", await phone.evaluate(async () => (await fetch("/api/auth/me")).status === 200));
    await residentContext.close();
  } finally {
    await browser.close();
  }

  console.log(`\n${failed === 0 ? "ALL GOOD" : "FAILURES"} - ${passed} passed, ${failed} failed  (account: pk_${stamp})`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(error => { console.error(`\npasskey test crashed: ${error instanceof Error ? error.message : error}`); process.exit(1); });
