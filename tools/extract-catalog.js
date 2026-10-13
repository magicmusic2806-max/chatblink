const fs = require("fs");
const src = fs.readFileSync("server-multi-room.js", "utf8").split(/\r?\n/);
const block = src.slice(25, 59).join("\n");
const out = block
  .split("\n")
  .map(line => (/^const /.test(line) ? "export " + line : /^function /.test(line) ? "export " + line : line))
  .join("\n");
fs.mkdirSync("worker/lib", { recursive: true });
fs.writeFileSync("worker/lib/catalog.js", out + "\n");
console.log("wrote worker/lib/catalog.js");
console.log(out.split("\n").filter(l => /^export/.test(l)).map(l => l.slice(0, 42)).join("\n"));
