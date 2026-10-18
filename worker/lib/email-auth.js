import { clean, escapeHtml, bytesToBase64, base64ToBytes, constantTimeEqual } from "./core.js";
import { sha256Hex } from "./crypto.js";

const PASSWORD_ITERATIONS = 120000;
const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 60 * 60 * 1000;

const base64Url = bytes => bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromBase64Url = value => base64ToBytes(String(value || "").replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (String(value || "").length % 4)) % 4));

export function normalizeEmail(value) {
  const email = clean(value).toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

export function validPassword(value) { return typeof value === "string" && value.length >= 10 && value.length <= 128; }

async function derivePassword(password, salt, iterations = PASSWORD_ITERATIONS) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  if (!validPassword(password)) throw new Error("Password must be 10–128 characters.");
  const salt = crypto.getRandomValues(new Uint8Array(16)), hash = await derivePassword(password, salt);
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${base64Url(salt)}$${base64Url(hash)}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [scheme, rounds, salt, expected] = String(stored || "").split("$");
    const iterations = Number(rounds);
    if (scheme !== "pbkdf2-sha256" || !Number.isInteger(iterations) || iterations < 100000 || iterations > 1000000 || !validPassword(password)) return false;
    const actual = base64Url(await derivePassword(password, fromBase64Url(salt), iterations));
    return constantTimeEqual(actual, expected);
  } catch { return false; }
}

export async function opaqueToken() {
  const raw = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  return { raw, hash: await sha256Hex(raw) };
}

export const verificationExpiry = () => Date.now() + VERIFY_TTL_MS;
export const resetExpiry = () => Date.now() + RESET_TTL_MS;
export const tokenHash = value => sha256Hex(clean(value));

function emailFrame(title, copy, href, button) {
  return `<!doctype html><html><body style="margin:0;background:#0b1019;color:#eef2f8;font-family:Arial,sans-serif"><div style="max-width:560px;margin:0 auto;padding:40px 22px"><div style="font-size:22px;font-weight:800;margin-bottom:28px">Chatblink</div><div style="background:#151722;border:1px solid #343344;border-radius:18px;padding:28px"><h1 style="font-size:24px;margin:0 0 14px">${escapeHtml(title)}</h1><p style="color:#b8c3d4;line-height:1.6;margin:0 0 24px">${escapeHtml(copy)}</p><a href="${escapeHtml(href)}" style="display:inline-block;background:#8b5cf6;color:#fff;text-decoration:none;font-weight:700;padding:13px 20px;border-radius:10px">${escapeHtml(button)}</a><p style="color:#7f8da3;font-size:12px;line-height:1.5;margin:24px 0 0">If you did not request this, you can safely ignore this email.</p></div></div></body></html>`;
}

async function sendEmail(env, { to, subject, html, text, idempotencyKey }) {
  if (String(env.EMAIL_TEST_MODE || "").toLowerCase() === "true") return { test: true };
  if (!env.RESEND_API_KEY) throw new Error("Email sign-in is temporarily unavailable. Please use a profile key or try again later.");
  const response = await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey }, body: JSON.stringify({ from: clean(env.EMAIL_FROM) || "Chatblink <account@chatblink.chat>", to: [to], subject, html, text }) });
  if (!response.ok) { console.error(`Email delivery failed: ${response.status} ${(await response.text()).slice(0, 300)}`); throw new Error("We could not send that email right now. Please try again later."); }
  return response.json().catch(() => ({}));
}

export async function sendVerificationEmail(env, email, username, rawToken, tokenId) {
  const origin = clean(env.PUBLIC_ORIGIN) || "https://chatblink.chat", href = `${origin}/verify-email?token=${encodeURIComponent(rawToken)}`;
  return sendEmail(env, { to: email, subject: "Verify your Chatblink email", html: emailFrame("Verify your email", `Hi ${username}, confirm this email to finish creating your Chatblink account. This link expires in 24 hours.`, href, "Verify email"), text: `Verify your Chatblink email: ${href}\n\nThis link expires in 24 hours.`, idempotencyKey: `verify-${tokenId}` });
}

export async function sendAccountEmailVerification(env, email, username, rawToken, tokenId) {
  const origin = clean(env.PUBLIC_ORIGIN) || "https://chatblink.chat", href = `${origin}/verify-email?token=${encodeURIComponent(rawToken)}`;
  return sendEmail(env, { to: email, subject: "Add email sign-in to Chatblink", html: emailFrame("Confirm your email", `Hi ${username}, confirm this address to add email and password sign-in to your existing Chatblink account. Your profile key will keep working. This link expires in 24 hours.`, href, "Confirm email"), text: `Confirm email sign-in for your Chatblink account: ${href}\n\nYour profile key will keep working. This link expires in 24 hours.`, idempotencyKey: `link-${tokenId}` });
}

export async function sendResetEmail(env, email, username, rawToken, tokenId) {
  const origin = clean(env.PUBLIC_ORIGIN) || "https://chatblink.chat", href = `${origin}/reset-password?token=${encodeURIComponent(rawToken)}`;
  return sendEmail(env, { to: email, subject: "Reset your Chatblink password", html: emailFrame("Reset your password", `Hi ${username}, use this secure link to choose a new Chatblink password. This link expires in one hour.`, href, "Reset password"), text: `Reset your Chatblink password: ${href}\n\nThis link expires in one hour.`, idempotencyKey: `reset-${tokenId}` });
}
