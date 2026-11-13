// The D1 schema, mirroring schema.sql statement for statement (tests/schema-parity.js fails if the
// two drift apart). It lives here as well as in the .sql file because the Worker applies it itself
// now: production drifted once - tables a read path touched were never created because `db:remote`
// was a manual step - and a missing table must not be able to break an unrelated page again.
export const D1_SCHEMA_VERSION = 1;

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
  "CREATE INDEX IF NOT EXISTS room_subscriptions_room ON room_subscriptions (room_id)",
  `CREATE TABLE IF NOT EXISTS email_credentials (
    user_id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    email_lower TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    verified_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS pending_email_signups (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    username_lower TEXT NOT NULL UNIQUE,
    age INTEGER NOT NULL,
    email TEXT NOT NULL,
    email_lower TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    adult_confirmed_at TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS pending_email_signups_expires ON pending_email_signups (expires_at)",
  `CREATE TABLE IF NOT EXISTS pending_email_links (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    email_lower TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS pending_email_links_expires ON pending_email_links (expires_at)",
  `CREATE TABLE IF NOT EXISTS auth_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS auth_tokens_user_kind ON auth_tokens (user_id, kind)",
  "CREATE INDEX IF NOT EXISTS auth_tokens_expires ON auth_tokens (expires_at)"
];
