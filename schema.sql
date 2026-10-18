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

-- Web Push subscriptions, one row per browser/device endpoint. A user can have several (phone +
-- laptop), and an endpoint is unique per browser profile, so the endpoint is the natural key for
-- "unsubscribe this device" - the same browser re-subscribing replaces its row rather than piling up.
-- p256dh/auth are the subscription's public key and auth secret, needed to encrypt each payload.
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions (user_id);

-- A room subscription belongs to an account, while push_subscriptions above belongs to each
-- browser/device. Joining the two lets a single room visit reach every registered device without
-- duplicating the user's room preference per device.
CREATE TABLE IF NOT EXISTS room_subscriptions (
  user_id TEXT NOT NULL,
  room_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, room_id)
);
CREATE INDEX IF NOT EXISTS room_subscriptions_room ON room_subscriptions (room_id);
