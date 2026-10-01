// Placeholder allocation for the gateway. Unlike the extension's counter vault, the gateway is stateless
// across requests: every turn replays the whole history, so the placeholder for a value must be the same
// on every turn without remembering anything. It is derived with HMAC(key, kind, value) (the AstrLink
// design): deterministic for one key, not reversible by enumeration, rotated only when the key changes.
import { createHmac } from "node:crypto";

const SUFFIX_HEX = 8;

export function createAllocator(key, { bodyText = "" } = {}) {
  if (!key || key.length < 16) throw new Error("placeholder key must be at least 16 bytes");
  const map = new Map();          // placeholder -> original (this request only)
  const seen = new Map();         // kind|normalised value -> placeholder
  const norm = (v) => v.replace(/[\s.-]/g, "");

  function derive(kind, value, trial) {
    return createHmac("sha256", key).update(kind).update("\0").update(norm(value)).update("\0").update(String(trial)).digest("hex").slice(0, SUFFIX_HEX);
  }

  // Same value (ignoring spacing) -> same placeholder. A derived candidate that already occurs in the
  // request body as literal text would be "restored" into genuine content, so it is re-derived.
  function allocate(kind, value) {
    const k = kind + "|" + norm(value);
    if (seen.has(k)) return seen.get(k);
    for (let trial = 0; trial < 64; trial++) {
      const ph = "{{" + kind + "_" + derive(kind, value, trial) + "}}";
      if (map.has(ph) || bodyText.includes(ph)) continue;
      seen.set(k, ph);
      map.set(ph, value);
      return ph;
    }
    throw new Error("placeholder namespace exhausted for " + kind);
  }

  // redact(text, matches) with matches from findPII/combine: [{type,start,end,text}] sorted, non-overlapping
  function redact(text, matches) {
    let out = "", cursor = 0;
    for (const m of matches) {
      out += text.slice(cursor, m.start) + allocate(m.type, text.slice(m.start, m.end));
      cursor = m.end;
    }
    return out + text.slice(cursor);
  }

  return { allocate, redact, map };
}

export const PLACEHOLDER = /\{\{([A-Z]+)_([0-9a-f]{8})\}\}/g;
export const isPlaceholder = (s) => { PLACEHOLDER.lastIndex = 0; return PLACEHOLDER.test(s); };
