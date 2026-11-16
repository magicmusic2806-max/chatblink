/**
 * Runs every end-to-end suite and reports a summary.
 *
 * Usage:  node tests/run-all.js [suite ...]
 *
 * With no arguments every group runs. Naming suites runs only the groups that contain them, which is how the
 * deploy workflow gates on the game rules (`node tests/run-all.js chess draw`) without paying for the browser
 * suites. An unknown name is an error rather than a silent no-op: a typo in CI must not pass as "everything".
 *
 * Most suites run against their own local `wrangler dev`. The quota-cap suite needs deliberately
 * small budgets, so it gets a second server on another port with --var overrides; everything else
 * runs against the defaults. `tests/canonical-host.js` needs no server at all - it drives the
 * Worker's fetch handler directly, because `wrangler dev` always reports request.url as its own
 * local address and so cannot exercise hostname-based logic.
 */
const { spawn, spawnSync } = require("child_process");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const READY_TRIES = 45, READY_WAIT_MS = 2000;

const servers = [
  { port: 8799, vars: [], env: {}, suites: [
    { name: "smoke", file: "tests/worker-smoke.js" },
    { name: "retention", file: "tests/message-retention.js" },
    { name: "push-gate", file: "tests/push-gate-e2e.js" },
    { name: "theme", file: "tests/theme-e2e.js" }
  ] },
  { port: 8801, vars: ["MESSAGE_DAILY_CAP:25", "UPLOAD_DAILY_CAP:2"], env: { MESSAGE_DAILY_CAP: "25", UPLOAD_DAILY_CAP: "2" }, suites: [
    { name: "quotas", file: "tests/quota-caps.js" }
  ] },
  // Own server because the signup rate limit is per IP and would otherwise be shared with the suites
  // above; this one creates four accounts on its own.
  { port: 8803, vars: [], env: {}, suites: [
    { name: "actions", file: "tests/message-actions.js" }
  ] },
  // The browser suites create rooms too, and room creation is limited to 5 per 10 minutes per IP, so
  // they get a third server of their own rather than sharing the one above.
  { port: 8805, vars: [], env: {}, suites: [
    { name: "room-actions", file: "tests/room-actions-e2e.js" },
    { name: "voice-note", file: "tests/voice-note-e2e.js" }
  ] },
  // Room calls: signaling over the socket, then a real two-browser mesh. Same rate-limit reason.
  { port: 8807, vars: [], env: {}, suites: [
    { name: "group-call", file: "tests/group-call.js" },
    { name: "group-call-e2e", file: "tests/group-call-e2e.js" }
  ] },
  // Games create their own room and need four accounts. The away grace and the life of a finished board are
  // both shortened so the suite can watch an abandoned seat and a clear happen without waiting minutes.
  { port: 8791, vars: ["AWAY_GRACE_MS:1500", "ENDED_GAME_TTL_MS:6000"], env: { AWAY_GRACE_MS: "1500", ENDED_GAME_TTL_MS: "6000" }, suites: [
    { name: "games", file: "tests/games.js" }
  ] },
  // Chess: its own server because the clock is shortened to four seconds, so a flag can fall inside the test
  // instead of five minutes into it.
  { port: 8795, vars: ["AWAY_GRACE_MS:1500", "ENDED_GAME_TTL_MS:6000", "CHESS_CLOCK_MS:4000"], env: { AWAY_GRACE_MS: "1500", ENDED_GAME_TTL_MS: "6000", CHESS_CLOCK_MS: "4000" }, suites: [
    { name: "chess", file: "tests/chess.js" }
  ] },
  // Draw & Guess: short turns and a short reveal, so a whole three-round game runs in seconds. The choosing
  // window is longer than the others because the suite reads the words and then picks one: with a two-second
  // window the object's auto-pick could win the race and the test would fail on its own timing.
  { port: 8797, vars: ["AWAY_GRACE_MS:1500", "ENDED_GAME_TTL_MS:6000", "DRAW_SECONDS:20", "DRAW_REVEAL_MS:400", "DRAW_CHOOSE_MS:6000"], env: { AWAY_GRACE_MS: "1500", ENDED_GAME_TTL_MS: "6000", DRAW_SECONDS: "20", DRAW_REVEAL_MS: "400", DRAW_CHOOSE_MS: "6000" }, suites: [
    { name: "draw", file: "tests/draw.js" }
  ] },
  // Draw & Guess in two browsers: the drawer's word, the pointer strokes and the chat-sentence guess.
  { port: 8815, vars: ["AWAY_GRACE_MS:1500", "ENDED_GAME_TTL_MS:6000", "DRAW_SECONDS:30", "DRAW_REVEAL_MS:600", "DRAW_CHOOSE_MS:20000"], env: { AWAY_GRACE_MS: "1500", ENDED_GAME_TTL_MS: "6000", DRAW_SECONDS: "30", DRAW_REVEAL_MS: "600", DRAW_CHOOSE_MS: "20000" }, suites: [
    { name: "draw-ui", file: "tests/draw-ui.js" }
  ] },
  // The games dock drives two browsers through the paths a stranded player used to be stuck in, and its own
  // accounts and room would otherwise share the signup and room-create budgets with the suite above.
  { port: 8811, vars: [], env: {}, suites: [
    { name: "games-ui", file: "tests/games-ui.js" }
  ] },
  // Boot and room switching: two rooms, one extra signup, and a browser that holds a token but no cookie. Its
  // own server for the same budget reasons as the suites above.
  { port: 8813, vars: [], env: {}, suites: [
    { name: "boot", file: "tests/boot-e2e.js" }
  ] },
  // The notice board is the only suite here, and it needs an admin account, so it keeps a server of its
  // own rather than sharing room-creation budgets with the browser suites above.
  { port: 8809, vars: [], env: {}, suites: [
    { name: "notice", file: "tests/notice-board.js" }
  ] }
];

