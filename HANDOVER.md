# Chatblink handover

Updated 2026-11-14. Live at <https://chatblink.chat>, deployed from `main` by
`.github/workflows/deploy.yml` (`npm ci` → canonical-host suite → `wrangler deploy`).
Current client bundle: `multi-room.js?v=81`. D1 schema version: 4
(`worker/lib/schema.js`, applied by the Durable Object itself).

## What the site is now

- Cloudflare Worker (`worker/index.js`) routing pages, assets, `/uploads/*` and `/api/*` to one
  Durable Object, `ChatHub` (`worker/hub.js`), which holds all live state: users, rooms, presence,
  DMs, room calls, rate limits. Room history lives in the object's SQLite (latest 100 per room).
- D1 holds accounts (`users`), rooms, push devices, room-alert subscriptions and the room-list
  notice (`site_notice`).
- Uploads (photos, voice notes) live in the KV binding `UPLOADS` (R2 stays commented out in
  `wrangler.jsonc`) and are served with `Range`, `ETag` and `206`.
- Production D1 currently holds 41 accounts and the admin account `Dynamic`.

## Accounts and sign-in

- **Profile key only, and that is the whole of it.** Signup (username + age + 18+ confirm) returns a
  `CHATBLINK-…` key once on the setup screen; the server stores only its SHA-256 hash. Logging in is
  that key, in the login pane. There is no email, no password, no recovery address and no second door
  — the key is the account.
- **Menu → Account details** (`#safetyModal`, `/api/account/safety`) shows the signed-in account's
  own facts — username, display name, age, role, member since — plus one sentence: the profile key is
  the only way in and there is no way back without it. The route keeps its old `safety` name and ids;
  the panel no longer offers anything to add or remove.
- Worker secrets listed in production: `AUTH_SECRET`, `VAPID_PRIVATE_KEY`. No mail provider key —
  email auth was removed (commit `d2ccab6`, dead code deleted in `b52084d`).

## Passkeys were removed on purpose (`v=77`)

Do not re-add them without reading this. Passkeys (WebAuthn fingerprint/face/screen-lock sign-in)
shipped in `aa01d31`/`325481c`/`cc4a5c1`, were debugged to the root cause in `v=75`, and were then
deleted at the owner's request because they did not deliver the thing they were wanted for.

**What went wrong, in order.**

1. "Add this device" failed on an Android phone with `NotReadableError`. `public/passkey-check.html`
   (a diagnostic page, itself now deleted) bisected it: that platform provider refuses **any**
   `create()` that asks for a resident (discoverable) credential, even when `residentKey` is only
   `"preferred"`. Dropping that one field made the same call succeed behind a fingerprint prompt.
2. `v=75` fixed the ceremony for that case: fall back without `residentKey` and let sign-in name the
   device-bound credential id. That bought a working fingerprint door — but only on the device that
   enrolled it, which is inherent: a biometric never leaves the device, so the passkey only travels if
   the device's key provider stores a discoverable credential and syncs it (Google Password Manager,
   iCloud Keychain, a Windows account).
3. The owner's requirement was fingerprint sign-in **from any device or browser**, without the
   profile key. A device-bound passkey cannot do that, and the phone in question cannot store a
   synced one at all. With that established, the profile key alone is the simpler, honest product.

**What was deleted, so nobody hunts for it:** `worker/lib/webauthn.js` (CBOR/COSE, ES256 verification),
the `/api/auth/passkey/options|register|verify` and `/api/account/passkeys/remove` routes, the signed
`nearby_passkey` challenge cookie, `jsonCookies`, the `passkey-credentials` rate-limit keys, the
`x-cb-origin` header the DO used to learn the real browser origin, the whole client passkey block
(`signInWithPasskey`, `addPasskey`, the prefetched-challenge machinery, the refusal-text helpers, the
localStorage credential list), the fingerprint button and divider in the login pane, the passkey CSS,
`public/passkey-check.html`, and `tests/passkey-e2e.js`.

