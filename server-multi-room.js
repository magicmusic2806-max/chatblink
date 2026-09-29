const http = require("http");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");
const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

const PORT = process.env.PORT || 3100;
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = process.env.NEARBY_DATA_DIR ? path.resolve(process.env.NEARBY_DATA_DIR) : path.join(__dirname, "data");
const USER_FILE = path.join(DATA_DIR, "users.json");
const ROOM_FILE = path.join(DATA_DIR, "chatrooms.json");
const AUTH_SECRET_FILE = path.join(DATA_DIR, "auth-secret.txt");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
const MAX_MESSAGES = 100;
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ROOMS_PER_USER = 20;
const MAX_PENDING_REQUESTS = 200;
const MESSAGE_LIMIT_PER_WINDOW = 20;
const MESSAGE_WINDOW_MS = 10000;
const HEARTBEAT_MS = 30000;

const GIF_PACKS = {
  casual: ["/gifs/hello.gif", "/gifs/coffee.gif", "/gifs/party.gif", "/gifs/fistbump.gif"],
  fun: ["/gifs/party.gif", "/gifs/laugh.gif", "/gifs/hello.gif", "/gifs/fistbump.gif"],
  comedy: ["/gifs/laugh.gif", "/gifs/party.gif", "/gifs/hello.gif", "/gifs/heart.gif"],
  dating: ["/gifs/heart.gif", "/gifs/sunset.gif", "/gifs/hello.gif", "/gifs/party.gif"],
  adult: ["/gifs/moon.gif", "/gifs/heart.gif", "/gifs/sunset.gif", "/gifs/berry.gif"],
  friends: ["/gifs/fistbump.gif", "/gifs/hello.gif", "/gifs/party.gif", "/gifs/hug.gif"],
  "best-friends": ["/gifs/hug.gif", "/gifs/heart.gif", "/gifs/fistbump.gif", "/gifs/berry.gif"],
  ocean: ["/gifs/ocean.gif", "/gifs/party.gif", "/gifs/hello.gif", "/gifs/fistbump.gif"],
  sunset: ["/gifs/sunset.gif", "/gifs/heart.gif", "/gifs/party.gif", "/gifs/hello.gif"],
  berry: ["/gifs/berry.gif", "/gifs/party.gif", "/gifs/heart.gif", "/gifs/hug.gif"],
  forest: ["/gifs/forest.gif", "/gifs/hug.gif", "/gifs/hello.gif", "/gifs/party.gif"]
};
const DEFAULT_GIFS = GIF_PACKS.casual;

const BUILT_INS = [
  { id: "casual", name: "Casual", icon: "☕", vibe: "Easy conversation, everyday thoughts, no pressure.", accent: "#4f8cff", soft: "#eaf2ff", gifs: GIF_PACKS.casual, emojis: ["👋","😊","☕","🌤️","💬","✨","🙌","😌","🍃","📚","🎧","🌻","🛋️","🧸","🍵","🎵","🌙","💤","👀","🙂","🌼","🪴","😄","🕊️"], stickers: ["HELLO! 👋","GOOD VIBES ✨","SAME 😌","TELL ME MORE 💬","COFFEE? ☕","TAKE IT EASY 🍃","NICE ONE 🙌","HERE FOR YOU 💛","DAYDREAMING 🌤️","CHAT SOON 💭"] },
  { id: "fun", name: "Fun", icon: "🎉", vibe: "Games, playful questions and spontaneous chaos.", accent: "#8b5cf6", soft: "#f2edff", gifs: GIF_PACKS.fun, emojis: ["🎉","🤩","🥳","🎲","🚀","🔥","⚡","🪩","🎮","🎯","🏆","🍿","🎈","🕺","💃","🥁","🎪","🤹","🎨","🛹","🎳","🧩","🔮","😎"], stickers: ["LET'S GO! 🚀","PLOT TWIST ⚡","PARTY TIME 🥳","I'M IN 🎲","GAME ON 🎮","HIGH SCORE 🏆","ONE MORE 🎯","WILD CARD 🃏","DANCE BREAK 🕺","CHAOS MODE 🌪️"] },
  { id: "comedy", name: "Comedy", icon: "😂", vibe: "Jokes, memes and the lighter side of everything.", accent: "#f59e0b", soft: "#fff5da", gifs: GIF_PACKS.comedy, emojis: ["😂","🤣","😭","💀","🤡","😹","🙃","🎭","🤪","😆","🍌","🐸","👻","📢","🎤","🥸","😜","🤭","🫠","🙈","🤦","💩","🙉","🎬"], stickers: ["I CAN'T 😂","COMEDY GOLD 🏆","TOO REAL 💀","BA-DUM-TSS 🥁","LOL 🤣","I'M CRYING 😭","CLASSIC 🤡","BIG MOOD 🎭","SEND HELP 🆘","NICE TRY 😜"] },
  { id: "dating", name: "Dating", icon: "💘", vibe: "Respectful conversation for singles open to a spark.", accent: "#ec4899", soft: "#fff0f7", gifs: GIF_PACKS.dating, emojis: ["💘","🌹","😉","🥰","❤️","🫶","✨","🍷","💌","🌙","🎶","🥂","💐","😍","💞","🕯️","🍫","💃","🕺","💍","🧡","💋","🌸","😊"], stickers: ["HEY YOU 💘","CUTE! 🥰","COFFEE? ☕","GOOD ENERGY ✨","YOU'RE SWEET 🌹","DINNER? 🍷","TELL ME MORE 💌","HEART EYES 😍","CHEERS 🥂","DATE NIGHT 🌙"] },
  { id: "adult", name: "Adult", icon: "🌙", vibe: "Mature 18+ conversation with boundaries and respect.", accent: "#7c3aed", soft: "#f1ebff", gifs: GIF_PACKS.adult, emojis: ["🌙","🖤","🍷","😏","🔥","🫦","💜","✨","🕯️","🎶","🥂","🌌","🃏","♠️","💋","🧊","🌃","🍸","🎷","🛋️","💤","😈","🪩","🍒"], stickers: ["AFTER DARK 🌙","BE RESPECTFUL 🖤","CHEERS 🍷","VIBE CHECK ✨","NIGHT OWL 🦉","SLOW BURN 🔥","MYSTERY 🃏","MIDNIGHT TALK 🌌","CLASSY 💜","KEEP IT SECRET 🤫"] },
  { id: "friends", name: "Friends", icon: "🤝", vibe: "Meet people, find common ground and stay awhile.", accent: "#10b981", soft: "#e7faf3", gifs: GIF_PACKS.friends, emojis: ["🤝","🫶","😄","🎧","🎮","🍕","🌈","💚","👋","🙌","🏀","🎬","🧋","🍔","🎳","🎤","🚴","🏕️","🎨","🐶","🌞","🍀","💬","🎊"], stickers: ["NEW FRIEND? 🤝","YOU GOT THIS 💚","HANG OUT? 🎮","PIZZA TIME 🍕","SQUAD UP 🙌","ROAD TRIP 🚐","GAME NIGHT 🎲","GOOD TIMES 🌈","COUNT ME IN ✋","SEE YOU SOON 👋"] },
  { id: "best-friends", name: "Best Friends", icon: "🫂", vibe: "Deeper chats, trusted circles and familiar faces.", accent: "#0ea5a4", soft: "#e5fbfa", gifs: GIF_PACKS["best-friends"], emojis: ["🫂","💙","🥹","🫶","🧸","🌻","🤞","💫","💌","🕊️","🎀","🍰","🌙","📸","🫧","🎵","🌸","🤗","💎","🏡","🥰","✨","☕","🔒"], stickers: ["I GOT YOU 🫂","FOREVER TEAM 💙","PROUD OF YOU 🌻","CORE MEMORY 💫","ALWAYS HERE 🧸","MISS YOU 🥹","BEST DAY 🎀","HOME 🏡","TIGHT HUG 🫂","LOVE YOU 💙"] }
].map(room => ({ ...room, access: "open", builtIn: true, ownerId: null, members: [], requests: [], createdAt: null }));

