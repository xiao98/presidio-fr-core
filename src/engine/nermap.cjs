// GENERATED from presidio-fr-extension/src/nermap.js by scripts/sync-engine.mjs — do not edit here.
// Map raw nym labels to product labels, drop what the benchmark showed to be noise, merge name parts.
// Plain script: shared by the content script (browser) and Node tests.
(function (root) {
  const LABEL = {
    GIVEN_NAME: "PERSON", SURNAME: "PERSON",
    STREET_ADDRESS: "ADDRESS", STREET_NAME: "ADDRESS", BUILDING_NUMBER: "ADDRESS", ZIP_CODE: "ADDRESS",
    CITY: "ADDRESS", SECONDARY_ADDRESS: "ADDRESS",
    COMPANY_NAME: "COMPANY", DATE_OF_BIRTH: "DOB",
    // DATE is only kept when the text says it is a birth date (FR-PII-Bench: generic DATE = invoice dates = false masks)
    DATE: "DOB?",
    PASSPORT: "PASSEPORT", LICENSE_PLATE: "PLAQUE", IBAN: "IBAN", EMAIL: "EMAIL", PHONE: "PHONE",
    SSN: "NIR", GOVERNMENT_ID: "ID", TAX_ID: "ID", CREDIT_DEBIT_CARD: "CARD", API_KEY: "SECRET", PASSWORD: "SECRET",
  };
  const BIRTH_CTX = /\bn[ée]e?s?\s*(?:\(e\))?\s*(?:le|à|a)?\s*$|naissance\s*(?::|le)?\s*$/i;
  const MIN_SCORE = 0.5;

  // spans: raw nym spans [{label,start,end,score}] -> [{type,start,end,text}] sorted, non-overlapping
  function mapSpans(text, spans) {
    const out = [];
    for (const s of spans) {
      if (s.score < MIN_SCORE) continue;
      let type = LABEL[s.label];
      if (!type) continue;
      if (type === "DOB?") {
        if (!BIRTH_CTX.test(text.slice(Math.max(0, s.start - 24), s.start))) continue;
        type = "DOB";
      }
      out.push({ type, start: s.start, end: s.end });
    }
    out.sort((a, b) => a.start - b.start || b.end - a.end);
    // merge adjacent pieces of the same type (GIVEN_NAME + SURNAME, street + zip + city)
    const merged = [];
    for (const s of out) {
      const last = merged[merged.length - 1];
      const gap = last ? text.slice(last.end, s.start) : null;
      if (last && last.type === s.type && s.start >= last.end && /^[\s,'-]{0,3}$/.test(gap)) {
        last.end = Math.max(last.end, s.end);
      } else if (!last || s.start >= last.end) {
        merged.push({ type: s.type, start: s.start, end: s.end });
      }
    }
    for (const m of merged) m.text = text.slice(m.start, m.end);
    return merged;
  }

  // Administrative "NOM Prénom" / "XIAO HAO": a run of 2–4 all-caps words. The model misses ~45% of these
  // on FR-PII-Bench, so a rule covers them. Acronyms and shouted words are excluded by a stoplist.
  const CAPS_STOP = new Set(("SARL SAS SA SASU EURL SCI SNC SCP SELARL TVA HT TTC SIRET SIREN NIR IBAN BIC RIB CAF CPAM URSSAF RCS INSEE DGFIP " +
    "CDI CDD RH PV PDF URL API OK NB CC RE FW TR ID NIF SPI APE NAF KBIS RIB URGENT MERCI BONJOUR ATTENTION TOTAL FACTURE DEVIS " +
    "CONTRAT AVENANT ANNEXE ARTICLE NOTE OBJET REF DATE LIEU ETAT ETATS FRANCE PARIS LYON MARSEILLE EU UE USA CHATGPT GPT AI IA " +
    // document headings
    "BULLETIN PAIE ATTESTATION EMPLOYEUR AVIS CONTRAVENTION TRAVAIL DURÉE DUREE INDÉTERMINÉE INDETERMINEE DÉTERMINÉE DETERMINEE " +
    "CERTIFICAT COURRIER LETTRE RELEVÉ RELEVE DÉCLARATION DECLARATION DEMANDE FORMULAIRE DOSSIER PROCÈS VERBAL RAPPORT COMPTE RENDU " +
    "CONDITIONS GÉNÉRALES GENERALES VENTE MANDAT PROCURATION CONVENTION ACCORD SOCIÉTÉ SOCIETE ENTREPRISE CABINET CAISSE ALLOCATIONS FAMILIALES").split(" "));
  // function words inside a caps run mean a title, not a name ("AVIS DE CONTRAVENTION"); LE/LA are kept (LE GOFF, LA FONTAINE)
  const CAPS_FUNC = new Set("DE DU DES ET À A AU AUX EN SUR POUR PAR SANS AVEC OU".split(" "));
  // 1–3 ALL-CAPS words (XIAO HAO, LE GOFF) optionally followed by 1–2 Capitalised words (DUPONT Jean, LE GOFF Isaac);
  // at least two words in total and one caps word of 3+ letters.
  const CAPS = "[A-ZÀ-ÖØ-Þ][A-ZÀ-ÖØ-Þ'-]+";
  const CAP = "[A-ZÀ-ÖØ-Þ][a-zà-öø-ÿ'-]+";
  const RUN = new RegExp(`(?<![A-Za-zÀ-ÿ])(${CAPS}(?:[ \\u00a0]+${CAPS}){0,2})((?:[ \\u00a0]+${CAP}){0,2})(?![A-Za-zÀ-ÿ])`, "g");
  function capsNames(text) {
    const out = [];
    let m;
    while ((m = RUN.exec(text)) !== null) {
      const caps = m[1].split(/[  ]+/);
      if (caps.some(w => CAPS_STOP.has(w.replace(/['-]/g, "")) || CAPS_FUNC.has(w))) continue;
      if (!caps.some(w => w.length >= 3)) continue;
      const words = m[0].trim().split(/[  ]+/);
      if (words.length < 2) continue;
      out.push({ type: "PERSON", start: m.index, end: m.index + m[0].length, text: m[0] });
    }
    return out;
  }

  // Cut `s` by every authoritative span it overlaps; returns the surviving pieces (0, 1 or 2 per cut).
  function subtract(text, s, auth) {
    let pieces = [s];
    for (const a of auth) {
      const next = [];
      for (const p of pieces) {
        if (Math.min(a.end, p.end) <= Math.max(a.start, p.start)) { next.push(p); continue; }
        if (p.start < a.start) next.push({ type: p.type, start: p.start, end: a.start });
        if (a.end < p.end) next.push({ type: p.type, start: a.end, end: p.end });
      }
      pieces = next;
    }
    return pieces.map(p => {
      // trim whitespace / punctuation left at the cut
      let { start, end } = p;
      while (start < end && /[\s,;:()]/.test(text[start])) start++;
      while (end > start && /[\s,;:()]/.test(text[end - 1])) end--;
      return { type: p.type, start, end, text: text.slice(start, end) };
    }).filter(p => p.end - p.start >= 2);
  }

  // Combine: regex (structured ids) and caps-name rule are authoritative; NER spans are trimmed around them.
  function combine(text, regexMatches, nerRaw) {
    const auth = regexMatches.map(m => ({ type: m.type, start: m.start, end: m.end, text: m.text, src: "regex" }));
    for (const c of capsNames(text)) {
      if (auth.some(a => Math.min(a.end, c.end) > Math.max(a.start, c.start))) continue;
      auth.push({ ...c, src: "rule" });
    }
    const all = auth.slice();
    for (const s of mapSpans(text, nerRaw)) {
      for (const p of subtract(text, s, auth)) all.push({ ...p, src: "ner" });
    }
    return all.sort((a, b) => a.start - b.start);
  }

  const api = { mapSpans, combine, capsNames, LABEL };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PFR = Object.assign(root.PFR || {}, api);
})(typeof globalThis !== "undefined" ? globalThis : this);
