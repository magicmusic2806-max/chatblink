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
npx wrangler kv namespace create chatblink-uploads   # prints a namespace id, for uploads
```

Paste the printed `database_id` into `wrangler.jsonc` under `d1_databases`, and the namespace id under
`kv_namespaces` — the ids in there belong to the live deployment, so treat them as operational state.
Then create the tables:

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
node tools/migrate.js uploads                                      # one command per file: copies the uploads into KV (add --r2 to target R2)
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

### Deploying from CI

Every push to `main` that is not docs-only deploys production through
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml). `npm run deploy` still works from this
machine, but a push is no longer inert the way it was on Render — which is exactly the trap this
closes: a push that changed `multi-room.js` used to leave the live site on old code.

Two repository secrets are needed once, under **Settings → Secrets and variables → Actions**:

- `CLOUDFLARE_API_TOKEN` — Cloudflare dashboard → **Account API tokens**
  (`dash.cloudflare.com/?to=/:account/api-tokens`) → Create Token → Permission policies → Custom →
  **Edit Cloudflare Workers**, scoped to this account and the `chatblink.chat` zone.
- `CLOUDFLARE_ACCOUNT_ID` — dashboard → Workers & Pages (side panel), or `npx wrangler whoami`.

Until both exist the deploy job fails on purpose and says so in the log, rather than dying on a
cryptic 401. After adding them, either re-run the failed job from the Actions tab or push again.

The workflow deliberately leaves two things alone: **Worker secrets** (`AUTH_SECRET` stays on the
Worker where `npx wrangler secret put` put it, and deploys preserve it) and the **D1 schema**
(`npm run db:remote` stays manual, so DDL never runs on an ordinary push).

Cloudflare's own **Workers Builds** (Workers & Pages → `chatblink` → Settings → Builds → connect the
repository) does the same job with no token stored in GitHub, because it authenticates from inside the
account. Either is fine; the Action is used here because the pipeline lives in the repo and can grow
gates.

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
   **Add custom domain** → `chatblink.chat` and `www.chatblink.chat`.
3. `wrangler.jsonc` already sets `PUBLIC_ORIGIN` to `https://chatblink.chat`, which is what
   canonical URLs and cookie security use.

Keep Render running until the custom domain has been verified for a day or two, then
suspend/delete it.

The apex and www are declared in `wrangler.jsonc` under `routes` as `custom_domain` entries, so
`wrangler deploy` keeps both live domains attached instead of them living only in the dashboard. A
correct deploy lists both:

```
Deployed chatblink triggers
  https://chatblink.chatblink.workers.dev
  chatblink.chat (custom domain)
  www.chatblink.chat (custom domain)
```

Each custom domain brings its own DNS record and certificate. Add them only once the zone is active
in this account; on a zone that is not in the account the deploy fails on them, which is why they
are not part of the initial setup above.

www is the alias rather than a second site: session cookies are host-only, so serving the app there
would create a separate login. `worker/index.js` redirects every www request to the apex instead
(301 for reads, 308 for other methods so a POST is not turned into a GET), and the plain-http side
of both names is left to the zone's Always Use HTTPS setting.

There is deliberately no `chatblink.chat/*` zone route alongside the custom domains. It started as
belt-and-braces against the stale proxied record left from Render, and once the custom domain created
the apex's own record it was redundant — while it was present, a plain-http `www` request was
answered at the edge with a redirect to `https://www...` instead of reaching the Worker's one-hop
redirect to the apex.

## 5. After cutting over

- **Verify the cutover:** `npm run test:prod` is read-only and safe against production. It checks
  the domain answers from the Worker — 200s, the DO-served `/api/config`, the client bundle, 404s,
  and that a WebSocket upgrade reaches the Durable Object — and fails if a routing header shows
  the domain is still landing on the old host.
- **Force HTTPS at the edge:** SSL/TLS → Edge Certificates → **Always Use HTTPS** on, ideally with
  HSTS. Without it `http://chatblink.chat` is served over plaintext (verified: it answers `200`),
  `isSecure()` sees http and session cookies go out without `Secure` — Render forced HTTPS for free,
  so losing it is a cutover regression. This is deliberately not done in the Worker: only the edge can
  redirect the static assets that bypass the Worker. `npm run test:prod` warns while it is off.
  Check: `curl.exe -sS -o NUL -w "%{http_code} %{redirect_url}\n" http://chatblink.chat/` should print
  `301`/`308` and the https URL, not `200`.
- **`www`:** declared as a custom domain in `wrangler.jsonc` and redirected to the apex by
  `worker/index.js`, so it is not a second site. `npm run test:prod` checks the redirect end to end;
  `npm run test:canonical` covers the rule itself, including that a POST is not downgraded to a GET.
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