const ALL_EMOJIS = [...new Set(BUILT_INS.flatMap(room => room.emojis))];
const ALL_STICKERS = [...new Set(BUILT_INS.flatMap(room => room.stickers))];
const ALL_GIFS = [...new Set(Object.values(GIF_PACKS).flat())];
const roomMedia = room => room.builtIn ? { emojis: room.emojis, stickers: room.stickers, gifs: room.gifs } : { emojis: ALL_EMOJIS, stickers: ALL_STICKERS, gifs: ALL_GIFS };
const UPLOAD_PATTERN = /^\/uploads\/[a-f0-9-]{36}\.(jpg|png|gif|webp|webm|mp4|m4a|ogg)$/;
const safeUploadUrl = value => UPLOAD_PATTERN.test(String(value || "")) ? String(value) : null;
const IMAGE_TYPES = [{ ext: "jpg", magic: [0xFF, 0xD8, 0xFF] }, { ext: "png", magic: [0x89, 0x50, 0x4E, 0x47] }, { ext: "gif", magic: [0x47, 0x49, 0x46, 0x38] }, { ext: "webp", magic: [0x52, 0x49, 0x46, 0x46] }];
const AUDIO_TYPES = [{ ext: "webm", magic: [0x1A, 0x45, 0xDF, 0xA3] }, { ext: "ogg", magic: [0x4F, 0x67, 0x67, 0x53] }, { ext: "mp4", magic: null }];
function matchesMediaType(buffer, type) { if (!type.magic) return buffer.length > 12 && buffer.slice(4, 8).toString("ascii") === "ftyp"; if (buffer.length < type.magic.length) return false; return type.magic.every((byte, index) => buffer[index] === byte); }

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
let authSecret;
try { authSecret = fs.readFileSync(AUTH_SECRET_FILE, "utf8").trim(); } catch { authSecret = crypto.randomBytes(48).toString("base64url"); fs.writeFileSync(AUTH_SECRET_FILE, authSecret, { encoding: "utf8", mode: 0o600 }); }
let userStore = { version: 1, users: [] };
try { userStore = JSON.parse(fs.readFileSync(USER_FILE, "utf8")); } catch {}
let roomStore = { version: 1, rooms: BUILT_INS };
try {
  const saved = JSON.parse(fs.readFileSync(ROOM_FILE, "utf8"));
  const customs = Array.isArray(saved.rooms) ? saved.rooms.filter(room => !room.builtIn) : [];
  roomStore = { version: 1, rooms: [...BUILT_INS, ...customs] };
} catch { fs.writeFileSync(ROOM_FILE, JSON.stringify(roomStore, null, 2)); }

let saveUsersQueue = Promise.resolve();
let saveRoomsQueue = Promise.resolve();
const sessions = new Map();
const attempts = new Map();
const roomMessages = new Map();
const clean = value => String(value || "").trim();
const publicUser = user => ({ id: user.id, username: user.username, age: user.age, role: user.role || "user", provider: "profile-key", profileComplete: Boolean(user.profileComplete), profile: user.profile || { displayName: user.username, avatar: "✨", bio: "", gender: "", interests: [], photo: null, photos: [] } });
const json = (res, status, payload) => res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify(payload));
const saveUsers = () => (saveUsersQueue = saveUsersQueue.then(() => fsp.writeFile(USER_FILE, JSON.stringify(userStore, null, 2), "utf8")));
const saveRooms = () => (saveRoomsQueue = saveRoomsQueue.then(() => fsp.writeFile(ROOM_FILE, JSON.stringify(roomStore, null, 2), "utf8")));
const dynamicAdmin = userStore.users.find(user => user.usernameLower === "dynamic");
if (dynamicAdmin && dynamicAdmin.role !== "admin") { dynamicAdmin.role = "admin"; saveUsers(); }
let firebaseDb = null;
function initFirebase() {
  try {
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT || "";
    if (!raw) return;
    const json = raw.trim().startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
    if (!getApps().length) initializeApp({ credential: cert(JSON.parse(json)) });
    firebaseDb = getFirestore();
    console.log("Firestore connected");
  } catch (error) { console.error(`Firestore init failed: ${error.message}`); }
}
function firestoreProfile(user) { return { id: user.id, username: user.username, usernameLower: user.usernameLower, age: user.age, role: user.role || "user", displayName: (user.profile && user.profile.displayName) || user.username, avatar: (user.profile && user.profile.avatar) || "✨", bio: (user.profile && user.profile.bio) || "", gender: (user.profile && user.profile.gender) || "", interests: (user.profile && user.profile.interests) || [], photo: (user.profile && user.profile.photo) || null, photos: (user.profile && user.profile.photos) || [], updatedAt: Date.now() }; }
async function syncProfile(user) { if (!firebaseDb || !user) return; try { await firebaseDb.collection("profiles").doc(user.id).set(firestoreProfile(user), { merge: true }); } catch (error) { console.error(`Profile sync failed: ${error.message}`); } }
function onlineUserIds() { const ids = new Set(); for (const client of wss.clients) if (client.readyState === WebSocket.OPEN && client.user) ids.add(client.user.id); return ids; }
initFirebase();
if (firebaseDb) setTimeout(() => { for (const account of userStore.users) syncProfile(account); }, 4000);
function canBanUser(room, actor, target) { const actorRole = actor.role || "user", targetRole = target.role || "user"; if (actor.id === target.id) return false; if (targetRole === "admin") return false; if (actorRole === "admin") return true; if (targetRole === "mod") return false; if (actorRole === "mod") return true; return room.ownerId === actor.id; }

