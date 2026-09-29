# AGENTS.md

Guidance for AI coding assistants working in this repository. `README.md` is the source of truth for architecture, APIs, and deployment — read it first; this file only adds the workflow rules.

## Commands

```powershell
npm install                 # deps: ws, firebase-admin (runtime); playwright (dev)
npm start                   # serves on http://localhost:3100 (PORT overrides)
npm test                    # runs tests/auth-e2e.js — requires a server ALREADY RUNNING
npx playwright install chromium   # once, to enable npm test
```

Local server with isolated data (never test against real data):

```powershell
$env:NEARBY_DATA_DIR="$env:TEMP\cb-dev"; $env:PORT=3113; npm start
```

End-to-end test against that server:

```powershell
$env:NEARBY_TEST_URL="http://localhost:3113"; npm test
```

## Non-negotiable conventions

1. **Cache-busting:** after editing anything in `public/`, bump `?v=NN` in THREE places — both `multi-room.js?v=NN` references in `server-multi-room.js` and the CSS `?v=NN` links in `rooms.html`. Static assets are immutable at the edge; forgetting this serves stale files to users.
2. **Code style:** the codebase is deliberately compact (single-line function bodies, no comments, semicolons). Match it. No frameworks, no build step, no TypeScript — plain Node + vanilla JS.
3. **Views:** toggle `<section>`s with the `hidden` attribute (forced to `display:none!important` in CSS) and route with the History API (`/rooms`, `/room/<id>`, `/dms`, `/explore`, `/profile/<username>`).
4. **CSS:** mobile-first base; desktop enhancements inside `@media(min-width:801px)` only.
5. **Secrets:** never commit `data/` (accounts + `auth-secret.txt`) or service-account keys. `.gitignore` already covers them.
6. **Never bump data compatibility silently:** `data/users.json` / `data/chatrooms.json` are read with defaults; new fields must be optional (`room.gifs || []`) so existing installs keep working.

## Architecture in one paragraph

All backend logic is in `server-multi-room.js` (HTTP pages/API/uploads + `ws` WebSocket for rooms/presence/DMs). All client logic is in `public/multi-room.js` with the shell in `public/rooms.html`. Persistence: JSON files + uploads on the disk at `NEARBY_DATA_DIR`; messages/sessions/presence in memory (wiped on restart); profile documents in Firestore when `FIREBASE_SERVICE_ACCOUNT` is set, with a local fallback. See README for the full REST/WS reference.

## Deployment

- Push to `main` on `magicmusic2806-max/chatblink` → Render auto-deploys (~1–2 min) to service `chatblink-sg` (Singapore), live at https://chatblink.chat.
- Production env: `NEARBY_DATA_DIR=/var/data`, `FIREBASE_SERVICE_ACCOUNT=<base64>`. Disk 1 GB, edge caching "Common static files".
- After pushing, verify live: `curl -s -o NUL -w "%{http_code}" https://chatblink.chat/` and check the injected `multi-room.js?v=` matches the new version.

## Definition of done for a change

1. Local syntax check: `node --check server-multi-room.js; node --check public/multi-room.js`.
2. `npm test` passes against a freshly started server on a temp `NEARBY_DATA_DIR`.
3. Version bumped (rule 1) and pushed; live site serves the new version.
4. UI changes verified with a browser check (Playwright screenshots) on a 390px-wide viewport, not just desktop.

## Known leftovers (do not extend)

`server.js`, `server-auth.js`, and the other `server-*.js` variants, plus `public/app*.js`, `global.*`, `location*`, `room-levels*`, `simple-auth.js`, `auth-enhancements.js` are dead code from earlier prototypes. Leave them alone unless asked to delete. `render.yaml` is reference only — the live Render service was created manually.
