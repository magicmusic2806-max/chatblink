/* Chatblink service worker.
 *
 * Its only job is to show the notifications the Worker pushes and to open the right place when one
 * is tapped. It deliberately caches nothing: every page, stylesheet and script is versioned by
 * CLIENT_VERSION on the Worker side, so caching here would add a second, staler copy of the app.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("push", event => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "" };
  }
  const title = payload.title || "Chatblink";
  const url = payload.url || "/rooms";
  event.waitUntil(self.registration.showNotification(title, {
    body: payload.body || "",
    // Tagging collapses repeats of the same conversation instead of stacking one per message.
    tag: payload.tag || "chatblink",
    data: { url }
  }));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/rooms";
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      // Send the route to the tab and focus it, so a click never opens a duplicate window.
      try { client.postMessage({ type: "notification-click", url }); } catch {}
      if ("focus" in client) return client.focus();
    }
    return self.clients.openWindow(url);
  })());
});

// Chrome rotates push endpoints from time to time. The key needed to re-subscribe lives in the page,
// so ask the open tabs to re-subscribe and re-register rather than guessing here.
self.addEventListener("pushsubscriptionchange", event => {
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      try { client.postMessage({ type: "push-resubscribe" }); } catch {}
    }
  })());
});
