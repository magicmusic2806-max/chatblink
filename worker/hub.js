import { BUILT_INS, ALL_EMOJIS, ALL_STICKERS, ALL_GIFS, roomMedia, safeUploadUrl, safeMediaUrl } from "./lib/catalog.js";
import { clean, safeDecode, json, publicUser, profileDoc, parseCookies, ipOf, isSecure, sameOrigin, bearerToken, sessionCookie, readJson, constantTimeEqual } from "./lib/core.js";
import { issueAuthToken, verifyAuthToken, hashProfileKey, generateProfileKey } from "./lib/crypto.js";
import { USER_COLUMNS, USER_UPSERT, ROOM_UPSERT, rowToUser, userToRow, roomToRow, saveUser, saveRoom, deleteRoom, deleteUser, loadUsers, loadRooms } from "./lib/db.js";
import { parseSubscription, saveSubscription, removeSubscription, subscriptionsFor, roomSubscription, setRoomSubscription, removeRoomSubscriptions, pushToUser, pushToRoomSubscribers, pushToAll, pushConfigured } from "./lib/push.js";
import { D1_SCHEMA, D1_SCHEMA_VERSION } from "./lib/schema.js";
// Chess rules come from chess.js (BSD-2-Clause) rather than from hand-written move generation: castling,
// en passant, promotion, checkmate, stalemate and the threefold/50-move draws are exactly the places a
// home-made board gets quietly wrong, and every one of them has to be autoritative on the server.
import { Chess } from "chess.js";
import { DRAW_WORDS, drawMask, drawGuessMatches } from "./lib/words.js";

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
// A room call is a full peer-to-peer mesh: every participant connects to every other one, so the
// ceiling is kept low enough that one device does not carry a dozen audio streams.
const GROUP_CALL_TYPES = ["group-call-join", "group-call-leave", "group-call-end", "group-call-offer", "group-call-answer", "group-call-ice"];
const GROUP_CALL_MAX = 6;
// Games live in the room they were started in (see GAME_KINDS). Connect Four is the first one; every
// game is turn-based and validated in the Durable Object, because a client-side board is a board
// people win with the console open.
const GAME_KINDS = {
  "connect-four": { name: "Connect Four", seats: 2, solo: false, board: "columns", columns: 7, rows: 6 },
  "tic-tac-toe": { name: "Tic-tac-toe", seats: 2, solo: false, board: "grid", size: 3 },
  "othello": { name: "Reversi", seats: 2, solo: false, board: "grid", size: 8 },
  "chess": { name: "Chess", seats: 2, solo: false, board: "chess", size: 8 },
  // Draw & Guess is the only game with a range of seats: two people can play it, and a full room of eight fits
  // too. The drawing itself is a shared canvas rather than a board array.
  "draw-guess": { name: "Draw & Guess", seats: 8, minSeats: 2, maxSeats: 8, solo: false, board: "canvas", size: 0 }
};
// The seat helpers keep the older games honest: they have one number, so min and max are the same.
const gameMinSeats = kind => Math.max(1, kind?.minSeats || kind?.seats || 2);
const gameMaxSeats = kind => Math.max(1, kind?.maxSeats || kind?.seats || 2);
const GAME_EVENT_TYPES = ["game-create", "game-join", "game-request", "game-approve", "game-deny", "game-leave", "game-watch", "game-move", "game-end", "game-restart", "game-start", "game-sync", "game-resign", "game-offer-draw", "game-accept-draw", "game-pick-word", "game-draw", "game-clear"];
const GAME_EVENT_LIMIT = 60;
// A pen stroke is one event per finished line, and a fast scribble is a lot of lines: the drawing gets its own,
// larger window so the room's per-connection budget can never swallow a line the drawer watched themselves draw.
const DRAW_EVENT_LIMIT = 120;
// A slot in a room belongs to a game still being waited on or played. A finished board is history and
// must never take a slot: four dead boards at the cap used to close a room to new games for good, which
// stranded every player whose host had walked off.
const GAMES_PER_ROOM = 4;
// How long a finished board survives so its players can read the result and take the rematch. A room keeps
// the games being played, not a history of them: after this the board clears itself, and its last player
// leaving clears it sooner.
const ENDED_GAME_TTL_MS = 120000;
// How long a player may have no socket in the room before their seat is resolved. A reload closes and
// reopens the socket in about a second, so this is a grace period, not a presence check.
const AWAY_GRACE_MS = 45000;
const CONNECT_FOUR_COLUMNS = 7, CONNECT_FOUR_ROWS = 6;
const TIC_TAC_TOE_LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const OTHELLO_DIRECTIONS = [[-1, -1], [-1, 0], [-1, 1], [0, -1], [0, 1], [1, -1], [1, 0], [1, 1]];
// Standard casual chess: five minutes on each clock, no increment, and a clock that runs out is a loss on
// time. CHESS_CLOCK_MS is env-overridable so the test suite can watch a flag fall in seconds.
const CHESS_CLOCK_MS = 300000;
// The allowances the create form offers, in minutes: ten, twenty, forty, or no clock at all (0). The env override
// stays the default for a create that names none, which is how the suites run a game on a four-second clock.
const CHESS_TIME_OPTIONS = [10, 20, 40, 0];
const CHESS_START_FEN = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
const CHESS_PROMOTIONS = ["q", "r", "b", "n"];
// The board the client draws, in visual order (rank 8 first, the way a player reads it). Codes are
// "wK"/"bP", so the client needs no chess library at all: the server owns the position and the rules.
const chessPieces = fen => {
  const pieces = new Array(64).fill("");
  const ranks = String(fen || CHESS_START_FEN).split(" ")[0].split("/");
  for (let row = 0; row < 8 && row < ranks.length; row++) {
    let column = 0;
    for (const character of ranks[row]) {
      if (character >= "1" && character <= "8") { column += Number(character); continue; }
      if (column > 7) break;
      pieces[row * 8 + column] = (character === character.toUpperCase() ? "w" : "b") + character.toUpperCase();
      column++;
    }
  }
  return pieces;
};
// Every legal move for the side to move: the panel marks these instead of letting a player click into a
// refusal, and a promotion appears once per piece it could become.
const chessLegalMoves = fen => {
  try { return new Chess(fen || CHESS_START_FEN).moves({ verbose: true }).map(move => ({ from: move.from, to: move.to, promotion: move.promotion || null })); }
  catch { return []; }
};
const chessTurnColor = fen => (String(fen || CHESS_START_FEN).split(" ")[1] === "b" ? "b" : "w");
// Draw & Guess, standard settings: three rounds, all players drawing once per round, 80 seconds a turn, three
// words offered and 15 seconds to choose before the first is used. Strokes are one event per stroke with the
// points batched, never one event per point (see "Budgets" in GAMES.md).
const DRAW_ROUNDS = 3;
const DRAW_SECONDS = 80;
const DRAW_CHOOSE_MS = 15000;
const DRAW_REVEAL_MS = 5000;
const DRAW_CHOICES = 3;
const DRAW_STROKE_POINTS_MAX = 200;
const DRAW_STROKES_MAX = 400;
// The whole drawing has to fit in one WebSocket message when a client syncs or rejoins, and Cloudflare closes a
// socket whose message is over 1 MiB. 400 strokes of 200 points is ~900 KB of JSON, so the oldest strokes are
// dropped instead: a drawing keeps its recent lines and can never take the room's socket down with it.
const DRAW_POINTS_TOTAL_MAX = 12000;
const DRAW_POINTS_MAX = 1024;
const DRAW_COLORS = ["#172033", "#ef476f", "#f9c74f", "#43aa8b", "#4f8cff", "#a259ff", "#ff8c42", "#ffffff"];
const DRAW_SCORE_FOR_GUESS = 200, DRAW_SCORE_FOR_DRAWER = 50;
// A board is one flat array for every game: columns (Connect Four) or a square grid (tic-tac-toe, Reversi).
// 0 is empty, 1 and 2 are the seats.
const boardCells = kind => kind.board === "columns" ? kind.columns * kind.rows : kind.size * kind.size;
const initialBoard = kind => {
  const board = new Array(boardCells(kind)).fill(0);
  if (kind === GAME_KINDS.othello) {
    // Standard opening: black (seat 1) on d4/e5, white (seat 2) on d5/e4 of an 8x8 grid.
    board[3 * 8 + 3] = 2; board[3 * 8 + 4] = 1; board[4 * 8 + 3] = 1; board[4 * 8 + 4] = 2;
  }
  return board;
};
// Which discs a Reversi move would flip, in every direction at once. Empty list means the move is illegal.
const othelloFlips = (board, player, index, size) => {
  if (board[index]) return [];
  const row = Math.floor(index / size), column = index % size, flips = [];
  for (const [dr, dc] of OTHELLO_DIRECTIONS) {
    let r = row + dr, c = column + dc, run = [];
    while (r >= 0 && r < size && c >= 0 && c < size) {
      const other = board[r * size + c];
      if (other === player) break;
      if (other === 0) { run = []; break; }
      run.push(r * size + c); r += dr; c += dc;
    }
    // The walk only stopped on our own disc if it ended inside the board with our colour.
    if (r >= 0 && r < size && c >= 0 && c < size && board[r * size + c] === player) flips.push(...run);
  }
  return flips;
};
const othelloLegal = (board, player, size) => {
  const moves = [];
  for (let index = 0; index < board.length; index++) if (!board[index] && othelloFlips(board, player, index, size).length) moves.push(index);
  return moves;
};
// The reaction vocabulary belongs to the server: it keeps the stored value bounded (a fixed list, so a
// message can never accumulate arbitrary payload), and the client picker is built from the same list. The
// first six are the original set, kept first so old messages keep their meaning.
const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🔥", "😍", "😆", "😅", "🤣", "🥰", "😎", "🤔", "😴", "🤯", "🙌", "👏", "👌", "🤝", "💪", "💯", "🎉", "✨", "👀", "🫡", "💔", "⚡", "🎮", "🍕", "☕", "🌈", "🥳"];
const REACTION_USERS_MAX = 50;
const REPLY_SNIPPET_MAX = 120;
const MESSAGE_TABLE = "CREATE TABLE IF NOT EXISTS messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, room_id TEXT NOT NULL, id TEXT NOT NULL, user_id TEXT, username TEXT, role TEXT, photo TEXT, kind TEXT, content TEXT, created_at INTEGER NOT NULL, reply_to TEXT, reply_username TEXT, reply_snippet TEXT, reactions TEXT, deleted_at INTEGER, deleted_by TEXT)";
// Columns added after the first release. A Durable Object that already holds rows keeps its table,
// so CREATE TABLE IF NOT EXISTS does nothing there and these have to be ALTERed in one by one.
const MESSAGE_LATER_COLUMNS = [["reply_to", "TEXT"], ["reply_username", "TEXT"], ["reply_snippet", "TEXT"], ["reactions", "TEXT"], ["deleted_at", "INTEGER"], ["deleted_by", "TEXT"]];
const MESSAGE_INDEX = "CREATE INDEX IF NOT EXISTS messages_room ON messages (room_id, seq)";
const MESSAGE_ID_INDEX = "CREATE INDEX IF NOT EXISTS messages_id ON messages (room_id, id)";
const ROOM_PRESETS = { ocean: { accent: "#0284c7", soft: "#e7f7ff" }, sunset: { accent: "#f97316", soft: "#fff0e7" }, berry: { accent: "#d946ef", soft: "#fcecff" }, forest: { accent: "#16a34a", soft: "#eaf8ec" } };

