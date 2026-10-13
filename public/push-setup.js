/* Chatblink push notifications - the permission gate and the subscription lifecycle.
 *
 * Kept in its own file so the app's own code stays untouched: this only watches for the moment the
 * user is genuinely inside the app (after the profile step, not on the auth screen), asks once, and
 * then keeps this browser registered.
 */
(() => {
  const configPromise = fetch("/api/config").then(response => response.ok ? response.json() : {}).catch(() => ({}));
  let registration = null, prompted = false, gate = null;

  // Push needs a secure context: https anywhere, or http on loopback (which browsers treat as secure).
  const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
    && (location.protocol === "https:" || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname));
  const flag = name => { try { return localStorage.getItem(name); } catch { return null; } };
  const setFlag = (name, value) => { try { localStorage.setItem(name, value); } catch {} };

  // The applicationServerKey is base64url; pushManager wants raw bytes.
  const decodeKey = value => {
    const padded = (value + "=".repeat((4 - (value.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(padded), bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index++) bytes[index] = raw.charCodeAt(index);
    return bytes;
  };

  const node = (id, tag, className) => { const element = document.createElement(tag); element.id = id; if (className) element.className = className; return element; };

  async function register() {
    if (!registration) registration = await navigator.serviceWorker.register("/sw.js");
    return registration;
  }

  /** Registers this browser with the Worker. Safe to call repeatedly. */
  async function subscribe() {
    const config = await configPromise;
    if (!config.vapidPublicKey) return false;
    const reg = await register();
    const existing = await reg.pushManager.getSubscription();
    const subscription = existing || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: decodeKey(config.vapidPublicKey) });
    const response = await fetch("/api/push/subscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(subscription.toJSON()) });
    if (!response.ok) return false;
    setFlag("chatblink.pushEnabled", "1");
    return true;
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
    const fail = message => { note.hidden = false; note.textContent = message; allow.disabled = false; allow.textContent = "Turn on notifications"; };
    allow.addEventListener("click", async () => {
      allow.disabled = true; allow.textContent = "Turning on…";
      setFlag("chatblink.pushPrompted", "1");
      try {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") { fail(permission === "denied" ? "Notifications are blocked in this browser's settings." : "Notifications were not enabled."); return; }
        const ok = await subscribe();
        if (!ok) { fail("Could not register this device. You can try again later."); return; }
        closeGate();
      } catch (error) { fail("Could not enable notifications here."); }
    });
    later.addEventListener("click", () => { setFlag("chatblink.pushPrompted", "1"); closeGate(); });
    return gate;
  }

  async function consider() {
    if (!supported()) return;
    if (Notification.permission === "denied") return;
    // Already granted (here or in another tab): make sure this browser is registered, silently.
    if (Notification.permission === "granted") { await subscribe().catch(() => {}); return; }
    if (flag("chatblink.pushPrompted") === "1") return;
    if (prompted) return;
    prompted = true;
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
