// GENERATED from presidio-fr-extension/src/license.js by scripts/sync-engine.mjs — do not edit here.
// Offline licence keys: Ed25519-signed, verified in the browser with WebCrypto. No licence server, so the
// "nothing leaves your browser" promise holds. Key format:
//   PFR1.<base64url payload>.<base64url signature>
//   payload = JSON {"e":"email","p":"pro","s":seats,"x":"2027-10-01"}
// A 14-day trial starts at install. Without a valid key after the trial, the extension keeps the rules
// but switches the model and attachments off (free tier). Replace PUBLIC_KEY with the output of
// `node scripts/license.mjs keygen`; the private key never leaves the vendor's machine.
(function (root) {
  const PUBLIC_KEY_JWK = { kty: "OKP", crv: "Ed25519", x: "REPLACE_WITH_PUBLIC_KEY" };
  const TRIAL_DAYS = 14;

  const b64u = {
    decode(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); },
    encode(bytes) { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
  };

  async function verifyKey(key, jwk) {
    if (typeof key !== "string") return { valid: false, reason: "empty" };
    const parts = key.trim().split(".");
    if (parts.length !== 3 || parts[0] !== "PFR1") return { valid: false, reason: "format" };
    let payload;
    try { payload = JSON.parse(new TextDecoder().decode(b64u.decode(parts[1]))); } catch (_) { return { valid: false, reason: "payload" }; }
    try {
      const pub = await crypto.subtle.importKey("jwk", jwk || PUBLIC_KEY_JWK, { name: "Ed25519" }, false, ["verify"]);
      const ok = await crypto.subtle.verify({ name: "Ed25519" }, pub, b64u.decode(parts[2]), new TextEncoder().encode(parts[1]));
      if (!ok) return { valid: false, reason: "signature" };
    } catch (e) { return { valid: false, reason: "crypto:" + (e && e.message) }; }
    if (!payload.x || new Date(payload.x + "T23:59:59Z") < new Date()) return { valid: false, reason: "expired", payload };
    return { valid: true, payload };
  }

  // entitlement(): {tier: "licensed"|"trial"|"free", until, email, seats, reason}
  async function entitlement(storage) {
    const st = storage || chrome.storage.local;
    const { licenseKey, installedAt } = await st.get({ licenseKey: "", installedAt: 0 });
    if (licenseKey) {
      const v = await verifyKey(licenseKey);
      if (v.valid) return { tier: "licensed", until: v.payload.x, email: v.payload.e, seats: v.payload.s || 1 };
      var reason = v.reason;
    }
    let start = installedAt;
    if (!start) { start = Date.now(); await st.set({ installedAt: start }); }
    const until = start + TRIAL_DAYS * 86400000;
    if (Date.now() < until) return { tier: "trial", until: new Date(until).toISOString().slice(0, 10), reason };
    return { tier: "free", reason };
  }

  const api = { verifyKey, entitlement, b64u, TRIAL_DAYS, PUBLIC_KEY_JWK };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PFR = Object.assign(root.PFR || {}, api);
})(typeof globalThis !== "undefined" ? globalThis : this);
