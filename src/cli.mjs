#!/usr/bin/env node
// presidio-fr-core: start the local privacy gateway and its control panel.
//   PFR_DATA_DIR   where config.json, registre.jsonl, the placeholder key and the model cache live (default ./data)
//   First start only (seeds data/config.json): PFR_PORT, OPENAI_API_KEY / MISTRAL_API_KEY / ANTHROPIC_API_KEY,
//   OPENAI_BASE / MISTRAL_BASE / ANTHROPIC_BASE, PFR_DEFAULT_UPSTREAM, PFR_NER=off. Afterwards: the panel.
//   PFR_SHOW_MASKED=1 prints the masked last message (placeholders only) for live verification.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createGateway } from "./server.mjs";
import { loadConfig } from "./config.mjs";

// Launched by the desktop shell: exit as soon as the parent's stdin pipe closes (parent gone).
if (process.env.PFR_PARENT_WATCH === "1") {
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
  process.stdin.on("error", () => process.exit(0));
  process.stdin.resume();
}

const dataDir = path.resolve(process.env.PFR_DATA_DIR || "data");
fs.mkdirSync(dataDir, { recursive: true });

// The placeholder key persists so a value keeps its placeholder across restarts. It never leaves the
// machine; delete the file to rotate.
const keyFile = path.join(dataDir, "placeholder.key");
if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });

const state = { cfg: loadConfig(dataDir), key: fs.readFileSync(keyFile), dataDir, ner: null, model: { status: "off" }, host: "127.0.0.1" };

// The model loads in the background; until it is ready, requests that need it are refused (fail closed),
// not forwarded in clear. Switching the model off in the panel makes requests pass with rules only.
let loading = null;
async function ensureModel() {
  if (state.ner || loading) return loading;
  state.model = { status: "loading", pct: 0 };
  loading = (async () => {
    try {
      const m = await import("./engine/ner.mjs");
      m.configure({ cacheDir: path.join(dataDir, "models") });
      await m.load((p) => { if (p.status === "progress" && p.file && p.file.endsWith(".onnx")) state.model = { status: "loading", pct: Math.round(p.progress) }; });
      state.ner = (text) => m.nerSpans(text);
      state.model = { status: "ready" };
      console.log("local model ready");
    } catch (e) {
      state.model = { status: "error", error: String(e && e.message || e) };
      console.error("local model failed to load:", state.model.error);
    } finally { loading = null; }
  })();
  return loading;
}
state.onConfigChange = (cfg) => { if (cfg.policy.ner && !state.ner) ensureModel(); };
if (state.cfg.policy.ner) ensureModel();

const gw = createGateway(state);
const addr = await gw.listen();
const ups = Object.keys(state.cfg.upstreams);
console.log(`presidio-fr-core listening on http://127.0.0.1:${addr.port}`);
console.log(`  panel     http://127.0.0.1:${addr.port}/        (${ups.length ? "upstreams: " + ups.join(", ") + "; default " + state.cfg.defaultUpstream : "no upstream yet — add one in the panel"})`);
console.log(`  clients   base URL http://127.0.0.1:${addr.port}/v1   registre /registre.csv   model ${state.cfg.policy.ner ? "loading" : "off"}`);
