// Control panel API: status, config round trip with validation and key masking, policy applied to the
// next request (a type switched off passes in clear), registre listing, panel page served.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGateway } from "../src/server.mjs";
import { loadConfig } from "../src/config.mjs";

function echoUpstream() {
  const seen = [];
  const server = http.createServer((req, res) => {
    let d = ""; req.on("data", c => d += c); req.on("end", () => {
      seen.push(JSON.parse(d));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ index: 0, message: { role: "assistant", content: "ok" } }] }));
    });
  });
  return { seen, listen: () => new Promise(r => server.listen(0, "127.0.0.1", () => r(server.address().port))), close: () => server.close() };
}

test("panel: status, config validation, key masking, policy effect, registre, page", async () => {
  const up = echoUpstream();
  const upPort = await up.listen();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-panel-"));
  const cfg = loadConfig(dataDir, { PFR_PORT: "0", OPENAI_API_KEY: "sk-secret-1234", OPENAI_BASE: "http://127.0.0.1:" + upPort });
  const state = { cfg, key: Buffer.from("0123456789abcdef0123456789abcdef"), dataDir, ner: null, model: { status: "off" } };
  const gw = createGateway(state);
  const { port } = await gw.listen();
  const base = `http://127.0.0.1:${port}`;
  const api = (p, opts) => fetch(base + p, { headers: { "content-type": "application/json", "x-pfr-panel": "1" }, ...opts });
  try {
    // page + status; the real key never reaches the panel
    const page = await (await fetch(base + "/")).text();
    assert.ok(page.includes("<title>presidio-fr — panneau</title>"));
    let st = await (await api("/api/status")).json();
    assert.equal(st.config.upstreams.openai.apiKey, "••••1234");
    assert.equal(st.config.upstreams.openai.configured, true);
    assert.equal(st.entitlement.tier, "trial");
    assert.ok(!JSON.stringify(st).includes("sk-secret-1234"));

    // validation
    let r = await api("/api/config", { method: "PUT", body: JSON.stringify({ upstreams: { mistral: { base: "ftp://x" , apiKey: "k" } } }) });
    assert.equal(r.status, 400);
    r = await api("/api/config", { method: "PUT", body: JSON.stringify({ policy: { types: { NOPE: true } } }) });
    assert.equal(r.status, 400);
    r = await fetch(base + "/api/config", { method: "PUT", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(r.status, 403, "PUT without the panel header must be refused");

    // empty apiKey keeps the stored key; base can change
    r = await api("/api/config", { method: "PUT", body: JSON.stringify({ upstreams: { openai: { base: "http://127.0.0.1:" + upPort + "/", apiKey: "" } } }) });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, "config.json"), "utf8")).upstreams.openai.apiKey, "sk-secret-1234");

    // policy: switch SIRET off -> SIRET passes in clear, NIR still masked, on the very next request
    const msg = "NIR 1 85 05 78 006 084 91 et SIRET 552 100 554 00013";
    const send = () => fetch(base + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "gpt-4o-mini", messages: [{ role: "user", content: msg }] }) });
    await send();
    assert.ok(!JSON.stringify(up.seen[0]).includes("552 100 554 00013") && !JSON.stringify(up.seen[0]).includes("1 85 05 78 006 084 91"));
    r = await api("/api/config", { method: "PUT", body: JSON.stringify({ policy: { types: { SIRET: false } } }) });
    assert.equal(r.status, 200);
    await send();
    assert.ok(JSON.stringify(up.seen[1]).includes("552 100 554 00013"), "SIRET should pass in clear when switched off");
    assert.ok(!JSON.stringify(up.seen[1]).includes("1 85 05 78 006 084 91"), "NIR still masked");
    // notice off -> no system message injected
    await api("/api/config", { method: "PUT", body: JSON.stringify({ policy: { notice: false } }) });
    await send();
    assert.equal(up.seen[2].messages[0].role, "user");

    // registre + stats
    const rows = await (await api("/api/registre?limit=10")).json();
    assert.equal(rows.length, 3);
    assert.deepEqual(rows[2].byType, { NIR: 1, SIRET: 1 });
    st = await (await api("/api/status")).json();
    assert.equal(st.stats.requests, 3);
    assert.equal(st.config.policy.types.SIRET, false);
  } finally { await gw.close(); up.close(); }
});