function readBody(req, limit = 16384) { return new Promise((resolve, reject) => { let body = ""; req.on("data", chunk => { body += chunk; if (body.length > limit) { reject(new Error("Request too large")); req.destroy(); } }); req.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { reject(new Error("Invalid request")); } }); req.on("error", reject); }); }
function readForm(req) { return new Promise((resolve, reject) => { let body = ""; req.on("data", chunk => { body += chunk; if (body.length > 16384) { reject(new Error("Request too large")); req.destroy(); } }); req.on("end", () => { try { resolve(Object.fromEntries(new URLSearchParams(body))); } catch { reject(new Error("Invalid form")); } }); req.on("error", reject); }); }
function parseCookies(req) { const cookies = {}; for (const part of String(req.headers.cookie || "").split(";")) { const index = part.indexOf("="); if (index === -1) continue; const key = part.slice(0, index).trim(); if (!key) continue; try { cookies[key] = decodeURIComponent(part.slice(index + 1).trim()); } catch { continue; } } return cookies; }
function safeDecode(value) { try { return decodeURIComponent(value); } catch { return null; } }
function issueAuthToken(user) { const expiresAt = Date.now() + TOKEN_TTL_MS, payload = `device.${user.id}.${Number(user.tokenVersion) || 0}.${expiresAt}`, signature = crypto.createHmac("sha256", authSecret).update(payload).digest("base64url"); return `${payload}.${signature}`; }
function verifyAuthToken(token) { try { const parts = String(token || "").split("."); if (parts.length !== 5) return null; const [version, userId, tokenVersion, expiresAt, signature] = parts; if (version !== "device") return null; if (!Number.isFinite(Number(expiresAt)) || Number(expiresAt) < Date.now()) return null; const payload = `${version}.${userId}.${tokenVersion}.${expiresAt}`, expected = crypto.createHmac("sha256", authSecret).update(payload).digest("base64url"); if (String(signature).length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null; const user = userStore.users.find(item => item.id === userId); if (!user || (Number(user.tokenVersion) || 0) !== Number(tokenVersion)) return null; return user; } catch { return null; } }
function bearerToken(req) { const authorization = String(req.headers.authorization || ""); if (authorization.startsWith("Bearer ")) return authorization.slice(7); try { return new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).searchParams.get("token"); } catch { return null; } }
function sessionUser(req) { const signedUser = verifyAuthToken(bearerToken(req)); if (signedUser) return signedUser; const token = parseCookies(req).nearby_session, session = token && sessions.get(token); if (!session || session.expiresAt < Date.now()) { if (token) sessions.delete(token); return null; } return userStore.users.find(user => user.id === session.userId) || null; }
function setSession(req, res, user) { const token = crypto.randomBytes(32).toString("base64url"), maxAge = Math.floor(SESSION_TTL_MS / 1000); sessions.set(token, { userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS }); const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""; res.setHeader("Set-Cookie", `nearby_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`); }
function clearSession(req, res) { const token = parseCookies(req).nearby_session; if (token) sessions.delete(token); const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""; res.setHeader("Set-Cookie", `nearby_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`); }
function sameOrigin(req) { const origin = req.headers.origin; if (!origin) return true; try { return new URL(origin).host === req.headers.host; } catch { return false; } }
function rateLimited(req, key, limit = 15) { const id = `${req.socket.remoteAddress}:${key}`, now = Date.now(), record = attempts.get(id) || { count: 0, resetAt: now + 600000 }; if (record.resetAt < now) { record.count = 0; record.resetAt = now + 600000; } record.count++; attempts.set(id, record); return record.count > limit; }
function normalizeProfileKey(value) { return clean(value).toUpperCase().replace(/[^A-Z0-9]/g, ""); }
function hashProfileKey(value) { return crypto.createHash("sha256").update(normalizeProfileKey(value)).digest("hex"); }
function generateProfileKey() { const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", bytes = crypto.randomBytes(20), characters = [...bytes].map(byte => alphabet[byte % alphabet.length]).join(""), groups = characters.match(/.{1,4}/g); return `CHATBLINK-${groups.join("-")}`; }
function keyPage(profileKey, token) {
  const safeKey = clean(profileKey).replace(/[^A-Z0-9-]/g, ""), safeToken = clean(token).replace(/[^A-Za-z0-9._-]/g, "");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#101828"><title>Your Chatblink key</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:linear-gradient(145deg,#0f172a,#172554);font-family:Arial,sans-serif;color:#14213d}.card{width:min(620px,100%);background:#fff;border-radius:24px;padding:36px;box-shadow:0 24px 70px #02061766}.brand{font-size:22px;font-weight:800;color:#2563eb}.icon{font-size:44px;margin:28px 0 10px}h1{font-size:32px;margin:0 0 10px}p{font-size:16px;line-height:1.55;color:#526074}code{display:block;margin:24px 0 14px;padding:18px;border:2px dashed #93b4ff;border-radius:14px;background:#f3f7ff;color:#173f9f;font:700 18px/1.5 monospace;overflow-wrap:anywhere;user-select:all}.actions{display:flex;gap:12px;flex-wrap:wrap}.actions button{border:0;border-radius:12px;padding:14px 18px;font-size:16px;font-weight:700;cursor:pointer}.copy{background:#eaf1ff;color:#1749a3}.actions form{display:flex;flex:1}.enter{width:100%;background:#2563eb;color:#fff}.note{font-size:14px;margin:18px 0 0}</style></head><body><main class="card"><div class="brand">Chatblink</div><div class="icon">🔑</div><h1>Save your profile key</h1><p>Your account is ready. Keep this key somewhere safe; it is the only way to regain access after clearing this browser's data.</p><code id="key">${safeKey}</code><div class="actions"><button class="copy" type="button" onclick="navigator.clipboard.writeText(document.getElementById('key').textContent).then(()=>this.textContent='Copied')">Copy key</button><form method="post" action="/enter"><input type="hidden" name="token" value="${safeToken}"><button class="enter" type="submit">Continue to chatrooms →</button></form></div><p class="note">This browser will remember your account automatically.</p></main><script>try{localStorage.setItem('nearby_auth_token',${JSON.stringify(token)})}catch{}</script></body></html>`;
}
function userForProfileKey(value) { const candidate = hashProfileKey(value); return userStore.users.find(user => user.keyHash && user.keyHash.length === candidate.length && crypto.timingSafeEqual(Buffer.from(user.keyHash), Buffer.from(candidate))) || null; }
function findRoom(id) { return roomStore.rooms.find(room => room.id === id); }
function canEnter(room, user) { return Boolean(room) && (room.access === "open" || Boolean(user) && (room.ownerId === user.id || room.members.includes(user.id))); }
function roomView(room, user) { const media = roomMedia(room); return { id: room.id, name: room.name, icon: room.icon, vibe: room.vibe, accent: room.accent, soft: room.soft, emojis: media.emojis, stickers: media.stickers, gifs: media.gifs, access: room.access, builtIn: room.builtIn, isOwner: Boolean(user) && room.ownerId === user.id, banned: Boolean(user) && Array.isArray(room.bans) && room.bans.includes(user.id), canEnter: canEnter(room, user), requestStatus: user && room.requests.includes(user.id) ? "pending" : null, pendingCount: user && room.ownerId === user.id ? room.requests.length : undefined, online: clientsIn(room.id).length, createdAt: room.createdAt }; }
function slugify(name) { const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "room"; if (!findRoom(base)) return base; for (let attempt = 0; attempt < 20; attempt++) { const id = `${base}-${crypto.randomBytes(3).toString("hex")}`; if (!findRoom(id)) return id; } return `room-${crypto.randomUUID()}`; }

async function createAccount(body) {
  const username = clean(body.username), age = Number(body.age);
  if (body.adultConfirmed !== true) throw new Error("Confirm that you are 18 or older.");
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) throw new Error("Username must be 3–24 characters using letters, numbers, or underscores.");
  if (!Number.isInteger(age) || age < 18 || age > 120) throw new Error("Enter a valid age of 18 or older.");
  if (userStore.users.some(user => user.usernameLower === username.toLowerCase())) throw new Error("That username is already taken.");
  const profileKey = generateProfileKey();
  const user = { id: crypto.randomUUID(), username, usernameLower: username.toLowerCase(), age, keyHash: hashProfileKey(profileKey), provider: "profile-key", profileComplete: true, profile: { displayName: username, avatar: "✨", bio: "", gender: "", interests: [] }, dmMediaGranted: [], dmMediaRequests: [], adultConfirmedAt: new Date().toISOString(), createdAt: new Date().toISOString() };
  if (user.usernameLower === "dynamic") user.role = "admin";
  userStore.users.push(user); await saveUsers(); syncProfile(user); return { user, profileKey };
}

