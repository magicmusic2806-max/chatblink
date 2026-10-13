const fs = require("fs");
const path = require("path");

const DATA_DIR = process.env.NEARBY_DATA_DIR || "data";
const USER_COLUMNS = ["id", "username", "username_lower", "age", "role", "key_hash", "token_version", "profile", "dm_granted", "dm_requests", "adult_confirmed_at", "created_at"];
const ROOM_COLUMNS = ["id", "name", "icon", "vibe", "accent", "soft", "access", "built_in", "owner_id", "members", "requests", "bans", "created_at"];
const UPLOAD_TYPES = { jpg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", webm: "audio/webm", mp4: "audio/mp4", m4a: "audio/mp4", ogg: "audio/ogg" };

const userRow = user => [user.id, user.username, user.usernameLower, user.age ?? null, user.role || "user", user.keyHash || null, Number(user.tokenVersion) || 0, JSON.stringify(user.profile || {}), JSON.stringify(user.dmMediaGranted || []), JSON.stringify(user.dmMediaRequests || []), user.adultConfirmedAt || null, user.createdAt || new Date().toISOString()];
const roomRow = room => [room.id, room.name, room.icon || null, room.vibe || null, room.accent || null, room.soft || null, room.access || "open", room.builtIn ? 1 : 0, room.ownerId || null, JSON.stringify(room.members || []), JSON.stringify(room.requests || []), JSON.stringify(room.bans || []), room.createdAt || new Date().toISOString()];
const quote = value => value === null || value === undefined ? "NULL" : typeof value === "number" ? String(value) : `'${String(value).replace(/'/g, "''")}'`;
const insert = (table, columns, rows) => rows.map(values => `INSERT OR REPLACE INTO ${table} (${columns.join(", ")}) VALUES (${values.map(quote).join(", ")});`).join("\n");

function readLocal() {
  const read = (file, key) => { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), "utf8"))[key] || []; } catch { return []; } };
  return { users: read("users.json", "users"), rooms: read("chatrooms.json", "rooms") };
}

async function pull(url, token) {
  const response = await fetch(`${url.replace(/\/$/, "")}/api/export?token=${encodeURIComponent(token)}`);
  if (!response.ok) throw new Error(`Export failed (${response.status}). Is MIGRATE_TOKEN set on the old host?`);
  const { files } = await response.json();
  let restored = 0;
  for (const file of files) {
    const target = path.resolve(DATA_DIR, file.path);
    if (!target.startsWith(path.resolve(DATA_DIR))) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(file.data, "base64"));
    restored++;
  }
  console.log(`Pulled ${restored} files from ${url} into ${DATA_DIR}`);
}

async function push(url, token, payload) {
  const response = await fetch(`${url.replace(/\/$/, "")}/api/migrate?token=${encodeURIComponent(token)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  console.log(`HTTP ${response.status}`, await response.text());
}

function uploadScript() {
  const directory = path.join(DATA_DIR, "uploads");
  if (!fs.existsSync(directory)) return "echo no uploads to copy";
  return fs.readdirSync(directory).map(name => {
    const type = UPLOAD_TYPES[name.split(".").pop()] || "application/octet-stream";
    return `npx wrangler@latest r2 object put "chatblink-uploads/${name}" --file "${path.join(directory, name)}" --content-type ${type} --remote`;
  }).join("\n");
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  const { users, rooms } = readLocal();
  if (command === "pull") return pull(args[0], args[1]);
  if (command === "push") return push(args[0], args[1], { users, rooms: rooms.length ? rooms : [] });
  if (command === "payload") return console.log(JSON.stringify({ users, rooms }));
  if (command === "uploads") return console.log(uploadScript());
  if (command === "sql") {
    const statements = [insert("users", USER_COLUMNS, users.map(userRow)), insert("rooms", ROOM_COLUMNS, rooms.map(roomRow))].filter(Boolean).join("\n");
    fs.mkdirSync("migration", { recursive: true });
    fs.writeFileSync("migration/seed.sql", statements + "\n");
    console.log(`Wrote migration/seed.sql (${users.length} users, ${rooms.length} rooms)`);
    console.log("Apply locally:  npx wrangler d1 execute chatblink --local  --file=migration/seed.sql");
    console.log("Apply remotely: npx wrangler d1 execute chatblink --remote --file=migration/seed.sql");
    return;
  }
  console.log("Usage:\n  node tools/migrate.js pull  <oldUrl> <token>   # copy data/ off the old host\n  node tools/migrate.js sql                      # -> migration/seed.sql for D1\n  node tools/migrate.js push  <newUrl> <token>   # POST /api/migrate\n  node tools/migrate.js uploads                  # print the R2 copy commands");
}

main().catch(error => { console.error(error.message); process.exit(1); });
