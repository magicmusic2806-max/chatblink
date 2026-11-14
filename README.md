# Chatblink

An 18+ real-time chat site: people pick a name and drop into topic rooms (open or request-only), exchange private messages, photos and voice notes, make peer-to-peer voice/video calls, and browse each other's profiles through an Explore page.

Live at **https://chatblink.chat** (deployed from this repo to **Cloudflare Workers** — see [DEPLOY.md](DEPLOY.md)).

```powershell
npm install
npm start
```

Then open `http://localhost:3100` (override with the `PORT` environment variable). No build step, no framework, no database required to run locally.

---

## Architecture

- **Backend (current):** a Cloudflare Worker in `worker/` — `index.js` routes pages, assets, `/auth/*` form posts, `/uploads/*` (R2) and `/api/*`; `hub.js` is a single `ChatHub` **Durable Object** holding users, rooms, chat history, presence, DMs, bans and rate limits (WebSockets via the hibernation API).
- **Backend (legacy):** `server-multi-room.js` — the original single long-running Node process (plain `http` + `ws`). Still runnable locally with `npm start` for reference/parity checks, and still what Render serves until the cutover completes.
- **Frontend:** one SPA in `public/` — `rooms.html` (shell + all views), `multi-room.js` (all client logic), `multi-room.css` (mobile-first styles), `profile-key.css` (setup/key screens). Vanilla JS, History-API routing (`/rooms`, `/room/<id>`, `/dms`, `/explore`, `/profile/<username>`), views are `<section>`s toggled via the `hidden` attribute.
- **Storage layers (important):**
  - **D1** (`schema.sql`): accounts (`users`), rooms (`rooms`), Web Push devices, room-alert subscriptions and the room-list notice (`site_notice`). Survives restarts and deploys, unlike the old JSON files.
  - **Durable Object SQLite**: room message history (latest 100/room). **This survives restarts — the old build lost history on every deploy.**
  - **Memory** (reset on restart, inside the Durable Object): sessions, rate-limit counters, presence. DM threads live in each browser's memory only.
  - **R2** (`chatblink-uploads`): uploaded photos and voice notes, served from `/uploads/<name>`.
  - **Firestore: no longer used.** It was only ever a server-side projection of profiles for Explore; `/api/explore` and `/api/profiles/:username` now read D1, and the browser client never touched it.

## Features

- **Entry:** profile key only. Pick a username and an age; the account is handed a `CHATBLINK-…` key exactly once, on the setup screen (copy it, download it, or read it later from the menu). Logging in is that key: no email, no password, no recovery address, so the key is the account. The server stores only its SHA-256 hash.
- **Signing in:** the profile key, and only the profile key. Passkeys (fingerprint/face/screen-lock WebAuthn) were tried and removed: a passkey only lives on the device that enrolled it unless the device's key provider syncs it, so it was never the "fingerprint from anywhere" door it looked like, and on some Android phones the provider refuses to store one at all. `Menu → Account details` shows the account's facts and repeats the warning that the key is the only way in.
- **Notice board:** a single announcement at the top of the room list, written and shown/hidden by the admin from an Edit control on the board itself. It is public to read, reaches open tabs live over the socket, and never leaks a hidden draft's text.
- **Rooms:** built-ins ship in code; user-created rooms (open or request-only) persist to `data/chatrooms.json`. Room cards show the latest three messages as a live preview, while locked-room content remains private. Every room is its own page. Creators can delete their rooms; the admin can delete any.
- **Media & calls:** every room has preset emojis, sticker phrases, and 12 animated GIFs from `public/gifs/`. Request-only **user-created** rooms additionally unlock image messages (up to 4 at once) and voice notes. A single DM media approval grants photo/voice sending in both directions and remains revocable. Signed-in users can start peer-to-peer voice or video calls from a DM; the server carries signaling only, while encrypted media flows through WebRTC.
- **Games:** every room can host a game, and nothing is visible until someone opens it — the **🎲 Games** button in the room's tool row opens that room's dock, and a **Games in rooms** card on the room list shows every live game with Watch / Join / Request. Seats are **open** (anyone may take one) or **by request** (the host approves from the dock; moderators and the admin can cover). Watching needs no seat. Connect Four is the first game: the Durable Object owns the board, validates every move and turn, and endings are four-in-a-row, a draw, or a forfeit when a player leaves. Game traffic has its own rate limit and never counts against the chat message budget. See `GAMES.md` for the rules, the licence checks and what is queued next (Draw & Guess).
- **Presence & social:** live online counts per room, online green dots on avatars, online-users list with profile view / DM / message-hiding per person (per browser), username colors derived from name length, Explore page (search + profile cards + Load more), profile pages with a photo gallery (up to 8 photos) and details. A bell beside GIF subscribes the account to room-entry alerts; incoming DMs notify every registered device even if Chatblink is open in a background tab.
- **Appearance:** a dark-first responsive theme covers entry, setup, rooms, chats, DMs, profiles and dialogs; the top theme control switches to the original light palette and remembers the browser's choice.
- **Moderation:** the account named `dynamic` (case-insensitive) is the admin — promoted at startup and at signup. Admin panel promotes/demotes mods and can delete an account outright (its rooms, bans, DM grants and sessions go with it). Mods and room creators can ban users per room; bans block that user's messages in that room only (they can still read and DM). Only the admin can ban mods. Role tags (ADMIN/MOD) render next to names.
- **SEO:** `robots.txt`, `sitemap.xml`, per-page canonical URLs, Open Graph/JSON-LD, Google Search Console verification (meta tag + `googlee03d569365db2c0a.html`).

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `AUTH_SECRET` | production secret | Signs session/device tokens |
| `PUBLIC_ORIGIN` | production | Absolute public origin used for canonical URLs and the www redirect |
| `VAPID_PRIVATE_KEY` | push secret | Encrypts Web Push messages |
| `MIGRATE_TOKEN` | migration only | Enables the token-gated migration endpoint |

