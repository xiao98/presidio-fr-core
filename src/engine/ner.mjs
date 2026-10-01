// GENERATED from presidio-fr-extension/src/ner.mjs by scripts/sync-engine.mjs — do not edit here.
// NER layer: Wismut/nym-pii-multilingual-small (edge-int8 ONNX) via transformers.js.
// Shared by the extension's offscreen document and the Node tests. Returns raw model spans;
// mapping to product labels lives in nermap.js.
import { env, AutoTokenizer, AutoModelForTokenClassification } from "@huggingface/transformers";

export const REPO = "Wismut/nym-pii-multilingual-small";
const SUBFOLDER = "edge-int8";
const ARGMAX = typeof process !== "undefined" && process.env && process.env.PFR_DECODE === "argmax";

let tokenizer, model, id2label, loading;

export function configure(opts = {}) {
  if (opts.cacheDir) { env.cacheDir = opts.cacheDir; env.useFSCache = true; }
  if (opts.wasmPaths) env.backends.onnx.wasm.wasmPaths = opts.wasmPaths;
  if (opts.numThreads) env.backends.onnx.wasm.numThreads = opts.numThreads;
  env.allowLocalModels = false;
}

export async function load(progress_callback) {
  if (tokenizer && model) return;
  if (!loading) {
    loading = (async () => {
      tokenizer = await AutoTokenizer.from_pretrained(REPO, { progress_callback });
      model = await AutoModelForTokenClassification.from_pretrained(REPO, {
        subfolder: SUBFOLDER, model_file_name: "model_int8", dtype: "fp32", progress_callback,
      });
      id2label = model.config.id2label;
    })();
  }
  await loading;
}

export function isReady() { return !!(tokenizer && model); }

// Align SentencePiece tokens back to character offsets (transformers.js does not return offset mappings).
function tokenOffsets(text, toks) {
  const special = new Set(tokenizer.all_special_tokens || []);
  const out = new Array(toks.length).fill(null);
  let cursor = 0;
  for (let i = 0; i < toks.length; i++) {
    let t = toks[i];
    if (special.has(t)) continue;
    if (t.startsWith("<0x") && t.endsWith(">")) continue;       // byte-fallback piece: skip, next real piece re-anchors
    t = t.replace(/^▁+/, "");
    if (!t) continue;
    let idx = text.indexOf(t, cursor);
    if (idx === -1 || idx - cursor > 8) {                        // tolerate small normaliser drift, else re-scan
      const alt = text.indexOf(t, Math.max(0, cursor - 2));
      if (alt === -1) continue;
      idx = alt;
    }
    out[i] = [idx, idx + t.length];
    cursor = idx + t.length;
  }
  return out;
}

export async function nerSpans(text) {
  await load();
  // transformers.js v4 wraps a Rust-port tokenizer; its encode() gives token strings but no offsets.
  const raw = tokenizer._tokenizer.encode(text);
  const offsets = tokenOffsets(text, raw.tokens);
  const enc = await tokenizer(text, { add_special_tokens: true });
  if (enc.input_ids.dims[1] !== raw.ids.length) throw new Error("tokenizer length mismatch");
  const { logits } = await model(enc);
  const [, T, L] = logits.dims;
  const data = logits.data;
  // Recall-first decoding (nym's redaction mode): a token is an entity when P(O) < 0.5, i.e. when the
  // total entity mass wins even if it is spread over several labels; the kind is the best entity label
  // with B and I mass pooled. Plain argmax lets "XIAO HAO 12 rue…" fall to O because the mass splits
  // between STREET_ADDRESS, COMPANY_NAME and SURNAME.
  const kinds = [], kindIdx = new Map();
  const labKind = new Array(L), labTag = new Array(L);
  for (let l = 0; l < L; l++) {
    const lab = id2label[l], dash = lab.indexOf("-");
    labTag[l] = dash === -1 ? lab : lab.slice(0, dash);
    const k = dash === -1 ? "" : lab.slice(dash + 1);
    labKind[l] = k;
    if (k && !kindIdx.has(k)) { kindIdx.set(k, kinds.length); kinds.push(k); }
  }
  const spans = [];
  let cur = null;
  const mass = new Float64Array(kinds.length), bMass = new Float64Array(kinds.length);
  for (let t = 0; t < T; t++) {
    const off = offsets[t];
    if (!off) continue;
    let maxV = -Infinity, sum = 0;
    for (let l = 0; l < L; l++) { const v = data[t * L + l]; if (v > maxV) maxV = v; }
    for (let l = 0; l < L; l++) sum += Math.exp(data[t * L + l] - maxV);
    mass.fill(0); bMass.fill(0);
    let pO = 0;
    for (let l = 0; l < L; l++) {
      const p = Math.exp(data[t * L + l] - maxV) / sum;
      if (labTag[l] === "O") { pO += p; continue; }
      const k = kindIdx.get(labKind[l]);
      mass[k] += p;
      if (labTag[l] === "B") bMass[k] += p;
    }
    // PFR_DECODE=argmax reproduces plain argmax decoding (ablation only; never set in the product)
    const argmaxO = ARGMAX && (() => { let b = 0; for (let l = 1; l < L; l++) if (data[t * L + l] > data[t * L + b]) b = l; return labTag[b] === "O"; })();
    if (pO >= 0.5 || argmaxO) { cur = null; continue; }
    let k = 0;
    for (let i = 1; i < kinds.length; i++) if (mass[i] > mass[k]) k = i;
    const kind = kinds[k], score = 1 - pO;
    const isB = bMass[k] > mass[k] - bMass[k];
    if (isB || !cur || cur.label !== kind) {
      cur = { label: kind, start: off[0], end: off[1], score };
      spans.push(cur);
    } else {
      cur.end = off[1];
      cur.score = Math.min(cur.score, score);
    }
  }
  for (const s of spans) s.text = text.slice(s.start, s.end);
  return spans;
}
