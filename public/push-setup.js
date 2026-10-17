/* Chatblink push notifications - the permission gate and the subscription lifecycle.
 *
 * Kept in its own file so the app's own code stays untouched: this only watches for the moment the
 * user is genuinely inside the app (after the profile step, not on the auth screen), asks once, and
 * then keeps this browser registered.
 */
(() => {
  let registrationPromise = null, subscriptionPromise = null, prompted = false, gate = null;

  // Push needs a secure context: https anywhere, or http on loopback (which browsers treat as secure).
  const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
    && (location.protocol === "https:" || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname));
  const flag = name => { try { return localStorage.getItem(name); } catch { return null; } };
  const setFlag = (name, value) => { try { localStorage.setItem(name, value); } catch {} };
  const withTimeout = (promise, milliseconds, message) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), milliseconds);
    Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });

  // The applicationServerKey is base64url; pushManager wants raw bytes.
  const decodeKey = value => {
    const padded = (value + "=".repeat((4 - (value.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(padded), bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
    return bytes;
  };

  const node = (id, tag, className) => { const element = document.createElement(tag); element.id = id; if (className) element.className = className; return element; };

  async function register() {
    if (!registrationPromise) registrationPromise = (async () => {
      await withTimeout(navigator.serviceWorker.register("/sw.js", { scope: "/" }), 10000, "The notification service took too long to start.");
      return withTimeout(navigator.serviceWorker.ready, 10000, "The notification service is not ready yet.");
    })();
    try { return await registrationPromise; }
    catch (error) { registrationPromise = null; throw error; }
  }

  async function loadConfig() {
    const response = await withTimeout(fetch("/api/config", { cache: "no-store" }), 8000, "Chatblink could not load notification settings. Please try again.");
    if (!response.ok) throw new Error("Chatblink could not load notification settings. Please try again.");
    const config = await response.json();
    if (!config.pushEnabled || !config.vapidPublicKey) throw new Error("Notifications are temporarily unavailable. Please try again later.");
    return config;
  }

  /** Registers this browser with the Worker. Safe to call repeatedly. */
  async function subscribeOnce() {
    const config = await loadConfig();
    const reg = await register();
    const existing = await withTimeout(reg.pushManager.getSubscription(), 8000, "Checking this browser's notification status took too long.");
    const subscription = existing || await withTimeout(reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeKey(config.vapidPublicKey) }), 15000, "The browser did not finish enabling notifications. Check the permission prompt, then try again.");
    const response = await withTimeout(fetch("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(subscription.toJSON()) }), 10000, "Saving this browser took too long. Please try again.");
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || "Chatblink could not save this browser. Please try again.");
    }
    setFlag("chatblink.pushEnabled", "1");
    return true;
  }
  function subscribe() {
    if (!subscriptionPromise) subscriptionPromise = subscribeOnce().finally(() => { subscriptionPromise = null; });
    return subscriptionPromise;
  }

  async function unsubscribe() {
    const reg = await register();
    const subscription = await reg.pushManager.getSubscription();
    if (!subscription) return true;
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe().catch(() => {});
    const response = await fetch("/api/push/unsubscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ endpoint }) });
    setFlag("chatblink.pushEnabled", "0");
    return response.ok;
  }

  function closeGate() { if (gate) gate.hidden = true; }

  function buildGate() {
    if (gate) return gate;
    gate = node("pushGate", "div", "push-gate");
    gate.hidden = true;
    gate.innerHTML = `
      <div class="push-gate-card" role="dialog" aria-modal="true" aria-labelledby="pushGateTitle">
        <span class="push-gate-icon" aria-hidden="true">🔔</span>
        <h2 id="pushGateTitle">Know when someone messages you</h2>
        <p>Turn on notifications and Chatblink can tell you about new messages, new rooms and community milestones - even when this tab is closed.</p>
        <p class="push-gate-note" hidden></p>
        <div class="push-gate-actions">
          <button type="button" class="push-gate-allow">Turn on notifications</button>
          <button type="button" class="push-gate-later">Not now</button>
        </div>
      </div>`;
    document.body.appendChild(gate);
    const note = gate.querySelector(".push-gate-note"), allow = gate.querySelector(".push-gate-allow"), later = gate.querySelector(".push-gate-later");
    const fail = message => { note.hidden = false; note.textContent = message; allow.disabled = false; allow.textContent = "Try again"; };
    allow.addEventListener("click", async () => {
      if (allow.disabled) return;
      allow.disabled = true; allow.textContent = "Turning on…";
      note.hidden = true; note.textContent = "";
      try {
        const permission = Notification.permission === "granted" ? "granted" : await withTimeout(Notification.requestPermission(), 15000, "The browser permission prompt is still waiting. Choose Allow there, then try again.");
        if (permission !== "granted") { if (permission === "denied") setFlag("chatblink.pushPrompted", "1"); fail(permission === "denied" ? "Notifications are blocked in this browser's settings." : "Notifications were not enabled. You can try again."); return; }
        await subscribe();
        setFlag("chatblink.pushPrompted", "1");
        note.hidden = false; note.textContent = "Notifications are on."; allow.textContent = "Notifications on ✓";
        setTimeout(closeGate, 450);
      } catch (error) { fail(error && error.message ? error.message : "Could not enable notifications here. Please try again."); }
    });
    later.addEventListener("click", () => { setFlag("chatblink.pushPrompted", "1"); closeGate(); });
    return gate;
  }

  async function consider() {
    if (!supported()) return;
    if (Notification.permission === "denied") return;
    if (gate && !gate.hidden) return;
    if (Notification.permission === "default" && flag("chatblink.pushPrompted") === "1") return;
    if (prompted) return;
    prompted = true;
    // Already granted (here or in another tab): make sure this browser is registered, silently.
    if (Notification.permission === "granted") { await subscribe().catch(() => {}); return; }
    buildGate().hidden = false;
  }

  // "Inside the app" is the app view becoming visible: the setup step also lives outside it, so the
  // prompt lands after the profile is created rather than before it.
  const insideApp = () => { const app = document.getElementById("appView"); return Boolean(app) && !app.hidden; };
  const check = () => { if (insideApp()) consider(); };
  const start = () => {
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden"] });
    check();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();

  navigator.serviceWorker && navigator.serviceWorker.addEventListener("message", event => {
    const type = event.data && event.data.type;
    if (type === "notification-click" && event.data.url) location.href = event.data.url;
    // The endpoint rotated; re-subscribe while the page is open rather than losing notifications.
    if (type === "push-resubscribe") subscribe().catch(() => {});
  });
})();