## REST API

Auth = session cookie or `Authorization: Bearer <device token>`. All POSTs require a matching `Origin`.

| Endpoint | Notes |
|---|---|
| `POST /auth/signup`, `POST /auth/login`, `POST /enter` | HTML form endpoints: create a profile-key account, sign in with a key, or consume an entry link (redirect/serve the app) |
| `POST /api/auth/logout` | Clears session and bumps `tokenVersion` (revokes device tokens) |
| `GET /api/account/safety` | Session required: the signed-in account's own details (username, display name, age, role, created at) |
| `GET /api/games` | Session required: every live room game in a room the caller may enter (room, game, seats, status, policy) |
| `GET /api/notice` | Public: the room-list notice (message only while it is visible) |
| `POST /api/notice` | Admin only: `{message, visible}`, broadcast as `notice-changed` |
| `GET /api/auth/me` | Current user |
| `GET /api/users` | All users + `online` flag (DM page) |
| `GET /api/explore?limit&q&cursor` | D1-backed profile directory, newest first |
| `GET /api/profiles/:username` | Single profile + `online`/`isSelf` |
| `POST /api/profile` | Save displayName, avatar, bio, gender, interests, photo |
| `POST /api/profile/photos` / `.../remove` | Add/remove gallery photo (max 8, must be an `/uploads/...` URL) |
| `GET /api/rooms` / `GET /api/rooms/online` | Room list (with media) / lightweight online counts |
| `GET /api/rooms/:id/subscription` · `POST .../subscription` | Read or set the current account's room-entry alert with `{subscribed:true|false}` |
| `POST /api/rooms` | Create room: `name` (≥3 chars), optional `vibe` (≥3 if given), `access` (open/request), `theme` |
| `POST /api/rooms/:id/request` | Request access to a request-only room |
| `GET /api/rooms/:id/requests` · `POST .../requests/:userId` | Owner lists requests / `{action:"approve"|"decline"}` |
| `GET /api/rooms/:id/bans` · `POST .../bans/:userId` | List bans / `{action:"ban"|"unban"}` (owner, mod, admin only) |
| `DELETE /api/rooms/:id` | Delete a user-created room (creator or admin) |
| `POST /api/upload` | `{kind:"image"|"voice", data:<base64>}` → `{url:"/uploads/<uuid>.<ext>"}`; images ≤6 MB (jpg/png/gif/webp), voice ≤4 MB (webm/ogg/mp4), magic-byte validated |
| `GET /api/admin/users` · `POST /api/admin/role/:id` · `DELETE /api/admin/users/:id` | Admin only: list users / `{role:"mod"|"user"}` / delete an account outright (also removes the rooms it owns) |
| `POST /api/migrate?token` | Only when `MIGRATE_TOKEN` is set: `{users, rooms}` bulk upsert (replaces the old `GET /api/export` + `POST /api/restore`) |

