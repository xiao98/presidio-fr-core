// Restore placeholders in model output. Two concerns (both from AstrLink's restore layer):
//  - spellings: a model or a markdown stage may write "{{ NIR_1a2b3c4d }}", "{{NIR\_1a2b3c4d}}", "**{{…}}**"
//  - streaming: a placeholder can be split across SSE chunks, so a chunk's tail that could be the start
//    of a placeholder is held back until the next chunk decides.
const LOOSE = /\{\{\s*\**\s*([A-Z]+)\s*(?:\\_|_|-|\s)\s*([0-9a-f]{8})\s*\**\s*\}\}/g;

export function restoreText(text, map) {
  if (!map.size || !text.includes("{{")) return text;
  return text.replace(LOOSE, (m, kind, hex) => map.get("{{" + kind + "_" + hex + "}}") ?? m);
}

// Longest tail of `text` that is a proper prefix of some placeholder spelling (cheap conservative test:
// anything from the last "{{" that has no closing "}}" yet, capped at 40 chars).
function pendingTail(text) {
  const i = text.lastIndexOf("{{");
  if (i === -1) return 0;
  if (text.indexOf("}}", i) !== -1) return 0;
  const tail = text.length - i;
  return tail <= 40 ? tail : 0;
}
// A lone "{" at the very end could be the first half of "{{".
function pendingBrace(text) { return text.endsWith("{") && !text.endsWith("{{") ? 1 : 0; }

export function createStreamRestorer(map) {
  let pending = "";
  return {
    push(chunk) {
      const combined = pending + chunk;
      pending = "";
      const restored = restoreText(combined, map);
      const hold = pendingTail(restored) || pendingBrace(restored);
      if (!hold) return restored;
      pending = restored.slice(restored.length - hold);
      return restored.slice(0, restored.length - hold);
    },
    flush() { const p = pending; pending = ""; return restoreText(p, map); },
  };
}
