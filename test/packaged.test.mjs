// Smoke test against the packaged app (dist/win-unpacked/presidio-fr.exe): the gateway must start from
// the installed layout WITH the local model (onnxruntime-node native binary loaded from the trimmed
// node_modules), serve the panel, and mask a request. Skipped when the build is absent.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXE = path.join(ROOT, "dist", "win-unpacked", "presidio-fr.exe");
const PORT = 8600 + Math.floor(Math.random() * 200);

test("packaged app: gateway + local model start from the installed layout", { skip: !fs.existsSync(EXE), timeout: 600000 }, async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-pack-"));
  const app = await electron.launch({ executablePath: EXE, args: [`--user-data-dir=${userData}`], env: { ...process.env, PFR_PORT: String(PORT) } });
  try {
    const win = await app.firstWindow({ timeout: 120000 });
    await win.waitForSelector("nav button[data-tab='connect']", { timeout: 60000 });
    // wait for the model (download on first run into userData, then load)
    const t0 = Date.now();
    while (Date.now() - t0 < 480000) {
      const h = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
      if (h.model.status === "ready") break;
      if (h.model.status === "error") assert.fail("model error in packaged app: " + h.model.error);
      await new Promise(r => setTimeout(r, 2000));
    }
    const h = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
    assert.equal(h.model.status, "ready", "model did not become ready");
    // no upstream configured -> 502, but the masking engine must have run first? No: upstream check comes first.
    // Add a dummy upstream through the panel API, then send a request to a dead port: we only need the registre line.
    await fetch(`http://127.0.0.1:${PORT}/api/config`, { method: "PUT", headers: { "content-type": "application/json", "x-pfr-panel": "1" }, body: JSON.stringify({ upstreams: { openai: { base: "http://127.0.0.1:1", apiKey: "k" } } }) });
    const r = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: "Jean Dupont habite 12 rue de la Paix, SIRET 552 100 554 00013" }] }) });
    assert.equal(r.status, 502);     // upstream unreachable, but the request was masked and logged before forwarding
    const rows = await (await fetch(`http://127.0.0.1:${PORT}/api/registre?limit=5`)).json();
    assert.equal(rows[0].event, "request");
    assert.ok(rows[0].byType.SIRET === 1 && rows[0].byType.PERSON === 1 && rows[0].byType.ADDRESS === 1, JSON.stringify(rows[0].byType));
  } finally { await app.close(); }
});
