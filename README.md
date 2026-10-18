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
  - **D1** (`schema.sql`): accounts (`users`) and rooms (`rooms`). Survives restarts and deploys, unlike the old JSON files.
  - **Durable Object SQLite**: room message history (latest 100/room). **This survives restarts — the old build lost history on every deploy.**
  - **Memory** (reset on restart, inside the Durable Object): sessions, rate-limit counters, presence. DM threads live in each browser's memory only.
  - **R2** (`chatblink-uploads`): uploaded photos and voice notes, served from `/uploads/<name>`.
  - **Firestore: no longer used.** It was only ever a server-side projection of profiles for Explore; `/api/explore` and `/api/profiles/:username` now read D1, and the browser client never touched it.

## Features

- **Entry:** the room selector loads first (`/rooms`); a join card asks username, age, 18+ confirmation — no email or password. Accounts get a profile key (`CHATBLINK-XXXX-XXXX-XXXX-XXXX-XXXX`, 20 chars) that signs in via the "Use a key" tab; API signups receive it directly.
- **Rooms:** built-ins ship in code; user-created rooms (open or request-only) persist to `data/chatrooms.json`. Room cards show the latest three messages as a live preview, while locked-room content remains private. Every room is its own page. Creators can delete their rooms; the admin can delete any.
- **Media & calls:** every room has preset emojis, sticker phrases, and 12 animated GIFs from `public/gifs/`. Request-only **user-created** rooms additionally unlock image messages (up to 4 at once) and voice notes. A single DM media approval grants photo/voice sending in both directions and remains revocable. Signed-in users can start peer-to-peer voice or video calls from a DM; the server carries signaling only, while encrypted media flows through WebRTC.
- **Presence & social:** live online counts per room, online green dots on avatars, online-users list with profile view / DM / message-hiding per person (per browser), username colors derived from name length, Explore page (search + profile cards + Load more), profile pages with a photo gallery (up to 8 photos) and details.
- **Appearance:** a dark-first responsive theme covers entry, setup, rooms, chats, DMs, profiles and dialogs; the top theme control switches to the original light palette and remembers the browser's choice.
- **Moderation:** the account named `dynamic` (case-insensitive) is the admin — promoted at startup and at signup. Admin panel promotes/demotes mods and can delete an account outright (its rooms, bans, DM grants and sessions go with it). Mods and room creators can ban users per room; bans block that user's messages in that room only (they can still read and DM). Only the admin can ban mods. Role tags (ADMIN/MOD) render next to names.
- **SEO:** `robots.txt`, `sitemap.xml`, per-page canonical URLs, Open Graph/JSON-LD, Google Search Console verification (meta tag + `googlee03d569365db2c0a.html`).

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `PORT` | no | Port to listen on (default `3100`) |
| `NEARBY_DATA_DIR` | production | Absolute path for JSON state + uploads (Render disk: `/var/data`) |
| `FIREBASE_SERVICE_ACCOUNT` | no | Base64 (or raw JSON) Firebase service-account key. Enables Firestore. Without it the app falls back to local user data for Explore. |
| `MIGRATE_TOKEN` | no | When set, enables token-gated `GET /api/export` and `POST /api/restore` (used to move a deployment between hosts). Leave unset in normal operation. |
| `GIPHY_API_KEY` | no | Legacy; the UI no longer calls GIPHY. |

## REST API

Auth = session cookie or `Authorization: Bearer <device token>`. All POSTs require a matching `Origin`.

