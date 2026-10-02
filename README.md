# Chatblink

An 18+ real-time chat site: people pick a name and drop into topic rooms (open or request-only), exchange private messages, photos and voice notes, and browse each other's profiles through an Explore page.

Live at **https://chatblink.chat** (deployed from this repo on Render, Singapore).

```powershell
npm install
npm start
```

Then open `http://localhost:3100` (override with the `PORT` environment variable). No build step, no framework, no database required to run locally.

---

## Architecture

- **Backend:** a single long-running Node process in `server-multi-room.js` — plain `http` server for pages/API/uploads plus a `ws` WebSocket server for live rooms, presence, and DMs. No framework.
- **Frontend:** one SPA in `public/` — `rooms.html` (shell + all views), `multi-room.js` (all client logic), `multi-room.css` (mobile-first styles), `profile-key.css` (setup/key screens). Vanilla JS, History-API routing (`/rooms`, `/room/<id>`, `/dms`, `/explore`, `/profile/<username>`), views are `<section>`s toggled via the `hidden` attribute.
- **Storage layers (important):**
  - **Disk** (`NEARBY_DATA_DIR`, default `./data`, gitignored): `users.json`, `chatrooms.json`, `auth-secret.txt`, `uploads/`.
  - **Memory** (reset on every restart): room message history (latest 100/room), sessions, rate-limit counters, presence. DM threads live in each browser's memory only.
  - **Firestore** (optional, see below): profile documents backing Explore and profile pages, with a local fallback.

## Features

- **Entry:** the room selector loads first (`/rooms`); a join card asks username, age, 18+ confirmation — no email or password. Accounts get a profile key (`CHATBLINK-XXXX-XXXX-XXXX-XXXX-XXXX`, 20 chars) that signs in via the "Use a key" tab; API signups receive it directly.
- **Rooms:** built-ins ship in code; user-created rooms (open or request-only) persist to `data/chatrooms.json`. Every room is its own page. Creators can delete their rooms; the admin can delete any.
- **Media:** every room has preset emojis, sticker phrases, and 12 animated GIFs from `public/gifs/`. Request-only **user-created** rooms additionally unlock image messages (up to 4 at once) and voice notes. DM photos/voice require the other person's permanent permission (request → grant, revocable).
- **Presence & social:** live online counts per room, online green dots on avatars, online-users list with profile view / DM / message-hiding per person (per browser), username colors derived from name length, Explore page (search + profile cards + Load more), profile pages with a photo gallery (up to 8 photos) and details.
- **Moderation:** the account named `dynamic` (case-insensitive) is the admin — promoted at startup and at signup. Admin panel promotes/demotes mods. Mods and room creators can ban users per room; bans block that user's messages in that room only (they can still read and DM). Only the admin can ban mods. Role tags (ADMIN/MOD) render next to names.
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
| `GET /api/explore?limit&q&cursor` | Firestore-backed profile directory, paged by `updatedAt` |
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
| `GET /api/admin/users` · `POST /api/admin/role/:id` | Admin only: list users / `{role:"mod"|"user"}` |
| `GET /api/export?token` · `POST /api/restore?token` | Only when `MIGRATE_TOKEN` is set |

Uploaded files are served publicly from `/uploads/<name>` (uuid + validated extension).

## WebSocket protocol

Connect: `ws(s)://<host>?room=<roomId>` (auth via cookie or `&token=`). `room=__notify` opens a notification-only channel (no presence/history) that every client holds whenever they don't have a room socket — signed in or guest — so room-list changes, live room online counts, user presence and request/DM/ban events arrive from anywhere in the app. Server messages: `history {messages, online, users}`, `message`, `presence {online, users}`, `room-online {roomId, online}`, `rooms-changed`, `users-changed` (signed-in clients only), `dm {from, to, kind, content, at}`, `dm-permission {from, status}`, `room-updated {roomId}`, `room-ban {roomId, banned}`, `room-deleted {roomId}`.
Client messages: `{type:"message", kind:"text|emoji|sticker|gif|image|voice", content}` and `{type:"dm", to, kind, content}`.
Limits: 20 messages/10 s per socket (room + DM share the budget); GIF URLs must be `/gifs/<name>.gif` or allowlisted Giphy/Tenor hosts; image/voice room messages only in request-only user-created rooms; DM media only after the recipient grants permission. Server pings every 30 s and drops dead sockets.

