import { jsonColumn, parseColumn } from "./core.js";

export const USER_COLUMNS = "id, username, username_lower, age, role, key_hash, token_version, profile, dm_granted, dm_requests, adult_confirmed_at, created_at";
export const USER_UPSERT = `INSERT INTO users (${USER_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET username=excluded.username, username_lower=excluded.username_lower, age=excluded.age, role=excluded.role, key_hash=excluded.key_hash, token_version=excluded.token_version, profile=excluded.profile, dm_granted=excluded.dm_granted, dm_requests=excluded.dm_requests, adult_confirmed_at=excluded.adult_confirmed_at, created_at=excluded.created_at`;
export const ROOM_COLUMNS = "id, name, icon, vibe, accent, soft, access, built_in, owner_id, members, requests, bans, created_at";
export const ROOM_UPSERT = `INSERT INTO rooms (${ROOM_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
ON CONFLICT(id) DO UPDATE SET name=excluded.name, icon=excluded.icon, vibe=excluded.vibe, accent=excluded.accent, soft=excluded.soft, access=excluded.access, built_in=excluded.built_in, owner_id=excluded.owner_id, members=excluded.members, requests=excluded.requests, bans=excluded.bans, created_at=excluded.created_at`;

export function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id, username: row.username, usernameLower: row.username_lower, age: row.age, role: row.role || "user",
    keyHash: row.key_hash, tokenVersion: Number(row.token_version) || 0,
    profile: parseColumn(row.profile, null) || { displayName: row.username, avatar: "✨", bio: "", gender: "", interests: [], photo: null, photos: [] },
    dmMediaGranted: parseColumn(row.dm_granted), dmMediaRequests: parseColumn(row.dm_requests),
    adultConfirmedAt: row.adult_confirmed_at, createdAt: row.created_at, profileComplete: true
  };
}
export function userToRow(user) {
  return [user.id, user.username, user.usernameLower, user.age ?? null, user.role || "user", user.keyHash || null, Number(user.tokenVersion) || 0, JSON.stringify(user.profile || {}), jsonColumn(user.dmMediaGranted), jsonColumn(user.dmMediaRequests), user.adultConfirmedAt || null, user.createdAt || new Date().toISOString()];
}
export function rowToRoom(row) {
  if (!row) return null;
  return {
    id: row.id, name: row.name, icon: row.icon, vibe: row.vibe, accent: row.accent, soft: row.soft,
    access: row.access === "request" ? "request" : "open", builtIn: Boolean(row.built_in), ownerId: row.owner_id,
    members: parseColumn(row.members), requests: parseColumn(row.requests), bans: parseColumn(row.bans),
    emojis: null, stickers: null, gifs: null, createdAt: row.created_at
  };
}
export function roomToRow(room) {
  return [room.id, room.name, room.icon, room.vibe, room.accent, room.soft, room.access, room.builtIn ? 1 : 0, room.ownerId || null, jsonColumn(room.members), jsonColumn(room.requests), jsonColumn(room.bans), room.createdAt || new Date().toISOString()];
}

export async function loadUsers(env) {
  const result = await env.DB.prepare(`SELECT ${USER_COLUMNS} FROM users`).all();
  return (result.results || []).map(rowToUser);
}
export async function loadRooms(env) {
  const result = await env.DB.prepare(`SELECT ${ROOM_COLUMNS} FROM rooms`).all();
  return (result.results || []).map(rowToRoom);
}
export async function saveUser(env, user) { await env.DB.prepare(USER_UPSERT).bind(...userToRow(user)).run(); }
export async function saveUsers(env, users) { if (!users.length) return; await env.DB.batch(users.map(user => env.DB.prepare(USER_UPSERT).bind(...userToRow(user)))); }
export async function deleteUser(env, id) { await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(id).run(); }
export async function saveRoom(env, room) { await env.DB.prepare(ROOM_UPSERT).bind(...roomToRow(room)).run(); }
export async function deleteRoom(env, id) { await env.DB.prepare("DELETE FROM rooms WHERE id = ?").bind(id).run(); }
