// End-to-end through the HTTP gateway with a fake upstream that records what it received and streams
// back an echo of the last user message (so placeholders come back and must be restored).
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGateway } from "../src/server.mjs";

function fakeUpstream(protocol) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let data = "";
    req.on("data", d => data += d);
    req.on("end", () => {
      const body = JSON.parse(data);
      seen.push({ headers: req.headers, body });
      const last = protocol === "anthropic"
        ? [].concat(body.messages.at(-1).content).map(p => typeof p === "string" ? p : p.text).join("")
        : [].concat(body.messages.at(-1).content).map(p => typeof p === "string" ? p : p.text).join("");
      const reply = "Reçu : " + last;
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify(protocol === "anthropic"
          ? { type: "message", content: [{ type: "text", text: reply }] }
          : { choices: [{ index: 0, message: { role: "assistant", content: reply } }] }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      // stream in 7-char pieces so placeholders are split across events
      let i = 0;
      const iv = setInterval(() => {
        const piece = reply.slice(i, i + 7); i += 7;
        if (protocol === "anthropic") res.write("event: content_block_delta\ndata: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } }) + "\n\n");
        else res.write("data: " + JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] }) + "\n\n");
        if (i >= reply.length) { clearInterval(iv); res.write(protocol === "anthropic" ? "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n" : "data: [DONE]\n\n"); res.end(); }
      }, 3);
    });
  });
  return { seen, listen: () => new Promise(r => server.listen(0, "127.0.0.1", () => r(server.address().port))), close: () => server.close() };
}

async function readSse(res, protocol) {
  let text = "", out = "";
  for await (const chunk of res.body) {
    text += Buffer.from(chunk).toString("utf8");
  }
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
    const obj = JSON.parse(line.slice(5));
    if (protocol === "anthropic") { if (obj.delta && obj.delta.text) out += obj.delta.text; }
    else for (const c of obj.choices || []) if (c.delta && c.delta.content) out += c.delta.content;
  }
  return out;
}

for (const protocol of ["openai", "anthropic"]) {
  test(`gateway ${protocol}: upstream sees placeholders, client sees originals (stream + non-stream), registre written`, async () => {
    const up = fakeUpstream(protocol);
    const upPort = await up.listen();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-core-"));
    const gw = createGateway({
      port: 0, key: Buffer.from("0123456789abcdef0123456789abcdef"), dataDir, ner: null,
      upstreams: { mistral: { base: "http://127.0.0.1:" + upPort, apiKey: "sk-test" }, anthropic: { base: "http://127.0.0.1:" + upPort, apiKey: "sk-ant" } },
      defaultUpstream: "mistral",
    });
    const { port } = await gw.listen();
    try {
      const msg = "Le salarié, NIR 1 85 05 78 006 084 91, SIRET 552 100 554 00013, mail jean@cabinet.fr.";
      const path_ = protocol === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
      const mk = (stream) => protocol === "anthropic"
        ? { model: "claude-x", max_tokens: 50, stream, messages: [{ role: "user", content: msg }] }
        : { model: "mistral-small", stream, messages: [{ role: "user", content: msg }] };
      const headers = { "content-type": "application/json", authorization: "Bearer client-key-ignored" };

      const r1 = await fetch(`http://127.0.0.1:${port}${path_}`, { method: "POST", headers, body: JSON.stringify(mk(true)) });
      assert.equal(r1.status, 200);
      const streamed = await readSse(r1, protocol);
      assert.equal(streamed, "Reçu : " + msg);

      const r2 = await fetch(`http://127.0.0.1:${port}${path_}`, { method: "POST", headers, body: JSON.stringify(mk(false)) });
      const j = await r2.json();
      assert.equal(protocol === "anthropic" ? j.content[0].text : j.choices[0].message.content, "Reçu : " + msg);

      // what the upstream actually received
      assert.equal(up.seen.length, 2);
      for (const s of up.seen) {
        const t = JSON.stringify(s.body);
        for (const leak of ["1 85 05 78 006 084 91", "552 100 554 00013", "jean@cabinet.fr"]) assert.ok(!t.includes(leak), "upstream saw " + leak);
        assert.ok(/\{\{NIR_[0-9a-f]{8}\}\}/.test(t) && /\{\{SIRET_/.test(t) && /\{\{EMAIL_/.test(t));
        assert.equal(protocol === "anthropic" ? s.headers["x-api-key"] : s.headers["authorization"], protocol === "anthropic" ? "sk-ant" : "Bearer sk-test");
      }
      // same value -> same placeholder in both requests (HMAC, no state)
      assert.equal(JSON.stringify(up.seen[0].body.messages.at(-1)), JSON.stringify(up.seen[1].body.messages.at(-1)));

      const csv = await (await fetch(`http://127.0.0.1:${port}/registre.csv`)).text();
      assert.ok(csv.includes("NIR") && csv.split("\r\n").length === 3 && !csv.includes("185057800608491"));
    } finally {
      await gw.close(); up.close();
    }
  });
}

test("fail closed: a detector error refuses the request instead of forwarding it", async () => {
  const up = fakeUpstream("openai");
  const upPort = await up.listen();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pfr-core-"));
  const gw = createGateway({ port: 0, key: Buffer.from("0123456789abcdef0123456789abcdef"), dataDir, ner: async () => { throw new Error("model crashed"); },
    upstreams: { mistral: { base: "http://127.0.0.1:" + upPort, apiKey: "k" } }, defaultUpstream: "mistral" });
  const { port } = await gw.listen();
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "Jean Dupont habite 12 rue de la Paix" }] }) });
    assert.equal(r.status, 503);
    assert.equal(up.seen.length, 0);
  } finally { await gw.close(); up.close(); }
});
