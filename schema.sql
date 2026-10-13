CREATE TABLE IF NOT EXISTS users (
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
);
CREATE TABLE IF NOT EXISTS rooms (
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
);
CREATE INDEX IF NOT EXISTS rooms_owner ON rooms (owner_id);
CREATE INDEX IF NOT EXISTS users_created ON users (created_at);
