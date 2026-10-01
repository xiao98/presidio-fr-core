// Copy the detection engine from the extension repo (single source of truth) into src/engine/.
// Plain scripts become .cjs here: this package is ESM ("type": "module") and the engine files export
// through module.exports.
import fs from "node:fs";
import path from "node:path";

const src = path.resolve("../presidio-fr-extension/src"), dst = path.resolve("src/engine");
fs.rmSync(dst, { recursive: true, force: true });
fs.mkdirSync(dst, { recursive: true });
for (const f of ["recognizers.js", "nermap.js", "vault.js", "license.js", "ner.mjs"]) {
  const body = fs.readFileSync(path.join(src, f), "utf8");
  const out = f.endsWith(".js") ? f.slice(0, -3) + ".cjs" : f;
  fs.writeFileSync(path.join(dst, out), `// GENERATED from presidio-fr-extension/src/${f} by scripts/sync-engine.mjs — do not edit here.\n` + body);
}
console.log("synced:", fs.readdirSync(dst).join(" "));
