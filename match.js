"use strict";
/**
 * M.IRIS — Zahlungsabgleich: reine Matching-Logik (keine Abhängigkeiten, voll testbar).
 *
 * Ordnet einen eingehenden Bank-Umsatz (Enable Banking, normalisiert) einer offenen
 * Bestellung zu. Grundregel (vom Betreiber vorgegeben):
 *   - Der BETRAG muss IMMER exakt stimmen (centgenau, gleiche Währung).
 *   - Steht die Bestellnummer (B####) im Verwendungszweck und der Betrag passt -> sicherer Treffer.
 *   - Sonst über Vor- UND Nachnamen des Überweisers + exakter Betrag (eindeutig).
 *   - Alles Uneindeutige geht zur manuellen Prüfung, wird NIE automatisch bezahlt.
 *
 * confidence: "order_number" | "name"  -> darf automatisch als bezahlt markiert werden
 *             "ambiguous"              -> Review (mehrere Kandidaten / Betrag weicht ab)
 *             "none"                   -> kein/greifbarer Treffer (Dedup-only, außer ref außerhalb Fenster)
 */

const crypto = require("crypto");

/** Deutsche Normalisierung: Kleinschreibung, Umlaute ausschreiben, Diakritika strippen. */
function foldGerman(s) {
  return String(s == null ? "" : s)
    .toLowerCase()
    .replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** SEPA-Strukturtags aus dem Verwendungszweck entfernen (SVWZ+, EREF+, …). */
const SEPA_PREFIXES = ["SVWZ", "EREF", "KREF", "MREF", "CRED", "DEBT", "ABWA", "ABWE", "BREF", "RREF", "IBAN", "BIC", "PURP", "ORCR", "ORMD"];
function stripSepaPrefixes(s) {
  let out = String(s == null ? "" : s);
  const re = new RegExp("\\b(" + SEPA_PREFIXES.join("|") + ")\\+", "gi");
  out = out.replace(re, " ");
  return out.replace(/\s+/g, " ").trim();
}

/** Bestellnummer aus dem Verwendungszweck ziehen (Format B123..B123456).
 *  Nur wenn GENAU EINE eindeutige Nummer vorkommt — bei mehreren ist die Zuordnung unklar (→ Review). */
function extractOrderNumber(remittance) {
  const cleaned = stripSepaPrefixes(remittance);
  const matches = cleaned.match(/B\d{3,6}/gi) || [];
  const uniq = Array.from(new Set(matches.map((m) => m.toUpperCase())));
  return uniq.length === 1 ? uniq[0] : null;
}

/** Centgenauer Betragsvergleich. */
function centEquals(a, b) {
  const na = Number(a), nb = Number(b);
  if (!isFinite(na) || !isFinite(nb)) return false;
  return Math.round(na * 100) === Math.round(nb * 100);
}

/** In gefaltete Tokens zerlegen (nur alphanumerisch, min. 2 Zeichen). */
function tokenize(s) {
  return foldGerman(s).split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
}

/** Vor-/Nachname einer Bestellung ermitteln (Lieferadresse bevorzugt, sonst customerName). */
function orderNameParts(order) {
  const sa = order.shippingAddress || {};
  let first = sa.firstName || "";
  let last = sa.lastName || "";
  if (!first && !last) {
    const parts = String(order.customerName || "").trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) { first = parts[0]; last = parts[parts.length - 1]; }
    else if (parts.length === 1) { last = parts[0]; }
  }
  return { firstTokens: tokenize(first), lastTokens: tokenize(last) };
}

/**
 * Payer-Name-Abgleich: Vor- UND Nachname müssen als BENACHBARTE Tokens INNERHALB EINER Quelle
 * (Überweisername ODER Verwendungszweck) vorkommen — kein Pooling über beide Felder, sonst
 * könnten ein Straßenwort (Vorname) und ein Vereins-/Firmenname (Nachname) einen Falsch-Treffer bauen.
 */
function nameMatches(txn, order) {
  const { firstTokens, lastTokens } = orderNameParts(order);
  if (!firstTokens.length || !lastTokens.length) return false; // Vor- UND Nachname nötig
  const sources = [txn.payerName || "", txn.remittance || ""];
  for (const src of sources) {
    const toks = tokenize(src);
    for (let i = 0; i < toks.length - 1; i++) {
      const a = toks[i], b = toks[i + 1];
      if ((firstTokens.includes(a) && lastTokens.includes(b)) || (lastTokens.includes(a) && firstTokens.includes(b))) return true;
    }
  }
  return false;
}

