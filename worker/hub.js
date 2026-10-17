import { BUILT_INS, ALL_EMOJIS, ALL_STICKERS, ALL_GIFS, roomMedia, safeUploadUrl, safeMediaUrl } from "./lib/catalog.js";
import { clean, safeDecode, json, publicUser, profileDoc, parseCookies, ipOf, isSecure, sameOrigin, bearerToken, sessionCookie, readJson, constantTimeEqual } from "./lib/core.js";
import { issueAuthToken, verifyAuthToken, hashProfileKey, generateProfileKey } from "./lib/crypto.js";
import { USER_COLUMNS, USER_UPSERT, ROOM_UPSERT, rowToUser, userToRow, roomToRow, saveUser, saveRoom, deleteRoom, deleteUser, loadUsers, loadRooms } from "./lib/db.js";
import { parseSubscription, saveSubscription, removeSubscription, subscriptionsFor, pushToUser, pushToAll, pushConfigured } from "./lib/push.js";

const MAX_MESSAGES = 100;
const TRIM_INTERVAL = 25;
const MAX_ROOMS_PER_USER = 20;
const MAX_PENDING_REQUESTS = 200;
const MESSAGE_LIMIT_PER_WINDOW = 20;
const MESSAGE_WINDOW_MS = 10000;
// Per-user daily budgets, because the free tier meters the whole account: one client holding the
// per-window limit drains the DO's 100k rows written/day in ~14h, and one IP drains KV's 1k
// writes/day in under 4. Set either var to 0 to switch that budget off.
const MESSAGE_DAILY_CAP = 1000;
const UPLOAD_DAILY_CAP = 20;
const MESSAGE_KINDS = ["text", "emoji", "sticker", "gif", "image", "voice"];
const DM_KINDS = ["text", "image", "voice"];
const CALL_TYPES = ["call-offer", "call-answer", "call-ice", "call-end", "call-reject", "call-busy"];
const CALL_SIGNAL_LIMIT = 120;
const MESSAGE_TABLE = "CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, id TEXT NOT NULL, user_id TEXT, username TEXT, role TEXT, photo TEXT, kind TEXT, content TEXT, created_at INTEGER NOT NULL)";
const MESSAGE_INDEX = "CREATE INDEX IF NOT EXISTS messages_room ON messages (room_id, seq)";
const ROOM_PRESETS = { ocean: { accent: "#0284c7", soft: "#e7f7ff" }, sunset: { accent: "#f97316", soft: "#fff0e7" }, berry: { accent: "#d946ef", soft: "#fcecff" }, forest: { accent: "#16a34a", soft: "#eaf8ec" } };

const attachment = socket => { try { return socket.deserializeAttachment() || {}; } catch { return {}; } };
// 0 means "budget off", so only fall back when the var is absent or unparseable.
const budget = (value, fallback) => { const parsed = Number(value); return value === undefined || value === null || value === "" || !Number.isFinite(parsed) || parsed < 0 ? fallback : parsed; };

const builtInRooms = () => BUILT_INS.map(room => ({ ...room, emojis: [...room.emojis], stickers: [...room.stickers], gifs: [...room.gifs], members: [], requests: [], bans: [] }));