// No server and no port: these load the Worker module and call it in-process.
const offline = [{ name: "canonical", file: "tests/canonical-host.js" }, { name: "schema", file: "tests/schema-parity.js" }];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A `wrangler dev` left over from a killed run keeps its port, and `ready()` would then be satisfied by
// that stale server - silently testing old code and the wrong budgets. Fail fast and say why instead.
const portBusy = async port => {
  try { await fetch(`http://127.0.0.1:${port}/api/config`, { signal: AbortSignal.timeout(1500) }); return true; } catch { return false; }
};

async function ready(port) {
  for (let attempt = 0; attempt < READY_TRIES; attempt++) {
    await sleep(READY_WAIT_MS);
    try { const response = await fetch(`http://127.0.0.1:${port}/api/config`); if (response.ok) return true; } catch {}
  }
  return false;
}
const stop = server => {
  if (!server || server.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  else server.kill();
};

async function main() {
  // No names means everything; names narrow it to the groups that contain them.
  const wanted = new Set(process.argv.slice(2));
  const selected = name => wanted.size === 0 || wanted.has(name);
  const offlineSuites = offline.filter(suite => selected(suite.name));
  const serverGroups = servers
    .map(config => ({ ...config, suites: config.suites.filter(suite => selected(suite.name)) }))
    .filter(config => config.suites.length);
  if (!offlineSuites.length && !serverGroups.length) {
    const known = [...offline, ...servers.flatMap(config => config.suites)].map(suite => suite.name).join(", ");
    console.error(`no suite matches "${[...wanted].join(" ")}" - known suites: ${known}`);
    process.exit(1);
  }

  // Only the server suites need the local D1 tables; a filtered offline run must not touch them.
  if (serverGroups.length) {
    console.log("applying the local D1 schema (idempotent)");
    spawnSync("npm", ["run", "db:local"], { cwd: ROOT, shell: true, stdio: "ignore" });
  }

  const results = [];

  if (offlineSuites.length) {
    console.log(`\n=== ${offlineSuites.map(suite => suite.name).join(" + ")} (no server needed) ===`);
    for (const suite of offlineSuites) {
      // NODE_NO_WARNINGS: importing the Worker module re-parses it as ESM, which Node warns about.
      const run = spawnSync(process.execPath, [suite.file], { cwd: ROOT, stdio: "inherit", env: { ...process.env, NODE_NO_WARNINGS: "1" } });
      results.push({ name: suite.name, code: run.status === null ? 99 : run.status });
    }
  }

  for (const config of serverGroups) {
    const args = ["wrangler", "dev", "--port", String(config.port), ...config.vars.flatMap(pair => ["--var", pair])];
    console.log(`\n=== ${config.suites.map(s => s.name).join(" + ")} on port ${config.port} ${config.vars.length ? `(${config.vars.join(" ")})` : "(default budgets)"} ===`);
    const server = spawn("npx", args, { cwd: ROOT, shell: true, stdio: "ignore" });
    try {
      if (!await ready(config.port)) { console.error(`!! wrangler dev never came up on ${config.port}`); for (const suite of config.suites) results.push({ name: suite.name, code: 99 }); continue; }
      for (const suite of config.suites) {
        const run = spawnSync(process.execPath, [suite.file, `http://127.0.0.1:${config.port}`], { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...config.env } });
        results.push({ name: suite.name, code: run.status === null ? 99 : run.status });
      }
    } finally { stop(server); await sleep(1500); }
  }

  console.log("\n=== summary ===");
  for (const result of results) console.log(`${result.code === 0 ? "PASS" : "FAIL"}  ${result.name}`);
  const failed = results.filter(result => result.code !== 0);
  console.log(failed.length ? `${failed.length} suite(s) failed` : "all suites passed");
  process.exit(failed.length ? 1 : 0);
}

main().catch(error => { console.error(`runner crashed: ${error.message}`); process.exit(1); });
