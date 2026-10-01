// Protocol-aware masking of an inference request body.
//   openai    : POST /v1/chat/completions  — messages[].content (string | [{type:"text",text}]), tool results,
//               assistant tool_calls[].function.arguments (JSON string)
//   anthropic : POST /v1/messages          — system (string | [{type:"text",text}]), messages[].content blocks
// Only text leaves are touched; everything else (ids, signatures, images, encrypted blocks) is replayed as is.
import { createRequire } from "node:module";
import { createAllocator } from "./placeholders.mjs";

const require = createRequire(import.meta.url);
const { findPII } = require("./engine/recognizers.cjs");
const { combine } = require("./engine/nermap.cjs");

export const NOTICE = "Certaines valeurs de cette conversation ont été remplacées par des marqueurs de la forme " +
  "{{TYPE_xxxxxxxx}} (données personnelles masquées localement). Traitez chaque marqueur comme un libellé opaque : " +
  "recopiez-le tel quel quand vous devez y faire référence, ne le modifiez pas, n'inventez pas de marqueur et " +
  "ne devinez jamais la valeur qu'il cache.";

// Walk every text leaf; `visit(text) -> newText`.
function walkOpenAI(body, visit) {
  for (const m of body.messages || []) {
    if (typeof m.content === "string") m.content = visit(m.content, m.role);
    else if (Array.isArray(m.content)) for (const p of m.content) if (p && p.type === "text" && typeof p.text === "string") p.text = visit(p.text, m.role);
    for (const c of m.tool_calls || []) if (c.function && typeof c.function.arguments === "string") c.function.arguments = visit(c.function.arguments, "tool_call");
  }
}
function walkAnthropic(body, visit) {
  if (typeof body.system === "string") body.system = visit(body.system, "system");
  else if (Array.isArray(body.system)) for (const p of body.system) if (p && p.type === "text" && typeof p.text === "string") p.text = visit(p.text, "system");
  for (const m of body.messages || []) {
    if (typeof m.content === "string") m.content = visit(m.content, m.role);
    else if (Array.isArray(m.content)) for (const p of m.content) {
      if (!p) continue;
      if (p.type === "text" && typeof p.text === "string") p.text = visit(p.text, m.role);
      if (p.type === "tool_result") {
        if (typeof p.content === "string") p.content = visit(p.content, "tool_result");
        else if (Array.isArray(p.content)) for (const q of p.content) if (q && q.type === "text" && typeof q.text === "string") q.text = visit(q.text, "tool_result");
      }
      if (p.type === "tool_use" && p.input && typeof p.input === "object") {
        const s = JSON.stringify(p.input), r = visit(s, "tool_call");
        if (r !== s) { try { p.input = JSON.parse(r); } catch (_) { /* keep original if the rewrite broke JSON */ } }
      }
    }
  }
}

// maskRequest(protocol, body, {key, ner: async text -> raw nym spans, notice, types: {TYPE: bool}}) -> {body, map, findings}
export async function maskRequest(protocol, body, { key, ner, notice = true, types = null }) {
  const bodyText = JSON.stringify(body);
  const alloc = createAllocator(key, { bodyText });
  const findings = {};            // type -> count (never values)
  const leaves = [];
  const collect = (text, role) => { leaves.push({ text, role }); return text; };
  (protocol === "anthropic" ? walkAnthropic : walkOpenAI)(body, collect);

  const redacted = new Map();
  for (const leaf of leaves) {
    if (!leaf.text.trim() || redacted.has(leaf.text)) continue;
    const regex = findPII(leaf.text);
    const raw = ner ? await ner(leaf.text) : [];
    let matches = combine(leaf.text, regex, raw);
    if (types) matches = matches.filter(m => types[m.type] !== false);   // policy: a type switched off is left in clear
    if (!matches.length) continue;
    for (const m of matches) findings[m.type] = (findings[m.type] || 0) + 1;
    redacted.set(leaf.text, alloc.redact(leaf.text, matches));
  }
  const apply = (text) => redacted.get(text) ?? text;
  (protocol === "anthropic" ? walkAnthropic : walkOpenAI)(body, apply);

  if (notice && alloc.map.size) injectNotice(protocol, body);
  return { body, map: alloc.map, findings };
}

function injectNotice(protocol, body) {
  if (protocol === "anthropic") {
    if (typeof body.system === "string") { if (!body.system.includes(NOTICE)) body.system = NOTICE + "\n\n" + body.system; }
    else if (Array.isArray(body.system)) { if (!body.system.some(p => p && p.text && p.text.includes(NOTICE))) body.system.unshift({ type: "text", text: NOTICE }); }
    else body.system = NOTICE;
    return;
  }
  const msgs = body.messages || (body.messages = []);
  if (msgs.some(m => (m.role === "system" || m.role === "developer") && typeof m.content === "string" && m.content.includes(NOTICE))) return;
  msgs.unshift({ role: "system", content: NOTICE });
}
