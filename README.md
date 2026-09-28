# Chatblink

A real-time rooms chat MVP: drop into an open room, or create your own room with open or request-only access.

```powershell
npm install
npm start
```

Then open `http://localhost:3100` (override with the `PORT` environment variable).

## How it works

- The room selector loads first (at `/rooms`); a compact join card asks for username, age, and 18+ confirmation only — no email or password — and submitting drops you in. The browser stays signed in.
- Each account still gets a profile key (`CHATBLINK-…`); accounts created through the API receive it directly, and saved keys sign in via the "Use a key" tab.
- Rooms are either **Open** (anyone can chat) or **Request only** (the creator approves each member). Built-in rooms ship with the server; user-created rooms persist in `data/chatrooms.json` and their creators (or the admin) can delete them from the rooms page.
- Every room is its own page (`/room/<id>`) and the room directory lives at `/rooms`. The top-right icon bar opens profile, rooms, private messages (placeholder), and a menu with the profile key and log out.
- Messages and sessions live only in server memory, and each room keeps its latest 100 messages, so everything resets when the server restarts.
- Every room ships with preset emojis, sticker phrases, and animated GIFs served from `public/gifs/` — no external GIF keys or URL pasting needed. GIF messages still accept allowlisted GIPHY/Tenor URLs for API clients.
- Request-only rooms created by users unlock image messages (up to four images at once) and voice notes; uploaded files live in `data/uploads/`.
- Tap the online count to see who is in the room: view a profile, start a private message, or hide another person's messages from your screen (saved per browser). Private messages open as a full page at `/dms` with a people picker on the right (active conversations first) and unread numbers on the DM icon. Photos and voice notes in DMs need the other person's permission first — request once and the grant is permanent until revoked.
- Profiles support an uploaded photo in addition to the emoji avatar, and photos appear next to messages.
- The account named `Dynamic` is the **admin** at startup; the admin panel (menu → Admin panel) promotes or demotes **mods**. Role tags show next to usernames. Mods and room creators can ban users per room from the online list or a profile card; bans block that user's messages in that room only — they can still read the room and send direct messages until unbanned. Only the admin can ban mods. User-created open rooms automatically remember everyone who joins as an allowed member.

## Data and secrets

Runtime state lives in `data/` and must never be committed or shared:

- `data/auth-secret.txt` signs auth tokens.
- `data/users.json` stores accounts.
- `data/chatrooms.json` stores user-created rooms.
- `data/uploads/` stores uploaded images, voice notes, and profile photos.

## Deployment

The app is a single long-running Node process with WebSockets and on-disk state, so it needs a host that supports both (not a static/serverless host like Netlify). On Render:

1. Push this folder to a GitHub repository.
2. In Render, choose **New → Web Service**, pick the repo, and set: runtime **Node**, build `npm install`, start `npm start`.
3. Select a paid instance (e.g. `0.5c-512mb`, ~$7/mo) so a disk can attach, then under **Advanced → Add disk** mount a 1 GB disk at `/var/data` and add the env var `NEARBY_DATA_DIR=/var/data`.
4. Deploy. HTTPS/WSS are automatic, and the disk keeps accounts, rooms, and uploads across deploys and restarts.

`render.yaml` documents the same configuration if you prefer the Blueprint flow. Alternatives with the same requirements: Railway or Fly.io (attach a volume and point `NEARBY_DATA_DIR` at it), or any VPS running `npm start` behind a TLS reverse proxy.

## Tests

`tests/auth-e2e.js` drives a real browser with Playwright:

```powershell
npx playwright install chromium
npm test
```

Set `NEARBY_TEST_URL` to point at a running server (default `http://localhost:3100`) and `NEARBY_BROWSER_PATH` to use a specific browser executable.
