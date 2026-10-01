// Desktop shell smoke test: Electron starts, the gateway child process comes up on a free port with an
// isolated data dir, the window shows the panel, quitting kills the gateway.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8700 + Math.floor(Math.random() * 200);

test("desktop: tray app starts the gateway and shows the panel", { timeout: 180000 }, async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-desk-"));
  const app = await electron.launch({
    args: [ROOT, `--user-data-dir=${userData}`],
    env: { ...process.env, PFR_PORT: String(PORT), PFR_NER: "off" },
  });
  try {
    const win = await app.firstWindow({ timeout: 120000 });
    await win.waitForLoadState("domcontentloaded");
    assert.equal(await win.title(), "presidio-fr");
    await win.waitForSelector("nav button[data-tab='connect']", { timeout: 30000 });
    const health = await (await fetch(`http://127.0.0.1:${PORT}/health`)).json();
    assert.equal(health.ok, true);
    // the panel reports the gateway's own port
    assert.ok((await win.locator("#addr").textContent()).includes(String(PORT)));
    // gateway data lives under the app's userData, not in the repo
    const dataDir = await app.evaluate(({ app }) => app.getPath("userData"));
    assert.ok(fs.existsSync(path.join(dataDir, "data", "config.json")), "config.json not in userData");
  } finally {
    await app.close();
  }
  // gateway must be gone with the app
  await new Promise(r => setTimeout(r, 1500));
  let alive = true;
  try { await fetch(`http://127.0.0.1:${PORT}/health`); } catch (_) { alive = false; }
  assert.equal(alive, false, "gateway still running after quit");
});