| Endpoint | Notes |
|---|---|
| `POST /auth/signup`, `POST /auth/login` | HTML form endpoints (redirect/serve the app) |
| `POST /api/auth/logout` | Clears session and bumps `tokenVersion` (revokes device tokens) |
| `GET /api/auth/me` | Current user |
| `GET /api/users` | All users + `online` flag (DM page) |
| `GET /api/explore?limit&q&cursor` | D1-backed profile directory, newest first |
| `GET /api/profiles/:username` | Single profile + `online`/`isSelf` |
| `POST /api/profile` | Save displayName, avatar, bio, gender, interests, photo |
| `POST /api/profile/photos` / `.../remove` | Add/remove gallery photo (max 8, must be an `/uploads/...` URL) |
| `GET /api/rooms` / `GET /api/rooms/online` | Room list (with media) / lightweight online counts |
| `POST /api/rooms` | Create room: `name` (≥3 chars), optional `vibe` (≥3 if given), `access` (open/request), `theme` |
| `POST /api/rooms/:id/request` | Request access to a request-only room |
| `GET /api/rooms/:id/requests` · `POST .../requests/:userId` | Owner lists requests / `{action:"approve"|"decline"}` |
| `GET /api/rooms/:id/bans` · `POST .../bans/:userId` | List bans / `{action:"ban"|"unban"}` (owner, mod, admin only) |
| `DELETE /api/rooms/:id` | Delete a user-created room (creator or admin) |
| `POST /api/upload` | `{kind:"image"|"voice", data:<base64>}` → `{url:"/uploads/<uuid>.<ext>"}`; images ≤6 MB (jpg/png/gif/webp), voice ≤4 MB (webm/ogg/mp4), magic-byte validated |
| `GET /api/admin/users` · `POST /api/admin/role/:id` · `DELETE /api/admin/users/:id` | Admin only: list users / `{role:"mod"|"user"}` / delete an account outright (also removes the rooms it owns) |
| `POST /api/migrate?token` | Only when `MIGRATE_TOKEN` is set: `{users, rooms}` bulk upsert (replaces the old `GET /api/export` + `POST /api/restore`) |

Uploaded files are served publicly from `/uploads/<name>` (uuid + validated extension).

## WebSocket protocol

Connect: `ws(s)://<host>?room=<roomId>` (auth via cookie or `&token=`). `room=__notify` opens a notification-only channel (no presence/history) that every client holds whenever they don't have a room socket — signed in or guest — so room-list changes, live room online counts, user presence and request/DM/ban/call events arrive from anywhere in the app. Server messages: `history {messages, online, users}`, `message`, `presence {online, users}`, `room-online {roomId, online}`, `rooms-changed`, `users-changed` (signed-in clients only), `dm {from, to, kind, content, at}`, `dm-permission {from, status}`, `room-updated {roomId}`, `room-ban {roomId, banned}`, `room-deleted {roomId}`, and the call signals `call-offer`, `call-answer`, `call-ice`, `call-end`, `call-reject`, `call-busy`, `call-unavailable`, `call-taken`.
Client messages: `{type:"message", kind:"text|emoji|sticker|gif|image|voice", content}`, `{type:"dm", to, kind, content}`, and authenticated WebRTC signaling messages carrying `to`, `callId`, SDP or ICE candidates as appropriate.
Limits: 20 messages/10 s per socket (room + DM share the budget), plus 120 call signals/minute per socket; GIF URLs must be `/gifs/<name>.gif` or allowlisted Giphy/Tenor hosts; image/voice room messages only in request-only user-created rooms; DM media only after either participant grants permission. Calls use public STUN servers; a TURN relay should be added for reliable connectivity between restrictive corporate/mobile networks. Server pings every 30 s and drops dead sockets.

## Frontend conventions (read before editing)

- **Cache-busting is manual:** static assets with `?v=` are served `immutable` for a year and cached at the edge. After changing anything in `public/`, bump `CLIENT_VERSION` in `worker/index.js` (it is appended to the `multi-room.js` script tag the Worker injects) **and** the CSS `?v=NN` links in `rooms.html`. Current version: **56** (the legacy Node server injects the same number from its own copy).
- **Mobile-first CSS:** base rules target phones; desktop enhancements live in `@media(min-width:801px)`.
- Client polls: room online counts every 20 s (rooms page), DM user list every 30 s, pending request check every 4 s — all paused when their view is hidden.
- LocalStorage keys: `nearby_auth_token` (device token), `nearby_pending_profile_key`, `nearby_hidden_users` (per-user message hiding).
- `[hidden]` is forced with `display:none!important` in CSS — keep using the `hidden` attribute to toggle views.

## Secrets, migration, and the retired Firestore

