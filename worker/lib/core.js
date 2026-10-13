const TEXT_ENCODER = new TextEncoder();
export const clean = value => String(value ?? "").trim();
export const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
export const safeDecode = value => { try { return decodeURIComponent(value); } catch { return null; } };
export const json = (status, payload, headers = {}) => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers } });
export const publicUser = user => ({ id: user.id, username: user.username, age: user.age, role: user.role || "user", provider: "profile-key", profileComplete: Boolean(user.profileComplete), profile: user.profile || { displayName: user.username, avatar: "✨", bio: "", gender: "", interests: [], photo: null, photos: [] } });
export const profileDoc = user => ({ id: user.id, username: user.username, usernameLower: user.usernameLower, age: user.age, role: user.role || "user", displayName: user.profile?.displayName || user.username, avatar: user.profile?.avatar || "✨", bio: user.profile?.bio || "", gender: user.profile?.gender || "", interests: user.profile?.interests || [], photo: user.profile?.photo || null, photos: user.profile?.photos || [], updatedAt: Date.now() });

export function parseCookies(header) {
  const cookies = {};
  for (const part of String(header || "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    const key = part.slice(0, index).trim();
    if (!key) continue;
    try { cookies[key] = decodeURIComponent(part.slice(index + 1).trim()); } catch { continue; }
  }
  return cookies;
}
export function hostOf(request) { return clean(request.headers.get("x-cb-host")) || new URL(request.url).host; }
export function ipOf(request) { return clean(request.headers.get("x-cb-ip")) || "0.0.0.0"; }
export function isSecure(request) { return clean(request.headers.get("x-cb-proto")) === "https" || new URL(request.url).protocol === "https:"; }
export function sameOrigin(request) { const origin = request.headers.get("Origin"); if (!origin) return true; try { return new URL(origin).host === hostOf(request); } catch { return false; } }
export function bearerToken(request) { const authorization = clean(request.headers.get("Authorization")); if (authorization.startsWith("Bearer ")) return authorization.slice(7); try { return new URL(request.url).searchParams.get("token"); } catch { return null; } }
export function sessionCookie(token, maxAge, secure, name = "nearby_session") { return `${name}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? "; Secure" : ""}`; }

export async function readText(request, limit = 16384) {
  const declared = Number(request.headers.get("Content-Length") || 0);
  if (declared && declared > limit) throw new Error("Request too large");
  const text = await request.text();
  if (text.length > limit) throw new Error("Request too large");
  return text;
}
export async function readJson(request, limit = 16384) { const text = await readText(request, limit); try { return JSON.parse(text || "{}"); } catch { throw new Error("Invalid request"); } }
export async function readForm(request, limit = 16384) { const text = await readText(request, limit); const form = new URLSearchParams(text); return Object.fromEntries(form); }

export function bytesToBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
  return btoa(binary);
}
export function base64ToBytes(value) {
  const cleaned = String(value || "").replace(/\s+/g, "");
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
export function constantTimeEqual(a, b) {
  const left = String(a ?? ""), right = String(b ?? "");
  let mismatch = left.length === right.length ? 0 : 1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index++) mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  return mismatch === 0;
}
export function utf8(value) { return TEXT_ENCODER.encode(value); }
export function jsonColumn(value) { return JSON.stringify(value || []); }
export function parseColumn(value, fallback = []) { if (value === null || value === undefined || value === "") return fallback; try { const parsed = JSON.parse(value); return parsed ?? fallback; } catch { return fallback; } }
