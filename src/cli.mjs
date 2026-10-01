#!/usr/bin/env node
// presidio-fr-core: start the local privacy gateway.
//   PFR_DATA_DIR   where registre.jsonl and the placeholder key live (default ./data)
//   PFR_PORT       default 8787
//   PFR_NER        "off" to run rules only (default: load the local model)
//   OPENAI_API_KEY / MISTRAL_API_KEY / ANTHROPIC_API_KEY   upstream credentials
//   PFR_DEFAULT_UPSTREAM   openai | mistral | anthropic (default: first configured)
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { createGateway } from "./server.mjs";

const dataDir = path.resolve(process.env.PFR_DATA_DIR || "data");
fs.mkdirSync(dataDir, { recursive: true });

// The placeholder key persists so a value keeps its placeholder across restarts (conversation history
// replayed by clients keeps working). It never leaves the machine; delete the file to rotate.
const keyFile = path.join(dataDir, "placeholder.key");
if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, randomBytes(32), { mode: 0o600 });
const key = fs.readFileSync(keyFile);

const upstreams = {};
if (process.env.OPENAI_API_KEY) upstreams.openai = { base: process.env.OPENAI_BASE || "https://api.openai.com", apiKey: process.env.OPENAI_API_KEY };
if (process.env.MISTRAL_API_KEY) upstreams.mistral = { base: process.env.MISTRAL_BASE || "https://api.mistral.ai", apiKey: process.env.MISTRAL_API_KEY };
if (process.env.ANTHROPIC_API_KEY) upstreams.anthropic = { base: process.env.ANTHROPIC_BASE || "https://api.anthropic.com", apiKey: process.env.ANTHROPIC_API_KEY };
const defaultUpstream = process.env.PFR_DEFAULT_UPSTREAM || Object.keys(upstreams)[0];
if (!defaultUpstream) { console.error("no upstream: set MISTRAL_API_KEY, OPENAI_API_KEY or ANTHROPIC_API_KEY"); process.exit(2); }

let ner = null;
if (process.env.PFR_NER !== "off") {
  const m = await import("./engine/ner.mjs");
  m.configure({ cacheDir: path.join(dataDir, "models") });
  process.stdout.write("loading local model… ");
  const t0 = Date.now();
  await m.load((p) => { if (p.status === "progress" && p.file && p.file.endsWith(".onnx")) process.stdout.write(`\rloading local model… ${Math.round(p.progress)}%  `); });
  console.log(`\rlocal model ready in ${((Date.now() - t0) / 1000).toFixed(1)}s      `);
  ner = (text) => m.nerSpans(text);
}

const gw = createGateway({ port: Number(process.env.PFR_PORT || 8787), host: "127.0.0.1", key, dataDir, ner, upstreams, defaultUpstream });
const addr = await gw.listen();
console.log(`presidio-fr-core listening on http://127.0.0.1:${addr.port}  (upstreams: ${Object.keys(upstreams).join(", ")}; default ${defaultUpstream}; model ${ner ? "on" : "off"})`);
console.log(`point any OpenAI-compatible client at http://127.0.0.1:${addr.port}/v1 — registre at /registre.csv`);