function serveRooms(req, res, requestUrl, authenticatedUser = null, newKey = null) {
  return fs.readFile(path.join(PUBLIC_DIR, "rooms.html"), "utf8", (error, source) => {
    if (error) return res.writeHead(404).end("Not found");
    const user = authenticatedUser || sessionUser(req), loginError = clean(requestUrl.searchParams.get("error"));
    let output = source;
    const canonicalPath = requestUrl.pathname === "/rooms" ? "/rooms" : requestUrl.pathname.startsWith("/room/") ? requestUrl.pathname : "/";
    if (!output.includes('rel="canonical"')) output = output.replace("</head>", `<link rel="canonical" href="https://chatblink.chat${canonicalPath}"></head>`);
    if (user) {
      const bootstrap = JSON.stringify(publicUser(user)).replace(/</g, "\\u003c");
      const tokenBootstrap = JSON.stringify(issueAuthToken(user)).replace(/</g, "\\u003c");
      const keyBootstrap = newKey ? `window.__NEARBY_NEW_KEY__=${JSON.stringify(newKey).replace(/</g, "\\u003c")};` : "";
      output = output.replace('<main class="auth-shell" id="authView">', '<main class="auth-shell" id="authView" hidden>')
        .replace('<main class="app" id="appView" hidden>', '<main class="app" id="appView">')
        .replace('<script src="/multi-room.js"></script>', `<script>window.__NEARBY_USER__=${bootstrap};window.__NEARBY_TOKEN__=${tokenBootstrap};${keyBootstrap}</script><script src="/multi-room.js?v=33"></script>`);
    } else {
      output = output.replace('<main class="app" id="appView" hidden>', '<main class="app" id="appView">')
        .replace('<script src="/multi-room.js"></script>', '<script src="/multi-room.js?v=33"></script>');
      if (loginError && requestUrl.searchParams.get("mode") !== "signup") output = output.replace('<div class="form-error" id="loginError" hidden></div>', `<div class="form-error" id="loginError">${loginError.replace(/[&<>"']/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[character])}</div>`);
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, no-cache, must-revalidate", "Pragma": "no-cache" }).end(output);
  });
}

async function handleRequest(req, res) {
  let requestUrl, urlPath;
  try { requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`); urlPath = safeDecode(requestUrl.pathname); } catch { urlPath = null; }
  if (!urlPath) return res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }).end("Bad request");
  if (urlPath === "/api/config") return json(res, 200, { giphyApiKey: process.env.GIPHY_API_KEY || null });
  if (urlPath === "/api/auth/me") { const user = sessionUser(req); return user ? json(res, 200, { user: publicUser(user) }) : json(res, 401, { error: "Not signed in" }); }
  if (urlPath === "/api/users" && req.method === "GET") { const user = sessionUser(req); if (!user) return json(res, 401, { error: "Sign in first." }); const onlineIds = onlineUserIds(); return json(res, 200, { users: userStore.users.filter(item => item.id !== user.id).map(item => ({ ...publicUser(item), online: onlineIds.has(item.id) })) }); }
  if (urlPath === "/api/explore" && req.method === "GET") { const user = sessionUser(req); if (!user) return json(res, 401, { error: "Sign in first." }); const limit = Math.min(48, Math.max(6, Number(requestUrl.searchParams.get("limit")) || 24)), q = clean(requestUrl.searchParams.get("q") || "").toLowerCase(), cursor = Number(requestUrl.searchParams.get("cursor") || 0); const onlineIds = onlineUserIds(); if (firebaseDb) { try { let query = firebaseDb.collection("profiles"); if (q) query = query.where("usernameLower", ">=", q).where("usernameLower", "<=", q + "\uf8ff").orderBy("usernameLower").limit(limit + 1); else { query = query.orderBy("updatedAt", "desc").limit(limit + 1); if (cursor) query = query.startAfter(cursor); } const snapshot = await query.get(), docs = snapshot.docs.map(doc => doc.data()), hasMore = docs.length > limit, profiles = docs.slice(0, limit).map(profile => ({ ...profile, online: onlineIds.has(profile.id), isSelf: profile.id === user.id })); return json(res, 200, { profiles, nextCursor: hasMore && !q ? profiles[profiles.length - 1].updatedAt : null }); } catch (error) { console.error(`Explore query failed: ${error.message}`); } } const fallback = userStore.users.filter(item => !q || item.usernameLower.includes(q)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(item => ({ ...firestoreProfile(item), online: onlineIds.has(item.id), isSelf: item.id === user.id })); return json(res, 200, { profiles: fallback, nextCursor: null }); }
  const profileMatch = urlPath.match(/^\/api\/profiles\/([^/]+)$/);
  if (profileMatch && req.method === "GET") { const user = sessionUser(req); if (!user) return json(res, 401, { error: "Sign in first." }); const username = safeDecode(profileMatch[1]), account = username && userStore.users.find(item => item.usernameLower === username.toLowerCase()); if (!account) return json(res, 404, { error: "Profile not found." }); const onlineIds = onlineUserIds(); return json(res, 200, { profile: { ...firestoreProfile(account), online: onlineIds.has(account.id), isSelf: account.id === user.id } }); }
  if (urlPath.startsWith("/api/dm/permissions/")) { const user = sessionUser(req); if (!user) return json(res, 401, { error: "Sign in first." }); const otherId = safeDecode(urlPath.slice("/api/dm/permissions/".length)), other = userStore.users.find(item => item.id === otherId); if (!other) return json(res, 404, { error: "User not found." }); user.dmMediaGranted = user.dmMediaGranted || []; user.dmMediaRequests = user.dmMediaRequests || []; other.dmMediaGranted = other.dmMediaGranted || []; other.dmMediaRequests = other.dmMediaRequests || []; if (req.method === "GET") return json(res, 200, { canSend: other.dmMediaGranted.includes(user.id), outgoingPending: other.dmMediaRequests.includes(user.id), incomingPending: user.dmMediaRequests.includes(other.id), incomingGranted: user.dmMediaGranted.includes(other.id) }); if (req.method === "POST") { if (!sameOrigin(req)) return json(res, 403, { error: "Request origin was rejected." }); try { const body = await readBody(req), action = clean(body.action); if (action === "request") { if (!other.dmMediaRequests.includes(user.id) && !other.dmMediaGranted.includes(user.id)) other.dmMediaRequests.push(user.id); await saveUsers(); notifyUser(other.id, { type: "dm-permission", from: publicUser(user), status: "requested" }); return json(res, 200, { outgoingPending: true }); } if (action === "grant") { if (user.dmMediaRequests.includes(other.id)) { user.dmMediaRequests = user.dmMediaRequests.filter(id => id !== other.id); if (!user.dmMediaGranted.includes(other.id)) user.dmMediaGranted.push(other.id); } await saveUsers(); notifyUser(other.id, { type: "dm-permission", from: publicUser(user), status: "granted" }); return json(res, 200, { incomingGranted: true }); } if (action === "decline") { user.dmMediaRequests = user.dmMediaRequests.filter(id => id !== other.id); await saveUsers(); notifyUser(other.id, { type: "dm-permission", from: publicUser(user), status: "declined" }); return json(res, 200, { incomingPending: false }); } if (action === "revoke") { user.dmMediaGranted = user.dmMediaGranted.filter(id => id !== other.id); await saveUsers(); notifyUser(other.id, { type: "dm-permission", from: publicUser(user), status: "revoked" }); return json(res, 200, { incomingGranted: false }); } throw new Error("Unknown action."); } catch (error) { return json(res, 400, { error: error.message }); } } }
  if (urlPath === "/api/admin/users" && req.method === "GET") { const user = sessionUser(req); if (!user || user.role !== "admin") return json(res, 403, { error: "Admin only." }); return json(res, 200, { users: userStore.users.map(publicUser) }); }
  if (urlPath.startsWith("/api/admin/role/") && req.method === "POST") { const user = sessionUser(req); if (!user || user.role !== "admin") return json(res, 403, { error: "Admin only." }); if (!sameOrigin(req)) return json(res, 403, { error: "Request origin was rejected." }); try { const targetId = safeDecode(urlPath.slice("/api/admin/role/".length)), target = userStore.users.find(item => item.id === targetId); if (!target) return json(res, 404, { error: "User not found." }); if (target.id === user.id || target.role === "admin") throw new Error("That user's role cannot be changed."); const body = await readBody(req); target.role = clean(body.role) === "mod" ? "mod" : "user"; await saveUsers(); refreshUserPresence(target.id); syncProfile(target); return json(res, 200, { user: publicUser(target) }); } catch (error) { return json(res, 400, { error: error.message }); } }
  if (urlPath === "/api/auth/signup" && req.method === "POST") { if (!sameOrigin(req)) return json(res, 403, { error: "Request origin was rejected." }); if (rateLimited(req, "signup", 10)) return json(res, 429, { error: "Too many attempts. Try again later." }); try { const result = await createAccount(await readBody(req)); setSession(req, res, result.user); return json(res, 201, { user: publicUser(result.user), token: issueAuthToken(result.user), profileKey: result.profileKey }); } catch (error) { return json(res, 400, { error: error.message }); } }
  if (urlPath === "/api/auth/login" && req.method === "POST") { if (!sameOrigin(req)) return json(res, 403, { error: "Request origin was rejected." }); if (rateLimited(req, "login", 20)) return json(res, 429, { error: "Too many attempts. Try again later." }); try { const body = await readBody(req), user = userForProfileKey(body.key); if (!user) throw new Error("That profile key is not valid."); setSession(req, res, user); return json(res, 200, { user: publicUser(user), token: issueAuthToken(user) }); } catch (error) { return json(res, 401, { error: error.message }); } }
  if (urlPath === "/api/auth/logout" && req.method === "POST") { if (!sameOrigin(req)) return json(res, 403, { error: "Request origin was rejected." }); const user = sessionUser(req); if (user) { user.tokenVersion = (Number(user.tokenVersion) || 0) + 1; await saveUsers(); } clearSession(req, res); return json(res, 200, { ok: true }); }
  if (urlPath === "/auth/login" && req.method === "POST") { if (!sameOrigin(req)) return res.writeHead(403).end("Request origin was rejected."); if (rateLimited(req, "login-form", 20)) return res.writeHead(303, { Location: "/?mode=login&error=" + encodeURIComponent("Too many attempts. Try again later.") }).end(); try { const body = await readForm(req), user = userForProfileKey(body.key); if (!user) throw new Error("That profile key is not valid."); setSession(req, res, user); return serveRooms(req, res, requestUrl, user); } catch (error) { return res.writeHead(303, { Location: "/?mode=login&error=" + encodeURIComponent(error.message) }).end(); } }
  if (urlPath === "/auth/signup" && req.method === "POST") { if (!sameOrigin(req)) return res.writeHead(403).end("Request origin was rejected."); if (rateLimited(req, "signup-form", 10)) return res.writeHead(303, { Location: "/?mode=signup&error=" + encodeURIComponent("Too many attempts. Try again later.") }).end(); try { const body = await readForm(req), result = await createAccount({ ...body, adultConfirmed: body.adultConfirmed === "on" }); setSession(req, res, result.user); return serveRooms(req, res, requestUrl, result.user, result.profileKey); } catch (error) { return res.writeHead(303, { Location: "/?mode=signup&error=" + encodeURIComponent(error.message) }).end(); } }
  if (urlPath === "/enter" && req.method === "POST") { if (!sameOrigin(req)) return res.writeHead(403).end("Request origin was rejected."); try { const body = await readForm(req), user = verifyAuthToken(body.token); if (!user) throw new Error("This entry link is no longer valid."); setSession(req, res, user); return serveRooms(req, res, requestUrl, user); } catch (error) { return res.writeHead(303, { Location: "/?mode=login&error=" + encodeURIComponent(error.message) }).end(); } }
  if (urlPath === "/api/profile" && req.method === "POST") { const user = sessionUser(req); if (!user) return json(res, 401, { error: "Sign in first." }); if (!sameOrigin(req)) return json(res, 403, { error: "Request origin was rejected." }); try { const body = await readBody(req), avatars = ["✨","🌻","🌙","⚡","🌊","🎧","🦋","🔥"], genders = ["","woman","man","nonbinary","prefer_not"]; user.profile = { displayName: clean(body.displayName).slice(0, 30) || user.username, avatar: avatars.includes(body.avatar) ? body.avatar : "✨", bio: clean(body.bio).slice(0, 160), gender: genders.includes(body.gender) ? body.gender : "", interests: clean(body.interests).split(",").map(item => item.trim()).filter(Boolean).slice(0, 6), photo: clean(body.photo) === "" ? null : (safeUploadUrl(clean(body.photo)) || (user.profile && user.profile.photo) || null), photos: (user.profile && user.profile.photos) || [] }; user.profileComplete = true; await saveUsers(); refreshUserPresence(user.id); syncProfile(user); return json(res, 200, { user: publicUser(user) }); } catch (error) { return json(res, 400, { error: error.message }); } }
  if (urlPath === "/api/profile/photos" && req.method === "POST") { const user = sessionUser(req); if (!user) return json(res, 401, { error: "Sign in first." }); if (!sameOrigin(req)) return json(res, 403, { error: "Request origin was rejected." }); try { const body = await readBody(req), url = safeUploadUrl(clean(body.url)); if (!url) throw new Error("That photo is not available."); const photos = (user.profile && user.profile.photos) || []; if (!photos.includes(url)) { if (photos.length >= 8) throw new Error("You can keep up to 8 photos."); user.profile = { ...(user.profile || {}), photos: [...photos, url] }; await saveUsers(); syncProfile(user); } return json(res, 200, { photos: (user.profile && user.profile.photos) || [] }); } catch (error) { return json(res, 400, { error: error.message }); } }
  if (urlPath === "/api/profile/photos/remove" && req.method === "POST") { const user = sessionUser(req); if (!user) return json(res, 401, { error: "Sign in first." }); if (!sameOrigin(req)) return json(res, 403, { error: "Request origin was rejected." }); try { const body = await readBody(req), url = clean(body.url); const photos = ((user.profile && user.profile.photos) || []).filter(item => item !== url); user.profile = { ...(user.profile || {}), photos }; await saveUsers(); syncProfile(user); return json(res, 200, { photos }); } catch (error) { return json(res, 400, { error: error.message }); } }
  if (urlPath === "/api/upload" && req.method === "POST") { const user = sessionUser(req); if (!user) return json(res, 401, { error: "Sign in first." }); if (!sameOrigin(req)) return json(res, 403, { error: "Request origin was rejected." }); if (rateLimited(req, "upload", 30)) return json(res, 429, { error: "Too many uploads. Try again later." }); try { const body = await readBody(req, 9 * 1024 * 1024), kind = clean(body.kind), data = clean(body.data); if (!data) throw new Error("Upload payload is missing."); const buffer = Buffer.from(data, "base64"); if (!buffer.length) throw new Error("That file is empty."); if (buffer.length > (kind === "voice" ? 4 : 6) * 1024 * 1024) throw new Error("That file is too large."); const type = (kind === "voice" ? AUDIO_TYPES : IMAGE_TYPES).find(item => matchesMediaType(buffer, item)); if (!type) throw new Error(kind === "voice" ? "Unsupported audio format." : "Unsupported image format."); const name = `${crypto.randomUUID()}.${type.ext}`; await fsp.writeFile(path.join(UPLOAD_DIR, name), buffer); return json(res, 201, { url: `/uploads/${name}` }); } catch (error) { return json(res, 400, { error: error.message }); } }

  if (urlPath.startsWith("/api/rooms")) {
    const user = sessionUser(req);
    if (!user && urlPath === "/api/rooms" && req.method === "GET") return json(res, 200, { rooms: roomStore.rooms.map(room => roomView(room, null)) });
    if (!user) return json(res, 401, { error: "Sign in first." });
    if (req.method !== "GET" && !sameOrigin(req)) return json(res, 403, { error: "Request origin was rejected." });
    if (urlPath === "/api/rooms" && req.method === "GET") return json(res, 200, { rooms: roomStore.rooms.map(room => roomView(room, user)) });
    const banMatch = urlPath.match(/^\/api\/rooms\/([^/]+)\/bans(?:\/([^/]+))?$/);
    if (banMatch) { const banRoom = findRoom(banMatch[1]); if (!banRoom) return json(res, 404, { error: "Room not found." }); const actorRole = user.role || "user"; if (!(actorRole === "admin" || actorRole === "mod" || banRoom.ownerId === user.id)) return json(res, 403, { error: "Only the room creator, mods, or the admin can manage bans." }); if (req.method === "GET") return json(res, 200, { users: (banRoom.bans || []).map(id => userStore.users.find(item => item.id === id)).filter(Boolean).map(publicUser) }); if (req.method === "POST" && banMatch[2]) { try { const target = userStore.users.find(item => item.id === banMatch[2]); if (!target) return json(res, 404, { error: "User not found." }); const body = await readBody(req), unban = clean(body.action) === "unban"; if (!unban && !canBanUser(banRoom, user, target)) return json(res, 403, { error: "You cannot ban this user." }); if (unban) banRoom.bans = (banRoom.bans || []).filter(id => id !== target.id); else banRoom.bans = [...new Set([...(banRoom.bans || []), target.id])]; await saveRooms(); notifyUser(target.id, { type: "room-ban", roomId: banRoom.id, banned: !unban }); return json(res, 200, { ok: true, banned: !unban }); } catch (error) { return json(res, 400, { error: error.message }); } } }
    if (urlPath === "/api/rooms" && req.method === "POST") { try { if (rateLimited(req, "room-create", 5)) throw new Error("Too many rooms created recently. Try again later."); const body = await readBody(req), name = clean(body.name).slice(0, 40), access = body.access === "request" ? "request" : "open", presets = { ocean: {accent:"#0284c7",soft:"#e7f7ff"}, sunset: {accent:"#f97316",soft:"#fff0e7"}, berry: {accent:"#d946ef",soft:"#fcecff"}, forest: {accent:"#16a34a",soft:"#eaf8ec"} }, pack = presets[body.theme] || presets.ocean; if (name.length < 3) throw new Error("Room name must be at least 3 characters."); if (roomStore.rooms.filter(room => room.ownerId === user.id).length >= MAX_ROOMS_PER_USER) throw new Error(`You can create up to ${MAX_ROOMS_PER_USER} rooms.`); const room = { id: slugify(name), name, icon: access === "request" ? "🔐" : "✦", vibe: clean(body.vibe).slice(0, 100) || `A community room created by ${user.username}.`, accent:pack.accent, soft:pack.soft, emojis:ALL_EMOJIS, stickers:ALL_STICKERS, gifs:ALL_GIFS, access, builtIn: false, ownerId: user.id, members: [], requests: [], createdAt: new Date().toISOString() }; roomStore.rooms.push(room); await saveRooms(); return json(res, 201, { room: roomView(room, user) }); } catch (error) { return json(res, 400, { error: error.message }); } }
    const match = urlPath.match(/^\/api\/rooms\/([^/]+)(?:\/(?:request|requests(?:\/([^/]+))?))?$/), room = match && findRoom(match[1]);
    if (!room) return json(res, 404, { error: "Room not found." });
    if (urlPath.endsWith("/request") && req.method === "POST") { if (room.access !== "request") return json(res, 400, { error: "This room is open." }); if (room.ownerId !== user.id && !room.members.includes(user.id) && !room.requests.includes(user.id)) { if (room.requests.length >= MAX_PENDING_REQUESTS) return json(res, 429, { error: "This room has too many pending requests. Try again later." }); room.requests.push(user.id); await saveRooms(); notifyUser(room.ownerId, { type: "room-updated", roomId: room.id }); return json(res, 200, { status: "pending" }); } return json(res, 200, { status: room.members.includes(user.id) ? "member" : "pending" }); }
    if (match && urlPath.endsWith("/requests") && req.method === "GET") { if (room.ownerId !== user.id) return json(res, 403, { error: "Only the room creator can view requests." }); return json(res, 200, { requests: room.requests.map(id => userStore.users.find(item => item.id === id)).filter(Boolean).map(publicUser) }); }
    if (match && match[2] && req.method === "POST") { if (room.ownerId !== user.id) return json(res, 403, { error: "Only the room creator can manage requests." }); const body = await readBody(req), targetId = match[2]; room.requests = room.requests.filter(id => id !== targetId); if (body.action === "approve" && !room.members.includes(targetId)) room.members.push(targetId); await saveRooms(); notifyUser(targetId, { type: "room-updated", roomId: room.id }); return json(res, 200, { ok: true }); }
    const deleteMatch = urlPath.match(/^\/api\/rooms\/([^/]+)$/);
    if (deleteMatch && req.method === "DELETE") { const target = findRoom(deleteMatch[1]); if (!target) return json(res, 404, { error: "Room not found." }); if (target.builtIn) return json(res, 400, { error: "Built-in rooms cannot be deleted." }); if (target.ownerId !== user.id && user.role !== "admin") return json(res, 403, { error: "Only the room creator or the admin can delete this room." }); roomStore.rooms = roomStore.rooms.filter(room => room.id !== target.id); roomMessages.delete(target.id); await saveRooms(); for (const client of wss.clients) if (client.readyState === WebSocket.OPEN && client.roomId === target.id) client.send(JSON.stringify({ type: "room-deleted", roomId: target.id })); return json(res, 200, { ok: true }); }
    return json(res, 404, { error: "Room action not found." });
  }

  if (urlPath === "/" || urlPath === "/index.html" || urlPath === "/rooms" || urlPath === "/dms" || urlPath === "/explore" || urlPath.startsWith("/room/") || urlPath.startsWith("/profile/")) return serveRooms(req, res, requestUrl);
  if (urlPath.startsWith("/uploads/")) { const name = urlPath.slice(9); if (!/^[a-f0-9-]{36}\.(jpg|png|gif|webp|webm|mp4|m4a|ogg)$/.test(name)) return res.writeHead(404).end("Not found"); return fs.readFile(path.join(UPLOAD_DIR, name), (error, data) => { if (error) return res.writeHead(404).end("Not found"); const types = { ".jpg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".webm": "audio/webm", ".mp4": "audio/mp4", ".m4a": "audio/mp4", ".ogg": "audio/ogg" }; res.writeHead(200, { "Content-Type": types[path.extname(name)] || "application/octet-stream", "Cache-Control": "private, max-age=86400" }).end(data); }); }
  const relative = urlPath.replace(/^\/+/, ""), file = path.resolve(PUBLIC_DIR, relative); if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) return res.writeHead(403).end("Forbidden"); fs.readFile(file, (error, data) => { if (error) return res.writeHead(404).end("Not found"); const types = { ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg", ".gif": "image/gif", ".txt": "text/plain; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".html": "text/html; charset=utf-8" }; res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" }).end(data); });
}

const server = http.createServer((req, res) => { handleRequest(req, res).catch(error => { console.error(`Request failed: ${error && error.stack || error}`); if (res.headersSent) return res.end(); res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" }).end("Something went wrong."); }); });

const wss = new WebSocketServer({ noServer: true, maxPayload: 16384 });
server.on("upgrade", (req, socket, head) => {
  try {
    if (!sameOrigin(req)) return socket.destroy();
    const user = sessionUser(req), roomId = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).searchParams.get("room"), room = roomId && findRoom(roomId);
    if (!user || !canEnter(room, user)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => { ws.user = user; ws.roomId = roomId; wss.emit("connection", ws); });
  } catch { socket.destroy(); }
});
function clientsIn(roomId) { return [...wss.clients].filter(client => client.readyState === WebSocket.OPEN && client.roomId === roomId); }
function broadcast(roomId, payload) { const text = JSON.stringify(payload); for (const client of clientsIn(roomId)) client.send(text); }
function notifyUser(userId, payload) { const text = JSON.stringify(payload); for (const client of wss.clients) if (client.readyState === WebSocket.OPEN && client.user && client.user.id === userId) client.send(text); }
function refreshUserPresence(userId) { const rooms = new Set(); for (const client of wss.clients) if (client.readyState === WebSocket.OPEN && client.user && client.user.id === userId) rooms.add(client.roomId); for (const roomId of rooms) broadcastPresence(roomId); }
function safeMediaUrl(value) { const candidate = String(value || "").trim(); if (/^\/gifs\/[a-z0-9-]+\.gif$/i.test(candidate)) return candidate; try { const url = new URL(candidate); return url.protocol === "https:" && ["media.giphy.com", "i.giphy.com", "media.tenor.com", "media1.tenor.com"].some(host => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url.href : null; } catch { return null; } }
function presencePayload(roomId) { const clients = clientsIn(roomId), seen = new Map(); for (const client of clients) { if (client.user && !seen.has(client.user.id)) seen.set(client.user.id, publicUser(client.user)); } return { type: "presence", online: clients.length, users: [...seen.values()] }; }
function broadcastPresence(roomId) { broadcast(roomId, presencePayload(roomId)); }
wss.on("connection", ws => {
  ws.isAlive = true; ws.messageWindowStart = Date.now(); ws.messageCount = 0;
  ws.on("pong", () => { ws.isAlive = true; });
  const joinedRoom = findRoom(ws.roomId);
  if (joinedRoom && !joinedRoom.builtIn && joinedRoom.access === "open" && !joinedRoom.members.includes(ws.user.id)) { joinedRoom.members.push(ws.user.id); saveRooms(); }
  const messages = roomMessages.get(ws.roomId) || []; roomMessages.set(ws.roomId, messages);
  ws.send(JSON.stringify({ type: "history", messages: messages.slice(-MAX_MESSAGES), online: clientsIn(ws.roomId).length, users: presencePayload(ws.roomId).users }));
  broadcastPresence(ws.roomId);
  ws.on("message", raw => {
    let event; try { event = JSON.parse(raw.toString()); } catch { return; }
    if (event.type === "dm") {
      const now = Date.now();
      if (now - ws.messageWindowStart > MESSAGE_WINDOW_MS) { ws.messageWindowStart = now; ws.messageCount = 0; }
      if (++ws.messageCount > MESSAGE_LIMIT_PER_WINDOW) return;
      const target = userStore.users.find(user => user.id === clean(event.to));
      if (!target) return;
      const kind = ["text", "image", "voice"].includes(event.kind) ? event.kind : "text";
      let content = clean(event.content);
      if (kind === "image" || kind === "voice") { target.dmMediaGranted = target.dmMediaGranted || []; if (!target.dmMediaGranted.includes(ws.user.id)) return; content = safeUploadUrl(content); }
      else content = content.slice(0, 500);
      if (!content) return;
      const payload = { type: "dm", from: publicUser(ws.user), to: target.id, kind, content, at: Date.now() }, text = JSON.stringify(payload);
      for (const client of wss.clients) if (client.readyState === WebSocket.OPEN && client.user && (client.user.id === target.id || client.user.id === ws.user.id)) client.send(text);
      return;
    }
    if (event.type !== "message") return;
    const now = Date.now();
    if (now - ws.messageWindowStart > MESSAGE_WINDOW_MS) { ws.messageWindowStart = now; ws.messageCount = 0; }
    if (++ws.messageCount > MESSAGE_LIMIT_PER_WINDOW) return;
    const room = findRoom(ws.roomId); if (!room) return;
    if (Array.isArray(room.bans) && room.bans.includes(ws.user.id)) return;
    let kind = ["text", "emoji", "sticker", "gif", "image", "voice"].includes(event.kind) ? event.kind : "text", content = clean(event.content || event.text);
    if (kind === "gif") content = safeMediaUrl(content);
    else if (kind === "image" || kind === "voice") content = safeUploadUrl(content);
    else content = content.slice(0, 500);
    if (!content) return;
    if ((kind === "image" || kind === "voice") && !(room.access === "request" && !room.builtIn)) return;
    const media = roomMedia(room);
    if (kind === "emoji" && !media.emojis.includes(content)) return;
    if (kind === "sticker" && !media.stickers.includes(content)) return;
    const message = { id: crypto.randomUUID(), userId: ws.user.id, username: ws.user.username, role: ws.user.role || "user", photo: ws.user.profile?.photo || null, kind, content, createdAt: Date.now() };
    messages.push(message); if (messages.length > MAX_MESSAGES) messages.splice(0, messages.length - MAX_MESSAGES);
    broadcast(ws.roomId, { type: "message", message });
  });
  ws.on("close", () => broadcastPresence(ws.roomId));
});
const heartbeat = setInterval(() => {
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (!client.isAlive) { client.terminate(); continue; }
    client.isAlive = false;
    try { client.ping(); } catch {}
  }
}, HEARTBEAT_MS);
heartbeat.unref();
const maintenance = setInterval(() => {
  const now = Date.now();
  for (const [key, record] of attempts) if (record.resetAt < now) attempts.delete(key);
  for (const [token, session] of sessions) if (session.expiresAt < now) sessions.delete(token);
}, 600000);
maintenance.unref();

server.on("error", error => { console.error(`Server error: ${error.message}`); process.exit(1); });
server.listen(PORT, () => console.log(`Chatblink rooms are running at http://localhost:${PORT}`));