Uploaded files are served from `/uploads/<name>` (uuid + validated extension) with `Accept-Ranges`, `ETag` and `206` support, so a media element can seek without re-downloading the whole file.

## WebSocket protocol

Connect: `ws(s)://<host>?room=<roomId>` (auth via cookie or `&token=`). `room=__notify` opens a notification-only channel (no presence/history) that every client holds whenever they don't have a room socket — signed in or guest — so room-list changes, live room online counts, user presence and request/DM/ban/call events arrive from anywhere in the app. Server messages: `history {messages, online, users}`, `message`, `message-reactions {messageId, reactions}`, `message-deleted {messageId, by}`, `notice-changed {notice}`, `presence {online, users}`, `room-online {roomId, online}`, `rooms-changed`, `users-changed` (signed-in clients only), `dm {from, to, kind, content, at}`, `dm-permission {from, status}`, `room-updated {roomId}`, `room-ban {roomId, banned}`, `room-deleted {roomId}`, and the call signals `call-offer`, `call-answer`, `call-ice`, `call-end`, `call-reject`, `call-busy`, `call-unavailable`, `call-taken`.
Client messages: `{type:"message", kind:"text|emoji|sticker|gif|image|voice", content, replyTo?}`, `{type:"react", messageId, emoji}`, `{type:"delete-message", messageId}`, `{type:"dm", to, kind, content}`, the room-call signals below, and authenticated WebRTC signaling messages carrying `to`, `callId`, SDP or ICE candidates as appropriate.
Room (group) call, request-only rooms only, audio never leaves the peers: `{type:"group-call-join"}` → `group-call-joined {callId, hostId, startedAt, participants, self}` to the joiner and `group-call-state` to the room; then `{type:"group-call-offer"|"group-call-answer", callId, to, sdp}` and `{type:"group-call-ice", callId, to, candidate}` relayed between participants, `{type:"group-call-leave"}` → `group-call-left {callId, userId}` plus a fresh `group-call-state`, and `{type:"group-call-end"}` from the account that started the call → `group-call-ended {callId, by}` plus `group-call-state {active:false}` for everybody (ignored from anyone else). The joiner always offers to the members already in the call, so two joins at once cannot glare. Up to 6 participants (full mesh); the relay keeps one call per room, drops a member when their last socket in the room closes, ends the call when the last participant leaves, and hands the host label to the earliest remaining member if the starter leaves without ending it.
Message shape: `{id, userId, username, role, photo, kind, content, createdAt, reply, reactions, deleted}` — `reply` is `{id, username, snippet}` snapshotted when the reply was sent (so a trimmed or later-deleted parent still reads), `reactions` is `{emoji: [userId, …]}`, and a deleted message keeps its slot with `deleted: true`, empty `content` and no reactions. Deletion is a soft delete; anyone who can post in the room may delete their own message, and the room creator, a mod or the admin may delete any message in that room.
Limits: 20 messages/10 s per socket (room + DM share the budget, reactions and deletions included), plus 120 call signals/minute per socket; GIF URLs must be `/gifs/<name>.gif` or allowlisted Giphy/Tenor hosts; image/voice room messages only in request-only user-created rooms; DM media only after either participant grants permission; reactions are restricted to the server's fixed six (`👍 ❤️ 😂 😮 😢 🔥`) with at most 50 accounts each. Calls use public STUN servers; a TURN relay should be added for reliable connectivity between restrictive corporate/mobile networks. Server pings every 30 s and drops dead sockets.

## Frontend conventions (read before editing)

