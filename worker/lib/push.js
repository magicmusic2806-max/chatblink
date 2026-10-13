/**
 * Web Push sending, used by the Durable Object for DMs, new rooms and account milestones.
 *
 * Payload encryption (RFC 8291) and the VAPID JWT are handled by @block65/webcrypto-web-push, which
 * is built on Web Crypto rather than node:crypto, so it runs unchanged in the Workers runtime.
 *
 * Everything here fails soft. A push is a notification - if a push service is slow, dead or
 * misconfigured, the message or room creation that triggered it must still succeed untouched.
 */
import { buildPushPayload } from "@block65/webcrypto-web-push";

const ENDPOINT_MAX = 600, KEY_MAX = 200, BATCH = 20, BROADCAST_LIMIT = 500;

const text = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");

/** VAPID identity: the subject must be a mailto: or https: URL per the spec. */
export const vapidFor = env => ({
  subject: text(env.VAPID_SUBJECT, 200) || "mailto:hello@chatblink.chat",
  publicKey: env.VAPID_PUBLIC_KEY,
  privateKey: env.VAPID_PRIVATE_KEY
});

// Local development has no secrets, and a misconfigured deploy should not 500 every message path.
export const pushConfigured = env => Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);

/**
 * A browser posts back exactly what pushManager.subscribe() produced. Anything else is dropped
 * rather than stored, so a malformed row can never turn into a failed send later.
 */
export function parseSubscription(body) {
  const endpoint = text(body && body.endpoint, ENDPOINT_MAX);
  const keys = (body && body.keys) || {};
  const p256dh = text(keys.p256dh, KEY_MAX), auth = text(keys.auth, KEY_MAX);
  if (!/^https:\/\/\S+$/.test(endpoint) || !p256dh || !auth) return null;
  return { endpoint, p256dh, auth };
}

/**
 * Upserting on the endpoint means the same browser re-subscribing replaces its row instead of
 * piling up, while a different device (or browser profile) keeps its own.
 */
export async function saveSubscription(env, userId, subscription) {
  await env.DB.prepare(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?,?,?,?,?,?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth, created_at=excluded.created_at`)
    .bind(crypto.randomUUID(), userId, subscription.endpoint, subscription.p256dh, subscription.auth, new Date().toISOString()).run();
}

/** Scoped to the user so one account can never unregister another account's device. */
export async function removeSubscription(env, userId, endpoint) {
  await env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").bind(endpoint, userId).run();
}

export async function subscriptionsFor(env, userId) {
  const result = await env.DB.prepare("SELECT user_id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?").bind(userId).all();
  return result.results || [];
}

/**
 * True when the push service accepted it. A 404/410 means the subscription is permanently gone -
 * the browser profile was wiped or the permission revoked - so the row is dropped rather than
 * retried on every future notification.
 */
export async function sendToSubscription(env, row, message) {
  try {
    const payload = await buildPushPayload(
      { data: JSON.stringify(message), options: { ttl: 60 * 60 * 24 } },
      { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
      vapidFor(env)
    );
    const response = await fetch(row.endpoint, payload);
    // user_id comes back with the row purely so a dead subscription can be pruned here.
    if (response.status === 404 || response.status === 410) await removeSubscription(env, row.user_id || "", row.endpoint);
    return response.ok;
  } catch {
    return false;
  }
}

/** Every device the user registered. Returns how many were accepted. */
export async function pushToUser(env, userId, message) {
  if (!pushConfigured(env)) return 0;
  const rows = await subscriptionsFor(env, userId);
  const results = await Promise.all(rows.map(row => sendToSubscription(env, row, message)));
  return results.filter(Boolean).length;
}

/**
 * Broadcast to every registered device, in sequential batches: a couple of hundred pushes in one
 * go would otherwise trip the per-request subrequest limit. Caps at BROADCAST_LIMIT attachments so
 * a milestone cannot fan out without bound.
 */
export async function pushToAll(env, message, limit = BROADCAST_LIMIT) {
  if (!pushConfigured(env)) return 0;
  const result = await env.DB.prepare("SELECT user_id, endpoint, p256dh, auth FROM push_subscriptions LIMIT ?").bind(limit).all();
  const rows = result.results || [];
  let accepted = 0;
  for (let index = 0; index < rows.length; index += BATCH) {
    const results = await Promise.all(rows.slice(index, index + BATCH).map(row => sendToSubscription(env, row, message)));
    accepted += results.filter(Boolean).length;
  }
  return accepted;
}