export class ChatHub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.users = [];
    this.rooms = builtInRooms();
    this.attempts = new Map();
    this.pendingTrim = new Map();
    this.messageWindows = new Map();
    this.callWindows = new Map();
    this.daily = new Map();
    this.dailyDay = 0;
    this.messageDailyCap = budget(env.MESSAGE_DAILY_CAP, MESSAGE_DAILY_CAP);
    this.uploadDailyCap = budget(env.UPLOAD_DAILY_CAP, UPLOAD_DAILY_CAP);
    state.blockConcurrencyWhile(async () => {
      state.storage.sql.exec(MESSAGE_TABLE);
      state.storage.sql.exec(MESSAGE_INDEX);
      await this.hydrate();
    });
  }

  async hydrate() {
    const [users, rows] = await Promise.all([loadUsers(this.env), loadRooms(this.env)]);
    this.users = users;
    const rooms = builtInRooms(), stored = new Map(rows.map(room => [room.id, room]));
    for (const room of rooms) {
      const saved = stored.get(room.id);
      if (saved) { room.bans = saved.bans; room.members = saved.members; room.requests = saved.requests; }
    }
    this.rooms = [...rooms, ...rows.filter(room => !room.builtIn)];
    const admin = this.users.find(user => user.usernameLower === "dynamic");
    if (admin && admin.role !== "admin") { admin.role = "admin"; await saveUser(this.env, admin); }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") return this.handleSocket(request, url);
    const path = safeDecode(url.pathname);
    if (!path) return new Response("Bad request", { status: 400, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    try {
      if (path === "/__internal/session") return await this.internalSession(request);
      if (path === "/__internal/auth") return await this.internalAuth(request, url);
      if (path === "/__internal/upload") return await this.internalUpload(request);
      if (path === "/api/migrate") return await this.internalFlush(request, url);
      return await this.api(request, url, path);
    } catch (error) {
      console.error(`Request failed: ${error && error.stack || error}`);
      return json(500, { error: "Something went wrong." });
    }
  }

  /* ---------------------------------------------------------------- internal */

  async internalSession(request) {
    const user = await this.sessionUser(request);
    return json(200, { user: user ? publicUser(user) : null, token: user ? await this.token(user) : null });
  }

  async internalAuth(request, url) {
    const body = await readJson(request, 16384);
    const action = clean(body.action);
    const ip = ipOf(request);
    const limit = action === "signup" ? 10 : 20;
    if (this.rateLimited(ip, `${action}-form`, limit)) return json(429, { status: 429, error: "Too many attempts. Try again later." });
    if (action === "signup") {
      try {
        const result = await this.createAccount(body.fields || {});
        return json(200, { status: 201, user: publicUser(result.user), token: await this.token(result.user), profileKey: result.profileKey });
      } catch (error) { return json(200, { status: 400, error: error.message }); }
    }
    if (action === "login") {
      const user = await this.userForProfileKey((body.fields || {}).key);
      if (!user) return json(200, { status: 401, error: "That profile key is not valid." });
      return json(200, { status: 200, user: publicUser(user), token: await this.token(user) });
    }
    if (action === "enter") {
      const user = await verifyAuthToken(clean((body.fields || {}).token), this.env.AUTH_SECRET, id => this.userById(id));
      if (!user) return json(200, { status: 401, error: "This entry link is no longer valid." });
      return json(200, { status: 200, user: publicUser(user), token: await this.token(user) });
    }
    return json(200, { status: 400, error: "Unknown action." });
  }

  async internalUpload(request) {
    const user = await this.sessionUser(request);
    if (!user) return json(401, { error: "Sign in first." });
    if (!sameOrigin(request)) return json(403, { error: "Request origin was rejected." });
    if (this.rateLimited(ipOf(request), "upload", 30)) return json(429, { error: "Too many uploads. Try again later." });
    if (this.dailyLimited("upload", user.id, this.uploadDailyCap)) return json(429, { error: "You have reached today's upload limit. Try again tomorrow." });
    return json(200, { ok: true });
  }

  async internalFlush(request, url) {
    const token = clean(url.searchParams.get("token"));
    if (!this.env.MIGRATE_TOKEN || token !== this.env.MIGRATE_TOKEN) return json(404, { error: "Not found." });
    if (request.method !== "POST") return json(200, { users: this.users.length, rooms: this.rooms.length });
    const body = await readJson(request, 32 * 1024 * 1024);
    if (Array.isArray(body.users) && body.users.length) await this.env.DB.batch(body.users.map(user => this.env.DB.prepare(USER_UPSERT).bind(...userToRow({ ...user, tokenVersion: Number(user.tokenVersion) || 0 }))));
    const rooms = Array.isArray(body.rooms) ? body.rooms : [];
    if (rooms.length) await this.env.DB.batch(rooms.map(room => this.env.DB.prepare(ROOM_UPSERT).bind(...roomToRow(room))));
    await this.hydrate();
    this.broadcastAll({ type: "rooms-changed" });
    this.broadcastUsersChanged();
    return json(200, { ok: true, users: this.users.length, rooms: this.rooms.length });
  }

  /* ------------------------------------------------------------- data layer */

  userById(id) { return this.users.find(user => user.id === id) || null; }
  userByUsernameLower(name) { return this.users.find(user => user.usernameLower === name) || null; }
  async userForProfileKey(value) {
    const candidate = await hashProfileKey(value);
    return this.users.find(user => user.keyHash && user.keyHash.length === candidate.length && constantTimeEqual(user.keyHash, candidate)) || null;
  }
  findRoom(id) { return this.rooms.find(room => room.id === id) || null; }
  canEnter(room, user) { return Boolean(room) && (room.access === "open" || Boolean(user) && (room.ownerId === user.id || room.members.includes(user.id))); }
  canBanUser(room, actor, target) {
    const actorRole = actor.role || "user", targetRole = target.role || "user";
    if (actor.id === target.id) return false;
    if (targetRole === "admin") return false;
    if (actorRole === "admin") return true;
    if (targetRole === "mod") return false;
    if (actorRole === "mod") return true;
    return room.ownerId === actor.id;
  }
  async token(user) { return issueAuthToken(user, this.env.AUTH_SECRET); }
  async sessionUser(request) {
    const token = bearerToken(request) || parseCookies(request.headers.get("Cookie")).nearby_session;
    if (!token) return null;
    return verifyAuthToken(token, this.env.AUTH_SECRET, id => this.userById(id));
  }
  rateLimited(ip, key, limit = 15) {
    const id = `${ip}:${key}`, now = Date.now();
    const record = this.attempts.get(id) || { count: 0, resetAt: now + 600000 };
    if (record.resetAt < now) { record.count = 0; record.resetAt = now + 600000; }
    record.count++;
    this.attempts.set(id, record);
    return record.count > limit;
  }
  windowLimited(connectionId, now) {
    const record = this.messageWindows.get(connectionId) || { start: now, count: 0 };
    if (now - record.start > MESSAGE_WINDOW_MS) { record.start = now; record.count = 0; }
    record.count++;
    this.messageWindows.set(connectionId, record);
    return record.count > MESSAGE_LIMIT_PER_WINDOW;
  }
  callLimited(connectionId, now) {
    const record = this.callWindows.get(connectionId) || { start: now, count: 0 };
    if (now - record.start > MESSAGE_WINDOW_MS) { record.start = now; record.count = 0; }
    record.count++;
    this.callWindows.set(connectionId, record);
    return record.count > CALL_SIGNAL_LIMIT;
  }
  // Counts the attempt and reports whether this user has spent their daily budget for `scope`.
  // Deliberately not persisted: a storage write here would cost exactly what the budget protects.
  dailyLimited(scope, userId, limit) {
    if (!limit) return false;
    const day = Math.floor(Date.now() / 86400000);
    if (this.dailyDay !== day) { this.daily.clear(); this.dailyDay = day; }
    const key = `${scope}:${userId}`, count = (this.daily.get(key) || 0) + 1;
    this.daily.set(key, count);
    return count > limit;
  }
  async createAccount(body) {
    const username = clean(body.username), age = Number(body.age);
    if (body.adultConfirmed !== true) throw new Error("Confirm that you are 18 or older.");
    if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) throw new Error("Username must be 3–24 characters using letters, numbers, or underscores.");
    if (!Number.isInteger(age) || age < 18 || age > 120) throw new Error("Enter a valid age of 18 or older.");
    if (this.userByUsernameLower(username.toLowerCase())) throw new Error("That username is already taken.");
    const profileKey = generateProfileKey();
    const user = { id: crypto.randomUUID(), username, usernameLower: username.toLowerCase(), age, keyHash: await hashProfileKey(profileKey), role: username.toLowerCase() === "dynamic" ? "admin" : "user", profile: { displayName: username, avatar: "✨", bio: "", gender: "", interests: [], photo: null, photos: [] }, dmMediaGranted: [], dmMediaRequests: [], adultConfirmedAt: new Date().toISOString(), createdAt: new Date().toISOString(), profileComplete: true };
    await saveUser(this.env, user);
    this.users.push(user);
    return { user, profileKey };
  }
  slugify(name) {
    const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "room";
    if (!this.findRoom(base)) return base;
    for (let attempt = 0; attempt < 20; attempt++) { const id = `${base}-${crypto.randomUUID().slice(0, 6)}`; if (!this.findRoom(id)) return id; }
    return `room-${crypto.randomUUID()}`;
  }
  roomView(room, user) {
    const media = roomMedia(room);
    return { id: room.id, name: room.name, icon: room.icon, vibe: room.vibe, accent: room.accent, soft: room.soft, emojis: media.emojis, stickers: media.stickers, gifs: media.gifs, access: room.access, builtIn: Boolean(room.builtIn), isOwner: Boolean(user) && room.ownerId === user.id, banned: Boolean(user) && Array.isArray(room.bans) && room.bans.includes(user.id), canEnter: this.canEnter(room, user), requestStatus: user && room.requests.includes(user.id) ? "pending" : null, pendingCount: user && room.ownerId === user.id ? room.requests.length : undefined, online: this.roomOnlineCount(room.id), createdAt: room.createdAt };
  }

  /* --------------------------------------------------------------- realtime */

  sockets() { return this.state.getWebSockets().filter(socket => socket.readyState === 1); }
  clientsIn(roomId) { return this.sockets().filter(socket => attachment(socket).roomId === roomId); }
  roomOnlineCount(roomId) { return new Set(this.clientsIn(roomId).map(socket => attachment(socket).userId).filter(Boolean)).size; }
  send(socket, payload) { try { socket.send(JSON.stringify(payload)); } catch {} }
  broadcast(roomId, payload) { const text = JSON.stringify(payload); for (const socket of this.clientsIn(roomId)) { try { socket.send(text); } catch {} } }
  notifyUser(userId, payload) { const text = JSON.stringify(payload); let sent = 0; for (const socket of this.sockets()) if (attachment(socket).userId === userId) { try { socket.send(text); sent++; } catch {} } return sent; }
  notifyUserExcept(userId, excluded, payload) { const text = JSON.stringify(payload); for (const socket of this.sockets()) if (socket !== excluded && attachment(socket).userId === userId) { try { socket.send(text); } catch {} } }
  broadcastAll(payload) { const text = JSON.stringify(payload); for (const socket of this.sockets()) { try { socket.send(text); } catch {} } }
  broadcastRoomOnline(roomId) { if (roomId === "__notify" || !this.findRoom(roomId)) return; this.broadcastAll({ type: "room-online", roomId, online: this.roomOnlineCount(roomId) }); }
  broadcastUsersChanged() { const text = JSON.stringify({ type: "users-changed" }); for (const socket of this.sockets()) if (attachment(socket).userId) { try { socket.send(text); } catch {} } }
  onlineUserIds() { const ids = new Set(); for (const socket of this.sockets()) { const id = attachment(socket).userId; if (id) ids.add(id); } return ids; }
  presenceUsers(roomId) { const seen = new Map(); for (const socket of this.clientsIn(roomId)) { const id = attachment(socket).userId, user = id && this.userById(id); if (user && !seen.has(id)) seen.set(id, publicUser(user)); } return [...seen.values()]; }
  presencePayload(roomId) { return { type: "presence", online: this.roomOnlineCount(roomId), users: this.presenceUsers(roomId) }; }
  broadcastPresence(roomId) { this.broadcast(roomId, this.presencePayload(roomId)); }
  refreshUserPresence(userId) {
    const rooms = new Set();
    for (const socket of this.sockets()) { const meta = attachment(socket); if (meta.userId === userId) rooms.add(meta.roomId); }
    for (const roomId of rooms) if (roomId !== "__notify") this.broadcastPresence(roomId);
    this.broadcastUsersChanged();
  }
  history(roomId) {
    const rows = this.state.storage.sql.exec("SELECT id, user_id, username, role, photo, kind, content, created_at FROM messages WHERE room_id = ? ORDER BY seq DESC LIMIT ?", roomId, MAX_MESSAGES).toArray();
    return rows.reverse().map(row => ({ id: row.id, userId: row.user_id, username: row.username, role: row.role, photo: row.photo, kind: row.kind, content: row.content, createdAt: row.created_at }));
  }
  addMessage(roomId, message) {
    const sql = this.state.storage.sql;
    sql.exec("INSERT INTO messages (room_id, id, user_id, username, role, photo, kind, content, created_at) VALUES (?,?,?,?,?,?,?,?,?)", roomId, message.id, message.userId, message.username, message.role, message.photo, message.kind, message.content, message.createdAt);
    // The retention DELETE rescans the room, so running it on every insert costs ~MAX_MESSAGES rows
    // read per message and burns through the Durable Object row-read quota long before the message
    // count itself matters. Run it once per TRIM_INTERVAL inserts instead, and always on the first
    // insert of an instance so a room can never grow unbounded across hibernation (the counter is
    // in-memory, so it resets with the object).
    const pending = this.pendingTrim.get(roomId) || 0;
    if (pending === 0 || pending >= TRIM_INTERVAL) { this.trimMessages(roomId); this.pendingTrim.set(roomId, 1); }
    else this.pendingTrim.set(roomId, pending + 1);
  }
  trimMessages(roomId) {
    this.state.storage.sql.exec("DELETE FROM messages WHERE room_id = ? AND seq NOT IN (SELECT seq FROM messages WHERE room_id = ? ORDER BY seq DESC LIMIT ?)", roomId, roomId, MAX_MESSAGES);
  }

  async handleSocket(request, url) {
    if (!sameOrigin(request)) return new Response("Request origin was rejected.", { status: 403 });
    const roomId = url.searchParams.get("room");
    const user = await this.sessionUser(request);
    const room = roomId && this.findRoom(roomId);
    if (roomId !== "__notify" && (!user || !this.canEnter(room, user))) return new Response("Forbidden", { status: 403 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.serializeAttachment({ userId: user ? user.id : null, roomId, connectionId: crypto.randomUUID() });
    this.state.acceptWebSocket(server);
    if (room && !room.builtIn && room.access === "open" && user && !room.members.includes(user.id)) { room.members.push(user.id); await saveRoom(this.env, room); }
    if (roomId !== "__notify") {
      server.send(JSON.stringify({ type: "history", messages: this.history(roomId), online: this.roomOnlineCount(roomId), users: this.presenceUsers(roomId) }));
      this.broadcastPresence(roomId);
    }
    this.broadcastRoomOnline(roomId);
    if (user) this.broadcastUsersChanged();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket, raw) {
    const meta = attachment(socket);
    const user = meta.userId && this.userById(meta.userId);
    if (!user) return;
    let event; try { event = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); } catch { return; }
    const now = Date.now();
    if (CALL_TYPES.includes(event.type)) {
      if (this.callLimited(meta.connectionId || meta.userId, now)) return;
      const target = this.userById(clean(event.to)), callId = clean(event.callId).slice(0, 80);
      if (!target || target.id === user.id || !callId) return;
      const payload = { type: event.type, callId, from: publicUser(user), to: target.id };
      if (event.type === "call-offer" || event.type === "call-answer") { const description = event.sdp || {}, sdp = typeof description.sdp === "string" ? description.sdp : ""; if ((event.type === "call-offer" ? description.type !== "offer" : description.type !== "answer") || !sdp.trim() || sdp.length > 50000) return; payload.sdp = { type: description.type, sdp }; if (event.type === "call-offer") payload.mode = event.mode === "video" ? "video" : "voice"; }
      if (event.type === "call-ice") { const candidate = event.candidate; if (candidate !== null && (!candidate || typeof candidate !== "object" || clean(candidate.candidate).length > 4096)) return; payload.candidate = candidate === null ? null : { candidate: clean(candidate.candidate), sdpMid: candidate.sdpMid == null ? null : clean(candidate.sdpMid).slice(0, 64), sdpMLineIndex: Number.isInteger(candidate.sdpMLineIndex) ? candidate.sdpMLineIndex : null, usernameFragment: candidate.usernameFragment == null ? null : clean(candidate.usernameFragment).slice(0, 256) }; }
      const delivered = this.notifyUser(target.id, payload);
      if (event.type === "call-offer" && !delivered) this.send(socket, { type: "call-unavailable", callId, from: publicUser(target), to: user.id });
      if (event.type === "call-answer" || event.type === "call-reject" || event.type === "call-busy") this.notifyUserExcept(user.id, socket, { type: "call-taken", callId });
      return;
    }
    // Kept in memory: the attachment this used to live in cost a persisted write on every single
    // message, potentially doubling a message's row-write cost. Eviction only happens after ~10s
    // of quiet, already longer than the window, so a counter lost to it would have expired anyway.
    if (this.windowLimited(meta.connectionId || meta.userId, now)) return;
    if (event.type === "dm") {
      const target = this.userById(clean(event.to));
      if (!target) return;
      const kind = DM_KINDS.includes(event.kind) ? event.kind : "text";
      let content = clean(event.content);
      if (kind === "image" || kind === "voice") { if (!(target.dmMediaGranted || []).includes(user.id)) return; content = safeUploadUrl(content); }
      else content = content.slice(0, 500);
      if (!content) return;
      const payload = { type: "dm", id: crypto.randomUUID(), from: publicUser(user), to: target.id, kind, content, at: Date.now() }, text = JSON.stringify(payload);
      for (const peer of this.sockets()) { const id = attachment(peer).userId; if (id === target.id || id === user.id) { try { peer.send(text); } catch {} } }
      // Only when the recipient has no socket open: a tab that is already showing the message does
      // not need a notification about it.
      if (!this.onlineUserIds().has(target.id)) this.background(pushToUser(this.env, target.id, { title: `${user.username} sent you a message`, body: kind === "text" ? content.slice(0, 120) : kind === "image" ? "Sent you a photo" : "Sent you a voice note", url: "/dms", tag: `dm-${user.id}` }));
      return;
    }
    if (event.type !== "message") return;
    const room = this.findRoom(meta.roomId);
    if (!room) return;
    if (Array.isArray(room.bans) && room.bans.includes(user.id)) return;
    let kind = MESSAGE_KINDS.includes(event.kind) ? event.kind : "text", content = clean(event.content || event.text);
    if (kind === "gif") content = safeMediaUrl(content);
    else if (kind === "image" || kind === "voice") content = safeUploadUrl(content);
    else content = content.slice(0, 500);
    if (!content) return;
    if ((kind === "image" || kind === "voice") && !(room.access === "request" && !room.builtIn)) return;
    const media = roomMedia(room);
    if (kind === "emoji" && !media.emojis.includes(content)) return;
    if (kind === "sticker" && !media.stickers.includes(content)) return;
    const message = { id: crypto.randomUUID(), userId: user.id, username: user.username, role: user.role || "user", photo: user.profile?.photo || null, kind, content, createdAt: Date.now() };
    if (this.dailyLimited("message", user.id, this.messageDailyCap)) return;
    this.addMessage(meta.roomId, message);
    this.broadcast(meta.roomId, { type: "message", message });
  }

  async webSocketClose(socket) {
    const meta = attachment(socket);
    if (meta.connectionId) this.messageWindows.delete(meta.connectionId);
    if (meta.connectionId) this.callWindows.delete(meta.connectionId);
    try { socket.close(1000, "closed"); } catch {}
    if (meta.roomId && meta.roomId !== "__notify") { this.broadcastPresence(meta.roomId); this.broadcastRoomOnline(meta.roomId); }
    if (meta.userId) this.broadcastUsersChanged();
  }

  async webSocketError(socket) { await this.webSocketClose(socket); }

  /* ------------------------------------------------------------------- API */

  /**
   * Pushes must never hold up the work that triggered them: this single Durable Object serves every
   * room, so blocking its event loop on a push-service round-trip would stall everybody else. Hand
   * the promise to the runtime when it offers waitUntil, and let it settle on its own otherwise.
   */
  background(promise) {
    const work = Promise.resolve(promise).catch(() => {});
    if (this.state && typeof this.state.waitUntil === "function") this.state.waitUntil(work);
  }

  async api(request, url, path) {
    // The VAPID public key is what a browser needs in order to subscribe; the private key is a Worker
    // secret and never leaves the server.
    if (path === "/api/config") return json(200, { giphyApiKey: this.env.GIPHY_API_KEY || null, vapidPublicKey: this.env.VAPID_PUBLIC_KEY || null, pushEnabled: pushConfigured(this.env) });

    if (path === "/api/push/subscribe" && request.method === "POST") {
      if (!sameOrigin(request)) return json(403, { error: "Request origin was rejected." });
      const user = await this.sessionUser(request);
      if (!user) return json(401, { error: "Sign in first." });
      const subscription = parseSubscription(await readJson(request).catch(() => null));
      if (!subscription) return json(400, { error: "That subscription is not usable." });
      await saveSubscription(this.env, user.id, subscription);
      return json(201, { ok: true });
    }

    if (path === "/api/push/unsubscribe" && request.method === "POST") {
      if (!sameOrigin(request)) return json(403, { error: "Request origin was rejected." });
      const user = await this.sessionUser(request);
      if (!user) return json(401, { error: "Sign in first." });
      const body = await readJson(request).catch(() => ({}));
      const endpoint = clean(body.endpoint);
      if (endpoint) await removeSubscription(this.env, user.id, endpoint);
      return json(200, { ok: true });
    }

    // Sends to this account's own devices, so "are notifications working?" is answerable without
    // waiting for somebody to send a message.
    if (path === "/api/push/test" && request.method === "POST") {
      if (!sameOrigin(request)) return json(403, { error: "Request origin was rejected." });
      const user = await this.sessionUser(request);
      if (!user) return json(401, { error: "Sign in first." });
      const devices = await subscriptionsFor(this.env, user.id);
      if (!devices.length) return json(400, { error: "No notifications are registered for this account yet." });
      const sent = await pushToUser(this.env, user.id, { title: "Chatblink", body: "Notifications work on this device.", url: "/rooms", tag: "push-test" });
      return json(200, { sent, devices: devices.length });
    }
    if (path === "/api/auth/me") { const user = await this.sessionUser(request); return user ? json(200, { user: publicUser(user) }) : json(401, { error: "Not signed in" }); }

    if (path === "/api/users" && request.method === "GET") {
      const user = await this.sessionUser(request);
      if (!user) return json(401, { error: "Sign in first." });
      const onlineIds = this.onlineUserIds();
      return json(200, { users: this.users.filter(item => item.id !== user.id).map(item => ({ ...publicUser(item), online: onlineIds.has(item.id) })) });
    }

    if (path === "/api/explore" && request.method === "GET") {
      const user = await this.sessionUser(request);
      if (!user) return json(401, { error: "Sign in first." });
      const limit = Math.min(48, Math.max(6, Number(url.searchParams.get("limit")) || 24));
      const query = clean(url.searchParams.get("q") || "").toLowerCase();
      const cursor = Math.max(0, Number(url.searchParams.get("cursor")) || 0);
      const onlineIds = this.onlineUserIds();
      const statement = query
        ? this.env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE username_lower LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(`%${query}%`, limit + 1, cursor)
        : this.env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?`).bind(limit + 1, cursor);
      const result = await statement.all();
      const accounts = (result.results || []).map(rowToUser);
      const hasMore = accounts.length > limit;
      const profiles = accounts.slice(0, limit).map(account => ({ ...profileDoc(account), online: onlineIds.has(account.id), isSelf: account.id === user.id }));
      return json(200, { profiles, nextCursor: hasMore ? cursor + limit : null });
    }

    const profileMatch = path.match(/^\/api\/profiles\/([^/]+)$/);
    if (profileMatch && request.method === "GET") {
      const user = await this.sessionUser(request);
      if (!user) return json(401, { error: "Sign in first." });
      const username = safeDecode(profileMatch[1]), account = username && this.userByUsernameLower(username.toLowerCase());
      if (!account) return json(404, { error: "Profile not found." });
      return json(200, { profile: { ...profileDoc(account), online: this.onlineUserIds().has(account.id), isSelf: account.id === user.id } });
    }

    if (path.startsWith("/api/dm/permissions/")) {
      const user = await this.sessionUser(request);
      if (!user) return json(401, { error: "Sign in first." });
      const other = this.userById(safeDecode(path.slice("/api/dm/permissions/".length)));
      if (!other) return json(404, { error: "User not found." });
      user.dmMediaGranted = user.dmMediaGranted || []; user.dmMediaRequests = user.dmMediaRequests || [];
      other.dmMediaGranted = other.dmMediaGranted || []; other.dmMediaRequests = other.dmMediaRequests || [];
      if (request.method === "GET") return json(200, { canSend: other.dmMediaGranted.includes(user.id), outgoingPending: other.dmMediaRequests.includes(user.id), incomingPending: user.dmMediaRequests.includes(other.id), incomingGranted: user.dmMediaGranted.includes(other.id) });
      if (request.method === "POST") {
        if (!sameOrigin(request)) return json(403, { error: "Request origin was rejected." });
        try {
          const body = await readJson(request), action = clean(body.action);
          if (action === "request") { if (!other.dmMediaRequests.includes(user.id) && !other.dmMediaGranted.includes(user.id)) other.dmMediaRequests.push(user.id); await saveUser(this.env, other); this.notifyUser(other.id, { type: "dm-permission", from: publicUser(user), status: "requested" }); return json(200, { outgoingPending: true }); }
          if (action === "grant") { if (user.dmMediaRequests.includes(other.id)) { user.dmMediaRequests = user.dmMediaRequests.filter(id => id !== other.id); other.dmMediaRequests = other.dmMediaRequests.filter(id => id !== user.id); if (!user.dmMediaGranted.includes(other.id)) user.dmMediaGranted.push(other.id); if (!other.dmMediaGranted.includes(user.id)) other.dmMediaGranted.push(user.id); await Promise.all([saveUser(this.env, user), saveUser(this.env, other)]); } this.notifyUser(other.id, { type: "dm-permission", from: publicUser(user), status: "granted" }); return json(200, { incomingGranted: true, canSend: other.dmMediaGranted.includes(user.id) }); }
          if (action === "decline") { user.dmMediaRequests = user.dmMediaRequests.filter(id => id !== other.id); await saveUser(this.env, user); this.notifyUser(other.id, { type: "dm-permission", from: publicUser(user), status: "declined" }); return json(200, { incomingPending: false }); }
          if (action === "revoke") { user.dmMediaGranted = user.dmMediaGranted.filter(id => id !== other.id); await saveUser(this.env, user); this.notifyUser(other.id, { type: "dm-permission", from: publicUser(user), status: "revoked" }); return json(200, { incomingGranted: false }); }
          throw new Error("Unknown action.");
        } catch (error) { return json(400, { error: error.message }); }
      }
    }

    if (path === "/api/admin/users" && request.method === "GET") {
      const user = await this.sessionUser(request);
      if (!user || user.role !== "admin") return json(403, { error: "Admin only." });
      return json(200, { users: this.users.map(publicUser) });
    }

    if (path.startsWith("/api/admin/role/") && request.method === "POST") {
      const user = await this.sessionUser(request);
      if (!user || user.role !== "admin") return json(403, { error: "Admin only." });
      if (!sameOrigin(request)) return json(403, { error: "Request origin was rejected." });
      try {
        const target = this.userById(safeDecode(path.slice("/api/admin/role/".length)));
        if (!target) return json(404, { error: "User not found." });
        if (target.id === user.id || target.role === "admin") throw new Error("That user's role cannot be changed.");
        const body = await readJson(request);
        target.role = clean(body.role) === "mod" ? "mod" : "user";
        await saveUser(this.env, target);
        this.refreshUserPresence(target.id);
        return json(200, { user: publicUser(target) });
      } catch (error) { return json(400, { error: error.message }); }
    }

    if (path.startsWith("/api/admin/users/") && request.method === "DELETE") {
      const user = await this.sessionUser(request);
      if (!user || user.role !== "admin") return json(403, { error: "Admin only." });
      if (!sameOrigin(request)) return json(403, { error: "Request origin was rejected." });
      try {
        const target = this.userById(safeDecode(path.slice("/api/admin/users/".length)));
        if (!target) return json(404, { error: "User not found." });
        if (target.id === user.id) throw new Error("You cannot delete your own account.");
        if (target.role === "admin") throw new Error("Admin accounts cannot be deleted.");
        const removed = publicUser(target);
        this.users = this.users.filter(item => item.id !== target.id);
        const touched = [];
        for (const account of this.users) {
          const granted = account.dmMediaGranted || [], requests = account.dmMediaRequests || [];
          const nextGranted = granted.filter(id => id !== target.id), nextRequests = requests.filter(id => id !== target.id);
          if (nextGranted.length !== granted.length || nextRequests.length !== requests.length) { account.dmMediaGranted = nextGranted; account.dmMediaRequests = nextRequests; touched.push(account); }
        }
        const orphaned = this.rooms.filter(room => !room.builtIn && room.ownerId === target.id);
        for (const room of orphaned) {
          this.rooms = this.rooms.filter(item => item.id !== room.id);
          this.state.storage.sql.exec("DELETE FROM messages WHERE room_id = ?", room.id);
          this.pendingTrim.delete(room.id);
          await deleteRoom(this.env, room.id);
          this.broadcastAll({ type: "room-deleted", roomId: room.id });
        }
        const touchedRooms = [];
        for (const room of this.rooms) {
          if (room.builtIn) continue;
          const members = (room.members || []).filter(id => id !== target.id), requests = (room.requests || []).filter(id => id !== target.id), bans = (room.bans || []).filter(id => id !== target.id);
          if (members.length !== (room.members || []).length || requests.length !== (room.requests || []).length || bans.length !== (room.bans || []).length) { room.members = members; room.requests = requests; room.bans = bans; touchedRooms.push(room); }
        }
        for (const account of touched) await saveUser(this.env, account);
        for (const room of touchedRooms) await saveRoom(this.env, room);
        await deleteUser(this.env, target.id);
        for (const socket of this.sockets()) if (attachment(socket).userId === target.id) { this.send(socket, { type: "account-deleted" }); try { socket.close(1000, "account deleted"); } catch {} }
        this.broadcastAll({ type: "rooms-changed" });
        this.broadcastUsersChanged();
        return json(200, { ok: true, deleted: removed, roomsDeleted: orphaned.length });
      } catch (error) { return json(400, { error: error.message }); }
    }

    if (path === "/api/auth/signup" && request.method === "POST") {
      if (!sameOrigin(request)) return json(403, { error: "Request origin was rejected." });
      if (this.rateLimited(ipOf(request), "signup", 10)) return json(429, { error: "Too many attempts. Try again later." });
      try {
        const result = await this.createAccount(await readJson(request));
        // A one-off community milestone. this.users is the full account list, so this is true exactly
        // once - there is no counter that can drift or fire a second time.
        if (this.users.length === 500) this.background(pushToAll(this.env, { title: "Chatblink just reached 500 members", body: "Thank you for being here - new rooms are opening all the time.", url: "/rooms", tag: "milestone-500" }));
        const token = await this.token(result.user);
        return json(201, { user: publicUser(result.user), token, profileKey: result.profileKey }, { "Set-Cookie": sessionCookie(token, Math.floor(30 * 24 * 60 * 60), isSecure(request)) });
      } catch (error) { return json(400, { error: error.message }); }
    }

    if (path === "/api/auth/login" && request.method === "POST") {
      if (!sameOrigin(request)) return json(403, { error: "Request origin was rejected." });
      if (this.rateLimited(ipOf(request), "login", 20)) return json(429, { error: "Too many attempts. Try again later." });
      try {
        const body = await readJson(request), user = await this.userForProfileKey(body.key);
        if (!user) throw new Error("That profile key is not valid.");
        const token = await this.token(user);
        return json(200, { user: publicUser(user), token }, { "Set-Cookie": sessionCookie(token, Math.floor(30 * 24 * 60 * 60), isSecure(request)) });
      } catch (error) { return json(401, { error: error.message }); }
    }

    if (path === "/api/auth/logout" && request.method === "POST") {
      if (!sameOrigin(request)) return json(403, { error: "Request origin was rejected." });
      const user = await this.sessionUser(request);
      if (user) { user.tokenVersion = (Number(user.tokenVersion) || 0) + 1; await saveUser(this.env, user); }
      return json(200, { ok: true }, { "Set-Cookie": sessionCookie("", 0, isSecure(request)) });
    }

    if (path === "/api/profile" && request.method === "POST") {
      const user = await this.sessionUser(request);
      if (!user) return json(401, { error: "Sign in first." });
      if (!sameOrigin(request)) return json(403, { error: "Request origin was rejected." });
      try {
        const body = await readJson(request), avatars = ["✨", "🌻", "🌙", "⚡", "🌊", "🎧", "🦋", "🔥"], genders = ["", "woman", "man", "nonbinary", "prefer_not"];
        user.profile = { displayName: clean(body.displayName).slice(0, 30) || user.username, avatar: avatars.includes(body.avatar) ? body.avatar : "✨", bio: clean(body.bio).slice(0, 160), gender: genders.includes(body.gender) ? body.gender : "", interests: clean(body.interests).split(",").map(item => item.trim()).filter(Boolean).slice(0, 6), photo: clean(body.photo) === "" ? null : (safeUploadUrl(clean(body.photo)) || (user.profile && user.profile.photo) || null), photos: (user.profile && user.profile.photos) || [] };
        user.profileComplete = true;
        await saveUser(this.env, user);
        this.refreshUserPresence(user.id);
        return json(200, { user: publicUser(user) });
      } catch (error) { return json(400, { error: error.message }); }
    }

    if ((path === "/api/profile/photo" || path === "/api/profile/photos" || path === "/api/profile/photos/remove") && request.method === "POST") {
      const user = await this.sessionUser(request);
      if (!user) return json(401, { error: "Sign in first." });
      if (!sameOrigin(request)) return json(403, { error: "Request origin was rejected." });
      try {
        const body = await readJson(request), value = clean(body.url);
        if (path === "/api/profile/photo") user.profile = { ...(user.profile || {}), photo: value === "" ? null : (safeUploadUrl(value) || (user.profile && user.profile.photo) || null) };
        else {
          const url = safeUploadUrl(value);
          if (path === "/api/profile/photos") {
            if (!url) throw new Error("That photo is not available.");
            const photos = (user.profile && user.profile.photos) || [];
            if (!photos.includes(url)) { if (photos.length >= 8) throw new Error("You can keep up to 8 photos."); user.profile = { ...(user.profile || {}), photos: [...photos, url] }; }
          } else user.profile = { ...(user.profile || {}), photos: ((user.profile && user.profile.photos) || []).filter(item => item !== value) };
        }
        await saveUser(this.env, user);
        this.refreshUserPresence(user.id);
        return json(200, path === "/api/profile/photo" ? { user: publicUser(user) } : { photos: (user.profile && user.profile.photos) || [] });
      } catch (error) { return json(400, { error: error.message }); }
    }

    if (path === "/api/rooms/online" && request.method === "GET") {
      const user = await this.sessionUser(request);
      if (!user) return json(401, { error: "Sign in first." });
      const counts = {};
      for (const room of this.rooms) counts[room.id] = this.roomOnlineCount(room.id);
      return json(200, { online: counts });
    }

    if (path.startsWith("/api/rooms")) return this.apiRooms(request, url, path);

    return json(404, { error: "Not found." });
  }

  async apiRooms(request, url, path) {
    const user = await this.sessionUser(request);
    if (!user && path === "/api/rooms" && request.method === "GET") return json(200, { rooms: this.rooms.map(room => this.roomView(room, null)) });
    if (!user) return json(401, { error: "Sign in first." });
    if (request.method !== "GET" && !sameOrigin(request)) return json(403, { error: "Request origin was rejected." });
    if (path === "/api/rooms" && request.method === "GET") return json(200, { rooms: this.rooms.map(room => this.roomView(room, user)) });

    const banMatch = path.match(/^\/api\/rooms\/([^/]+)\/bans(?:\/([^/]+))?$/);
    if (banMatch) {
      const room = this.findRoom(banMatch[1]);
      if (!room) return json(404, { error: "Room not found." });
      const actorRole = user.role || "user";
      if (!(actorRole === "admin" || actorRole === "mod" || room.ownerId === user.id)) return json(403, { error: "Only the room creator, mods, or the admin can manage bans." });
      if (request.method === "GET") return json(200, { users: (room.bans || []).map(id => this.userById(id)).filter(Boolean).map(publicUser) });
      if (request.method === "POST" && banMatch[2]) {
        try {
          const target = this.userById(banMatch[2]);
          if (!target) return json(404, { error: "User not found." });
          const body = await readJson(request), unban = clean(body.action) === "unban";
          if (!unban && !this.canBanUser(room, user, target)) return json(403, { error: "You cannot ban this user." });
          room.bans = unban ? (room.bans || []).filter(id => id !== target.id) : [...new Set([...(room.bans || []), target.id])];
          await saveRoom(this.env, room);
          this.notifyUser(target.id, { type: "room-ban", roomId: room.id, banned: !unban });
          return json(200, { ok: true, banned: !unban });
        } catch (error) { return json(400, { error: error.message }); }
      }
    }

    if (path === "/api/rooms" && request.method === "POST") {
      try {
        if (this.rateLimited(ipOf(request), "room-create", 5)) throw new Error("Too many rooms created recently. Try again later.");
        const body = await readJson(request), name = clean(body.name).slice(0, 40), access = body.access === "request" ? "request" : "open", pack = ROOM_PRESETS[body.theme] || ROOM_PRESETS.ocean;
        if (name.length < 3) throw new Error("Room name must be at least 3 characters.");
        if (clean(body.vibe) && clean(body.vibe).length < 3) throw new Error("Short vibe must be at least 3 characters.");
        if (this.rooms.filter(room => room.ownerId === user.id).length >= MAX_ROOMS_PER_USER) throw new Error(`You can create up to ${MAX_ROOMS_PER_USER} rooms.`);
        const room = { id: this.slugify(name), name, icon: access === "request" ? "🔐" : "✦", vibe: clean(body.vibe).slice(0, 100) || `A community room created by ${user.username}.`, accent: pack.accent, soft: pack.soft, emojis: ALL_EMOJIS, stickers: ALL_STICKERS, gifs: ALL_GIFS, access, builtIn: false, ownerId: user.id, members: [], requests: [], bans: [], createdAt: new Date().toISOString() };
        await saveRoom(this.env, room);
        this.rooms.push(room);
        this.broadcastAll({ type: "rooms-changed" });
        // A new room is one of the few genuine broadcast moments, so every device that has
        // notifications on hears about it.
        this.background(pushToAll(this.env, { title: `${user.username} opened a room`, body: `${room.name} - ${room.vibe}`, url: `/room/${room.id}`, tag: "new-room" }));
        return json(201, { room: this.roomView(room, user) });
      } catch (error) { return json(400, { error: error.message }); }
    }

    const match = path.match(/^\/api\/rooms\/([^/]+)(?:\/(?:request|requests(?:\/([^/]+))?))?$/), room = match && this.findRoom(match[1]);
    if (!room) return json(404, { error: "Room not found." });

    if (path.endsWith("/request") && request.method === "POST") {
      if (room.access !== "request") return json(400, { error: "This room is open." });
      if (room.ownerId !== user.id && !room.members.includes(user.id) && !room.requests.includes(user.id)) {
        if (room.requests.length >= MAX_PENDING_REQUESTS) return json(429, { error: "This room has too many pending requests. Try again later." });
        room.requests.push(user.id);
        await saveRoom(this.env, room);
        this.notifyUser(room.ownerId, { type: "room-updated", roomId: room.id });
        return json(200, { status: "pending" });
      }
      return json(200, { status: room.members.includes(user.id) ? "member" : "pending" });
    }

    if (match && path.endsWith("/requests") && request.method === "GET") {
      if (room.ownerId !== user.id) return json(403, { error: "Only the room creator can view requests." });
      return json(200, { requests: room.requests.map(id => this.userById(id)).filter(Boolean).map(publicUser) });
    }

    if (match && match[2] && request.method === "POST") {
      if (room.ownerId !== user.id) return json(403, { error: "Only the room creator can manage requests." });
      const body = await readJson(request), targetId = match[2];
      room.requests = room.requests.filter(id => id !== targetId);
      if (body.action === "approve" && !room.members.includes(targetId)) room.members.push(targetId);
      await saveRoom(this.env, room);
      this.notifyUser(targetId, { type: "room-updated", roomId: room.id });
      return json(200, { ok: true });
    }

    if (match && !match[2] && path.match(/^\/api\/rooms\/([^/]+)$/) && request.method === "DELETE") {
      if (room.builtIn) return json(400, { error: "Built-in rooms cannot be deleted." });
      if (room.ownerId !== user.id && user.role !== "admin") return json(403, { error: "Only the room creator or the admin can delete this room." });
      this.rooms = this.rooms.filter(item => item.id !== room.id);
      this.state.storage.sql.exec("DELETE FROM messages WHERE room_id = ?", room.id);
      this.pendingTrim.delete(room.id);
      await deleteRoom(this.env, room.id);
      this.broadcastAll({ type: "room-deleted", roomId: room.id });
      this.broadcastAll({ type: "rooms-changed" });
      return json(200, { ok: true });
    }

    return json(404, { error: "Room action not found." });
  }
}