- **Cache-busting is manual:** static assets with `?v=` are served `immutable` for a year and cached at the edge. After changing anything in `public/`, bump `CLIENT_VERSION` in `worker/index.js` (it is appended to the `multi-room.js` script tag the Worker injects) **and** the CSS `?v=NN` links in `rooms.html`. Current version: **68** (the legacy Node server injects the same number from its own copy).
- **Mobile-first CSS:** base rules target phones; desktop enhancements live in `@media(min-width:801px)`.
- Client polls: room online counts every 20 s (rooms page), DM user list every 30 s, pending request check every 4 s — all paused when their view is hidden.
- LocalStorage keys: `nearby_auth_token` (device token), `nearby_pending_profile_key`, `nearby_hidden_users` (per-user message hiding).
- `[hidden]` is forced with `display:none!important` in CSS — keep using the `hidden` attribute to toggle views.

## Secrets, migration, and the retired Firestore

- **Worker secrets:** `AUTH_SECRET` signs device tokens / entry links, `VAPID_PRIVATE_KEY` encrypts push, and `MIGRATE_TOKEN` is only for migration. Set them with `npx wrangler secret put <NAME>`; locally they belong in `.dev.vars`. There is no mail provider secret because the site sends no email.
- **No longer needed:** `FIREBASE_SERVICE_ACCOUNT` (Firestore retired) and `GIPHY_API_KEY` (the UI no longer calls GIPHY, so `/api/config` returning null is expected and harmless).
- **Profile keys do not depend on any secret** — they are plain SHA-256 hashes — so accounts migrated from the old host sign in with the same keys.
- **Moving data in:** `node tools/migrate.js pull <oldUrl> <token>` copies `data/` off the old host, `node tools/migrate.js sql` regenerates `migration/seed.sql`, `npx wrangler d1 execute chatblink --remote --file=migration/seed.sql` loads it, and `node tools/migrate.js uploads` prints the R2 copy commands. See [DEPLOY.md](DEPLOY.md) for the exact order.
- Firebase project `chatblink-5e62f` (Firestore Native, region asia-south1, Spark plan) still exists and holds an old `profiles/{userId}` snapshot. Nothing reads it any more; it can be deleted when you are satisfied. Never put the old service-account key into the Worker.

## Tests

`npm run test:all` starts a local `wrangler dev` per suite group, runs everything and prints a summary — no manual terminals:

```powershell
npm run test:all
```

`tests/worker-smoke.js` is the fast, dependency-light end-to-end suite for the Cloudflare build — 73 checks over HTTP + WebSockets, including profile-key signup and login, that the removed email endpoints stay removed, session revocation, uploads, DMs, rooms, bans and the history cap. `tests/message-retention.js` proves the history cap keeps exactly the newest 100 messages, and `tests/quota-caps.js` proves the per-user daily budgets — it needs small budgets, so the runner gives it its own server on port 8801 with `--var MESSAGE_DAILY_CAP:25 --var UPLOAD_DAILY_CAP:2`. `tests/canonical-host.js` and `tests/schema-parity.js` need no server: the first drives the Worker handler directly, the second fails if `schema.sql` and `worker/lib/schema.js` (the copy the Worker applies itself) drift apart.

`tests/message-actions.js` covers reply, reactions and deletion over the room socket — quote snapshots, the fixed reaction set, toggle-off, refused deletions for a plain member, the creator and author paths, the empty preview on private room cards, and `/uploads` byte ranges. Its admin/mod section needs the one account the server auto-promotes (`dynamic`), which can only be created once per database, so it reports `SKIP` when that account already exists. The runner gives it its own server on port 8803 because signups are rate-limited per IP.

To run a single suite by hand, start the Worker first (`npm run db:local` once, then `npm run dev:worker`) and point the suite at it:

```powershell
npm run test:worker        # or test:retention, test:actions, test:canonical, test:room-actions, test:voice
```

`tests/prod-check.js` (`npm run test:prod`) is the post-deploy check for the live domain. It is read-only — it creates no accounts, rooms or messages — so it is safe to run against production, and it fails if `chatblink.chat` is being served by anything other than the Worker. It also checks that `www.chatblink.chat` redirects to the apex, and warns (without failing) while the zone is still serving plain http over the apex.