**What is left behind on purpose:** schema version 4 does `DROP TABLE IF EXISTS passkey_credentials`
(both `schema.sql` and `worker/lib/schema.js`, which `tests/schema-parity.js` keeps identical), so
production stops carrying dead credential rows; the client drops `chatblink.passkeys` and
`chatblink.passkeyNoResident` only when the browser clears site data, which is harmless. The
`/passkey-check` URL is gone with the file.

## Features shipped in this round

| Area | What it does | Main files | Commit |
|---|---|---|---|
| Message actions | Reply with a quote snapshot, six fixed reactions, soft delete by author/creator/mod/admin; actions appear on tap, on their own row under the bubble | `public/multi-room.js`, `worker/hub.js` | `118bf53`, `5a04630` |
| Voice notes | Mono Opus 96 kbps with a 1 s timeslice, one session object, mic release, 2-minute cap, 60 s upload timeout; WebM duration shim | `public/multi-room.js` | `118bf53` |
| Uploads | `Range`/`ETag`/`206` so players can seek without refetching | `worker/index.js` | `118bf53` |
| Private room cards | No preview window at all for request-only rooms; card collapses to a compact row | `public/multi-room.js`, `public/multi-room.css` | `71b5984` |
| Room calls | Peer-to-peer audio mesh (≤6), join/leave/end, host-only **End call**, dock with members/mute | `worker/hub.js`, `public/multi-room.js` | `71b5984`, `37f32ce` |
| D1 self-migration | The DO applies `schema.sql` from `worker/lib/schema.js` once per version; this fixed production 500s on every profile | `worker/lib/schema.js`, `worker/hub.js` | `8e821c1` |
| Profile-key only | Email signup/login/reset, the mail module, the badge, the tables and the dangling scripts are gone | many | `d2ccab6`, `b52084d` |
| Notice board | One admin-written announcement above the room list with a show/hide toggle, pushed live | `worker/hub.js`, `public/multi-room.js` | `aa01d31` |
| Passkeys removed | WebAuthn sign-in, its Worker routes, its verification module and its schema table are gone; sign-in is the key | many | `8095c45` then the removal commit |
| Games | Room games: up to four running per room, a count on the room's Games button, a Games entry in the room list, and three server-validated kinds (Connect Four, Tic-tac-toe, Reversi) with open/by-request seats, host approval, spectators, rematch from either player and a host role that moves to whoever is left | `worker/hub.js`, `public/multi-room.js`, `public/multi-room.css`, `tests/games.js`, `tests/games-ui.js` | `56a61c9`, `004e415`, this round `v=82` |

## Verification

- `npm run test:all` (`tests/run-all.js`) starts one `wrangler dev` per suite group and prints a
  summary. At `v=77` (passkeys removed): **13 groups green** — canonical, schema, smoke, retention,
  push-gate, theme, quotas, actions, room-actions, voice-note, group-call, group-call-e2e, notice.
  The passkey suite is deleted with the feature, so there is no longer a localhost-only rpId rule to
  remember. At `v=78`: **14 groups green**, the new one being `tests/games.js`. At `v=82` that suite is
  **58 checks**: three games, multi-game rooms, the cap counting only games still running, one seat per
  person, open and by-request seats, approve/deny authority, out-of-turn and spectator refusals, an
  occupied square, an impossible column, a Reversi move that flips nothing, the legal moves the object
  reports for each turn, a full game of each kind to its ending, a rematch from the host and again from
  the other player (the opening seat alternating), restarting a live board refused to the non-host,
  clearing a finished board as the non-host player, a full room still taking a new game once a finished
  board frees its slot, finished boards pruned to two, and an abandoned host resolving to the player who
  stayed — who wins, is handed the host role (`game-host`), can start another game and can replay the
  board without the absent seat (run with `AWAY_GRACE_MS=1500`). There are also the room-list feed (only
  running games) and the private-room rule, and that a burst of game events does not spend the chat
  message window. The alarm path was checked separately: a host's socket was killed and, with nothing
  sent from the other side, the object pushed the forfeited result on its own.
