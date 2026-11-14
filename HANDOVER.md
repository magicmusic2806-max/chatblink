# Chatblink handover

Updated 2026-11-14. Live at <https://chatblink.chat>, deployed from `main` by
`.github/workflows/deploy.yml` (`npm ci` → canonical-host suite → `wrangler deploy`).
Current client bundle: `multi-room.js?v=73`. D1 schema version: 3
(`worker/lib/schema.js`, applied by the Durable Object itself).

## What the site is now

- Cloudflare Worker (`worker/index.js`) routing pages, assets, `/uploads/*` and `/api/*` to one
  Durable Object, `ChatHub` (`worker/hub.js`), which holds all live state: users, rooms, presence,
  DMs, room calls, rate limits. Room history lives in the object's SQLite (latest 100 per room).
- D1 holds accounts (`users`), rooms, push devices, room-alert subscriptions, passkeys
  (`passkey_credentials`) and the room-list notice (`site_notice`).
- Uploads (photos, voice notes) live in the KV binding `UPLOADS` (R2 stays commented out in
  `wrangler.jsonc`) and are served with `Range`, `ETag` and `206`.
- Production D1 currently holds 41 accounts and the admin account `Dynamic`.

## Accounts and sign-in

- **Profile key only.** Signup (username + age + 18+ confirm) returns a `CHATBLINK-…` key once on
  the setup screen; the server stores only its SHA-256 hash. Logging in is that key. There is no
  email, no password and no recovery address — the key is the account.
- **Passkeys** (WebAuthn) are the everyday door: "Sign in with fingerprint" on the login screen, and
  **Menu → Account safety → Add this device**. The ceremony is pinned to `authenticatorAttachment:
  "platform"`, so only the device's own fingerprint/face/screen lock is offered — never a phone, QR
  code or security key.
- Verification is in-Worker with no dependency (`worker/lib/webauthn.js`): CBOR subset decoder,
  COSE→SPKI at registration, ES256 only, assertion over `authenticatorData || SHA-256(clientDataJSON)`.
  Challenge in a signed 5-minute HttpOnly cookie (`nearby_passkey`), never a table.
- Worker secrets listed in production: `AUTH_SECRET`, `VAPID_PRIVATE_KEY`. No mail provider key —
  email auth was removed (commit `d2ccab6`, dead code deleted in `b52084d`).

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
| Passkeys | Platform-only WebAuthn, account-safety panel, fingerprint sign-in | `worker/lib/webauthn.js`, `worker/hub.js`, `public/multi-room.js` | `aa01d31`, `325481c`, `cc4a5c1` |
| Notice board | One admin-written announcement above the room list with a show/hide toggle, pushed live | `worker/hub.js`, `public/multi-room.js` | `aa01d31` |

## Current work focus (open)

**"Add this device" failed with Chromium's *"unknown error occurred while talking to the credentials
manager"*.** The toast was just forwarding that raw string.

Fixed in `cc4a5c1` (`v=73`), not yet confirmed on the reporter's device:

1. The registration challenge is prefetched when the safety panel opens and single-flighted, so the
   click goes straight from the handler into `navigator.credentials.create()` with a live user
   activation. (Awaiting the options request inside the click could burn that activation.)
2. `create()`/`get()` retry once with reduced options when the device refuses for a reason other than
   a dismissal, keeping platform attachment, user verification and resident keys.
3. Errors are translated to actionable sentences (dismissal, blocked address, existing credential,
   unsupported device, generic credential-manager refusal) and the raw `name`/`message` is logged as
   `passkey error: …`.

**Needed to close it:** the platform and browser the reporter used, and the new text of the toast or
the `passkey error:` console line. Ranked hypotheses:

1. OS platform authenticator not usable — Windows Hello/PIN not set up, Android screen lock or Google
   Password Manager unavailable, enterprise policy blocking WebAuthn. The new message says so.
2. A Chrome/OS credential-manager glitch on that specific machine (try an incognito window or another
   browser on the same device to separate browser state from OS state).
3. Only after 1 and 2 are excluded: a parameter the device dislikes — the reduced-option retry is the
   probe for that, and the console log names which attempt failed and how.

## Verification

- `npm run test:all` (`tests/run-all.js`) starts one `wrangler dev` per suite group and prints a
  summary. Last run: **14 groups green** — canonical, schema, smoke, retention, push-gate, theme,
  quotas, actions, room-actions, voice-note, group-call, group-call-e2e, passkey, notice.
- Notable suites: `tests/passkey-e2e.js` (18 checks, Chromium + a CDP virtual authenticator, asserts
  platform-only options, the prefetched challenge, and the plain-words refusal message),
  `tests/notice-board.js` (public read, admin write, live event; the admin half SKIPs when the
  one-shot `dynamic` account already exists), `tests/group-call.js` + `group-call-e2e.js`,
  `tests/voice-note-e2e.js` (records a generated tone and measures it), `tests/schema-parity.js`
  (keeps `schema.sql` and `worker/lib/schema.js` identical).
- `npm run test:prod` (`tests/prod-check.js`) is the read-only post-deploy check; it currently passes.

## Environment notes for whoever picks this up

- **Passkey ceremonies only work on `https://chatblink.chat` or `http://localhost:PORT`.** A WebAuthn
  rpId cannot be an IP, so `127.0.0.1` refuses by design; `wrangler dev --ip localhost` is the local
  setup, and `tests/passkey-e2e.js` rewrites a `127.0.0.1` base URL to `localhost` for that reason.
- `wrangler dev` rewrites `request.url` and the `Origin` header to the configured custom domain, so the
  real browser origin travels in `x-cb-origin` and, for WebAuthn, in the request body's `origin`
  field; the DO accepts `PUBLIC_ORIGIN` or a loopback origin on a non-https request.
- Uploads in production are in KV, not R2 — the R2 binding and payment method are still off.
- Inspect production with `npx wrangler d1 execute chatblink --remote --command "…"`. `npm run
  db:remote` still exists and is harmless; the Worker applies the schema itself.
- On this Windows box, `command_stop` on a `npx wrangler dev | tail` pipeline leaves the
  wrangler/workerd trees alive and they stack on the port; start `node
  node_modules/wrangler/bin/wrangler.js dev --port N` and kill with `taskkill /PID <pid> /T /F`.

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
