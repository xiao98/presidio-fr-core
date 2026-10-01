// The gateway: an OpenAI- and Anthropic-compatible HTTP endpoint on localhost. Masks the request,
// forwards it to the configured upstream with the upstream's key, restores placeholders in the reply
// (streamed or not), appends one line to the registre. Fails closed: if the detector is unavailable the
// request is refused (503), never forwarded in clear.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { maskRequest } from "./mask.mjs";
import { restoreText, createStreamRestorer } from "./restore.mjs";

// config: { port, host, key (Buffer), dataDir, ner: async(text)->spans | null, upstreams: {
//   openai: { base: "https://api.openai.com", apiKey }, mistral: { base: "https://api.mistral.ai", apiKey },
//   anthropic: { base: "https://api.anthropic.com", apiKey } }, defaultUpstream: "mistral" }
export function createGateway(config) {
  const registre = path.join(config.dataDir, "registre.jsonl");
  fs.mkdirSync(config.dataDir, { recursive: true });

  function pickUpstream(req, body) {
    const h = req.headers["x-pfr-upstream"];
    if (h && config.upstreams[h]) return [h, config.upstreams[h]];
    const model = String(body.model || "");
    if (/^(gpt-|o\d|chatgpt)/.test(model) && config.upstreams.openai) return ["openai", config.upstreams.openai];
    if (/^(mistral|ministral|codestral|magistral|pixtral|open-mistral|open-mixtral)/.test(model) && config.upstreams.mistral) return ["mistral", config.upstreams.mistral];
    if (/^claude/.test(model) && config.upstreams.anthropic) return ["anthropic", config.upstreams.anthropic];
    return [config.defaultUpstream, config.upstreams[config.defaultUpstream]];
  }

  function audit(entry) {
    fs.appendFileSync(registre, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true, ner: !!config.ner });
    if (req.method === "GET" && url.pathname === "/registre.csv") return registreCsv(res);
    const protocol = url.pathname === "/v1/messages" ? "anthropic" : url.pathname === "/v1/chat/completions" ? "openai" : null;
    if (req.method === "GET" && url.pathname === "/v1/models") return passthroughModels(req, res);
    if (!protocol || req.method !== "POST") return json(res, 404, { error: { message: "unsupported route" } });

    let body;
    try { body = JSON.parse(await readBody(req)); } catch (_) { return json(res, 400, { error: { message: "invalid JSON" } }); }
    const [name, up] = pickUpstream(req, body);
    if (!up || !up.apiKey) return json(res, 502, { error: { message: "no upstream configured for " + name } });

    let masked;
    try { masked = await maskRequest(protocol, body, { key: config.key, ner: config.ner, notice: config.notice !== false }); }
    catch (e) { audit({ event: "refused", reason: String(e && e.message) }); return json(res, 503, { error: { message: "privacy filter unavailable, request refused: " + (e && e.message) } }); }
    const { map, findings } = masked;
    audit({ event: "request", protocol, upstream: name, model: body.model, stream: !!body.stream, masked: Object.values(findings).reduce((a, b) => a + b, 0), byType: findings });

    const headers = { "content-type": "application/json" };
    if (protocol === "anthropic") { headers["x-api-key"] = up.apiKey; headers["anthropic-version"] = req.headers["anthropic-version"] || "2023-06-01"; }
    else headers["authorization"] = "Bearer " + up.apiKey;
    let upstream;
    try {
      upstream = await fetch(up.base.replace(/\/$/, "") + url.pathname, { method: "POST", headers, body: JSON.stringify(masked.body) });
    } catch (e) { return json(res, 502, { error: { message: "upstream unreachable: " + (e && e.message) } }); }

    const ct = upstream.headers.get("content-type") || "";
    if (!upstream.ok || !ct.includes("text/event-stream")) {
      const text = await upstream.text();
      res.writeHead(upstream.status, { "content-type": ct || "application/json" });
      return res.end(upstream.ok ? restoreJson(text, map, protocol) : text);
    }
    // SSE: restore inside each event's text delta, with carry-over for placeholders split across events.
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    const restorer = createStreamRestorer(map);
    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const event = buf.slice(0, i); buf = buf.slice(i + 2);
        res.write(restoreEvent(event, restorer, protocol) + "\n\n");
      }
    }
    if (buf) res.write(restoreEvent(buf, restorer, protocol));
    const tail = restorer.flush();
    if (tail) res.write(tailEvent(tail, protocol));
    res.end();
  }

  function restoreEvent(event, restorer, protocol) {
    return event.split("\n").map(line => {
      if (!line.startsWith("data:")) return line;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") return line;
      let obj;
      try { obj = JSON.parse(payload); } catch (_) { return line; }
      if (protocol === "anthropic") {
        if (obj.type === "content_block_delta" && obj.delta && typeof obj.delta.text === "string") obj.delta.text = restorer.push(obj.delta.text);
        if (obj.type === "content_block_delta" && obj.delta && typeof obj.delta.partial_json === "string") obj.delta.partial_json = restorer.push(obj.delta.partial_json);
      } else {
        for (const c of obj.choices || []) {
          if (c.delta && typeof c.delta.content === "string") c.delta.content = restorer.push(c.delta.content);
          for (const t of (c.delta && c.delta.tool_calls) || []) if (t.function && typeof t.function.arguments === "string") t.function.arguments = restorer.push(t.function.arguments);
        }
      }
      return "data: " + JSON.stringify(obj);
    }).join("\n");
  }
  // text held back at the very end (a "{{" that never closed) is emitted as one extra delta
  function tailEvent(text, protocol) {
    if (protocol === "anthropic") return "event: content_block_delta\ndata: " + JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }) + "\n\n";
    return "data: " + JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] }) + "\n\n";
  }
  function restoreJson(text, map, protocol) {
    let obj;
    try { obj = JSON.parse(text); } catch (_) { return restoreText(text, map); }
    if (protocol === "anthropic") for (const p of obj.content || []) { if (typeof p.text === "string") p.text = restoreText(p.text, map); }
    else for (const c of obj.choices || []) {
      if (c.message && typeof c.message.content === "string") c.message.content = restoreText(c.message.content, map);
      for (const t of (c.message && c.message.tool_calls) || []) if (t.function && typeof t.function.arguments === "string") t.function.arguments = restoreText(t.function.arguments, map);
    }
    return JSON.stringify(obj);
  }
  async function passthroughModels(req, res) {
    const name = req.headers["x-pfr-upstream"] || config.defaultUpstream;
    const up = config.upstreams[name];
    if (!up) return json(res, 502, { error: { message: "no upstream " + name } });
    const r = await fetch(up.base.replace(/\/$/, "") + "/v1/models", { headers: { authorization: "Bearer " + up.apiKey } });
    res.writeHead(r.status, { "content-type": "application/json" });
    res.end(await r.text());
  }
  function registreCsv(res) {
    const rows = fs.existsSync(registre) ? fs.readFileSync(registre, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
    const types = [...new Set(rows.flatMap(r => Object.keys(r.byType || {})))].sort();
    const esc = (v) => '"' + String(v ?? "").replace(/"/g, '""') + '"';
    const lines = [["horodatage", "evenement", "protocole", "upstream", "modele", "total", ...types].map(esc).join(";")];
    for (const r of rows) lines.push([r.ts, r.event, r.protocol, r.upstream, r.model, r.masked, ...types.map(t => (r.byType || {})[t] || 0)].map(esc).join(";"));
    res.writeHead(200, { "content-type": "text/csv; charset=utf-8" });
    res.end("﻿" + lines.join("\r\n"));
  }

  const server = http.createServer((req, res) => handle(req, res).catch(e => { try { json(res, 500, { error: { message: String(e && e.message) } }); } catch (_) {} }));
  return {
    listen: () => new Promise(r => server.listen(config.port, config.host || "127.0.0.1", () => r(server.address()))),
    close: () => new Promise(r => server.close(r)),
  };
}

function json(res, status, obj) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise((res, rej) => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => res(Buffer.concat(c).toString("utf8"))); req.on("error", rej); }); }