## Frontend conventions (read before editing)

- **Cache-busting is manual:** static assets with `?v=` are served `immutable` for a year and cached at the edge. After changing any file in `public/`, bump the version in **three places**: both `multi-room.js?v=NN` references in `server-multi-room.js` (authenticated and unauthenticated page injection) and the CSS `?v=NN` links in `rooms.html`. Current version: **v41**.
- **Mobile-first CSS:** base rules target phones; desktop enhancements live in `@media(min-width:801px)`.
- Client polls: room online counts every 20 s (rooms page), DM user list every 30 s, pending request check every 4 s — all paused when their view is hidden.
- LocalStorage keys: `nearby_auth_token` (device token), `nearby_pending_profile_key`, `nearby_hidden_users` (per-user message hiding).
- `[hidden]` is forced with `display:none!important` in CSS — keep using the `hidden` attribute to toggle views.

## Firestore (profiles)

- Firebase project `chatblink-5e62f`, Firestore Native, region **asia-south1 (Mumbai)**, Spark plan. Rules are production (locked); only the server's Admin SDK (via `FIREBASE_SERVICE_ACCOUNT`) reads/writes.
- Collection `profiles/{userId}`: id, username, usernameLower, age, role, displayName, avatar, bio, gender, interests, photo, photos[], updatedAt. Written on signup, profile/photo changes, role changes, and backfilled for all accounts at startup.
- The service-account base64 is stored in Render's env; a local copy used during development is at `%TEMP%\kilo\fb-sa-base64.txt` on the dev machine. Treat it as a secret.
- To move to another host: set `MIGRATE_TOKEN` on both, then `curl /api/export` from the old and `POST /api/restore` to the new (moved 10 users + uploads this way), then remove the token.

## Tests

`tests/auth-e2e.js` drives a real browser with Playwright. It needs a server already running and creates throwaway accounts:

```powershell
npx playwright install chromium
# in one terminal:
$env:NEARBY_DATA_DIR='C:\Users\balan\AppData\Local\Temp\cb-e2e'; npm start
# in another:
npm test
```

`NEARBY_TEST_URL` points the test at a server (default `http://localhost:3100`); `NEARBY_BROWSER_PATH` selects a specific browser executable.

## Deployment (current production)

- **Repo:** `https://github.com/magicmusic2806-max/chatblink` (public). Pushing to `main` auto-deploys to Render (~1–2 min).
- **Render service:** `chatblink-sg`, region **Singapore**, plan `0.5c-512mb`, 1 GB disk mounted at `/var/data`, env `NEARBY_DATA_DIR=/var/data` + `FIREBASE_SERVICE_ACCOUNT`, Edge Caching profile **Common static files** (JS/CSS/images cached at the edge; HTML/JSON never).
- **Domains:** `chatblink.chat` (apex A records → Render LB) and `www.chatblink.chat` (CNAME → `chatblink-sg.onrender.com`), DNS at Spaceship, TLS auto-issued.
- **Cost:** ~$7.25/month total (compute $7 + disk $0.25). Firestore is inside its free tier and photos live on the disk, so features don't change the price.
- `render.yaml` documents the equivalent Blueprint; the live service was created manually (the Blueprint parser rejected the file), so it is reference only.

## Repo layout

```
server-multi-room.js        entire backend (HTTP + API + WebSocket)
public/rooms.html           app shell and all views
public/multi-room.js        all client logic
public/multi-room.css       mobile-first styles
public/profile-key.css      setup/key screens
public/gifs/*.gif           12 preset animated GIFs
public/robots.txt, sitemap.xml, google*.html   SEO / Search Console
tests/auth-e2e.js           Playwright end-to-end test
render.yaml                 reference deployment config
data/                       runtime state (gitignored — never commit)
```

## Gotchas

- Never commit `data/` — it contains accounts and `auth-secret.txt` (anyone with both can forge tokens).
- Restarting the server clears chat history, sessions and DMs (disk data survives). Deploys restart it.
- Uploads are publicly readable via `/uploads/<uuid>.<ext>`; names are random UUIDs.
- The client sends no Authorization header on form posts; same-origin checks protect state-changing requests.
- Legacy prototype files from the earlier "Nearby" iterations may still exist in the repo (`server*.js`, `public/app*.js`, `global.*`, `location*`, `room-levels*`, `simple-auth.js`, etc.) — none are used by the live app.
