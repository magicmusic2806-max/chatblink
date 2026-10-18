import { clean, escapeHtml, json, safeDecode, sameOrigin, isSecure, sessionCookie, readForm, base64ToBytes } from "./lib/core.js";
import { SESSION_TTL_MS } from "./lib/crypto.js";
import { IMAGE_TYPES, AUDIO_TYPES, matchesMediaType, UPLOAD_CONTENT_TYPES } from "./lib/catalog.js";

export { ChatHub } from "./hub.js";

const CLIENT_VERSION = "58";
const UPLOAD_NAME = /^[a-f0-9-]{36}\.(jpg|png|gif|webp|webm|mp4|m4a|ogg)$/;
const PAGE_ROUTES = [/^\/$/, /^\/index\.html$/, /^\/rooms$/, /^\/dms$/, /^\/explore$/, /^\/room\/[^/]+$/, /^\/profile\/[^/]+$/];
const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } });

const hubFor = env => env.HUB.get(env.HUB.idFromName("hub"));

// The apex is canonical and www is an alias of it. Serving the app on both names would split
// sessions (the session cookie is host-only), spread shared links over two origins and hand
// crawlers two copies of every page, so www is always sent to the apex.
function canonicalOrigin(env) {
  try { return new URL(clean(env.PUBLIC_ORIGIN)); } catch { return null; }
}

function forward(env, request) {
  const headers = new Headers(request.headers);
  headers.set("x-cb-ip", request.headers.get("cf-connecting-ip") || "");
  headers.delete("content-length");
  const streamable = request.method !== "GET" && request.method !== "HEAD";
  return hubFor(env).fetch(new Request(request.url, { method: request.method, headers, body: streamable ? request.body : undefined }));
}
async function internal(env, pathname, request, payload) {
  const headers = new Headers({ "x-cb-host": new URL(request.url).host, "x-cb-ip": request.headers.get("cf-connecting-ip") || "", "Origin": request.headers.get("Origin") || "", "Cookie": request.headers.get("Cookie") || "", "Authorization": request.headers.get("Authorization") || "", "Content-Type": "application/json" });
  return hubFor(env).fetch(new Request(`https://hub${pathname}`, { method: "POST", headers, body: JSON.stringify(payload || {}) }));
}
async function session(env, request) { try { return await (await internal(env, "/__internal/session", request)).json(); } catch { return { user: null, token: null }; } }

