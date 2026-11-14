// The D1 schema, mirroring schema.sql statement for statement (tests/schema-parity.js fails if the
// two drift apart). It lives here as well as in the .sql file because the Worker applies it itself:
// production drifted once - tables a read path touched were never created because `db:remote` was a
// manual step - and a missing table must not be able to break an unrelated page again.
//
// The account system is profile-key only. The email/password tables that earlier versions created
// (email_credentials, pending_email_signups, pending_email_links, auth_tokens) are no longer part of
// the schema; where they already exist they are simply unused and can be dropped by hand.
export const D1_SCHEMA_VERSION = 2;

export const D1_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    username_lower TEXT NOT NULL UNIQUE,
    age INTEGER,
    role TEXT NOT NULL DEFAULT 'user',
    key_hash TEXT,
    token_version INTEGER NOT NULL DEFAULT 0,
    profile TEXT NOT NULL DEFAULT '{}',
    dm_granted TEXT NOT NULL DEFAULT '[]',
    dm_requests TEXT NOT NULL DEFAULT '[]',
    adult_confirmed_at TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT,
    vibe TEXT,
    accent TEXT,
    soft TEXT,
    access TEXT NOT NULL DEFAULT 'open',
    built_in INTEGER NOT NULL DEFAULT 0,
    owner_id TEXT,
    members TEXT NOT NULL DEFAULT '[]',
    requests TEXT NOT NULL DEFAULT '[]',
    bans TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS rooms_owner ON rooms (owner_id)",
  "CREATE INDEX IF NOT EXISTS users_created ON users (created_at)",
  `CREATE TABLE IF NOT EXISTS push_subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    endpoint TEXT NOT NULL UNIQUE,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions (user_id)",
  `CREATE TABLE IF NOT EXISTS room_subscriptions (
    user_id TEXT NOT NULL,
    room_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, room_id)
  )`,
  "CREATE INDEX IF NOT EXISTS room_subscriptions_room ON room_subscriptions (room_id)"
];
