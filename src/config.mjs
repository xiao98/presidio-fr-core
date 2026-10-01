// Persistent configuration (data/config.json) edited from the control panel. Environment variables seed
// the file on first start, so `MISTRAL_API_KEY=… npm start` still works with no panel visit.
import fs from "node:fs";
import path from "node:path";

export const TYPES = ["PERSON", "ADDRESS", "COMPANY", "DOB", "NIR", "SIREN", "SIRET", "IBAN", "FISCAL", "PLAQUE", "PASSEPORT", "EMAIL", "TEL", "ID", "CARD", "SECRET"];
const UPSTREAM_DEFAULTS = { openai: "https://api.openai.com", mistral: "https://api.mistral.ai", anthropic: "https://api.anthropic.com" };

export function defaultConfig(env = process.env) {
  const upstreams = {};
  for (const [name, base] of Object.entries(UPSTREAM_DEFAULTS)) {
    const key = env[name.toUpperCase() + "_API_KEY"];
    if (key) upstreams[name] = { base: env[name.toUpperCase() + "_BASE"] || base, apiKey: key };
  }
  return {
    port: Number(env.PFR_PORT || 8787),
    upstreams,
    defaultUpstream: env.PFR_DEFAULT_UPSTREAM || Object.keys(upstreams)[0] || "",
    policy: { types: Object.fromEntries(TYPES.map(t => [t, true])), ner: env.PFR_NER !== "off", notice: true },
    licenseKey: "",
    installedAt: Date.now(),
  };
}

export function loadConfig(dataDir, env = process.env) {
  const file = path.join(dataDir, "config.json");
  let cfg = defaultConfig(env);
  if (fs.existsSync(file)) {
    try { cfg = merge(cfg, JSON.parse(fs.readFileSync(file, "utf8"))); } catch (e) { console.error("config.json unreadable, using defaults:", e.message); }
  } else {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  }
  return cfg;
}

export function saveConfig(dataDir, cfg) {
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function merge(base, over) {
  const out = { ...base, ...over };
  out.policy = { ...base.policy, ...(over.policy || {}), types: { ...base.policy.types, ...((over.policy || {}).types || {}) } };
  out.upstreams = over.upstreams || base.upstreams;
  return out;
}

// What the panel may change, validated. Returns the new config or throws.
export function applyPanelUpdate(cfg, patch) {
  const next = JSON.parse(JSON.stringify(cfg));
  if (patch.upstreams) {
    for (const [name, u] of Object.entries(patch.upstreams)) {
      if (!UPSTREAM_DEFAULTS[name]) throw new Error("unknown upstream " + name);
      if (u === null) { delete next.upstreams[name]; continue; }
      const prev = next.upstreams[name] || {};
      next.upstreams[name] = { base: String(u.base || prev.base || UPSTREAM_DEFAULTS[name]).replace(/\/+$/, ""), apiKey: u.apiKey === undefined || u.apiKey === "" ? prev.apiKey || "" : String(u.apiKey) };
      if (!/^https?:\/\//.test(next.upstreams[name].base)) throw new Error("base URL must start with http(s)://");
    }
  }
  if (patch.defaultUpstream !== undefined) {
    if (patch.defaultUpstream && !next.upstreams[patch.defaultUpstream]) throw new Error("default upstream is not configured");
    next.defaultUpstream = patch.defaultUpstream;
  }
  if (!next.defaultUpstream || !next.upstreams[next.defaultUpstream]) next.defaultUpstream = Object.keys(next.upstreams)[0] || "";
  if (patch.policy) {
    if (patch.policy.types) for (const [t, v] of Object.entries(patch.policy.types)) { if (!TYPES.includes(t)) throw new Error("unknown type " + t); next.policy.types[t] = !!v; }
    if (patch.policy.ner !== undefined) next.policy.ner = !!patch.policy.ner;
    if (patch.policy.notice !== undefined) next.policy.notice = !!patch.policy.notice;
  }
  if (patch.licenseKey !== undefined) next.licenseKey = String(patch.licenseKey).trim();
  return next;
}

// What the panel is allowed to see: keys are masked to their last 4 characters.
export function publicConfig(cfg) {
  const upstreams = {};
  for (const [n, u] of Object.entries(cfg.upstreams)) upstreams[n] = { base: u.base, apiKey: u.apiKey ? "••••" + u.apiKey.slice(-4) : "", configured: !!u.apiKey };
  return { port: cfg.port, upstreams, defaultUpstream: cfg.defaultUpstream, policy: cfg.policy, licenseKey: cfg.licenseKey ? "••••" + cfg.licenseKey.slice(-6) : "", installedAt: cfg.installedAt };
}
