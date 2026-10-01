import test from "node:test";
import assert from "node:assert/strict";
import { createAllocator, isPlaceholder } from "../src/placeholders.mjs";
import { restoreText, createStreamRestorer } from "../src/restore.mjs";
import { maskRequest, NOTICE } from "../src/mask.mjs";

const KEY = Buffer.from("0123456789abcdef0123456789abcdef");

test("placeholders: deterministic per key and value, spacing-insensitive, never collides with body text", () => {
  const a = createAllocator(KEY), b = createAllocator(KEY), c = createAllocator(Buffer.from("another-key-another-key-another-"));
  const p1 = a.allocate("SIRET", "552 100 554 00013");
  assert.equal(p1, b.allocate("SIRET", "55210055400013"));           // same value, other request, other spacing
  assert.notEqual(p1, c.allocate("SIRET", "552 100 554 00013"));      // other key -> other placeholder
  assert.notEqual(p1, a.allocate("SIRET", "552 100 554 00014"));
  assert.ok(isPlaceholder(p1) && /^\{\{SIRET_[0-9a-f]{8}\}\}$/.test(p1));
  const d = createAllocator(KEY, { bodyText: "text already containing " + p1 });
  assert.notEqual(d.allocate("SIRET", "552 100 554 00013"), p1);      // would otherwise restore into genuine text
});

test("stream restorer: placeholder split across chunks, loose spellings, lone brace at chunk end", () => {
  const a = createAllocator(KEY);
  const ph = a.allocate("NIR", "185057800608491");
  const r = createStreamRestorer(a.map);
  const chunks = ["Le NIR est ", ph.slice(0, 5), ph.slice(5, 12), ph.slice(12) + " et **", ph, "** fin {"];
  let out = "";
  for (const ch of chunks) out += r.push(ch);
  out += r.flush();
  assert.equal(out, "Le NIR est 185057800608491 et **185057800608491** fin {");
  assert.equal(restoreText("x {{ NIR_" + ph.slice(6, 14) + " }} y", a.map), "x 185057800608491 y");
});

test("maskRequest openai: every text leaf masked, same value same placeholder across turns, notice injected", async () => {
  const body = {
    model: "mistral-large-latest", stream: true,
    messages: [
      { role: "system", content: "Tu es un assistant comptable." },
      { role: "user", content: "Client SIRET 552 100 554 00013, IBAN FR76 3000 6000 0112 3456 7890 189." },
      { role: "assistant", content: "Noté pour le SIRET 55210055400013." },
      { role: "user", content: [{ type: "text", text: "Son mail : jean@cabinet.fr" }, { type: "image_url", image_url: { url: "data:..." } }] },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: "{\"siret\":\"55210055400013\"}" } }] },
      { role: "tool", tool_call_id: "c1", content: "{\"ok\":true,\"iban\":\"FR7630006000011234567890189\"}" },
    ],
  };
  const { body: out, map, findings } = await maskRequest("openai", body, { key: KEY, ner: null });
  const text = JSON.stringify(out);
  for (const leak of ["552 100 554 00013", "55210055400013", "FR76 3000", "FR7630006000011234567890189", "jean@cabinet.fr"]) assert.ok(!text.includes(leak), "leaked " + leak);
  const siretPh = [...map.entries()].find(([, v]) => v.replace(/\s/g, "") === "55210055400013")[0];
  assert.equal(out.messages[3].content, "Noté pour le SIRET " + siretPh + ".");   // index +1: the notice was unshifted; same placeholder on the later turn
  assert.equal(out.messages[5].function?.arguments, undefined);
  assert.ok(out.messages[5].tool_calls[0].function.arguments.includes(siretPh));
  assert.equal(out.messages[0].role, "system");
  assert.ok(out.messages[0].content.startsWith(NOTICE));
  assert.deepEqual(Object.keys(findings).sort(), ["EMAIL", "IBAN", "SIRET"]);
  assert.equal(out.messages[4].content[1].image_url.url, "data:...");
});

test("maskRequest anthropic: system blocks, tool_result and tool_use input", async () => {
  const body = {
    model: "claude-sonnet-5", max_tokens: 100, system: [{ type: "text", text: "Dossier de M. X, NIR 1 85 05 78 006 084 91" }],
    messages: [
      { role: "user", content: [{ type: "text", text: "Plaque AB-123-CD" }] },
      { role: "assistant", content: [{ type: "thinking", thinking: "…", signature: "sig" }, { type: "tool_use", id: "t1", name: "f", input: { tel: "06 12 34 56 78" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "contact 06 12 34 56 78" }] },
    ],
  };
  const { body: out } = await maskRequest("anthropic", body, { key: KEY, ner: null });
  const text = JSON.stringify(out);
  for (const leak of ["1 85 05 78 006 084 91", "AB-123-CD", "06 12 34 56 78"]) assert.ok(!text.includes(leak), "leaked " + leak);
  assert.equal(out.messages[1].content[0].signature, "sig");
  assert.equal(out.system[0].text, NOTICE);
  assert.ok(/^\{\{TEL_/.test(out.messages[1].content[1].input.tel));
});