/** Stabiler Dedup-Schlüssel: bevorzugt Bank-Referenz, sonst Hash der Umsatzmerkmale. */
function computeDedupKey(t) {
  const ref = (t.entryReference || t.transactionId || "").trim();
  if (ref) return "ref:" + ref;
  const basis = [t.bookingDate || "", t.amount != null ? String(t.amount) : "", (t.remittance || "").slice(0, 200), t.iban || ""].join("|");
  return "h:" + crypto.createHash("sha256").update(basis).digest("hex").slice(0, 32);
}

/**
 * Kernfunktion. txn (normalisiert): {amount:Number, currency, direction:"CRDT", bookingDate,
 * remittance:String, payerName:String|null, iban:String|null}. unpaid: Array offener Bestellungen
 * {name, totalPrice:Number, currency, customerName, shippingAddress{firstName,lastName}}.
 * -> {orderName|null, confidence, reason, ref, candidates?}
 */
function matchTransaction(txn, unpaid) {
  const amount = Number(txn.amount);
  if (txn.direction && txn.direction !== "CRDT") return { orderName: null, confidence: "none", reason: "not_incoming", ref: null };
  if (!isFinite(amount) || amount <= 0) return { orderName: null, confidence: "none", reason: "not_incoming", ref: null };

  const cur = txn.currency || "EUR";
  const list = Array.isArray(unpaid) ? unpaid : [];
  const amountMatches = list.filter((o) => (o.currency || "EUR") === cur && centEquals(o.totalPrice, amount));

  const ref = extractOrderNumber(txn.remittance);

  // 1) Bestellnummer im Verwendungszweck
  if (ref) {
    const order = list.find((o) => String(o.name || "").toUpperCase() === ref);
    if (order) {
      if ((order.currency || "EUR") === cur && centEquals(order.totalPrice, amount)) {
        return { orderName: order.name, confidence: "order_number", reason: "order_number_exact", ref };
      }
      return { orderName: order.name, confidence: "ambiguous", reason: "order_number_amount_mismatch", ref };
    }
    // Bestellnr da, aber nicht im geladenen Fenster -> Endpoint prüft gezielt (getOrderPreviewData)
    return { orderName: null, confidence: "none", reason: "order_ref_not_in_window", ref };
  }

  // 2) Name + exakter Betrag — nur EINDEUTIG (genau ein Namens-Treffer UND keine weitere betragsgleiche Order)
  const nameHits = amountMatches.filter((o) => nameMatches(txn, o));
  if (nameHits.length === 1 && amountMatches.length === 1) {
    return { orderName: nameHits[0].name, confidence: "name", reason: "name_amount_exact", ref: null };
  }
  if (nameHits.length >= 1) {
    // Namens-Treffer, aber nicht eindeutig: mehrere Namens-Treffer ODER weitere betragsgleiche Order
    // (Namensvetter/Geschenk-Bestellung) -> nie auto, immer prüfen.
    return {
      orderName: nameHits.length === 1 ? nameHits[0].name : null,
      confidence: "ambiguous",
      reason: nameHits.length > 1 ? "name_multiple" : "name_amount_collision",
      ref: null, candidates: (nameHits.length > 1 ? nameHits : amountMatches).map((o) => o.name),
    };
  }

  // 3) Kein Namens-Treffer
  if (amountMatches.length > 1) {
    return { orderName: null, confidence: "ambiguous", reason: "multiple_amount_matches", ref: null, candidates: amountMatches.map((o) => o.name) };
  }
  if (amountMatches.length === 1) {
    // Betrag passt auf genau eine Bestellung, aber weder Nummer noch Name bestätigen -> prüfen
    return { orderName: amountMatches[0].name, confidence: "ambiguous", reason: "amount_only_single", ref: null };
  }
  return { orderName: null, confidence: "none", reason: "no_amount_match", ref: null };
}

/** Zwei echt verschiedene, aber merkmalsgleiche Umsätze (Hash-Fallback ohne Bankreferenz) über eine
 *  stabile Vorkommens-Ordinalzahl eindeutig machen — sonst würde der zweite als "schon verarbeitet"
 *  verschluckt. Erstes Vorkommen bleibt unverändert (Abwärtskompatibilität + stabiler Cross-Sync-Dedup). */
function applyOrdinalDedup(list) {
  const seen = new Map();
  (list || []).forEach((t) => {
    if (t && typeof t.dedupKey === "string" && t.dedupKey.startsWith("h:")) {
      const n = seen.get(t.dedupKey) || 0;
      seen.set(t.dedupKey, n + 1);
      if (n) t.dedupKey += ":" + n;
    }
  });
  return list;
}

module.exports = { foldGerman, stripSepaPrefixes, extractOrderNumber, centEquals, tokenize, orderNameParts, nameMatches, computeDedupKey, applyOrdinalDedup, matchTransaction };