`tests/call-e2e.js` (`npm run test:calls`) drives two Chromium contexts with fake camera/microphone devices. It places and answers both a voice call and a video call, then verifies a connected WebRTC peer and remote media tracks on both sides. Start the local Worker on port `8799` before running it.

`tests/room-design-e2e.js` (`npm run test:room-design`) creates a temporary room in Chromium, verifies consecutive-message grouping and the exact latest-three preview, and captures 390px mobile plus desktop screenshots. `tests/push-gate-e2e.js` (`npm run test:push-gate`) verifies that a failed notification setup restores a retryable button without suppressing the prompt, then completes registration on the retry at a 390px viewport. `tests/theme-e2e.js` (`npm run test:theme`) verifies the dark default, persistent light toggle, mobile overflow and both responsive theme presentations. Start the local Worker on port `8799` before running these browser suites.

`tests/room-actions-e2e.js` (`npm run test:room-actions`) drives the new message UI in Chromium: a row that reveals its action buttons only when tapped (on its own line under the bubble, tappable size, and also on grouped lines whose meta row is hidden) and hides them again, replying into the composer bar, the quote rendering and jumping back to its parent, the reaction picker and chip, the delete confirmation and the deleted placeholder, and that a request-only room card has no preview element at all. `tests/voice-note-e2e.js` (`npm run test:voice`) feeds Chromium's fake microphone a generated 440 Hz WAV, records through the real button and measures the uploaded note — its length has to match how long the button was held and no stretch over 300 ms may be silent, which is what a note with dropouts fails.

`tests/notice-board.js` (`npm run test:notice`) covers the notice board: public read, anonymous and member writes refused, the admin publishing it, the live `notice-changed` push, hiding it, and refusing to show an empty notice. Its admin half needs the one-shot `dynamic` account, so it reports SKIP when that already exists.

`tests/games.js` (`npm run test:games`) drives room games over HTTP and the room socket: starting a game, an open seat filling, watching without a seat, the refusals (out of turn, a spectator moving, an impossible column, joining once the game started), a whole Connect Four game to a four-in-a-column win, a request that waits for the host, approval authority, forfeiting by leaving, the host clearing the board, `GET /api/games` including the private-room visibility rule, and that a burst of game events does not spend the chat message window.

`tests/group-call.js` (`npm run test:group-call`) drives the room-call relay with three accounts — two participants and one member who never joined — covering join/leave/state, offer/answer/ICE routing, the refusals (oversized candidates, wrong SDP types, a stale call id, a non-participant), cleanup when sockets close, and that only the starter can end the call for the room. `tests/group-call-e2e.js` (`npm run test:group-call:e2e`) opens two Chromium contexts with fake microphones in one private room and requires a connected peer-to-peer mesh with a live remote audio track on both sides, then checks mute, the leave/teardown path, and the host-only End call control hanging up for both sides.

```powershell
npm run test:prod                          # https://chatblink.chat
node tests/prod-check.js http://127.0.0.1:8787
```

It cannot check an authenticated socket (that needs a real session), so sign in as a test account and open one room in two tabs after a cutover to confirm live delivery.

`KEEP=1` on the retention test leaves its room in place, which is handy for inspecting the
Durable Object's SQLite under `.wrangler/state/v3/do/` by hand.

`tests/auth-e2e.js` drives a real browser with Playwright against the legacy Node server, and creates throwaway accounts:

```powershell
npx playwright install chromium
# in one terminal:
$env:NEARBY_DATA_DIR='C:\Users\balan\AppData\Local\Temp\cb-e2e'; npm start
# in another:
npm test
```

`NEARBY_TEST_URL` points the browser test at a server (default `http://localhost:3100`); `NEARBY_BROWSER_PATH` selects a specific browser executable.

## Deployment (current)

Full instructions live in **[DEPLOY.md](DEPLOY.md)**. In short: `npx wrangler login`, create the D1 database and the uploads KV namespace (paste both ids into `wrangler.jsonc`), load `schema.sql`, `npx wrangler secret put AUTH_SECRET`, then deploy — either `npm run deploy`, or just push to `main`, which [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) deploys from CI once the two `CLOUDFLARE_*` secrets are set. The nameservers are then the only thing left to point at Cloudflare.