const attachment = socket => { try { return socket.deserializeAttachment() || {}; } catch { return {}; } };
// 0 means "budget off", so only fall back when the var is absent or unparseable.
const budget = (value, fallback) => { const parsed = Number(value); return value === undefined || value === null || value === "" || !Number.isFinite(parsed) || parsed < 0 ? fallback : parsed; };
// Stored as a JSON object of emoji -> [userId,...]. Anything unparsable degrades to "no reactions"
// rather than failing the read of a whole room's history.
const reactionMap = value => { if (!value) return {}; try { const parsed = JSON.parse(value); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}; const clean = {}; for (const emoji of REACTIONS) if (Array.isArray(parsed[emoji])) clean[emoji] = parsed[emoji].filter(id => typeof id === "string").slice(0, REACTION_USERS_MAX); return clean; } catch { return {}; } };
// What a reply quote shows for its parent. Denormalized on purpose: the parent can be trimmed out of
// the room's retained history, and a quote that disappears with it would be worse than a snapshot.
const replySnippet = message => { const kind = message.kind || "text"; if (kind === "image") return "📷 Photo"; if (kind === "voice") return "🎙 Voice note"; if (kind === "gif") return "GIF"; return String(message.content || "").replace(/\s+/g, " ").trim().slice(0, REPLY_SNIPPET_MAX); };
// A Connect Four board is one flat array so a move is a single assignment: index = column * rows + row,
// with row 0 at the bottom. 0 is empty, 1 and 2 are the two seats.
const emptyBoard = () => new Array(CONNECT_FOUR_COLUMNS * CONNECT_FOUR_ROWS).fill(0);
const connectFourWinner = (board, column, row, disc) => {
  const directions = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (const [dx, dy] of directions) {
    let run = 1;
    for (const sign of [1, -1]) {
      let c = column + dx * sign, r = row + dy * sign;
      while (c >= 0 && c < CONNECT_FOUR_COLUMNS && r >= 0 && r < CONNECT_FOUR_ROWS && board[c * CONNECT_FOUR_ROWS + r] === disc) { run++; c += dx * sign; r += dy * sign; }
    }
    if (run >= 4) return true;
  }
  return false;
};

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
    this.roomVisitNotices = new Map();
    this.roomCalls = new Map();
    this.roomGames = new Map();
    this.gameWindows = new Map();
    this.daily = new Map();
    this.dailyDay = 0;
    this.messageDailyCap = budget(env.MESSAGE_DAILY_CAP, MESSAGE_DAILY_CAP);
    this.uploadDailyCap = budget(env.UPLOAD_DAILY_CAP, UPLOAD_DAILY_CAP);
    this.awayGraceMs = Math.max(1000, budget(env.AWAY_GRACE_MS, AWAY_GRACE_MS));
    this.endedGameTtlMs = Math.max(1000, budget(env.ENDED_GAME_TTL_MS, ENDED_GAME_TTL_MS));
    this.chessClockMs = Math.max(1000, budget(env.CHESS_CLOCK_MS, CHESS_CLOCK_MS));
    this.drawSeconds = Math.max(10, budget(env.DRAW_SECONDS, DRAW_SECONDS));
    this.drawRevealMs = Math.max(0, budget(env.DRAW_REVEAL_MS, DRAW_REVEAL_MS));
    this.drawChooseMs = Math.max(100, budget(env.DRAW_CHOOSE_MS, DRAW_CHOOSE_MS));
    state.blockConcurrencyWhile(async () => {
      state.storage.sql.exec(MESSAGE_TABLE);
      this.migrateMessages();
      state.storage.sql.exec(MESSAGE_INDEX);
      state.storage.sql.exec(MESSAGE_ID_INDEX);
      await this.migrateDatabase();
      // Games are the one piece of live state that must outlive the object: a board people stare at for a
      // minute would otherwise vanish the moment the object hibernates (WebSocket hibernation clears
      // in-memory fields while the sockets stay open). Spectators are dropped on load because they are
      // per-connection, not part of the game.
      const stored = await state.storage.get("roomGames").catch(() => null);
      this.roomGames = this.loadGames(stored);
      await this.hydrate();
    });
  }

  // The D1 schema used to be applied by hand (`npm run db:remote`), and production drifted: tables a
  // read path touched were never created, so every profile lookup answered 500. The Worker owns it
  // now - one no-op batch per schema version, and a failure is logged rather than refusing to start,
  // because a hub that cannot boot takes the whole chat down while a missing table only breaks the
  // feature that needs it.
  async migrateDatabase() {
    try {
      const applied = Number(await this.state.storage.get("d1SchemaVersion")) || 0;
      if (applied >= D1_SCHEMA_VERSION) return;
      await this.env.DB.batch(D1_SCHEMA.map(statement => this.env.DB.prepare(statement)));
      await this.state.storage.put("d1SchemaVersion", D1_SCHEMA_VERSION);
    } catch (error) {
      console.error(`D1 schema check failed: ${error && error.message || error}`);
    }
  }

  migrateMessages() {
    const sql = this.state.storage.sql;
    const existing = new Set(sql.exec("SELECT name FROM pragma_table_info('messages')").toArray().map(row => row.name));
    for (const [name, type] of MESSAGE_LATER_COLUMNS) if (!existing.has(name)) sql.exec(`ALTER TABLE messages ADD COLUMN ${name} ${type}`);
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
  roomView(room, user, preview = []) {
    const media = roomMedia(room), enterable = this.canEnter(room, user);
    // A request-only room is private by definition, so its card never carries recent messages - not
    // even for the creator who is allowed in. Open rooms keep the three-line preview.
    const previewable = enterable && room.access !== "request";
    return { id: room.id, name: room.name, icon: room.icon, vibe: room.vibe, accent: room.accent, soft: room.soft, emojis: media.emojis, stickers: media.stickers, gifs: media.gifs, access: room.access, builtIn: Boolean(room.builtIn), isOwner: Boolean(user) && room.ownerId === user.id, banned: Boolean(user) && Array.isArray(room.bans) && room.bans.includes(user.id), canEnter: enterable, requestStatus: user && room.requests.includes(user.id) ? "pending" : null, pendingCount: user && room.ownerId === user.id ? room.requests.length : undefined, online: this.roomOnlineCount(room.id), preview: previewable ? preview : [], createdAt: room.createdAt };
  }
  roomPreviews() {
    const previews = new Map(), rows = this.state.storage.sql.exec("SELECT room_id, id, username, kind, content, created_at FROM (SELECT room_id, id, username, kind, content, created_at, seq, ROW_NUMBER() OVER (PARTITION BY room_id ORDER BY seq DESC) AS recent_rank FROM messages WHERE deleted_at IS NULL) WHERE recent_rank <= 3 ORDER BY room_id, seq").toArray();
    for (const row of rows) { const room = this.findRoom(row.room_id); if (!room || room.access === "request") continue; const list = previews.get(row.room_id) || []; list.push({ id: row.id, username: row.username, kind: row.kind, content: row.content, createdAt: row.created_at }); previews.set(row.room_id, list); }
    return previews;
  }
  roomsView(user) { const previews = this.roomPreviews(); return this.rooms.map(room => this.roomView(room, user, previews.get(room.id) || [])); }

  /* --------------------------------------------------------------- realtime */

  sockets() { return this.state.getWebSockets().filter(socket => socket.readyState === 1); }
  clientsIn(roomId) { return this.sockets().filter(socket => attachment(socket).roomId === roomId); }
  roomOnlineCount(roomId) { return new Set(this.clientsIn(roomId).map(socket => attachment(socket).userId).filter(Boolean)).size; }
  send(socket, payload) { try { socket.send(JSON.stringify(payload)); } catch {} }
  broadcast(roomId, payload) { const text = JSON.stringify(payload); for (const socket of this.clientsIn(roomId)) { try { socket.send(text); } catch {} } }
  notifyUser(userId, payload) { const text = JSON.stringify(payload); let sent = 0; for (const socket of this.sockets()) if (attachment(socket).userId === userId) { try { socket.send(text); sent++; } catch {} } return sent; }
  notifyUserExcept(userId, excluded, payload) { const text = JSON.stringify(payload); for (const socket of this.sockets()) if (socket !== excluded && attachment(socket).userId === userId) { try { socket.send(text); } catch {} } }
  broadcastAll(payload) { const text = JSON.stringify(payload); for (const socket of this.sockets()) { try { socket.send(text); } catch {} } }
  broadcastRoomPreview(room, message) { if (room.access === "request") return; const text = JSON.stringify({ type: "room-preview", roomId: room.id, message: { id: message.id, username: message.username, kind: message.kind, content: message.content, createdAt: message.createdAt } }); for (const socket of this.sockets()) { const user = this.userById(attachment(socket).userId); if (this.canEnter(room, user)) { try { socket.send(text); } catch {} } } }
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
    const rows = this.state.storage.sql.exec("SELECT id, user_id, username, role, photo, kind, content, created_at, reply_to, reply_username, reply_snippet, reactions, deleted_at, deleted_by FROM messages WHERE room_id = ? ORDER BY seq DESC LIMIT ?", roomId, MAX_MESSAGES).toArray();
    return rows.reverse().map(row => this.messageView(row));
  }
  messageView(row) {
    const deleted = Boolean(row.deleted_at);
    return { id: row.id, userId: row.user_id, username: row.username, role: row.role, photo: row.photo, kind: row.kind, content: deleted ? "" : row.content, createdAt: row.created_at, deleted, deletedBy: row.deleted_by || null, reply: row.reply_to ? { id: row.reply_to, username: row.reply_username, snippet: row.reply_snippet } : null, reactions: deleted ? {} : reactionMap(row.reactions) };
  }
  messageRow(roomId, messageId) {
    return this.state.storage.sql.exec("SELECT id, user_id, username, kind, content, reactions, deleted_at FROM messages WHERE room_id = ? AND id = ? LIMIT 1", roomId, messageId).toArray()[0] || null;
  }
  // A quote is resolved once, when the reply is sent: an unknown, foreign or removed parent simply
  // makes the message a normal one instead of failing the send.
  replyContext(roomId, value) {
    const parentId = clean(value).slice(0, 64);
    if (!parentId) return null;
    const parent = this.messageRow(roomId, parentId);
    if (!parent || parent.deleted_at) return null;
    return { id: parent.id, username: parent.username, snippet: replySnippet(parent) };
  }
  // Who may remove somebody else's message: the same actors who already moderate this room's bans.
  canModerate(room, user) { const role = user.role || "user"; return role === "admin" || role === "mod" || (Boolean(room.ownerId) && room.ownerId === user.id); }
  /* ---------------------------------------------------- group room calls */
  groupCallView(call) { return { callId: call.id, hostId: call.hostId, startedAt: call.startedAt, participants: call.participants.map(person => ({ id: person.id, username: person.username })) }; }
  groupCallState(call) { return call ? { type: "group-call-state", active: true, ...this.groupCallView(call) } : { type: "group-call-state", active: false }; }
  // Only sockets sitting in the room receive signaling, so a member's notification channel in
  // another tab cannot answer for the tab that actually holds the microphone.
  notifyRoomUsers(roomId, userIds, payload) { const text = JSON.stringify(payload); for (const socket of this.clientsIn(roomId)) if (userIds.includes(attachment(socket).userId)) { try { socket.send(text); } catch {} } }
  leaveRoomCall(roomId, userId) {
    const call = this.roomCalls.get(roomId);
    if (!call || !call.participants.some(person => person.id === userId)) return;
    call.participants = call.participants.filter(person => person.id !== userId);
    if (!call.participants.length) { this.roomCalls.delete(roomId); this.broadcast(roomId, this.groupCallState(null)); return; }
    // There is no separate host privilege to lose - the earliest remaining member just carries the label.
    if (call.hostId === userId) call.hostId = call.participants[0].id;
    this.broadcast(roomId, { type: "group-call-left", callId: call.id, userId });
    this.broadcast(roomId, this.groupCallState(call));
  }
  // The starter of the call ends it for everybody; everyone else leaving only removes themselves.
  endRoomCall(roomId, user) {
    const call = this.roomCalls.get(roomId);
    if (!call) return;
    this.roomCalls.delete(roomId);
    this.broadcast(roomId, { type: "group-call-ended", callId: call.id, by: { id: user.id, username: user.username } });
    this.broadcast(roomId, this.groupCallState(null));
  }
  groupCallSignal(socket, event, user, now) {
    const room = this.findRoom(attachment(socket).roomId);
    // Room calls exist only in request-only user rooms: those are the private, moderated spaces,
    // and open or built-in rooms would let any stranger walk into a call.
    if (!room || room.builtIn || room.access !== "request") return false;
    if (Array.isArray(room.bans) && room.bans.includes(user.id)) return false;
    if (this.callLimited(attachment(socket).connectionId || user.id, now)) return false;
    if (event.type === "group-call-join") {
      let call = this.roomCalls.get(room.id);
      if (!call) { call = { id: crypto.randomUUID(), hostId: user.id, startedAt: Date.now(), participants: [] }; this.roomCalls.set(room.id, call); }
      if (!call.participants.some(person => person.id === user.id)) {
        if (call.participants.length >= GROUP_CALL_MAX) { this.send(socket, { type: "group-call-full", callId: call.id }); return true; }
        call.participants.push({ id: user.id, username: user.username });
      }
      this.send(socket, { type: "group-call-joined", ...this.groupCallView(call), self: user.id });
      this.broadcast(room.id, this.groupCallState(call));
      return true;
    }
    const call = this.roomCalls.get(room.id);
    if (!call) return true;
    if (event.type === "group-call-leave") { this.leaveRoomCall(room.id, user.id); return true; }
    // Only the account that started the call can end it for everybody; for anyone else this is a
    // no-op rather than a silent drop of the whole call.
    if (event.type === "group-call-end") {
      if (call.hostId === user.id) this.endRoomCall(room.id, user);
      return true;
    }
    if (call.id !== clean(event.callId).slice(0, 80)) return true;
    if (!call.participants.some(person => person.id === user.id)) return true;
    const target = call.participants.find(person => person.id === clean(event.to));
    if (!target || target.id === user.id) return true;
    const payload = { type: event.type, callId: call.id, from: user.id, to: target.id };
    if (event.type === "group-call-ice") {
      const candidate = event.candidate;
      if (candidate !== null && (!candidate || typeof candidate !== "object" || clean(candidate.candidate).length > 4096)) return true;
      payload.candidate = candidate === null ? null : { candidate: clean(candidate.candidate), sdpMid: candidate.sdpMid == null ? null : clean(candidate.sdpMid).slice(0, 64), sdpMLineIndex: Number.isInteger(candidate.sdpMLineIndex) ? candidate.sdpMLineIndex : null, usernameFragment: candidate.usernameFragment == null ? null : clean(candidate.usernameFragment).slice(0, 256) };
    } else {
      const description = event.sdp || {}, sdp = typeof description.sdp === "string" ? description.sdp : "";
      const wanted = event.type === "group-call-offer" ? "offer" : "answer";
      if (description.type !== wanted || !sdp.trim() || sdp.length > 50000) return true;
      payload.sdp = { type: description.type, sdp };
    }
    this.notifyRoomUsers(room.id, [target.id], payload);
    return true;
  }
  /* ----------------------------------------------------------------- games */
  // Games belong to the room they were started in, and a room may run several at once, so this is a map
  // of maps. The whole thing is mirrored into the object's storage because WebSocket hibernation clears
  // in-memory fields while sockets stay open: a board people were staring at must survive the quiet.
  gamesIn(roomId) { return [...(this.roomGames.get(roomId) || new Map()).values()]; }
  gameIn(roomId, gameId) { return (this.roomGames.get(roomId) || new Map()).get(gameId) || null; }
  // Only a game still being played or waited on blocks someone from starting another; a finished board is
  // history, and its players must be free to start again.
  playerGame(roomId, userId) { return this.gamesIn(roomId).find(game => game.status !== "ended" && game.players.some(player => player.id === userId)) || null; }
  // The games that hold a slot in the room. Everything that caps or counts games uses this, never the raw
  // list, or a room fills up with boards nobody is playing any more.
  liveGamesIn(roomId) { return this.gamesIn(roomId).filter(game => game.status !== "ended"); }
  // A finished board is history only briefly: the alarm that drops it is set when it ends, and an alarm
  // already waiting (an away seat about to expire) must not be pushed back by it.
  scheduleClear(game) {
    const at = (game.endedAt || Date.now()) + this.endedGameTtlMs;
    this.background((async () => {
      const current = await this.state.storage.getAlarm();
      if (current === null || at < current) await this.state.storage.setAlarm(at);
    })().catch(() => {}));
  }
  // A fresh board's first move goes to the seat that opened the last round, and that seat alternates, so a
  // rematch never hands the same account the first move every time. Chess is the exception: white always
  // moves first, so a rematch swaps colours instead (see game-restart) and the opening seat stays seat 0.
  startGame(game) {
    const chess = game.kind === "chess";
    const opener = chess || !game.players.length ? 0 : (game.opener || 0) % game.players.length;
    game.status = "playing";
    game.startedAt = Date.now();
    game.passed = false;
    game.turn = game.players[opener] ? game.players[opener].id : null;
    if (chess) {
      game.fen = CHESS_START_FEN;
      game.last = null;
      game.drawOffer = null;
      // A game carries its own allowance: the create form offers 5, 20, 40 minutes or no clock, and 0 means the
      // clock is off entirely (no ticking, no flag, no alarm to wake for).
      const allowance = Number.isFinite(game.clockMs) ? game.clockMs : this.chessClockMs;
      game.clock = allowance > 0 ? { ms: Object.fromEntries(game.players.map(player => [player.id, allowance])), at: Date.now() } : null;
      this.scheduleChessAlarm(game);
    }
    if (game.kind === "draw-guess") {
      game.roundNumber = 1;
      game.drawerIndex = 0;
      game.strokes = [];
      game.guessed = [];
      game.round = null;
      this.startDrawTurn(game);
    }
  }
  // Whoever is left runs the board. Without this the host's seat is the only key to restarting, approving
  // and ending, and an absent host leaves a finished game that nobody can play again.
  rehostGame(roomId, game, goneId = null) {
    const seated = game.players.some(player => player.id === game.hostId);
    if (goneId ? game.hostId !== goneId : seated) return false;
    const next = game.players.find(player => player.id !== goneId && player.id !== game.hostId);
    if (!next) return false;
    game.hostId = next.id;
    this.notifyUser(next.id, { type: "game-host", roomId, gameId: game.id, name: (GAME_KINDS[game.kind] || {}).name || "the game" });
    return true;
  }
  // What the side to move may actually play, computed here so a client shows legal moves instead of letting
  // people click into a refusal - Reversi is guesswork without it. Columns report playable columns.
  gameMoves(game) {
    const kind = GAME_KINDS[game.kind];
    if (!kind || game.status !== "playing") return [];
    if (kind.board === "columns") {
      const moves = [];
      for (let column = 0; column < kind.columns; column++) if (!game.board[column * kind.rows + (kind.rows - 1)]) moves.push(column);
      return moves;
    }
    const seat = game.players.findIndex(player => player.id === game.turn);
    if (seat < 0) return [];
    if (game.kind === "othello") return othelloLegal(game.board, seat + 1, kind.size);
    return game.board.reduce((moves, cell, index) => (cell ? moves : [...moves, index]), []);
  }
  gameView(game) {
    const kind = GAME_KINDS[game.kind] || GAME_KINDS["connect-four"];
    const chess = game.kind === "chess";
    const view = {
      id: game.id, kind: game.kind, name: kind.name, roomId: game.roomId, hostId: game.hostId,
      policy: game.policy, status: game.status, seats: gameMaxSeats(kind), minSeats: gameMinSeats(kind), solo: Boolean(kind.solo),
      layout: { type: kind.board, columns: kind.columns || null, rows: kind.rows || null, size: kind.size || null },
      players: game.players.map(player => ({ id: player.id, username: player.username, score: player.score || 0 })),
      spectators: game.guests.length,
      pending: game.pending.map(person => ({ id: person.id, username: person.username })),
      turn: game.turn || null, board: game.board.slice(), winnerId: game.winnerId || null,
      moves: this.gameMoves(game),
      reason: game.reason || null, passed: Boolean(game.passed),
      createdAt: game.createdAt, startedAt: game.startedAt || null, endedAt: game.endedAt || null
    };
    if (chess) {
      view.fen = game.fen || CHESS_START_FEN;
      // The side to move comes from the position, not from the last thing anybody said, so the panel can
      // never offer a move the object would refuse.
      const color = chessTurnColor(view.fen);
      view.turn = (game.players[color === "w" ? 0 : 1] || {}).id || null;
      view.board = chessPieces(view.fen);
      view.moves = game.status === "playing" ? chessLegalMoves(view.fen) : [];
      view.last = game.last || null;
      view.check = game.status === "playing" && new Chess(view.fen).inCheck();
      view.drawOffer = game.drawOffer || null;
      view.clock = this.chessClock(game);
      // The allowance this game was created with, so the panel can say "20 minutes" and a game with no clock shows
      // no clocks at all rather than two frozen ones.
      view.clockMs = Number.isFinite(game.clockMs) ? game.clockMs : this.chessClockMs;
    }
    if (game.kind === "draw-guess") {
      const round = game.round || null;
      view.rounds = DRAW_ROUNDS;
      view.roundNumber = game.roundNumber || 1;
      view.round = round ? {
        number: round.number, drawerId: round.drawerId,
        mask: round.mask || (round.word ? drawMask(round.word) : ""),
        revealed: Boolean(round.revealed),
        // The word only travels once the turn is over; while it is live it is the drawer's secret.
        word: round.revealed ? round.word : null,
        endsAt: round.endsAt || null, choosingUntil: round.choosingUntil || null,
        choosing: Boolean(!round.word && !round.revealed)
      } : null;
      view.strokes = (game.strokes || []).map(stroke => ({ color: stroke.color, size: stroke.size, points: stroke.points }));
      // Strokes arrive as `game-stroke` packets after this; the sequence number is how a client notices it missed
      // one and asks for the whole truth again instead of drawing a picture with a line missing.
      view.strokeSeq = game.strokeSeq || 0;
      // Who has guessed this turn, so the drawer and the other guessers can see who is still thinking. The word
      // itself stays out of it: the list is accounts, never the answer.
      view.guessed = (game.guessed || []).slice();
      // Guests keep their own score list (the owner's rule), so the panel can show who scored best among them.
      view.guests = game.guests.map(person => ({ id: person.id, username: person.username, score: person.score || 0 }));
      view.turn = round && !round.revealed ? round.drawerId : null;
    }
    return view;
  }
  // Remaining time per player as of now. The running side is derived from the position, so a hibernated
  // object wakes up to the right numbers instead of a snapshot frozen at the last write.
  chessClock(game, now = Date.now()) {
    if (game.kind !== "chess") return null;
    if (!game.clock || !game.clock.ms) {
      // Before the first move the clocks are simply the starting allowance, so a board that is waiting for an
      // opponent can already show what both players will have. A game created with no clock shows none.
      const allowance = Number.isFinite(game.clockMs) ? game.clockMs : this.chessClockMs;
      return game.status === "lobby" && allowance > 0 ? Object.fromEntries(game.players.map(player => [player.id, allowance])) : null;
    }
    const remaining = {};
    for (const player of game.players) remaining[player.id] = Math.max(0, game.clock.ms[player.id] || 0);
    if (game.status === "playing" && game.fen) {
      const moving = game.players[chessTurnColor(game.fen) === "w" ? 0 : 1];
      if (moving) remaining[moving.id] = Math.max(0, (game.clock.ms[moving.id] || 0) - (now - (game.clock.at || now)));
    }
    return remaining;
  }
  // A clock that ran out ends the game even if nobody clicks: the sweep calls this on the alarm, and its
  // next-wake calculation schedules that alarm for the moment the flag falls.
  settleChessClock(game, now = Date.now()) {
    if (game.kind !== "chess" || game.status !== "playing" || !game.clock || !game.clock.ms || !game.fen) return false;
    const moving = game.players[chessTurnColor(game.fen) === "w" ? 0 : 1];
    if (!moving) return false;
    if ((game.clock.ms[moving.id] || 0) - (now - (game.clock.at || now)) > 0) return false;
    game.clock.ms[moving.id] = 0;
    const opponent = game.players.find(player => player.id !== moving.id);
    this.endGame(game, opponent ? opponent.id : null, "time");
    return true;
  }
  // Wake the object when a chess clock runs out, so a flag falls even if nobody clicks again. The sweep
  // recomputes the same deadline for every game, so this only ever brings the alarm forward.
  // Bring the alarm forward to a deadline, never push it back: the sweep owns the full picture and recomputes
  // every pending deadline (away seats, results, clocks, drawing turns) on each pass.
  wakeAt(at) {
    if (!at) return;
    this.background((async () => {
      const current = await this.state.storage.getAlarm();
      if (current === null || at < current) await this.state.storage.setAlarm(at);
    })().catch(() => {}));
  }
  scheduleChessAlarm(game, now = Date.now()) {
    if (game.kind !== "chess" || game.status !== "playing" || !game.clock || !game.clock.ms || !game.turn) return;
    this.wakeAt((game.clock.at || now) + (game.clock.ms[game.turn] || 0));
  }
  broadcastGames(roomId, persist = true) {
    // Spectator changes are per-connection and not worth a storage write; seats, boards and status are.
    if (persist) this.saveGames();
    this.broadcast(roomId, { type: "game-state", roomId, games: this.gamesIn(roomId).map(game => this.gameView(game)) });
    // The room list's games entry is an aggregate, so every client is told the set changed.
    this.broadcastAll({ type: "games-changed" });
  }
  saveGames() {
    const snapshot = {};
    for (const [roomId, games] of this.roomGames) snapshot[roomId] = Object.fromEntries(games);
    this.background(this.state.storage.put("roomGames", snapshot));
  }
  loadGames(stored) {
    const rooms = new Map();
    for (const [roomId, value] of Object.entries(stored || {})) {
      if (!value || typeof value !== "object") continue;
      // v79 stored one game per room as {roomId: game}; accept both shapes so a deploy never drops a board.
      const games = value.id ? { [value.id]: value } : value;
      const map = new Map();
      for (const [gameId, game] of Object.entries(games)) {
        // A game with no seats is not a game: it can only be a leftover from a board whose players all left,
        // and keeping it would pin a dead entry to the room across every restart.
        if (!game || !GAME_KINDS[game.kind] || !Array.isArray(game.players) || !game.players.length) continue;
        map.set(gameId, { ...game, guests: [] });
      }
      if (map.size) rooms.set(roomId, map);
    }
    return rooms;
  }
  gameError(socket, message) { this.send(socket, { type: "game-error", message }); }
  // Games get their own window so a click-heavy board never eats the chat message budget. Strokes count in a
  // window of their own, with a larger limit: a scribble is one event per line and must never be dropped silently
  // by the same counter that guards seat changes.
  gameLimited(bucket, now, limit = GAME_EVENT_LIMIT) {
    const record = this.gameWindows.get(bucket) || { start: now, count: 0 };
    if (now - record.start > MESSAGE_WINDOW_MS) { record.start = now; record.count = 0; }
    record.count++;
    this.gameWindows.set(bucket, record);
    return record.count > limit;
  }
  // The host runs a game; moderators and the admin can cover for a host who has gone quiet. A seated player
  // can run a board whose host is not in the room at all - the host role is handed over on the way out, but
  // this also rescues a board stored before that rule existed.
  canRunGame(room, game, user) {
    if (user.id === game.hostId || this.canModerate(room, user)) return true;
    return game.players.some(player => player.id === user.id) && !this.usersInRoom(room.id).has(game.hostId);
  }
  addGamePlayer(game, user) {
    game.pending = game.pending.filter(person => person.id !== user.id);
    // A seat is not a spectator seat: someone who watched the board before joining must not be counted twice.
    game.guests = game.guests.filter(person => person.id !== user.id);
    if (!game.players.some(player => player.id === user.id)) game.players.push({ id: user.id, username: user.username, score: 0 });
    // A two-seat game starts the moment its last seat fills. A game with a range of seats (Draw & Guess, two to
    // eight) waits for its host instead: auto-starting at the minimum is why it was only ever a two-player game -
    // the second person to arrive started the round and everybody after them was told it had already started.
    const kind = GAME_KINDS[game.kind] || {};
    if (game.status === "lobby" && game.players.length >= gameMaxSeats(kind)) this.startGame(game);
  }
  endGame(game, winnerId = null, reason = null) {
    game.status = "ended"; game.turn = null; game.winnerId = winnerId; game.reason = reason; game.endedAt = Date.now();
    // A two-seat board counts wins, so its winner gets one. Draw & Guess is decided on points that are already on
    // the scoreboard - adding a "win" there printed 601 for a 600-point game.
    if (winnerId && game.kind !== "draw-guess") { const winner = game.players.find(player => player.id === winnerId); if (winner) winner.score = (winner.score || 0) + 1; }
    this.scheduleClear(game);
  }
  // A seat that goes away while the game is being played. A two-seat board is a forfeit (that is the whole game),
  // but a game that seats more than two carries on with the people still there: one closed tab, or one player
  // pressing Leave, must not hand the room a result - it used to end a four-player drawing for everybody and
  // award the win to whoever happened to be first in the list.
  playerGone(game, goneId, seatIndex = -1) {
    if (game.status !== "playing" || !game.players.length) return false;
    const min = gameMinSeats(GAME_KINDS[game.kind] || {});
    if (game.players.length < min) { this.endGame(game, game.players[0].id, "left"); return true; }
    // A drawer who walked out leaves their turn behind: it is revealed early and the rotation carries on from the
    // seat they held, so the player who moved up into it draws next.
    if (game.kind === "draw-guess" && game.round && game.round.drawerId === goneId) {
      if (seatIndex >= 0) game.drawerIndex = Math.min(seatIndex, game.players.length - 1);
      if (!game.round.revealed) { game.round.revealed = true; game.round.revealUntil = 0; game.round.endsAt = Date.now(); game.turn = null; }
      this.advanceDrawTurn(game, Date.now());
    }
    return false;
  }
  // Connect Four, tic-tac-toe and Reversi share the seat/approval/spectator flow and differ only in how a
  // move is validated and how a move ends the game.
  gameMove(socket, game, user, room, event) {
    if (game.status !== "playing") return this.gameError(socket, "That game is not running.");
    const seat = game.players.findIndex(player => player.id === user.id);
    if (seat < 0) return this.gameError(socket, "Only the players can move.");
    if (game.turn !== user.id) return this.gameError(socket, "It is not your turn.");
    const kind = GAME_KINDS[game.kind], disc = seat + 1;
    const opponent = game.players.find(player => player.id !== user.id);

    if (kind.board === "columns") {
      const column = Number(event.column);
      if (!Number.isInteger(column) || column < 0 || column >= kind.columns) return this.gameError(socket, "That column is not on the board.");
      let row = -1;
      for (let level = 0; level < kind.rows; level++) if (!game.board[column * kind.rows + level]) { row = level; break; }
      if (row < 0) return this.gameError(socket, "That column is full.");
      game.board[column * kind.rows + row] = disc;
      if (connectFourWinner(game.board, column, row, disc)) return (this.endGame(game, user.id, "four"), this.broadcastGames(room.id));
      if (game.board.every(cell => cell !== 0)) return (this.endGame(game, null, "draw"), this.broadcastGames(room.id));
      game.turn = opponent ? opponent.id : null;
      return this.broadcastGames(room.id);
    }

    const index = Number(event.index);
    if (!Number.isInteger(index) || index < 0 || index >= game.board.length) return this.gameError(socket, "That square is not on the board.");
    if (game.board[index]) return this.gameError(socket, "That square is taken.");

    if (game.kind === "tic-tac-toe") {
      game.board[index] = disc;
      const won = TIC_TAC_TOE_LINES.some(line => line.every(cell => game.board[cell] === disc));
      if (won) return (this.endGame(game, user.id, "line"), this.broadcastGames(room.id));
      if (game.board.every(cell => cell !== 0)) return (this.endGame(game, null, "draw"), this.broadcastGames(room.id));
      game.turn = opponent ? opponent.id : null;
      return this.broadcastGames(room.id);
    }

    if (game.kind === "othello") {
      const flips = othelloFlips(game.board, disc, index, kind.size);
      if (!flips.length) return this.gameError(socket, "You cannot play there - it flips nothing.");
      game.board[index] = disc;
      for (const cell of flips) game.board[cell] = disc;
      const otherDisc = disc === 1 ? 2 : 1;
      const theirs = othelloLegal(game.board, otherDisc, kind.size), mine = othelloLegal(game.board, disc, kind.size);
      if (theirs.length) { game.turn = opponent ? opponent.id : null; game.passed = false; return this.broadcastGames(room.id); }
      // The opponent cannot move: this player goes again, and only stops when nobody can.
      if (mine.length) { game.passed = true; return this.broadcastGames(room.id); }
      const black = game.board.filter(cell => cell === 1).length, white = game.board.filter(cell => cell === 2).length;
      const winner = black === white ? null : game.players[black > white ? 0 : 1];
      return (this.endGame(game, winner ? winner.id : null, black === white ? "draw" : "discs"), this.broadcastGames(room.id));
    }
  }
  // Chess is validated by chess.js inside the object: the position lives in FEN and every rule that people
  // argue about (castling, en passant, promotion, check, mate, stalemate, threefold, 50-move) is the
  // library's, not a hand-rolled approximation. A move that runs out the mover's clock never lands.
  chessMove(socket, game, user, room, event) {
    if (game.status !== "playing") return this.gameError(socket, "That game is not running.");
    const seat = game.players.findIndex(player => player.id === user.id);
    if (seat < 0) return this.gameError(socket, "Only the players can move.");
    const fen = game.fen || CHESS_START_FEN, color = seat === 0 ? "w" : "b";
    if (chessTurnColor(fen) !== color) return this.gameError(socket, "It is not your turn.");
    const from = clean(event.from).slice(0, 2).toLowerCase(), to = clean(event.to).slice(0, 2).toLowerCase();
    const promotion = clean(event.promotion).toLowerCase();
    if (!/^[a-h][1-8]$/.test(from) || !/^[a-h][1-8]$/.test(to)) return this.gameError(socket, "That square is not on the board.");
    const chess = new Chess(fen);
    let move = null;
    try { move = chess.move({ from, to, promotion: CHESS_PROMOTIONS.includes(promotion) ? promotion : undefined }); }
    catch { move = null; }
    if (!move) return this.gameError(socket, "That move is not legal.");
    const now = Date.now(), opponent = game.players.find(player => player.id !== user.id);
    if (game.clock && game.clock.ms) {
      const left = (game.clock.ms[user.id] || 0) - (now - (game.clock.at || now));
      // A flag that fell before the move was made is a loss on time; the move does not rescue the position.
      if (left <= 0) {
        game.clock.ms[user.id] = 0;
        this.endGame(game, opponent ? opponent.id : null, "time");
        return this.broadcastGames(room.id);
      }
      game.clock.ms[user.id] = left;
      game.clock.at = now;
    }
    // A move withdraws the mover's own offer; it only stands while the opponent has to answer it.
    if (game.drawOffer === user.id) game.drawOffer = null;
    game.fen = chess.fen();
    game.last = { from: move.from, to: move.to };
    // Mate first, then the draws in the order a player would expect to be told about them.
    if (chess.isCheckmate()) return (this.endGame(game, user.id, "checkmate"), this.broadcastGames(room.id));
    if (chess.isStalemate()) return (this.endGame(game, null, "stalemate"), this.broadcastGames(room.id));
    if (chess.isInsufficientMaterial()) return (this.endGame(game, null, "material"), this.broadcastGames(room.id));
    if (chess.isThreefoldRepetition()) return (this.endGame(game, null, "repetition"), this.broadcastGames(room.id));
    if (chess.isDraw()) return (this.endGame(game, null, "fifty"), this.broadcastGames(room.id));
    game.turn = opponent ? opponent.id : null;
    this.scheduleChessAlarm(game, now);
    return this.broadcastGames(room.id);
  }
  /* ------------------------------------------------------- draw & guess */
  // Three words for the drawer, distinct, all short enough to draw.
  drawWords(count = DRAW_CHOICES) {
    const pool = DRAW_WORDS.filter(word => word.length <= 14), picked = [];
    let guard = 0;
    while (picked.length < count && guard++ < 200) {
      const word = pool[Math.floor(Math.random() * pool.length)];
      if (word && !picked.includes(word)) picked.push(word);
    }
    return picked;
  }
  // One turn per player per round. The drawer gets the words and a short window to choose; if they say nothing
  // the first one is used, so a distracted drawer cannot hold the whole room hostage.
  startDrawTurn(game, now = Date.now()) {
    const players = game.players;
    if (!players.length) return;
    game.drawerIndex = (game.drawerIndex || 0) % players.length;
    const drawer = players[game.drawerIndex];
    game.round = {
      number: game.roundNumber || 1, drawerId: drawer.id, word: null, mask: "",
      options: this.drawWords(), choosingUntil: now + this.drawChooseMs, endsAt: null, revealed: false, revealUntil: null
    };
    game.strokes = [];
    game.guessed = [];
    game.turn = drawer.id;
    this.notifyUser(drawer.id, { type: "game-word", roomId: game.roomId, gameId: game.id, options: game.round.options });
    this.wakeAt(now + this.drawChooseMs);
  }
  pickDrawWord(game, word, now = Date.now()) {
    if (!game.round || game.round.word || game.round.revealed) return false;
    if (!game.round.options.includes(word)) return false;
    game.round.word = word;
    game.round.mask = drawMask(word);
    game.round.endsAt = now + this.drawSeconds * 1000;
    game.round.choosingUntil = null;
    this.wakeAt(game.round.endsAt);
    // The drawer is told privately however the word was chosen. When the object picks it for a drawer who never
    // answered, this is the only place they can learn it - without it the canvas has no word to draw and the
    // whole turn is a blank 80 seconds that nobody can end early but the clock.
    this.notifyUser(game.round.drawerId, { type: "game-word", roomId: game.roomId, gameId: game.id, word, options: null });
    return true;
  }
  // Points: a guesser earns up to 200 scaled by the time left on the clock, and the drawer earns 50 for every
  // person who gets it — drawing well has to pay, or nobody wants to be the drawer.
  awardDrawGuess(game, guesserId, now = Date.now()) {
    const round = game.round;
    const remaining = Math.max(0, ((round.endsAt || now) - now) / (this.drawSeconds * 1000));
    const points = Math.max(50, Math.round(DRAW_SCORE_FOR_GUESS * Math.min(1, remaining)));
    const player = game.players.find(person => person.id === guesserId);
    const guest = game.guests.find(person => person.id === guesserId);
    if (player) player.score = (player.score || 0) + points;
    else if (guest) guest.score = (guest.score || 0) + points;
    else return 0;
    const drawer = game.players.find(person => person.id === round.drawerId);
    if (drawer) drawer.score = (drawer.score || 0) + DRAW_SCORE_FOR_DRAWER;
    if (!game.guessed.includes(guesserId)) game.guessed.push(guesserId);
    return points;
  }
  drawAllGuessed(game) {
    const round = game.round;
    if (!round) return false;
    const others = [...game.players.map(person => person.id), ...game.guests.map(person => person.id)].filter(id => id !== round.drawerId);
    return others.length > 0 && others.every(id => (game.guessed || []).includes(id));
  }
  finishDrawTurn(game, now = Date.now()) {
    if (!game.round || game.round.revealed) return false;
    game.round.revealed = true;
    game.round.revealUntil = now + this.drawRevealMs;
    game.round.endsAt = game.round.endsAt || now;
    game.turn = null;
    this.wakeAt(game.round.revealUntil);
    return true;
  }
  // The next drawer in the room, and the next round once everybody has drawn once. The rotation is anchored to
  // the drawer of the round that just ended rather than to a stored index: a seat can go away mid-game (somebody
  // leaves, or their grace runs out), and a stale index would either skip a player or point past the end.
  advanceDrawTurn(game, now = Date.now()) {
    const round = game.round;
    if (!round || !round.revealed || now < (round.revealUntil || 0)) return false;
    const players = Math.max(1, game.players.length);
    const current = game.players.findIndex(player => player.id === round.drawerId);
    game.drawerIndex = current < 0 ? Math.min(game.drawerIndex || 0, players - 1) : (current + 1) % players;
    if (game.drawerIndex === 0) {
      game.roundNumber = (game.roundNumber || 1) + 1;
      if (game.roundNumber > DRAW_ROUNDS) {
        const best = [...game.players].sort((left, right) => (right.score || 0) - (left.score || 0))[0];
        const tied = best && game.players.filter(player => (player.score || 0) === (best.score || 0)).length > 1;
        this.endGame(game, tied ? null : best ? best.id : null, tied ? "draw" : "points");
        return true;
      }
    }
    this.startDrawTurn(game, now);
    return true;
  }
  drawDeadline(game) {
    const round = game.round;
    if (!round || game.status !== "playing") return null;
    if (round.revealed) return round.revealUntil || null;
    if (!round.word) return round.choosingUntil || null;
    return round.endsAt || null;
  }
  // Called from the sweep (and therefore from the alarm and from any game event): a turn that ran out, a drawer
  // who never chose, and the reveal that has had its time all settle here.
  settleDrawTurn(game, now = Date.now()) {
    if (game.kind !== "draw-guess" || game.status !== "playing" || !game.round) return false;
    const round = game.round;
    if (round.revealed) return this.advanceDrawTurn(game, now);
    if (!round.word) {
      if (now < (round.choosingUntil || 0)) return false;
      return this.pickDrawWord(game, round.options[0], now);
    }
    if (this.drawAllGuessed(game) || now >= (round.endsAt || 0)) return this.finishDrawTurn(game, now);
    return false;
  }
  // A stroke is bounded at both ends: a colour from the fixed palette, a size of one to three, at most 200
  // points, and coordinates inside the canvas. Anything else is dropped rather than stored.
  cleanStroke(raw) {
    if (!raw || typeof raw !== "object") return null;
    const color = DRAW_COLORS.includes(String(raw.color)) ? String(raw.color) : DRAW_COLORS[0];
    const size = [1, 2, 3].includes(Number(raw.size)) ? Number(raw.size) : 2;
    const points = Array.isArray(raw.points) ? raw.points.slice(0, DRAW_STROKE_POINTS_MAX).map(point => {
      const x = Number(point?.[0]), y = Number(point?.[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
      return [Math.max(0, Math.min(DRAW_POINTS_MAX, Math.round(x))), Math.max(0, Math.min(DRAW_POINTS_MAX, Math.round(y)))];
    }).filter(Boolean) : [];
    if (!points.length) return null;
    return { color, size, points };
  }
  // A drawing is bounded as a whole, not just stroke by stroke: the full state travels in one WebSocket message
  // on a sync, and Cloudflare closes a socket whose message passes 1 MiB. The oldest lines go first, so the
  // drawing always keeps what is being drawn now.
  pruneStrokes(game) {
    const strokes = game.strokes || [];
    let total = strokes.reduce((sum, stroke) => sum + stroke.points.length, 0);
    let drop = 0;
    while (total > DRAW_POINTS_TOTAL_MAX && drop < strokes.length - 1) { total -= strokes[drop].points.length; drop++; }
    if (drop) game.strokes = strokes.slice(drop);
    game.strokes = (game.strokes || []).slice(-DRAW_STROKES_MAX);
    return game.strokes;
  }
  // A correct guess: points for the guesser (guests keep their own score), points for the drawer, a system line
  // in the room, and the word itself never echoed into the transcript.
  drawCorrectGuess(room, game, user, now = Date.now()) {
    const already = (game.guessed || []).includes(user.id);
    if (!already) this.awardDrawGuess(game, user.id, now);
    const message = { id: crypto.randomUUID(), userId: null, username: "Chatblink", role: "user", photo: null, kind: "system", content: already ? `${user.username} guessed it too` : `${user.username} guessed the word`, createdAt: Date.now() };
    this.addMessage(room.id, message);
    this.broadcast(room.id, { type: "message", message });
    this.broadcastRoomPreview(room, message);
    if (this.drawAllGuessed(game)) this.finishDrawTurn(game, now);
    this.broadcastGames(room.id);
  }
  gameEvent(socket, event, user, now) {
    const meta = attachment(socket), room = this.findRoom(meta.roomId);
    if (!room || (Array.isArray(room.bans) && room.bans.includes(user.id))) return;
    // A stroke has its own, larger window: one event per line is not a click, and a drawing must never lose a
    // line to the seat-change budget.
    const drawing = event.type === "game-draw";
    if (this.gameLimited(drawing ? `${meta.connectionId || user.id}:draw` : (meta.connectionId || user.id), now, drawing ? DRAW_EVENT_LIMIT : GAME_EVENT_LIMIT)) return;
    // Any interaction first settles seats whose grace ran out, so nobody has to wait for the alarm.
    this.sweepAway(now);
    const gameId = clean(event.gameId).slice(0, 64), game = gameId ? this.gameIn(room.id, gameId) : null;

    // Opening the dock asks for the truth rather than trusting what it last heard: the object may have
    // restarted, and "nobody is playing here" is the one wrong answer that looks like a bug.
    if (event.type === "game-sync") {
      this.send(socket, { type: "game-state", roomId: room.id, games: this.gamesIn(room.id).map(item => this.gameView(item)) });
      // The drawer's word never travels in the broadcast, so a reconnect (or a panel that just opened) is sent
      // it privately: a spectator's client cannot read it out of the state packet.
      for (const item of this.gamesIn(room.id)) {
        if (item.kind !== "draw-guess" || item.status !== "playing" || !item.round || item.round.revealed) continue;
        if (item.round.drawerId !== user.id) continue;
        this.send(socket, { type: "game-word", roomId: room.id, gameId: item.id, word: item.round.word || null, options: item.round.word ? null : item.round.options });
      }
      return;
    }

    if (event.type === "game-create") {
      const kind = GAME_KINDS[clean(event.kind).slice(0, 32)];
      if (!kind) return this.gameError(socket, "That game is not available.");
      // Only games still open hold a slot: finished boards are results and are pruned below, so a room can
      // never be closed to new games by boards nobody is playing.
      if (this.liveGamesIn(room.id).length >= GAMES_PER_ROOM) return this.gameError(socket, `This room already has ${GAMES_PER_ROOM} games running.`);
      // One seat per person per room keeps the dock readable and stops anyone playing two boards at once.
      if (this.playerGame(room.id, user.id)) return this.gameError(socket, "Finish the game you are playing in this room first.");
      if (!this.roomGames.has(room.id)) this.roomGames.set(room.id, new Map());
      const fresh = {
        id: crypto.randomUUID(), kind: clean(event.kind), roomId: room.id, hostId: user.id,
        policy: clean(event.policy) === "open" ? "open" : "request", status: "lobby",
        players: [{ id: user.id, username: user.username, score: 0 }], guests: [], pending: [],
        turn: null, board: initialBoard(kind), winnerId: null, reason: null, passed: false, opener: 0,
        createdAt: Date.now(), startedAt: null, endedAt: null
      };
      // Chess carries its own allowance. Only the offered ones are accepted, and no allowance at all (or 0) means
      // the game has no clock rather than a default nobody chose.
      if (fresh.kind === "chess") {
        const minutes = Number(event.minutes);
        fresh.clockMs = CHESS_TIME_OPTIONS.includes(minutes) ? minutes * 60000 : this.chessClockMs;
      }
      if (kind.solo) { fresh.status = "playing"; fresh.startedAt = fresh.createdAt; fresh.turn = user.id; }
      this.roomGames.get(room.id).set(fresh.id, fresh);
      return this.broadcastGames(room.id);
    }
    if (!game) return;
    const seats = gameMaxSeats(GAME_KINDS[game.kind] || {});
    const isPlayer = game.players.some(player => player.id === user.id);

    if (event.type === "game-join" || event.type === "game-request") {
      if (game.status !== "lobby") return this.gameError(socket, "That game already started.");
      if (isPlayer) return;
      if (game.players.length >= seats) return this.gameError(socket, "That game is full - you can watch it.");
      const playing = this.playerGame(room.id, user.id);
      if (playing && playing.id !== game.id) return this.gameError(socket, "Finish the game you are playing in this room first.");
      if (game.policy === "open") { this.addGamePlayer(game, user); return this.broadcastGames(room.id); }
      if (game.pending.some(person => person.id === user.id)) return;
      game.pending.push({ id: user.id, username: user.username });
      this.notifyUser(game.hostId, { type: "game-request", roomId: room.id, by: { id: user.id, username: user.username }, game: this.gameView(game) });
      return this.broadcastGames(room.id);
    }
    if (event.type === "game-approve" || event.type === "game-deny") {
      if (!this.canRunGame(room, game, user)) return this.gameError(socket, "Only the host can do that.");
      const targetId = clean(event.userId).slice(0, 64), target = this.userById(targetId);
      if (!game.pending.some(person => person.id === targetId)) return;
      game.pending = game.pending.filter(person => person.id !== targetId);
      if (event.type === "game-approve" && target && game.players.length < seats) {
        this.addGamePlayer(game, target);
        this.notifyUser(targetId, { type: "game-approved", roomId: room.id, gameId: game.id });
      } else if (event.type === "game-approve") {
        return this.gameError(socket, "That game is full.");
      } else {
        this.notifyUser(targetId, { type: "game-denied", roomId: room.id, gameId: game.id });
      }
      return this.broadcastGames(room.id);
    }
    if (event.type === "game-watch") {
      // A player is not a spectator of their own board.
      if (!game.players.some(player => player.id === user.id) && !game.guests.some(person => person.id === user.id)) game.guests.push({ id: user.id, username: user.username, score: 0 });
      return this.broadcastGames(room.id, false);
    }
    if (event.type === "game-start") {
      // Draw & Guess seats two to eight, so the room gathers first and the host says when to begin. A two-seat
      // board has no lobby worth waiting in: it starts by itself the moment its last seat fills.
      if (game.status !== "lobby") return this.gameError(socket, "That game already started.");
      if (!this.canRunGame(room, game, user)) return this.gameError(socket, "Only the host can start it.");
      const min = gameMinSeats(GAME_KINDS[game.kind] || {});
      if (game.players.length < min) return this.gameError(socket, `That game needs ${min} players.`);
      this.startGame(game);
      return this.broadcastGames(room.id);
    }
    if (event.type === "game-leave") {
      game.pending = game.pending.filter(person => person.id !== user.id);
      game.guests = game.guests.filter(person => person.id !== user.id);
      if (isPlayer) {
        const leftAt = game.players.findIndex(player => player.id === user.id);
        game.players = game.players.filter(player => player.id !== user.id);
        // A lobby game nobody is left in closes.
        if (!game.players.length) {
          this.dropGame(room.id, game.id);
          return this.broadcastGames(room.id);
        }
        this.playerGone(game, user.id, leftAt);
      }
      // The leaver may have been the host: the seat that is left takes the controls, so the game can still
      // be rematched, cleared or ended.
      if (game.hostId === user.id) this.rehostGame(room.id, game, user.id);
      return this.broadcastGames(room.id);
    }
    if (event.type === "game-move") return game.kind === "chess" ? this.chessMove(socket, game, user, room, event) : this.gameMove(socket, game, user, room, event);
    // Resigning and agreeing a draw are chess mechanics: a turn-based grid game ends by its own rules, and
    // "leave" already forfeits one. Both only ever apply to a game being played.
    if (event.type === "game-resign") {
      if (!isPlayer || game.status !== "playing") return this.gameError(socket, "Only a player in a running game can resign.");
      if (game.kind !== "chess") return this.gameError(socket, "Resigning is only part of chess.");
      const opponent = game.players.find(player => player.id !== user.id);
      this.endGame(game, opponent ? opponent.id : null, "resign");
      return this.broadcastGames(room.id);
    }
    if (event.type === "game-offer-draw") {
      if (!isPlayer || game.status !== "playing") return this.gameError(socket, "Only a player in a running game can offer a draw.");
      if (game.kind !== "chess") return this.gameError(socket, "Draw offers are only part of chess.");
      if (game.drawOffer === user.id) return this.gameError(socket, "You have already offered a draw.");
      game.drawOffer = user.id;
      const opponent = game.players.find(player => player.id !== user.id);
      if (opponent) this.notifyUser(opponent.id, { type: "game-draw-offer", roomId: room.id, gameId: game.id, by: { id: user.id, username: user.username } });
      return this.broadcastGames(room.id);
    }
    if (event.type === "game-accept-draw") {
      if (!isPlayer || game.status !== "playing" || !game.drawOffer) return this.gameError(socket, "There is no draw offer to accept.");
      if (game.drawOffer === user.id) return this.gameError(socket, "That is your own offer.");
      game.drawOffer = null;
      this.endGame(game, null, "agreed");
      return this.broadcastGames(room.id);
    }
    /* ------------------------------------------------ draw & guess turn */
    if (event.type === "game-pick-word") {
      if (game.kind !== "draw-guess") return this.gameError(socket, "That game has no words to pick.");
      if (!isPlayer || game.round?.drawerId !== user.id) return this.gameError(socket, "Only the drawer picks the word.");
      if (game.round?.word) return this.gameError(socket, "The word is already chosen.");
      if (!this.pickDrawWord(game, clean(event.word).toLowerCase())) return this.gameError(socket, "That word is not one of the choices.");
      // pickDrawWord tells the drawer their word privately; the broadcast still must not carry it.
      return this.broadcastGames(room.id);
    }
    if (event.type === "game-draw") {
      if (game.kind !== "draw-guess") return;
      if (!isPlayer || game.round?.drawerId !== user.id) return this.gameError(socket, "Only the drawer can draw.");
      if (!game.round?.word || game.round.revealed) return;
      const stroke = this.cleanStroke(event.stroke);
      if (!stroke) return;
      game.strokes = [...(game.strokes || []), stroke];
      this.pruneStrokes(game);
      // One stroke travels as one stroke. The whole drawing used to be re-sent in a game-state on every line, which
      // is quadratic in the number of strokes (a busy drawing reached hundreds of kilobytes a line) and made every
      // client rebuild its panel and repaint the canvas mid-stroke. The full state still rides on game-sync, seat
      // changes and turn changes, so a client that missed one repaints from the truth.
      game.strokeSeq = (game.strokeSeq || 0) + 1;
      // Only every twentieth stroke is written to storage: the free tier meters rows written, and a live drawing
      // would otherwise cost a row per line. A stroke is one event, not one event per point.
      if (game.strokeSeq % 20 === 0) this.saveGames();
      return this.broadcast(room.id, { type: "game-stroke", roomId: room.id, gameId: game.id, seq: game.strokeSeq, stroke });
    }
    if (event.type === "game-clear") {
      if (game.kind !== "draw-guess") return;
      if (!isPlayer || game.round?.drawerId !== user.id) return this.gameError(socket, "Only the drawer can clear the canvas.");
      game.strokes = [];
      game.strokeSeq = (game.strokeSeq || 0) + 1;
      this.saveGames();
      return this.broadcast(room.id, { type: "game-cleared", roomId: room.id, gameId: game.id, seq: game.strokeSeq });
    }
    if (event.type === "game-restart") {
      // A rematch only ever follows a result: the board screen says who won (or that it was a tie) and the
      // same seats start again. A board still in play is ended first, so nobody loses a half-played position
      // to a stray tap.
      if (game.status !== "ended") return this.gameError(socket, "That game is still running.");
      // Either player may ask for the rematch: being the host is not the price of playing again.
      if (!isPlayer && !this.canRunGame(room, game, user)) return this.gameError(socket, "Only a player can ask for a rematch.");
      // A rematch is with the people still here: a seat whose player walked out is dropped rather than
      // leaving a ghost opponent who never moves (and whose game would block the player from a new one).
      const here = this.usersInRoom(room.id);
      game.players = game.players.filter(player => player.id === user.id || here.has(player.id));
      game.pending = game.pending.filter(person => here.has(person.id));
      // Chess alternates colours between games because white always moves first: the seats swap instead of
      // the opening seat. The clock and any outstanding offer belonged to the game that just finished.
      if (game.kind === "chess") { game.players.reverse(); game.fen = CHESS_START_FEN; game.last = null; game.drawOffer = null; game.clock = null; }
      if (game.kind === "draw-guess") { game.round = null; game.strokes = []; game.guessed = []; game.roundNumber = 1; game.drawerIndex = 0; }
      // Same seats, fresh board, and the opening seat alternates. With a seat empty it drops back to the
      // lobby rather than starting short-handed.
      game.board = initialBoard(GAME_KINDS[game.kind] || GAME_KINDS["connect-four"]);
      game.winnerId = null; game.reason = null; game.passed = false; game.endedAt = null; game.startedAt = null;
      game.turn = null;
      game.opener = ((game.opener || 0) + 1) % seats;
      if (game.players.length >= gameMinSeats(GAME_KINDS[game.kind] || {})) this.startGame(game);
      else game.status = "lobby";
      this.rehostGame(room.id, game);
      return this.broadcastGames(room.id);
    }
    if (event.type === "game-end") {
      const mayManage = this.canRunGame(room, game, user);
      // Closing an ended board is open to the host, a moderator/admin and any player: an absent host must
      // not be the only person who can clear the room. Ending a running game stays with the host.
      if (game.status === "ended") {
        if (!mayManage && !isPlayer) return this.gameError(socket, "Only the host or a player can clear that game.");
        this.dropGame(room.id, game.id);
      } else {
        if (!mayManage) return this.gameError(socket, "Only the host can end a running game.");
        this.endGame(game, null, "ended");
      }
      return this.broadcastGames(room.id);
    }
  }
  dropGame(roomId, gameId) {
    const games = this.roomGames.get(roomId);
    if (!games) return;
    games.delete(gameId);
    if (!games.size) this.roomGames.delete(roomId);
  }
  usersInRoom(roomId) {
    const ids = new Set();
    for (const socket of this.clientsIn(roomId)) { const id = attachment(socket).userId; if (id) ids.add(id); }
    return ids;
  }
  // A seat is not vacated the moment a socket closes: a reload drops and reopens it in about a second. The
  // player is marked away instead, and the game only resolves once the grace period has passed - otherwise
  // one closed tab would hand the room a finished game nobody asked for.
  markAway(roomId, userId) {
    const games = this.roomGames.get(roomId);
    if (!games || !userId) return;
    const now = Date.now();
    let marked = false;
    for (const game of games.values()) {
      if (!game.players.some(player => player.id === userId)) continue;
      game.away = { ...(game.away || {}), [userId]: now };
      marked = true;
    }
    if (!marked) return;
    this.saveGames();
    this.background(this.state.storage.setAlarm(now + this.awayGraceMs).catch(() => {}));
  }
  clearAway(roomId, userId) {
    const games = this.roomGames.get(roomId);
    if (!games || !userId) return;
    let changed = false;
    for (const game of games.values()) if (game.away && game.away[userId]) { delete game.away[userId]; changed = true; }
    if (changed) this.saveGames();
  }
  // Resolve every player whose grace ran out and who is still not in the room: a running game becomes a
  // win for whoever is left, a lobby game loses the seat, and a lobby game whose host is gone disappears.
  // Runs on the alarm and again at the start of any game event, so an interacting player never sees a
  // game that should have ended already.
  sweepAway(now = Date.now()) {
    const touched = new Set();
    for (const [roomId, games] of [...this.roomGames]) {
      const here = this.usersInRoom(roomId);
      for (const game of [...games.values()]) {
        // No history: a finished board clears itself once its result has had its time. Its last player leaving
        // clears it sooner, on the socket-close path below.
        if (game.status === "ended" && now - (game.endedAt || 0) >= this.endedGameTtlMs) {
          this.dropGame(roomId, game.id);
          touched.add(roomId);
          continue;
        }
        // A chess clock that ran out ends the game even with both players sitting there doing nothing.
        if (this.settleChessClock(game, now)) { touched.add(roomId); continue; }
        // A drawing turn that ran out (or whose drawer never chose) settles here too.
        if (this.settleDrawTurn(game, now)) { touched.add(roomId); continue; }
        let changed = false;
        for (const [userId, since] of Object.entries(game.away || {})) {
          // A seat settled earlier in this loop can have taken the whole game with it (the last player left).
          if (!this.gameIn(roomId, game.id)) break;
          if (here.has(userId)) { delete game.away[userId]; changed = true; continue; }
          if (now - since < this.awayGraceMs) continue;
          delete game.away[userId];
          changed = true;
          const seated = game.players.some(player => player.id === userId);
          game.pending = game.pending.filter(person => person.id !== userId);
          if (!seated) continue;
          if (game.status === "playing") {
            // A game that seats more than two loses the seat and carries on (see playerGone); a two-seat board is
            // over the moment one of them is gone.
            const leftAt = game.players.findIndex(player => player.id === userId);
            game.players = game.players.filter(player => player.id !== userId);
            if (!game.players.length) {
              this.dropGame(roomId, game.id);
              continue;
            }
            this.playerGone(game, userId, leftAt);
          } else if (game.status === "lobby") {
            game.players = game.players.filter(player => player.id !== userId);
            if (!game.players.length) {
              this.dropGame(roomId, game.id);
              continue;
            }
          } else {
            // A finished game keeps its result; the seat is simply no longer held.
            game.players = game.players.filter(player => player.id !== userId);
          }
          // Nobody is left at the board: it clears, so a room cannot accumulate results whose players have
          // all gone (an ended board is furniture only while somebody is still sitting at it).
          if (!game.players.length) {
            this.dropGame(roomId, game.id);
            continue;
          }
          // The host's own seat can be the one that expired: hand the controls to whoever is still here,
          // otherwise the board is stranded with no one who may rematch or clear it.
          if (game.hostId === userId) this.rehostGame(roomId, game, userId);
        }
        if (changed) touched.add(roomId);
      }
    }
    if (touched.size) {
      this.saveGames();
      for (const roomId of touched) {
        this.broadcast(roomId, { type: "game-state", roomId, games: this.gamesIn(roomId).map(game => this.gameView(game)) });
      }
      this.broadcastAll({ type: "games-changed" });
    }
    // Another away seat, or another result, may still be inside its time: wake up for the earliest of them.
    // With nothing pending, the alarm is only cleared when a sweep actually changed something (an alarm call
    // must not turn every game event into a storage write).
    let next = null;
    for (const games of this.roomGames.values()) for (const game of games.values()) {
      for (const since of Object.values(game.away || {})) {
        const at = since + this.awayGraceMs;
        if (at > now && (next === null || at < next)) next = at;
      }
      if (game.status === "ended") {
        const at = (game.endedAt || 0) + this.endedGameTtlMs;
        if (at > now && (next === null || at < next)) next = at;
      }
      // A running chess clock is the other reason to wake up: the alarm is what makes a flag fall on time.
      if (game.kind === "chess" && game.status === "playing" && game.clock && game.clock.ms && game.fen) {
        const moving = game.players[chessTurnColor(game.fen) === "w" ? 0 : 1];
        if (moving) {
          const at = (game.clock.at || now) + (game.clock.ms[moving.id] || 0);
          if (at > now && (next === null || at < next)) next = at;
        }
      }
      // So is a drawing turn: the word choice, the turn itself and the reveal each have a moment to wake for.
      if (game.kind === "draw-guess") {
        const at = this.drawDeadline(game);
        if (at && at > now && (next === null || at < next)) next = at;
      }
    }
    if (next !== null) this.background(this.state.storage.setAlarm(next).catch(() => {}));
    else if (touched.size) this.background(this.state.storage.deleteAlarm().catch(() => {}));
    return touched.size > 0;
  }
  async alarm() { this.sweepAway(); }

  addMessage(roomId, message) {
    const sql = this.state.storage.sql;
    sql.exec("INSERT INTO messages (room_id, id, user_id, username, role, photo, kind, content, created_at, reply_to, reply_username, reply_snippet, reactions, deleted_at, deleted_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'{}',NULL,NULL)", roomId, message.id, message.userId, message.username, message.role, message.photo, message.kind, message.content, message.createdAt, message.reply?.id || null, message.reply?.username || null, message.reply?.snippet || null);
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
    const wasPresent = Boolean(user && room && this.clientsIn(roomId).some(socket => attachment(socket).userId === user.id));
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.serializeAttachment({ userId: user ? user.id : null, roomId, connectionId: crypto.randomUUID() });
    this.state.acceptWebSocket(server);
    if (room && !room.builtIn && room.access === "open" && user && !room.members.includes(user.id)) { room.members.push(user.id); await saveRoom(this.env, room); }
    if (roomId !== "__notify") {
      // Coming back within the grace period reclaims the seat, so a reload never forfeits.
      if (user) this.clearAway(roomId, user.id);
      server.send(JSON.stringify({ type: "history", messages: this.history(roomId), online: this.roomOnlineCount(roomId), users: this.presenceUsers(roomId) }));
      const call = this.roomCalls.get(roomId);
      if (call) server.send(JSON.stringify(this.groupCallState(call)));
      const games = this.gamesIn(roomId);
      if (games.length) server.send(JSON.stringify({ type: "game-state", roomId, games: games.map(game => this.gameView(game)) }));
      this.broadcastPresence(roomId);
    }
    this.broadcastRoomOnline(roomId);
    if (user) this.broadcastUsersChanged();
    if (user && room && !wasPresent) {
      const visitKey = `${room.id}:${user.id}`, now = Date.now(), lastNotice = this.roomVisitNotices.get(visitKey) || 0;
      if (now - lastNotice >= 5 * 60 * 1000) {
        this.roomVisitNotices.set(visitKey, now);
        this.background(pushToRoomSubscribers(this.env, room.id, user.id, { title: `${user.username} entered ${room.name}`, body: `Someone you may want to chat with is now in ${room.name}.`, url: `/room/${room.id}`, tag: `room-visit-${room.id}` }));
      }
    }
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
    // Room-call signaling is relayed inside the room and counted against the call budget, not the
    // message window, so a busy call cannot mute a member's chat.
    if (GROUP_CALL_TYPES.includes(event.type)) { this.groupCallSignal(socket, event, user, now); return; }
    // Games are their own budget for the same reason, and a board click must never count as a chat
    // message - see gameLimited().
    if (GAME_EVENT_TYPES.includes(event.type)) { this.gameEvent(socket, event, user, now); return; }
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
      // A background tab still has a socket, so online presence is not proof that the recipient saw
      // this DM. Always notify their registered devices; the conversation tag collapses repeats.
      this.background(pushToUser(this.env, target.id, { title: `${user.username} sent you a message`, body: kind === "text" ? content.slice(0, 120) : kind === "image" ? "Sent you a photo" : "Sent you a voice note", url: "/dms", tag: `dm-${user.id}` }));
      return;
    }
    if (event.type === "react") {
      const room = this.findRoom(meta.roomId);
      if (!room || (Array.isArray(room.bans) && room.bans.includes(user.id))) return;
      const messageId = clean(event.messageId).slice(0, 64), emoji = clean(event.emoji);
      if (!messageId || !REACTIONS.includes(emoji)) return;
      const row = this.messageRow(meta.roomId, messageId);
      if (!row || row.deleted_at) return;
      const reactions = reactionMap(row.reactions), users = (reactions[emoji] || []).filter(id => id !== user.id), next = reactions[emoji] && reactions[emoji].includes(user.id) ? users : [...(reactions[emoji] || []), user.id].slice(0, REACTION_USERS_MAX);
      if (next.length) reactions[emoji] = next; else delete reactions[emoji];
      this.state.storage.sql.exec("UPDATE messages SET reactions = ? WHERE room_id = ? AND id = ?", JSON.stringify(reactions), meta.roomId, messageId);
      this.broadcast(meta.roomId, { type: "message-reactions", messageId, reactions });
      return;
    }
    if (event.type === "delete-message") {
      const room = this.findRoom(meta.roomId);
      if (!room) return;
      const messageId = clean(event.messageId).slice(0, 64);
      if (!messageId) return;
      const row = this.messageRow(meta.roomId, messageId);
      if (!row || row.deleted_at) return;
      // Your own message, or somebody who moderates this room. Soft delete: the row stays so the
      // reply quotes pointing at it keep resolving, but no content survives.
      if (row.user_id !== user.id && !this.canModerate(room, user)) return;
      this.state.storage.sql.exec("UPDATE messages SET deleted_at = ?, deleted_by = ?, content = '', reactions = '{}' WHERE room_id = ? AND id = ?", Date.now(), user.id, meta.roomId, messageId);
      this.broadcast(meta.roomId, { type: "message-deleted", messageId, by: { id: user.id, username: user.username, role: user.role || "user" } });
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
    // A guess in a live Draw & Guess turn is checked before it can reach the transcript: the word must never
    // appear in the room, not even inside the message that got it right. Any sentence containing the word
    // counts, and that whole message becomes the highlighted "guessed the word" line instead of being posted.
    if (kind === "text") {
      const drawing = this.gamesIn(meta.roomId).find(game => game.kind === "draw-guess" && game.status === "playing" && game.round?.word && !game.round.revealed);
      if (drawing && drawGuessMatches(content, drawing.round.word)) {
        // The drawer typing the answer would spoil the round for everybody, so it is refused rather than posted.
        if (user.id === drawing.round.drawerId) { this.gameError(socket, "You cannot say the word while you are drawing."); return; }
        this.drawCorrectGuess(room, drawing, user, now);
        return;
      }
    }
    const message = { id: crypto.randomUUID(), userId: user.id, username: user.username, role: user.role || "user", photo: user.profile?.photo || null, kind, content, createdAt: Date.now(), reply: this.replyContext(meta.roomId, event.replyTo) };
    if (this.dailyLimited("message", user.id, this.messageDailyCap)) return;
    this.addMessage(meta.roomId, message);
    this.broadcast(meta.roomId, { type: "message", message });
    this.broadcastRoomPreview(room, message);
  }

  async webSocketClose(socket) {
    const meta = attachment(socket);
    if (meta.connectionId) this.messageWindows.delete(meta.connectionId);
    if (meta.connectionId) this.callWindows.delete(meta.connectionId);
    if (meta.connectionId) this.gameWindows.delete(meta.connectionId);
    if (meta.connectionId) this.gameWindows.delete(`${meta.connectionId}:draw`);
    try { socket.close(1000, "closed"); } catch {}
    if (meta.roomId && meta.roomId !== "__notify") {
      // The call only loses this member when their last socket in the room goes; a second tab in the
      // same room keeps them in the mesh.
      const stillHere = this.sockets().some(other => other !== socket && attachment(other).roomId === meta.roomId && attachment(other).userId === meta.userId);
      if (!stillHere && meta.userId) this.leaveRoomCall(meta.roomId, meta.userId);
      // A spectator who closes the tab stops being a spectator; a player stays in the seat so they can
      // reload and carry on.
      if (meta.userId && !stillHere) {
        const games = this.gamesIn(meta.roomId);
        if (games.length) {
          for (const game of games) game.guests = game.guests.filter(person => person.id !== meta.userId);
          this.broadcastGames(meta.roomId, false);
          // The seat stays for the grace period: closing a tab must not forfeit a game, and a player who
          // never comes back must not strand the room either.
          this.markAway(meta.roomId, meta.userId);
        }
      }
      this.broadcastPresence(meta.roomId);
      this.broadcastRoomOnline(meta.roomId);
    }
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
    if (path === "/api/auth/me") {
      const user = await this.sessionUser(request);
      if (!user) return json(401, { error: "Not signed in" });
      // A browser that remembers its token but lost the session cookie gets the cookie back here, so the next
      // page load is rendered already signed in instead of painting the login shell before the client asks.
      const token = bearerToken(request) || parseCookies(request.headers.get("Cookie") || "").nearby_session || "";
      return json(200, { user: publicUser(user) }, token ? { "Set-Cookie": sessionCookie(token, Math.floor(30 * 24 * 60 * 60), isSecure(request)) } : {});
    }

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
          this.roomCalls.delete(room.id);
          this.roomGames.delete(room.id);
          await deleteRoom(this.env, room.id);
          await removeRoomSubscriptions(this.env, { roomId: room.id });
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
        await removeRoomSubscriptions(this.env, { userId: target.id });
        await this.env.DB.batch([
          this.env.DB.prepare("DELETE FROM push_subscriptions WHERE user_id = ?").bind(target.id)
        ]);
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

    // ---- account details: what the account is, and the one warning that matters (the key is everything).
    if (path === "/api/account/safety" && request.method === "GET") {
      const user = await this.sessionUser(request);
      if (!user) return json(401, { error: "Sign in first." });
      return json(200, { account: { id: user.id, username: user.username, displayName: (user.profile && user.profile.displayName) || user.username, age: user.age, role: user.role || "user", createdAt: user.createdAt || null } });
    }

    // ---- the room-list notice board: one editable row, read by everybody, written by the admin.
    if (path === "/api/notice" && request.method === "GET") {
      const row = await this.env.DB.prepare("SELECT message, visible, updated_at FROM site_notice WHERE id = 'current' LIMIT 1").first();
      const visible = Boolean(row && row.visible);
      return json(200, { notice: { visible, message: visible && row ? row.message : "", updatedAt: row ? row.updated_at : null } });
    }

    if (path === "/api/notice" && request.method === "POST") {
      if (!sameOrigin(request)) return json(403, { error: "Request origin was rejected." });
      const user = await this.sessionUser(request);
      if (!user) return json(401, { error: "Sign in first." });
      if ((user.role || "user") !== "admin") return json(403, { error: "Only the admin can edit the notice board." });
      try {
        const body = await readJson(request), message = clean(body.message).slice(0, 600), visible = body.visible === true;
        if (visible && !message) throw new Error("Write the notice before showing it.");
        const updatedAt = new Date().toISOString();
        await this.env.DB.prepare("INSERT INTO site_notice (id, message, visible, updated_at, updated_by) VALUES ('current', ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET message = excluded.message, visible = excluded.visible, updated_at = excluded.updated_at, updated_by = excluded.updated_by").bind(message, visible ? 1 : 0, updatedAt, user.username).run();
        const notice = { visible, message: visible ? message : "", updatedAt };
        this.broadcastAll({ type: "notice-changed", notice });
        return json(200, { notice });
      } catch (error) { return json(400, { error: error.message }); }
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

    // Every live game, for the room list's games card. Only games in rooms this account may enter: a
    // private room's game must not be visible from outside the room, by owner decision.
    if (path === "/api/games" && request.method === "GET") {
      const user = await this.sessionUser(request);
      if (!user) return json(401, { error: "Sign in first." });
      const games = [];
      for (const [roomId, bucket] of this.roomGames) {
        const room = this.findRoom(roomId);
        if (!room || !this.canEnter(room, user)) continue;
        for (const game of bucket.values()) {
          // A finished board is a result in its own room, not something to discover and watch from outside.
          if (game.status === "ended") continue;
          const kind = GAME_KINDS[game.kind] || { name: game.kind, seats: 2 };
          const host = this.userById(game.hostId);
          games.push({ id: game.id, kind: game.kind, name: kind.name, roomId: room.id, roomName: room.name, roomIcon: room.icon, hostId: game.hostId, hostUsername: host ? host.username : "Host", policy: game.policy, status: game.status, seats: kind.seats, players: game.players.length, spectators: game.guests.length, createdAt: game.createdAt });
        }
      }
      games.sort((left, right) => right.createdAt - left.createdAt);
      return json(200, { games });
    }

    if (path.startsWith("/api/rooms")) return this.apiRooms(request, url, path);

    return json(404, { error: "Not found." });
  }

  async apiRooms(request, url, path) {
    const user = await this.sessionUser(request);
    if (!user && path === "/api/rooms" && request.method === "GET") return json(200, { rooms: this.roomsView(null) });
    if (!user) return json(401, { error: "Sign in first." });
    if (request.method !== "GET" && !sameOrigin(request)) return json(403, { error: "Request origin was rejected." });
    if (path === "/api/rooms" && request.method === "GET") return json(200, { rooms: this.roomsView(user) });

    const subscriptionMatch = path.match(/^\/api\/rooms\/([^/]+)\/subscription$/);
    if (subscriptionMatch) {
      const room = this.findRoom(subscriptionMatch[1]);
      if (!room) return json(404, { error: "Room not found." });
      if (!this.canEnter(room, user)) return json(403, { error: "Join this room before subscribing." });
      if (request.method === "GET") return json(200, { subscribed: await roomSubscription(this.env, user.id, room.id) });
      if (request.method === "POST") {
        const body = await readJson(request).catch(() => ({})), subscribed = body.subscribed === true;
        await setRoomSubscription(this.env, user.id, room.id, subscribed);
        return json(200, { subscribed });
      }
      return json(405, { error: "Method not allowed." });
    }

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
      this.roomCalls.delete(room.id);
      this.roomGames.delete(room.id);
      await deleteRoom(this.env, room.id);
      await removeRoomSubscriptions(this.env, { roomId: room.id });
      this.broadcastAll({ type: "room-deleted", roomId: room.id });
      this.broadcastAll({ type: "rooms-changed" });
      return json(200, { ok: true });
    }

    return json(404, { error: "Room action not found." });
  }
}
