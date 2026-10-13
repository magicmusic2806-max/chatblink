const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_MS = TOKEN_TTL_MS;
let cachedKey = null;

async function importHmacKey(secret) {
  // Node's crypto.createHmac("sha256", secret) uses the RAW secret bytes as the key.
  // Hashing the secret first would silently change every signature and break the
  // device tokens/entry links already handed out by the old Node server.
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}
async function hmacKey(secret) { if (!cachedKey || cachedKey.secret !== secret) cachedKey = { secret, key: await importHmacKey(secret) }; return cachedKey.key; }
export async function hmacBase64Url(secret, value) {
  const key = await hmacKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export function normalizeProfileKey(value) { return String(value || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, ""); }
export function hashProfileKey(value) { return sha256Hex(normalizeProfileKey(value)); }
export function generateProfileKey(bytes = 20) {
  const random = crypto.getRandomValues(new Uint8Array(bytes));
  const characters = [...random].map(byte => KEY_ALPHABET[byte % KEY_ALPHABET.length]).join("");
  return `CHATBLINK-${characters.match(/.{1,4}/g).join("-")}`;
}
export async function issueAuthToken(user, secret) {
  const expiresAt = Date.now() + TOKEN_TTL_MS;
  const payload = `device.${user.id}.${Number(user.tokenVersion) || 0}.${expiresAt}`;
  return `${payload}.${await hmacBase64Url(secret, payload)}`;
}
export async function verifyAuthToken(token, secret, lookup) {
  try {
    const parts = String(token || "").split(".");
    if (parts.length !== 5) return null;
    const [version, userId, tokenVersion, expiresAt, signature] = parts;
    if (version !== "device") return null;
    if (!Number.isFinite(Number(expiresAt)) || Number(expiresAt) < Date.now()) return null;
    const expected = await hmacBase64Url(secret, `${version}.${userId}.${tokenVersion}.${expiresAt}`);
    if (signature.length !== expected.length) return null;
    let mismatch = 0;
    for (let index = 0; index < signature.length; index++) mismatch |= signature.charCodeAt(index) ^ expected.charCodeAt(index);
    if (mismatch !== 0) return null;
    const user = lookup(userId);
    if (!user || (Number(user.tokenVersion) || 0) !== Number(tokenVersion)) return null;
    return user;
  } catch { return null; }
}