- **Cost:** $0 — Workers, Durable Objects (SQLite backend), D1 and the uploads KV namespace are all within the free tier; no card required. R2 (the upgrade path for uploads) does ask for one, which is the only reason uploads are on KV. See `wrangler.jsonc`.
- **Repo:** `https://github.com/magicmusic2806-max/chatblink` (public).
- **Still running (temporarily):** the Render service `chatblink-sg` (Singapore, ~$7.25/month) is the old host. Keep it up until the Cloudflare custom domain has been verified, then suspend/delete it. `render.yaml` is reference only — the live service was created by hand.
- **Domains:** `chatblink.chat` (apex) and `www.chatblink.chat`, both declared in `wrangler.jsonc` as Worker custom domains, with `www` redirecting to the apex in `worker/index.js`; DNS was at Spaceship and moved to Cloudflare nameservers for the cutover.

## Repo layout

```
worker/index.js             router: pages, assets, /api/*, /auth/*, /uploads/*
worker/hub.js               ChatHub Durable Object — the whole live backend
worker/lib/core.js          helpers (cookies, JSON, origin checks, base64)
worker/lib/crypto.js        profile-key hashing + HMAC device tokens
worker/lib/db.js            D1 access (users, rooms)
worker/lib/catalog.js       built-in rooms, emoji/sticker/GIF catalog, media validation
wrangler.jsonc              Cloudflare bindings (DO, D1, R2, assets, vars)
schema.sql                  D1 tables (applied by the Worker itself, see worker/lib/schema.js)
worker/lib/schema.js        the same DDL the Worker applies at Durable Object start
migration/seed.sql          generated data seed for D1
tools/migrate.js            pull data off an old host / emit seed.sql / R2 copy commands
tools/extract-catalog.js    regenerates worker/lib/catalog.js from the client + server sources
tests/worker-smoke.js       end-to-end HTTP + WebSocket suite for the Worker
tests/message-actions.js    reply / reactions / deletion / private-card previews / upload ranges
tests/room-actions-e2e.js   browser suite for the reply, reaction and delete UI
tests/voice-note-e2e.js     browser suite that records a known tone and measures it
tests/group-call.js         room-call signaling: join, relay, refusals, cleanup
tests/group-call-e2e.js     two-browser room-call mesh with real WebRTC audio
tests/games.js              room games over HTTP and the socket, including a full Connect Four game
tests/notice-board.js       notice board reads, admin writes and the live event
tests/auth-e2e.js           Playwright end-to-end suite for the legacy Node server
DEPLOY.md                   step-by-step deployment and data migration
GAMES.md                    games roadmap: Draw & Guess first, plus licences
server-multi-room.js        LEGACY Node backend (Render only, being retired)
public/rooms.html           app shell and all views
public/multi-room.js        all client logic
public/multi-room.css       mobile-first styles
public/profile-key.css      setup/key screens
public/gifs/*.gif           12 preset animated GIFs
public/robots.txt, sitemap.xml, google*.html   SEO / Search Console
render.yaml                 reference config for the retired Render service
data/                       local snapshot of runtime state (gitignored — never commit)
```

## Gotchas

- Never commit `data/` or `.dev.vars` — both contain `auth-secret.txt` / `AUTH_SECRET` (anyone with it can forge device tokens).
- Chat history now survives restarts and deploys (Durable Object SQLite). On the legacy Node server it still does not.
- `npm run dev:worker` (`wrangler dev`) is a server that never exits — run it in its own terminal, never as a step inside a script that waits for it.
- Uploads are publicly readable via `/uploads/<uuid>.<ext>`; names are random UUIDs.
- The client sends no Authorization header on form posts; same-origin checks protect state-changing requests.
- Only one Durable Object instance (`HUB.idFromName("hub")`) holds all live state. That is deliberate: it is what makes presence and broadcasting correct, and Cloudflare routes all clients to it automatically. If traffic ever outgrows a single object, rooms would need to be sharded by room id.
- Legacy prototype files from the earlier "Nearby" iterations may still exist in the repo (`server*.js`, `public/app*.js`, `index.html`, `styles.css`, `location*`, `room-levels*`, etc.) — none are used by the live app. The email/password prototype group has been deleted along with the email account system.