- The profile-key door was also driven at 390 px in Chromium: signup hands over a key, the key signs
  in, `Menu → Account details` shows the account with no passkey row and no buttons, the login pane
  has no fingerprint control, `/api/auth/passkey/options` and `/api/account/passkeys/remove` answer
  404, and `/api/account/safety` returns `{account}` only.
- The games dock was driven at 390 px with four signed-in contexts, which caught two things worth
  remembering: the dark `.cf-cell` rule outranked `.cf-cell.p1` (discs were invisible until the disc
  colours got dark-theme rules), and `.room-card` used to select "the first room" in the push-gate
  suite — the Games card now sits first in the grid, so that suite selects `.room-card[data-room-id]`.
- Writing suites against accounts: `/api/auth/logout` bumps the account's `tokenVersion`, so one
  context signing out ends every other session for that account. A second context must run last, or
  be dropped by clearing cookies rather than by logging out — a session that dies mid-suite shows up
  as `"Sign in first."` from `/api/account/safety`.
- Notable suites: `tests/notice-board.js` (public read, admin write, live event; the admin half SKIPs
  when the one-shot `dynamic` account already exists), `tests/group-call.js` + `group-call-e2e.js`,
  `tests/voice-note-e2e.js` (records a generated tone and measures it), `tests/schema-parity.js`
  (keeps `schema.sql` and `worker/lib/schema.js` identical).
- `npm run test:prod` (`tests/prod-check.js`) is the read-only post-deploy check; it currently passes.

## Environment notes for whoever picks this up

- Uploads in production are in KV, not R2 — the R2 binding and payment method are still off.
- Inspect production with `npx wrangler d1 execute chatblink --remote --command "…"`. `npm run
  db:remote` still exists and is harmless; the Worker applies the schema itself.
- On this Windows box, `command_stop` on a `npx wrangler dev | tail` pipeline leaves the
  wrangler/workerd trees alive and they stack on the port; start `node
  node_modules/wrangler/bin/wrangler.js dev --port N` and kill with `taskkill /PID <pid> /T /F`.
- PowerShell 5.1 rejects `&&` in a command line; use `shell:"cmd"` or `;`.

## Known gaps (not started, not regressions)

- **No TURN relay.** Room calls and DM calls use public STUN only, so restrictive mobile/corporate
  NATs can fail to connect. Audio-only, mesh capped at 6.
- **Guest view.** After logout the room list stays on screen behind the auth shell (the pre-existing
  "guest browsing" path). Observed but deliberately untouched.
- Admin-only paths in `tests/notice-board.js` and `tests/message-actions.js` skip on a database that
  already contains the auto-promoted `dynamic` admin; both were verified once on a fresh
  `--persist-to` state directory.
- The retired prototype files (`server.js`, `server-clean.js`, `public/app*.js`, `location*`, …) are
  still in the tree, unused. `AUTH_SETUP.md`, the email/password prototype and the four email tables
  are gone.
- **Games:** three games are live (`v=82`): Connect Four, Tic-tac-toe and Reversi. A room runs up to
  four at once (a finished board does not hold a slot, and only the newest two results are kept), one
  seat per person per room, and the 🎲 Games button counts the games still running in that room. The
  room list begins with a Games card whose badge is the live total. Games are hidden until that button or
  card is opened, seats are open or by request, the host (or a mod/admin) approves, and every move is
  validated in the Durable Object, which also reports the legal moves so the dock can mark them. A
  finished board can be rematched by either player or cleared by either of them; the host role moves to
  whoever is left when a host leaves, and a closed tab only forfeits after `AWAY_GRACE_MS` via a DO
  alarm, so an absent host cannot strand a room. `GAMES.md` is the spec plus the as-built notes; Draw &
  Guess is next on the same dock.