- **Worker secrets:** `AUTH_SECRET` (signs device tokens / entry links — set it to the contents of `data/auth-secret.txt` so links minted by the old host keep working) and `MIGRATE_TOKEN` (only while migrating). Set them with `npx wrangler secret put <NAME>`; locally they live in `.dev.vars`, which is gitignored.
- **No longer needed:** `FIREBASE_SERVICE_ACCOUNT` (Firestore retired) and `GIPHY_API_KEY` (the UI no longer calls GIPHY, so `/api/config` returning null is expected and harmless).
- **Profile keys do not depend on any secret** — they are plain SHA-256 hashes — so accounts migrated from the old host sign in with the same keys.
- **Moving data in:** `node tools/migrate.js pull <oldUrl> <token>` copies `data/` off the old host, `node tools/migrate.js sql` regenerates `migration/seed.sql`, `npx wrangler d1 execute chatblink --remote --file=migration/seed.sql` loads it, and `node tools/migrate.js uploads` prints the R2 copy commands. See [DEPLOY.md](DEPLOY.md) for the exact order.
- Firebase project `chatblink-5e62f` (Firestore Native, region asia-south1, Spark plan) still exists and holds an old `profiles/{userId}` snapshot. Nothing reads it any more; it can be deleted when you are satisfied. Never put the old service-account key into the Worker.

## Tests

`npm run test:all` starts a local `wrangler dev` per suite group, runs everything and prints a summary — no manual terminals:

```powershell
npm run test:all
```

`tests/worker-smoke.js` is the fast, dependency-light end-to-end suite for the Cloudflare build — 60 checks over HTTP + WebSockets (signup, cookie sessions, profile-key login, legacy device-token parity, rooms, live previews, calls, presence, history persistence, catalog validation, origin/authorization guards). `tests/message-retention.js` proves the history cap keeps exactly the newest 100 messages, and `tests/quota-caps.js` proves the per-user daily budgets — it needs small budgets, so the runner gives it its own server on port 8801 with `--var MESSAGE_DAILY_CAP:25 --var UPLOAD_DAILY_CAP:2`. `tests/canonical-host.js` needs no server at all: it loads the Worker module and drives its `fetch` handler with synthetic URLs, because `wrangler dev` builds `request.url` from the custom domain in `wrangler.jsonc` rather than from the requested host — so the `www` → apex redirect can only be exercised that way, and the same redirect is asserted for real by `test:prod`.

To run a single suite by hand, start the Worker first (`npm run db:local` once, then `npm run dev:worker`) and point the suite at it:

```powershell
npm run test:worker        # or test:retention, test:canonical
```

`tests/prod-check.js` (`npm run test:prod`) is the post-deploy check for the live domain. It is read-only — it creates no accounts, rooms or messages — so it is safe to run against production, and it fails if `chatblink.chat` is being served by anything other than the Worker. It also checks that `www.chatblink.chat` redirects to the apex, and warns (without failing) while the zone is still serving plain http over the apex.

`tests/call-e2e.js` (`npm run test:calls`) drives two Chromium contexts with fake camera/microphone devices. It places and answers both a voice call and a video call, then verifies a connected WebRTC peer and remote media tracks on both sides. Start the local Worker on port `8799` before running it.

`tests/room-design-e2e.js` (`npm run test:room-design`) creates a temporary room in Chromium, verifies consecutive-message grouping and the exact latest-three preview, and captures 390px mobile plus desktop screenshots. `tests/push-gate-e2e.js` (`npm run test:push-gate`) verifies that a failed notification setup restores a retryable button without suppressing the prompt, then completes registration on the retry at a 390px viewport. `tests/theme-e2e.js` (`npm run test:theme`) verifies the dark default, persistent light toggle, mobile overflow and both responsive theme presentations. Start the local Worker on port `8799` before running these browser suites.

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
schema.sql                  D1 tables
migration/seed.sql          generated data seed for D1
tools/migrate.js            pull data off an old host / emit seed.sql / R2 copy commands
tools/extract-catalog.js    regenerates worker/lib/catalog.js from the client + server sources
tests/worker-smoke.js       end-to-end HTTP + WebSocket suite for the Worker
tests/auth-e2e.js           Playwright end-to-end suite for the legacy Node server
DEPLOY.md                   step-by-step deployment and data migration
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
- Legacy prototype files from the earlier "Nearby" iterations may still exist in the repo (`server*.js`, `public/app*.js`, `global.*`, `location*`, `room-levels*`, `simple-auth.js`, etc.) — none are used by the live app.
