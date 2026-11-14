# Chatblink handover

Updated 2026-11-14. Live at <https://chatblink.chat>, deployed from `main` by
`.github/workflows/deploy.yml` (`npm ci` → canonical-host suite → `wrangler deploy`).
Current client bundle: `multi-room.js?v=74`. D1 schema version: 3
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

**"Add this device" fails on at least one Android phone with `NotReadableError`.** As of `v=74` this is
what is known, and what the next person has to get from the device.

Evidence from the reporting device (Chrome on Android, seen in the screenshot that opened this thread):

1. The toast was the generic branch of `passkeyErrorMessage`, so `problem.name === "NotReadableError"` —
   and that toast comes *after* the reduced-options retry, so the retry failed the same way. A dismissal
   on the second attempt would have printed the `NotAllowedError` sentence instead.
2. The safety panel printed "This device can use its fingerprint, face or screen lock", so
   `isUVPAA()` returned true. The refusal sits below the browser's own availability check.
3. The phone has a screen lock and enrolled fingerprints, so "nothing is set up on this device" is out.

Ruled out: the `v=73` retry does not test hypothesis "a parameter the device dislikes", because
`minimalRegisterOptions` keeps the same `authenticatorAttachment: "platform"`, `userVerification:
"required"`, `residentKey: "preferred"` triple the server sends (`worker/hub.js`); it only drops the
timeout, extensions and attestation preference. `residentKey` is `"preferred"`, never required.

Shipped in `v=74`:

1. The refusal sentence now names the lock screen the device actually has — Android: screen lock (PIN,
   pattern, fingerprint, face) plus Google Password Manager; Apple: Face ID/Touch ID/passcode; Windows:
   Windows Hello; anything else: a screen lock. Telling a phone to set up Windows Hello reads as a
   browser bug and hides the real check. The user agent is logged with the `passkey error:` line.
2. `public/passkey-check.html` — a same-origin diagnostic page, served as a plain static asset at
   <https://chatblink.chat/passkey-check.html>. It runs the app's exact `create()` options and then
   relaxes one field per step (drop `requireResidentKey`, relax user verification, drop `residentKey`,
   drop the attachment hint, require resident keys), stopping at the first success. Challenges are
   generated in the page and it never calls the server, so nothing is added to the account; a step that
   succeeds does leave a test passkey named `passkey-check` on the device.

**Needed to close it:** open that page on the failing phone and screenshot the verdict. Three outcomes:

- **Step 1 works** — the settings are fine and the refusal was transient/contextual; retry in the app.
- **Step N > 1 works** — that step names the field Android refuses. Then decide whether dropping it is
  acceptable: the platform-only pin exists deliberately (no phone/QR/security key offered), so dropping
  `authenticatorAttachment` is a product decision, not a bug fix.
- **Every step fails** — the blocker is the browser/OS passkey provider, not the request: Play Services
  or Google Password Manager missing, disabled or policy-blocked, a Chrome/Play Services version issue,
  or an OEM provider that refuses the `platform` attachment outright. Confirm by registering a passkey
  at <https://webauthn.io> from the same phone — if that also fails, the site is not the problem.

Ranked hypotheses, unchanged in order but weaker on 1: (1) the OS passkey provider is unusable on that
device, (2) a Chrome/credential-manager glitch specific to that machine, (3) only after 1 and 2 are
excluded, a parameter the device dislikes — the probe page is the test for it.

## Verification

- `npm run test:all` (`tests/run-all.js`) starts one `wrangler dev` per suite group and prints a
  summary. Last full run: **14 groups green** at `v=73` — canonical, schema, smoke, retention,
  push-gate, theme, quotas, actions, room-actions, voice-note, group-call, group-call-e2e, passkey,
  notice. At `v=74` only `tests/passkey-e2e.js` was re-run: **18 checks green**, including the
  reworded refusal sentence.
- `public/passkey-check.html` was driven at 390 px with a CDP virtual authenticator in three modes —
  step 1 succeeds, every step refused (`NotReadableError` stubbed), and only `platform` refused — and
  in each the ladder stopped or exhausted correctly and the verdict named the right step.
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
- `public/passkey-check.html` is scaffolding for the open passkey item: delete it (and this line) once
  the Android refusal is explained. It is a static asset, so the Worker never sees it, and it is
  `noindex`.
- The retired prototype files (`server.js`, `server-clean.js`, `public/app*.js`, `location*`, …) are
  still in the tree, unused. `AUTH_SETUP.md`, the email/password prototype and the four email tables
  are gone.
