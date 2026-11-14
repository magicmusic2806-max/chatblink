# Chatblink handover

Updated 2026-11-14. Live at <https://chatblink.chat>, deployed from `main` by
`.github/workflows/deploy.yml` (`npm ci` → canonical-host suite → `wrangler deploy`).
Current client bundle: `multi-room.js?v=75`. D1 schema version: 3
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

## Solved: "Add this device" on Android (`NotReadableError`)

Closed in `v=75`. Root cause, established by `public/passkey-check.html` on the reporting phone: that
platform provider refuses **any** `create()` that asks for a resident (discoverable) credential, even
though `residentKey` is only `"preferred"` — it answers `NotReadableError` in 15-64 ms, before any prompt.
The probe's ladder read: steps 1-3 (all carrying `residentKey: "preferred"`) failed; step 4
(`authenticatorAttachment: "platform"`, `userVerification: "required"`, no `residentKey` field) created a
credential after a 6.5 s fingerprint prompt. The only difference between the failing and the succeeding
steps is the `residentKey` field, so user verification, the platform pin, the algorithm list and the
timeout are all innocent.

What that meant for the `v=73` retry: it kept `residentKey: "preferred"` in `minimalRegisterOptions`, so
the "reduced options" attempt was refused for exactly the same reason as the first. Neither attempt ever
got near a prompt.

Fixed in `v=75` (`public/multi-room.js`):

1. `minimalRegisterOptions` drops the resident-key request; `authenticatorAttachment: "platform"` and
   `userVerification: "required"` stay, so the ceremony is still this device's own lock screen and never a
   phone/QR/security key.
2. A successful fallback sets `chatblink.passkeyNoResident=1` in localStorage, so later registrations on
   that browser skip the attempt already known to fail instead of showing a prompt that is refused.
3. The passkey is then device-bound, not discoverable, so a usernameless `get()` cannot see it:
   `rememberedCredentialIds()` puts the ids this browser stored in `allowCredentials`, and an empty list
   keeps the discoverable path for a passkey synced onto the phone from elsewhere. No server change was
   needed — `allowCredentials` is client-side, and `/api/auth/passkey/register` already returned the id.

The cost, stated for whoever reads this next: on such a device the passkey is tied to that browser
profile. Clearing site data means the profile key is the way back in. On devices whose provider does
store discoverable credentials nothing changes.

`public/passkey-check.html` and the `v=74` platform-aware refusal text stay: the page is how the next
odd device gets diagnosed without a console, and the refusal advice is now correct per platform (Android:
screen lock + Google Password Manager; Apple: Face ID/Touch ID/passcode; Windows: Hello; UA logged with
`passkey error:`).

## Verification

- `npm run test:all` (`tests/run-all.js`) starts one `wrangler dev` per suite group and prints a
  summary. Last full run: **14 groups green** at `v=73` — canonical, schema, smoke, retention,
  push-gate, theme, quotas, actions, room-actions, voice-note, group-call, group-call-e2e, passkey,
  notice. `tests/passkey-e2e.js` re-run alone at `v=74`: 18 checks, and at `v=75`: **22 checks, green**,
  now including a context whose `create()` refuses any request carrying `residentKey` (Android's
  behaviour, stubbed because Chromium's virtual authenticator accepts resident keys) and a sign-in that
  asserts the stored credential id was named in `allowCredentials`.
- Writing suites against accounts: `/api/auth/logout` bumps the account's `tokenVersion`, so one context
  signing out ends every other session for that account. A second context must run last, or be dropped by
  clearing cookies rather than by logging out — a session that dies mid-suite shows up as
  `"Sign in first."` in the safety panel.
- `public/passkey-check.html` was driven at 390 px with a CDP virtual authenticator in three modes —
  step 1 succeeds, every step refused (`NotReadableError` stubbed), and only `platform` refused — and
  in each the ladder stopped or exhausted correctly and the verdict named the right step. Deployed in
  `v=74`: `/passkey-check` is 200, `tests/prod-check.js` all green with the bundle at `v=74`.
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
- `public/passkey-check.html` (served at `/passkey-check`, `noindex`, outside the Worker) is the
  diagnostic that solved the Android `NotReadableError`; keep it — it is how the next odd device gets
  diagnosed without a console. Re-run it whenever a passkey report cannot be reproduced.
- The retired prototype files (`server.js`, `server-clean.js`, `public/app*.js`, `location*`, …) are
  still in the tree, unused. `AUTH_SETUP.md`, the email/password prototype and the four email tables
  are gone.