async function servePage(request, env, url, user, token, newKey = null, extraHeaders = {}) {
  const asset = await env.ASSETS.fetch(new Request(new URL("/rooms.html", url.origin), { headers: request.headers }));
  if (!asset.ok) return notFound();
  let output = await asset.text();
  const origin = clean(env.PUBLIC_ORIGIN) || "https://chatblink.chat";
  const canonical = url.pathname === "/rooms" ? "/rooms" : url.pathname.startsWith("/room/") ? url.pathname : "/";
  if (!output.includes('rel="canonical"')) output = output.replace("</head>", `<link rel="canonical" href="${origin}${canonical}"></head>`);
  if (user) {
    const userBootstrap = JSON.stringify(user).replace(/</g, "\\u003c"), tokenBootstrap = JSON.stringify(token).replace(/</g, "\\u003c");
    const keyBootstrap = newKey ? `window.__NEARBY_NEW_KEY__=${JSON.stringify(newKey).replace(/</g, "\\u003c")};` : "";
    output = output.replace('<main class="auth-shell" id="authView">', '<main class="auth-shell" id="authView" hidden>')
      .replace('<main class="app" id="appView" hidden>', '<main class="app" id="appView">')
      .replace('<script src="/multi-room.js"></script>', `<script>window.__NEARBY_USER__=${userBootstrap};window.__NEARBY_TOKEN__=${tokenBootstrap};${keyBootstrap}</script><script src="/multi-room.js?v=${CLIENT_VERSION}"></script><script src="/push-setup.js?v=${CLIENT_VERSION}"></script>`);
  } else {
    const error = clean(url.searchParams.get("error"));
    output = output.replace('<main class="app" id="appView" hidden>', '<main class="app" id="appView">')
      .replace('<script src="/multi-room.js"></script>', `<script src="/multi-room.js?v=${CLIENT_VERSION}"></script><script src="/push-setup.js?v=${CLIENT_VERSION}"></script>`);
    if (error && url.searchParams.get("mode") !== "signup") output = output.replace('<div class="form-error" id="loginError" hidden></div>', `<div class="form-error" id="loginError">${escapeHtml(error)}</div>`);
  }
  return new Response(output, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache", ...extraHeaders } });
}

// Uploads normally live in R2. Workers KV is a drop-in substitute because
// activating R2 requires a payment method on file: both bindings are named
// UPLOADS and the store is detected by capability (R2 has createMultipartUpload).
const uploadsAreR2 = env => typeof env.UPLOADS.createMultipartUpload === "function";

async function putUpload(env, name, bytes, contentType) {
  const cacheControl = "private, max-age=86400";
  if (uploadsAreR2(env)) return env.UPLOADS.put(name, bytes, { httpMetadata: { contentType, cacheControl } });
  return env.UPLOADS.put(name, bytes, { metadata: { contentType, cacheControl } });
}

async function getUpload(env, name) {
  if (uploadsAreR2(env)) {
    const object = await env.UPLOADS.get(name);
    return object ? { body: object.body, headers: { "ETag": object.httpEtag } } : null;
  }
  const { value } = await env.UPLOADS.getWithMetadata(name, "arrayBuffer");
  if (!value) return null;
  // Names are UUIDs and content never changes, so a synthetic validator is stable.
  return { body: value, headers: { "ETag": `W/"${name}"` } };
}

async function handleUpload(request, env) {
  const guard = await internal(env, "/__internal/upload", request);
  if (!guard.ok) return guard;
  try {
    const body = await request.json();
    const kind = clean(body.kind), data = clean(body.data);
    if (!data) throw new Error("Upload payload is missing.");
    const bytes = base64ToBytes(data);
    if (!bytes.length) throw new Error("That file is empty.");
    if (bytes.length > (kind === "voice" ? 4 : 6) * 1024 * 1024) throw new Error("That file is too large.");
    const type = (kind === "voice" ? AUDIO_TYPES : IMAGE_TYPES).find(item => matchesMediaType(bytes, item));
    if (!type) throw new Error(kind === "voice" ? "Unsupported audio format." : "Unsupported image format.");
    const name = `${crypto.randomUUID()}.${type.ext}`;
    await putUpload(env, name, bytes, UPLOAD_CONTENT_TYPES[type.ext]);
    return json(201, { url: `/uploads/${name}` });
  } catch (error) { return json(400, { error: error.message }); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = safeDecode(url.pathname);

    // Ahead of every route, WebSocket upgrades included, so www can never serve the app itself.
    // 301 carries reads (what browsers and crawlers send) and 308 everything else, so a POST to the
    // alias is not silently downgraded to a GET.
    // This keys off request.url, which `wrangler dev` builds from the configured custom domain - so
    // locally the alias can never appear, and tests/canonical-host.js drives the handler directly
    // instead. Forcing http requests to https is deliberately NOT done here: the zone's
    // Always Use HTTPS setting does it at the edge, including for the static assets that bypass the
    // Worker, whereas code here could only cover the routes that reach it.
    const canonical = canonicalOrigin(env);
    if (canonical && url.host === `www.${canonical.host}`) {
      return Response.redirect(`${canonical.origin}${url.pathname}${url.search}`, request.method === "GET" || request.method === "HEAD" ? 301 : 308);
    }

    if (!path) return new Response("Bad request", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });

    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") return hubFor(env).fetch(request);

    if (path === "/api/upload" && request.method === "POST") return handleUpload(request, env);

    if (path.startsWith("/uploads/")) {
      const name = path.slice("/uploads/".length);
      if (!UPLOAD_NAME.test(name)) return notFound();
      const file = await getUpload(env, name);
      if (!file) return notFound();
      const headers = new Headers({ "Cache-Control": "private, max-age=86400", ...file.headers, "Content-Type": UPLOAD_CONTENT_TYPES[name.split(".").pop()] || "application/octet-stream" });
      return new Response(file.body, { headers });
    }

    if (path.startsWith("/api/")) return forward(env, request);

    if (request.method === "POST" && (path === "/auth/login" || path === "/auth/signup" || path === "/enter")) return forwardForm(request, env, url);

    if (PAGE_ROUTES.some(route => route.test(path))) {
      const auth = await session(env, request);
      return servePage(request, env, url, auth.user, auth.token);
    }

    const asset = await env.ASSETS.fetch(request);
    if (asset.status === 404) return notFound();
    return asset;
  }
};

async function forwardForm(request, env, url) {
  const path = url.pathname;
  if (!sameOrigin(request)) return new Response("Request origin was rejected.", { status: 403 });
  const fields = await readForm(request);
  const action = path === "/auth/signup" ? "signup" : path === "/auth/login" ? "login" : "enter";
  if (action === "signup") fields.adultConfirmed = fields.adultConfirmed === "on";
  const result = await (await internal(env, "/__internal/auth", request, { action, fields })).json();
  if (result.error) return Response.redirect(`${url.origin}/?mode=${action === "signup" ? "signup" : "login"}&error=${encodeURIComponent(result.error)}`, 303);
  return servePage(request, env, url, result.user, result.token, result.profileKey || null, { "Set-Cookie": sessionCookie(result.token, Math.floor(SESSION_TTL_MS / 1000), isSecure(request)) });
}
