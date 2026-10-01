// The gateway: an OpenAI- and Anthropic-compatible HTTP endpoint on localhost plus its control panel.
// Masks the request, forwards it to the configured upstream with the upstream's key, restores
// placeholders in the reply (streamed or not), appends one line to the registre. Fails closed: if the
// detector is unavailable the request is refused (503), never forwarded in clear.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { maskRequest } from "./mask.mjs";
import { restoreText, createStreamRestorer } from "./restore.mjs";
import { applyPanelUpdate, publicConfig, saveConfig } from "./config.mjs";

const require = createRequire(import.meta.url);
const license = require("./engine/license.cjs");
const PANEL = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "panel.html"), "utf8");

// state: { cfg (live, from config.mjs), key (Buffer), dataDir, ner: async(text)->spans | null,
//          model: {status, pct, error}, host }
export function createGateway(state) {
  const registre = path.join(state.dataDir, "registre.jsonl");
  fs.mkdirSync(state.dataDir, { recursive: true });
  const stats = { requests: 0, masked: 0, refused: 0 };
  if (fs.existsSync(registre)) for (const l of fs.readFileSync(registre, "utf8").split("\n")) {
    if (!l) continue; try { const r = JSON.parse(l); if (r.event === "request") { stats.requests++; stats.masked += r.masked || 0; } else if (r.event === "refused") stats.refused++; } catch (_) {}
  }

  function pickUpstream(req, body) {
    const ups = state.cfg.upstreams;
    const h = req.headers["x-pfr-upstream"];
    if (h && ups[h]) return [h, ups[h]];
    const model = String(body.model || "");
    if (/^(gpt-|o\d|chatgpt)/.test(model) && ups.openai) return ["openai", ups.openai];
    if (/^(mistral|ministral|codestral|magistral|pixtral|open-mistral|open-mixtral)/.test(model) && ups.mistral) return ["mistral", ups.mistral];
    if (/^claude/.test(model) && ups.anthropic) return ["anthropic", ups.anthropic];
    return [state.cfg.defaultUpstream, ups[state.cfg.defaultUpstream]];
  }

  function audit(entry) {
    fs.appendFileSync(registre, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
    if (entry.event === "request") { stats.requests++; stats.masked += entry.masked || 0; } else if (entry.event === "refused") stats.refused++;
  }

  // Trial / licence: same rules as the extension. Free tier = rules only (no model), requests still pass.
  const storage = { get: async (d) => ({ ...d, licenseKey: state.cfg.licenseKey, installedAt: state.cfg.installedAt }), set: async () => {} };
  const entitlement = () => license.entitlement(storage);

  async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    if (req.method === "GET" && (p === "/" || p === "/panel")) { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(PANEL); }
    if (req.method === "GET" && p === "/health") return json(res, 200, { ok: true, model: state.model, ner: !!state.ner });
    if (req.method === "GET" && p === "/registre.csv") return registreCsv(res);
    if (p.startsWith("/api/")) return panelApi(req, res, url);
    const protocol = p === "/v1/messages" ? "anthropic" : p === "/v1/chat/completions" ? "openai" : null;
    if (req.method === "GET" && p === "/v1/models") return passthroughModels(req, res);
    if (!protocol || req.method !== "POST") return json(res, 404, { error: { message: "unsupported route" } });

    let body;
    try { body = JSON.parse(await readBody(req)); } catch (_) { return json(res, 400, { error: { message: "invalid JSON" } }); }
    const [name, up] = pickUpstream(req, body);
    if (!up || !up.apiKey) return json(res, 502, { error: { message: "no upstream configured for " + (name || "(none)") + " — open http://127.0.0.1:" + state.cfg.port + "/ to add one" } });

    const tier = (await entitlement()).tier;
    const useNer = state.cfg.policy.ner && tier !== "free" ? state.ner : null;
    if (state.cfg.policy.ner && tier !== "free" && state.ner && state.model.status !== "ready") {
      audit({ event: "refused", reason: "model_" + state.model.status });
      return json(res, 503, { error: { message: "privacy model " + state.model.status + (state.model.pct ? " " + state.model.pct + "%" : "") + ", request refused (fail closed); retry in a moment" } });
    }
    let masked;
    try { masked = await maskRequest(protocol, body, { key: state.key, ner: useNer, notice: state.cfg.policy.notice, types: state.cfg.policy.types }); }
    catch (e) { audit({ event: "refused", reason: String(e && e.message) }); return json(res, 503, { error: { message: "privacy filter unavailable, request refused: " + (e && e.message) } }); }
    const { map, findings } = masked;
    const total = Object.values(findings).reduce((a, b) => a + b, 0);
    audit({ event: "request", protocol, upstream: name, model: body.model, stream: !!body.stream, masked: total, byType: findings, tier });
    if (process.env.PFR_SHOW_MASKED === "1") {
      const last = (masked.body.messages || []).at(-1);
      const txt = last && (typeof last.content === "string" ? last.content : JSON.stringify(last.content));
      console.log(`→ ${name} (${body.model}) masked ${total} [${Object.keys(findings).join(", ")}]\n   ${String(txt).slice(0, 300)}`);
    }

    const headers = { "content-type": "application/json" };
    if (protocol === "anthropic") { headers["x-api-key"] = up.apiKey; headers["anthropic-version"] = req.headers["anthropic-version"] || "2023-06-01"; }
    else headers["authorization"] = "Bearer " + up.apiKey;
    let upstream;
    try { upstream = await fetch(up.base.replace(/\/$/, "") + p, { method: "POST", headers, body: JSON.stringify(masked.body) }); }
    catch (e) { return json(res, 502, { error: { message: "upstream unreachable: " + (e && e.message) } }); }

    const ct = upstream.headers.get("content-type") || "";
    if (!upstream.ok || !ct.includes("text/event-stream")) {
      const text = await upstream.text();
      res.writeHead(upstream.status, { "content-type": ct || "application/json" });
      return res.end(upstream.ok ? restoreJson(text, map, protocol) : text);
    }
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
      while ((i = buf.indexOf("\n\n")) !== -1) { const event = buf.slice(0, i); buf = buf.slice(i + 2); res.write(restoreEvent(event, restorer, protocol) + "\n\n"); }
    }
    if (buf) res.write(restoreEvent(buf, restorer, protocol));
    const tail = restorer.flush();
    if (tail) res.write(tailEvent(tail, protocol));
    res.end();
  }

  // ---- control panel API (localhost only; PUT requires the panel header so a web page cannot change settings)
  async function panelApi(req, res, url) {
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return json(res, 403, { error: "forbidden origin" });
    if (req.method === "GET" && url.pathname === "/api/status") {
      return json(res, 200, { config: publicConfig(state.cfg), model: state.model, stats, entitlement: await entitlement() });
    }
    if (req.method === "GET" && url.pathname === "/api/registre") {
      const limit = Math.min(1000, Number(url.searchParams.get("limit") || 200));
      const rows = fs.existsSync(registre) ? fs.readFileSync(registre, "utf8").trim().split("\n").filter(Boolean).slice(-limit).reverse().map(l => JSON.parse(l)) : [];
      return json(res, 200, rows);
    }
    if (req.method === "PUT" && url.pathname === "/api/config") {
      if (req.headers["x-pfr-panel"] !== "1") return json(res, 403, { error: "missing panel header" });
      let patch;
      try { patch = JSON.parse(await readBody(req)); } catch (_) { return json(res, 400, { error: "invalid JSON" }); }
      try { state.cfg = applyPanelUpdate(state.cfg, patch); saveConfig(state.dataDir, state.cfg); }
      catch (e) { return json(res, 400, { error: e.message }); }
      if (state.onConfigChange) state.onConfigChange(state.cfg);
      return json(res, 200, publicConfig(state.cfg));
    }
    return json(res, 404, { error: "unknown api route" });
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
    const name = req.headers["x-pfr-upstream"] || state.cfg.defaultUpstream;
    const up = state.cfg.upstreams[name];
    if (!up) return json(res, 502, { error: { message: "no upstream " + name } });
    try {
      const r = await fetch(up.base.replace(/\/$/, "") + "/v1/models", { headers: { authorization: "Bearer " + up.apiKey } });
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(await r.text());
    } catch (e) { json(res, 502, { error: { message: "upstream unreachable: " + (e && e.message) } }); }
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
    listen: () => new Promise(r => server.listen(state.cfg.port, state.host || "127.0.0.1", () => r(server.address()))),
    close: () => new Promise(r => server.close(r)),
    stats,
  };
}

function json(res, status, obj) { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); }
function readBody(req) { return new Promise((res, rej) => { const c = []; req.on("data", d => c.push(d)); req.on("end", () => res(Buffer.concat(c).toString("utf8"))); req.on("error", rej); }); }
