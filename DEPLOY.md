# Deploying Chatblink on Cloudflare Workers

Chatblink runs on the Cloudflare **free** plan — no card, no per-seat billing, and no
process that spins down like a Render free instance. Nothing here costs money until you
pass the free-tier limits (see the bottom of this file).

| Piece | Was (Render) | Now (Cloudflare) |
|---|---|---|
| HTTP server | `server-multi-room.js` (Node, long-running) | `worker/index.js` (router) |
| Chat / presence / DMs | in-process memory + `ws` | one `ChatHub` Durable Object (`worker/hub.js`) |
| Users + rooms | `data/*.json` on a Render disk | D1 (`schema.sql`) |
| Chat history | memory (**wiped on every restart**) | Durable Object SQLite (**survives**, 100 msgs/room) |
| Uploads | `data/uploads/` on disk | R2 (`chatblink-uploads`) |
| Explore / profiles | Firestore (optional Admin SDK sync) | D1 (no Firebase at all) |
| Frontend | `public/` | `public/` served by the Worker Assets binding |

Behaviour is unchanged for clients: `public/multi-room.js` is untouched and never talked
to Firebase directly. Profile keys are plain SHA-256 hashes, so accounts migrated from
`data/users.json` keep working, and `AUTH_SECRET` is only used to sign device tokens.

---

## 0. Local development

```powershell
npm install
npm run db:local          # create the local D1 tables
npm run dev:worker        # http://127.0.0.1:8787  (leave running)
npm run test:worker       # 38 end-to-end checks against it
```

`npm run dev:worker` is a **server that never exits**. Never run it as a foreground step of
an automated sequence — start it in its own terminal (or detached) so it cannot block
anything else.

---

## 1. One-time Cloudflare setup

```powershell
npx wrangler login                       # opens a browser, authorizes wrangler
npx wrangler d1 create chatblink         # prints a database_id
npx wrangler r2 bucket create chatblink-uploads
```

Paste the printed `database_id` into `wrangler.jsonc` (it currently holds the placeholder
`00000000-0000-0000-0000-000000000000`), then create the tables:

```powershell
npx wrangler d1 execute chatblink --remote --file=schema.sql
```

## 2. Move the live data off Render  (do this BEFORE turning Render off)

On the Render service, set the environment variable `MIGRATE_TOKEN` to any long random
string and wait for it to redeploy. That unlocks the token-gated export endpoint.

```powershell
node tools/migrate.js pull https://chatblink.chat <MIGRATE_TOKEN>   # writes data/ (users, rooms, auth-secret.txt, uploads/)
node tools/migrate.js sql                                          # regenerates migration/seed.sql from data/
npx wrangler d1 execute chatblink --remote --file=migration/seed.sql
node tools/migrate.js uploads                                      # prints one command per file; run them to copy uploads into R2
```

`data/auth-secret.txt` arrives with the pull. Use it as the Worker secret so that entry
links handed out by the old server keep working:

```powershell
npx wrangler secret put AUTH_SECRET      # paste the contents of data/auth-secret.txt
```

If you skip this, everything still works — profile keys do not depend on it — but old
`/enter` links stop being valid.

## 3. Ship it

```powershell
npm run deploy                           # npx wrangler deploy
```

That gives you `https://chatblink.<your-subdomain>.workers.dev`. Check it there first:

- load `/` and `/rooms`, create an account, enter a room, send a message
- open the same room in a second browser — the message appears live, online counts move
- reload: the message is still there (this is what Render could not do)
- `GET /api/explore` while signed in returns profiles

## 4. Point chatblink.chat at it

1. Add the domain to your Cloudflare account (free plan) and set the registrar's
   nameservers to the two Cloudflare gives you.
2. Dashboard → Workers & Pages → `chatblink` → Settings → Domains & Routes →
   **Add custom domain** → `chatblink.chat` (add `www` too if you want it).
3. `wrangler.jsonc` already sets `PUBLIC_ORIGIN` to `https://chatblink.chat`, which is what
   canonical URLs and cookie security use.

Keep Render running until the custom domain has been verified for a day or two, then
suspend/delete it.

## 5. After cutting over

- **Cache busting:** `CLIENT_VERSION` in `worker/index.js` is appended to `multi-room.js`
  automatically — bump it when you change client-side JS.
- **Secrets:** `AUTH_SECRET` (required), `MIGRATE_TOKEN` (only while migrating). Manage with
  `npx wrangler secret put <NAME>` / `npx wrangler secret delete <NAME>`. Locally they live
  in `.dev.vars`, which is gitignored.
- **Logs:** `npx wrangler tail` streams production logs.
- **Rollback:** `npx wrangler deployments list` then `npx wrangler rollback`.

## Free tier, and where the ceilings are

- Workers: 100,000 requests/day; static assets are served from the edge.
- Durable Objects: available on the free plan **only** with the SQLite backend — which is
  what `wrangler.jsonc` declares (`new_sqlite_classes`). Free allowance is 100,000
  requests/day and 13,000 GB-s/day of duration. Incoming WebSocket messages bill at a 20:1
  ratio, so ~2,000 chat messages count as 100 requests.
- D1: ~5 GB storage, ~5M row reads/day, ~100k row writes/day.
- R2: ~10 GB storage, no egress fees.

Practical effect: the ceiling that matters is the Workers request budget (100k/day, shared
with WebSocket messages at 20:1). A busy room sends thousands of messages for a few hundred
billed requests, so this comfortably covers a community site. If you ever exceed it, the
day's overage simply fails until 00:00 UTC rather than charging you.
