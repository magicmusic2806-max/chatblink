/**
 * Password hashing contract, checked without a server.
 *
 * Usage:  node --no-warnings tests/password-policy.js
 *
 * The iteration count is not a free choice: Cloudflare's WebCrypto refuses PBKDF2 above 100,000, so
 * the first production deployment of email signup threw "Pbkdf2 failed: iteration counts above
 * 100000 are not supported" for every attempt. Local workerd accepted it, so no running suite
 * noticed. This asserts the encoded parameters against that cap and that verification still holds
 * for the current format and the older single-pass one.
 */
let passed = 0, failed = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ""}`); }
};

(async () => {
  console.log("\npassword hashing policy");
  const { hashPassword, verifyPassword } = await import("../worker/lib/email-auth.js");
  const password = "correct-horse-battery";
  const hash = await hashPassword(password);
  const parts = hash.split("$");
  const iterations = Number(parts[1]), rounds = Number(parts[2]);

  ok("the hash names its scheme", parts[0] === "pbkdf2-sha256", parts[0]);
  ok("iterations stay inside the Worker runtime cap of 100000", Number.isInteger(iterations) && iterations > 0 && iterations <= 100000, String(iterations));
  ok("the work factor is chained to stay meaningful", Number.isInteger(rounds) && rounds >= 1 && rounds <= 20, String(rounds));
  ok("the effective work is at least 300k iterations", iterations * rounds >= 300000, `${iterations} x ${rounds}`);
  ok("the hash is salted per call", (await hashPassword(password)).split("$")[3] !== parts[3]);

  ok("the right password verifies", await verifyPassword(password, hash));
  ok("a wrong password does not", (await verifyPassword("wrong-password-here", hash)) === false);
  ok("a tampered hash does not", (await verifyPassword(password, hash.replace(/.$/, (character) => character === "A" ? "B" : "A"))) === false);
  ok("junk does not throw", (await verifyPassword(password, "nonsense")) === false);
  ok("an empty hash does not throw", (await verifyPassword(password, "")) === false);
  // The original single-pass format must keep verifying: build one with Node's PBKDF2 (the same
  // bits WebCrypto derives) and check the parser still accepts four parts.
  const { pbkdf2Sync } = require("node:crypto");
  const saltText = parts[3];
  const derived = pbkdf2Sync(Buffer.from(password), Buffer.from(saltText.replace(/-/g, "+").replace(/_/g, "/"), "base64"), 100000, 32, "sha256");
  const single = derived.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  ok("the older four-part format still verifies", await verifyPassword(password, `pbkdf2-sha256$100000$${saltText}$${single}`));

  console.log(`\n${failed === 0 ? "ALL GOOD" : "FAILURES"} - ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(error => { console.error(`\npassword-policy crashed: ${error.message}`); process.exit(1); });
