// GENERATED from presidio-fr-extension/src/recognizers.js by scripts/sync-engine.mjs — do not edit here.
// French PII recognizers, ported from the presidio-fr Python package.
// Plain script (no modules) so it can be shared by MV3 content scripts and Node tests.
(function (root) {
  function luhnOk(digits) {
    let total = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = +digits[digits.length - 1 - i];
      if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
      total += d;
    }
    return total % 10 === 0;
  }
  function nirOk(nir) {
    const body = nir.slice(0, 13).toUpperCase().replace("2A", "19").replace("2B", "18");
    const key = nir.slice(13);
    if (!/^\d{13}$/.test(body) || !/^\d{2}$/.test(key)) return false;
    return +key === 97 - (Number(body) % 97);
  }
  function ibanOk(iban) {
    const s = iban.slice(4) + iban.slice(0, 4);
    const num = s.replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
    let rem = 0;
    for (const ch of num) rem = (rem * 10 + +ch) % 97;
    return rem === 1;
  }
  const compact = s => s.replace(/[\s.-]/g, "");

  // Order matters: longer / more specific first so overlaps resolve correctly.
  const RECOGNIZERS = [
    { type: "NIR", re: /\b[12]\s?\d{2}\s?(?:0[1-9]|1[0-2]|[2-9]\d)\s?(?:\d{2}|2[AB])\s?\d{3}\s?\d{3}\s?\d{2}\b/g, validate: s => nirOk(compact(s)) },
    { type: "IBAN", re: /\bFR\d{2}(?:\s?[A-Z0-9]{4}){5}\s?[A-Z0-9]{3}\b/g, validate: s => ibanOk(compact(s)) },
    { type: "SIRET", re: /\b\d{3}\s?\d{3}\s?\d{3}\s?\d{5}\b/g, validate: s => luhnOk(compact(s)) },
    { type: "SIREN", re: /\b\d{3}\s?\d{3}\s?\d{3}\b/g, validate: s => luhnOk(compact(s)) },
    { type: "EMAIL", re: /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g },
    { type: "TEL", re: /(?:\+33\s?[1-9]|\b0[1-9])(?:[\s.-]?\d{2}){4}\b/g },
    { type: "PASSEPORT", re: /\b\d{2}[A-Z]{2}\d{5}\b/g },
    { type: "PLAQUE", re: /\b(?!SS)[A-HJ-NP-TV-Z]{2}[- ]?\d{3}[- ]?(?!SS)[A-HJ-NP-TV-Z]{2}\b/g },
    // No public checksum: only fires when the message talks about tax.
    { type: "FISCAL", re: /\b[0-3](?:\d\s?){11}\d\b/g, context: /fiscal|\bspi\b|imp[oô]t|imposition|dgfip/i },
  ];

  // Returns non-overlapping matches: [{type, start, end, text}]
  function findPII(text) {
    const found = [];
    for (const r of RECOGNIZERS) {
      if (r.context && !r.context.test(text)) continue;
      r.re.lastIndex = 0;
      let m;
      while ((m = r.re.exec(text)) !== null) {
        if (r.validate && !r.validate(m[0])) continue;
        found.push({ type: r.type, start: m.index, end: m.index + m[0].length, text: m[0] });
      }
    }
    found.sort((a, b) => a.start - b.start || b.end - a.end);
    const out = [];
    let lastEnd = -1;
    for (const f of found) {
      if (f.start >= lastEnd) { out.push(f); lastEnd = f.end; }
    }
    return out;
  }

  const api = { findPII, luhnOk, nirOk, ibanOk, RECOGNIZERS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PFR = Object.assign(root.PFR || {}, api);
})(typeof globalThis !== "undefined" ? globalThis : this);
