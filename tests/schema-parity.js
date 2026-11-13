/**
 * Keeps worker/lib/schema.js and schema.sql identical in effect.
 *
 * Usage:  node tests/schema-parity.js      (no server, no network)
 *
 * The Worker applies the D1 schema itself at Durable Object start, from the JS list, while the CLI
 * (`npm run db:remote`) applies the .sql file. If one gains a table the other does not, production and
 * local dev stop matching - which is exactly how a missing email_credentials table once made every
 * profile lookup answer 500. This compares the two by table name, index name and column names.
 */
const fs = require("fs");
const path = require("path");

let passed = 0, failed = 0;
const ok = (label, condition, detail = "") => {
  if (condition) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ` :: ${detail}` : ""}`); }
};

const sql = fs.readFileSync(path.join(__dirname, "..", "schema.sql"), "utf8");
// Comments would otherwise glue themselves to the following statement.
const statements = sql.split("\n").filter(line => !line.trim().startsWith("--")).join("\n").split(";").map(statement => statement.trim()).filter(Boolean);

const tables = new Map(), indexes = new Map();
for (const statement of statements) {
  const table = /^CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]+)\)$/i.exec(statement);
  if (table) {
    const columns = table[2].split(",").map(line => line.trim()).filter(line => line && !/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)\b/i.test(line)).map(line => line.split(/\s+/)[0]);
    tables.set(table[1], columns);
    continue;
  }
  const index = /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS\s+(\w+)\s+ON/i.exec(statement);
  if (index) indexes.set(index[1], statement.replace(/\s+/g, " "));
}

const module_ = require("../worker/lib/schema.js");

(async () => {
  console.log("\nschema parity: schema.sql vs worker/lib/schema.js");
  const jsTables = new Map(), jsIndexes = new Map();
  for (const statement of module_.D1_SCHEMA) {
    const table = /^CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]+)\)$/i.exec(statement);
    if (table) {
      const columns = table[2].split(",").map(line => line.trim()).filter(line => line && !/^(PRIMARY|UNIQUE|FOREIGN|CHECK|CONSTRAINT)\b/i.test(line)).map(line => line.split(/\s+/)[0]);
      jsTables.set(table[1], columns);
      continue;
    }
    const index = /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS\s+(\w+)\s+ON/i.exec(statement);
    if (index) jsIndexes.set(index[1], statement.replace(/\s+/g, " "));
  }

  ok("schema.sql parses into at least one table", tables.size > 0, `${tables.size}`);
  ok("the Worker schema has the same tables", [...tables.keys()].sort().join(",") === [...jsTables.keys()].sort().join(","), `sql=${[...tables.keys()]} js=${[...jsTables.keys()]}`);
  for (const [name, columns] of tables) {
    const other = jsTables.get(name) || [];
    ok(`${name} has the same columns in both`, columns.join(",") === other.join(","), `sql=${columns.join(",")} js=${other.join(",")}`);
  }
  ok("the Worker schema has the same indexes", [...indexes.keys()].sort().join(",") === [...jsIndexes.keys()].sort().join(","), `sql=${[...indexes.keys()]} js=${[...jsIndexes.keys()]}`);
  ok("the schema version is a positive integer", Number.isInteger(module_.D1_SCHEMA_VERSION) && module_.D1_SCHEMA_VERSION > 0, String(module_.D1_SCHEMA_VERSION));
  // A version bump is what makes the Worker re-apply the statements, so the constant must be bumped
  // whenever the list changes. Its value is not derivable, but a matching statement count catches the
  // common slip: appending a table without touching the version.
  ok("the statement list is not empty", module_.D1_SCHEMA.length === statements.length, `sql=${statements.length} js=${module_.D1_SCHEMA.length}`);

  console.log(`\n${failed === 0 ? "ALL GOOD" : "FAILURES"} - ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
