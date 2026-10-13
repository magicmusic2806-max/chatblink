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

Until this step is done the Worker only answers on `https://chatblink.chatblink.workers.dev`, and
`chatblink.chat` goes wherever the registrar's DNS says — which is Render, so suspending Render
takes the domain down (503 `x-render-routing: suspend`) while the Worker sits healthy. Check where
the domain actually resolves before debugging the Worker:

```powershell
nslookup -type=NS chatblink.chat 8.8.8.8              # Cloudflare nameservers only once the zone is active
curl.exe -sS -o NUL -D - https://chatblink.chat/ | findstr /I "HTTP/ x-render"
```

1. Add the domain to your Cloudflare account (free plan) and set the registrar's
   nameservers to the two Cloudflare gives you.
2. Dashboard → Workers & Pages → `chatblink` → Settings → Domains & Routes →
   **Add custom domain** → `chatblink.chat` (add `www` too if you want it).
3. `wrangler.jsonc` already sets `PUBLIC_ORIGIN` to `https://chatblink.chat`, which is what
   canonical URLs and cookie security use.

Keep Render running until the custom domain has been verified for a day or two, then
suspend/delete it. Add the custom domain from the dashboard rather than as a `routes` entry in
`wrangler.jsonc`: a `custom_domain` route for a zone that is not in the account yet makes
`wrangler deploy` fail, which would take the whole Worker down with it.

## 5. After cutting over

- **Verify the cutover:** `npm run test:prod` is read-only and safe against production. It checks
  the domain answers from the Worker — 200s, the DO-served `/api/config`, the client bundle, 404s,
  and that a WebSocket upgrade reaches the Durable Object — and fails if a routing header shows
  the domain is still landing on the old host.
- **Force HTTPS at the edge:** SSL/TLS → Edge Certificates → **Always Use HTTPS** on, ideally with
  HSTS. Without it `http://chatblink.chat` is served over plaintext, `isSecure()` sees http and
  session cookies go out without `Secure` — Render forced HTTPS for free, so losing it is a
  cutover regression. Check: `curl.exe -sS -o NUL -w "%{http_code} %{redirect_url}\n" http://chatblink.chat/`
  should print `301`/`308` and the https URL, not `200`.
- **`www`:** there is no DNS record for `www.chatblink.chat` unless you add one. Sessions are
  host-only cookies, so `www` would be a second, separate site — add it as a Worker custom domain
  *and* redirect it to the apex, rather than serving the app on both.
- **Retire Render:** once the domain has been verified for a day or two delete the service;
  `render.yaml` is reference only and nothing in this repo depends on it.
- **Cache busting:** `CLIENT_VERSION` in `worker/index.js` is appended to `multi-room.js`
  automatically — bump it when you change client-side JS.
- **Secrets:** `AUTH_SECRET` (required), `MIGRATE_TOKEN` (only while migrating). Manage with
  `npx wrangler secret put <NAME>` / `npx wrangler secret delete <NAME>`. Locally they live
  in `.dev.vars`, which is gitignored.
- **Logs:** `npx wrangler tail` streams production logs.
- **Rollback:** `npx wrangler deployments list` then `npx wrangler rollback`.

## Free tier, and where the ceilings are

- Workers: 100,000 requests/day account-wide. Static assets that don't match `run_worker_first`
  are free and unlimited, and once the budget is spent they 429 instead of falling back to assets.
- Durable Objects (SQLite backend — what `new_sqlite_classes` declares): 100,000 requests/day,
  100,000 **rows written**/day, 5,000,000 rows read/day, 13,000 GB-s/day, 5 GB storage. Incoming
  WebSocket messages bill at a 20:1 ratio, and outgoing messages are free, so the request budget
  alone would cover ~2,000,000 chat messages/day.
- D1: ~5 GB storage, ~5M row reads/day, ~100k row writes/day.
- Workers KV (uploads): 1,000 writes/day — the tightest budget in the project. R2 removes it;
  see the note in `wrangler.jsonc`.
- R2: ~10 GB storage, no egress fees.

What actually binds, in order:

1. **Uploads** — 1,000 KV writes/day. The per-IP limit allowed 30 per 10 minutes (4,320/day), so
   one IP could spend the whole day's budget. Each user now also gets `UPLOAD_DAILY_CAP`
   (default 20) uploads/day.
2. **Chat messages** — 100,000 DO rows written/day = one write per stored message, which is the
   floor. Each user also gets `MESSAGE_DAILY_CAP` (default 1000) messages/day, because one client
   sustaining 2 msg/s could otherwise reach ~172,000/day. The retention `DELETE` is amortised
   (`TRIM_INTERVAL`) so it no longer adds ~100 row reads to every message.
3. **Requests** never bind, at 20:1 they cover millions of messages.

Per-user budgets are counted in memory rather than in storage — a write used to track them would
cost exactly what they protect. They reset only if the Durable Object is evicted (after ~10s of
quiet, which is longer than the rate-limit window, so nothing is really lost). Tune them in the
`vars` block of `wrangler.jsonc`, or per deploy:

```powershell
npx wrangler deploy --var MESSAGE_DAILY_CAP:500 --var UPLOAD_DAILY_CAP:10
```

Set either to `0` to switch that budget off. Overrunning a budget fails the rest of the day's
remainder until 00:00 UTC rather than charging you; Workers Paid ($5/mo) raises the row budget to
50M/month ≈ 1.6M messages/day.
