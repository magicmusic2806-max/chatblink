/**
 * Runs every end-to-end suite and reports a summary.
 *
 * Usage:  node tests/run-all.js
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
    { name: "retention", file: "tests/message-retention.js" }
  ] },
  { port: 8801, vars: ["MESSAGE_DAILY_CAP:25", "UPLOAD_DAILY_CAP:2"], env: { MESSAGE_DAILY_CAP: "25", UPLOAD_DAILY_CAP: "2" }, suites: [
    { name: "quotas", file: "tests/quota-caps.js" }
  ] }
];

// No server and no port: these load the Worker module and call it in-process.
const offline = [{ name: "canonical", file: "tests/canonical-host.js" }];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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
  console.log("applying the local D1 schema (idempotent)");
  spawnSync("npm", ["run", "db:local"], { cwd: ROOT, shell: true, stdio: "ignore" });

  const results = [];

  console.log(`\n=== ${offline.map(suite => suite.name).join(" + ")} (no server needed) ===`);
  for (const suite of offline) {
    // NODE_NO_WARNINGS: importing the Worker module re-parses it as ESM, which Node warns about.
    const run = spawnSync(process.execPath, [suite.file], { cwd: ROOT, stdio: "inherit", env: { ...process.env, NODE_NO_WARNINGS: "1" } });
    results.push({ name: suite.name, code: run.status === null ? 99 : run.status });
  }

  for (const config of servers) {
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
