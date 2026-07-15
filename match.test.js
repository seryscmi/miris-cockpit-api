"use strict";
/* Reine Unit-Tests der Matching-Engine (node match.test.js). Kein Server, keine Netze. */
const m = require("./match");

let pass = 0, fail = 0;
function ok(name, cond, extra) { cond ? (pass++, console.log("  ✓ " + name)) : (fail++, console.log("  ✗ " + name + (extra ? " → " + extra : ""))); }
function eq(name, got, want) { ok(name + " (=" + JSON.stringify(want) + ")", JSON.stringify(got) === JSON.stringify(want), "got " + JSON.stringify(got)); }

// Bestellungen (offen)
const O = (name, price, first, last, cur) => ({ name, totalPrice: price, currency: cur || "EUR", customerName: (first ? first + " " : "") + (last || ""), shippingAddress: { firstName: first || "", lastName: last || "" } });
const T = (o) => Object.assign({ amount: 0, currency: "EUR", direction: "CRDT", bookingDate: "2026-07-10", remittance: "", payerName: null, iban: "DE00" }, o);

console.log("\n[Helfer]");
eq("foldGerman Müller", m.foldGerman("Müller"), "mueller");
eq("foldGerman José", m.foldGerman("José"), "jose");
eq("foldGerman Straße", m.foldGerman("Straße"), "strasse");
ok("centEquals 29.99==\"29.99\"", m.centEquals(29.99, "29.99"));
ok("centEquals 29.99!=29.98", !m.centEquals(29.99, 29.98));
eq("extract SVWZ+B2002", m.extractOrderNumber("SVWZ+Vielen Dank B2002"), "B2002");
eq("extract lowercase b1027", m.extractOrderNumber("zahlung b1027"), "B1027");
eq("extract keine Nummer", m.extractOrderNumber("Danke fuers Armband"), null);
eq("stripSepaPrefixes", m.stripSepaPrefixes("EREF+XYZ SVWZ+Zahlung"), "XYZ Zahlung");

console.log("\n[Tier 1 — Bestellnummer]");
let r = m.matchTransaction(T({ amount: 29.99, remittance: "SVWZ+B2002 danke" }), [O("B2002", 29.99, "Lena", "Hoffmann"), O("B2003", 49.99, "Max", "Weber")]);
eq("Bestellnr + exakter Betrag = order_number", { o: r.orderName, c: r.confidence }, { o: "B2002", c: "order_number" });

r = m.matchTransaction(T({ amount: 39.99, remittance: "B2002" }), [O("B2002", 29.99, "Lena", "Hoffmann")]);
eq("Bestellnr aber Betrag falsch = ambiguous(mismatch)", { o: r.orderName, c: r.confidence, reason: r.reason }, { o: "B2002", c: "ambiguous", reason: "order_number_amount_mismatch" });

// SICHERHEIT: Nr zeigt auf B2002, Betrag passt aber zu einer ANDEREN Order -> darf NICHT die andere auto-zahlen
r = m.matchTransaction(T({ amount: 49.99, remittance: "B2002" }), [O("B2002", 29.99, "Lena", "Hoffmann"), O("B2003", 49.99, "Max", "Weber")]);
eq("SICHERHEIT: Nr!=Betrag zahlt NICHT die betragsgleiche andere Order", { o: r.orderName, c: r.confidence }, { o: "B2002", c: "ambiguous" });

r = m.matchTransaction(T({ amount: 29.99, remittance: "B9999" }), [O("B2002", 29.99, "Lena", "Hoffmann")]);
eq("Bestellnr nicht im Fenster = none(order_ref_not_in_window)", { c: r.confidence, reason: r.reason, ref: r.ref }, { c: "none", reason: "order_ref_not_in_window", ref: "B9999" });

console.log("\n[Tier 2 — Name + exakter Betrag]");
r = m.matchTransaction(T({ amount: 49.99, payerName: "Max Mustermann" }), [O("B2001", 49.99, "Max", "Mustermann"), O("B2002", 29.99, "Lena", "Hoffmann")]);
eq("Name eindeutig = name", { o: r.orderName, c: r.confidence }, { o: "B2001", c: "name" });

r = m.matchTransaction(T({ amount: 19.99, payerName: "MUELLER, JAN" }), [O("B3001", 19.99, "Jan", "Müller")]);
eq("Name mit Umlaut/Uppercase/Komma = name", { o: r.orderName, c: r.confidence }, { o: "B3001", c: "name" });

r = m.matchTransaction(T({ amount: 19.99, payerName: null, remittance: "Ueberweisung Jan Mueller" }), [O("B3001", 19.99, "Jan", "Müller")]);
eq("Name aus Verwendungszweck (debtor.name null) = name", { o: r.orderName, c: r.confidence }, { o: "B3001", c: "name" });

// Nachname allein reicht NICHT
r = m.matchTransaction(T({ amount: 19.99, payerName: "Familie Mueller" }), [O("B3001", 19.99, "Jan", "Müller")]);
eq("nur Nachname (Vorname fehlt) = NICHT name (ambiguous amount_only_single)", { c: r.confidence, reason: r.reason }, { c: "ambiguous", reason: "amount_only_single" });

console.log("\n[Uneindeutig -> Review, nie auto]");
r = m.matchTransaction(T({ amount: 29.99, payerName: "Anna Schmidt" }), [O("B4001", 29.99, "Anna", "Schmidt"), O("B4002", 29.99, "Anna", "Schmidt")]);
eq("zwei gleiche Namen+Betrag = ambiguous(name_multiple)", { c: r.confidence, reason: r.reason }, { c: "ambiguous", reason: "name_multiple" });

r = m.matchTransaction(T({ amount: 29.99, payerName: "Fremd Person" }), [O("B4001", 29.99, "Anna", "Schmidt"), O("B4002", 29.99, "Bea", "Klein")]);
eq("zwei betragsgleiche, Name passt zu keiner = ambiguous(multiple_amount_matches)", { c: r.confidence, reason: r.reason }, { c: "ambiguous", reason: "multiple_amount_matches" });

r = m.matchTransaction(T({ amount: 29.99, payerName: "Fremd Person" }), [O("B4001", 29.99, "Anna", "Schmidt")]);
eq("eine betragsgleiche, Name passt nicht = ambiguous(amount_only_single, NICHT auto)", { c: r.confidence, reason: r.reason }, { c: "ambiguous", reason: "amount_only_single" });

r = m.matchTransaction(T({ amount: 99.99, payerName: "Egal" }), [O("B4001", 29.99, "Anna", "Schmidt")]);
eq("kein Betragstreffer = none(no_amount_match)", { c: r.confidence, reason: r.reason }, { c: "none", reason: "no_amount_match" });

r = m.matchTransaction(T({ amount: 29.99, direction: "DBIT" }), [O("B4001", 29.99, "Anna", "Schmidt")]);
eq("Lastschrift/DBIT ignoriert = none(not_incoming)", { c: r.confidence, reason: r.reason }, { c: "none", reason: "not_incoming" });

r = m.matchTransaction(T({ amount: -5, direction: "CRDT" }), [O("B4001", 5, "Anna", "Schmidt")]);
eq("negativer Betrag ignoriert", r.reason, "not_incoming");

console.log("\n[Sicherheit — Befunde der adversariellen Review]");
// (1) Cross-Source-Forgery: Straßenwort = Vorname + Vereins-/Nachname aus zwei Feldern darf NICHT auto
r = m.matchTransaction(T({ amount: 50.00, payerName: "Sportverein Bach e.V.", remittance: "Mitgliedsbeitrag Anna-Weg 3" }), [O("B7000", 50.00, "Anna", "Bach")]);
eq("Cross-Source (Straße+Verein) kein Name-Auto → amount_only_single", { c: r.confidence, reason: r.reason }, { c: "ambiguous", reason: "amount_only_single" });
// echter benachbarter Name im selben Feld matcht weiterhin
r = m.matchTransaction(T({ amount: 50.00, payerName: "Anna Bach" }), [O("B7000", 50.00, "Anna", "Bach")]);
eq("echter Name (benachbart, ein Feld) = name", { o: r.orderName, c: r.confidence }, { o: "B7000", c: "name" });

// (2) Namensvetter/Geschenk: Name trifft eine von ZWEI betragsgleichen Bestellungen → nie auto
r = m.matchTransaction(T({ amount: 49.90, payerName: "Thomas Weber", remittance: "Blumengruss" }), [O("B5001", 49.90, "Ingrid", "Sommer"), O("B5002", 49.90, "Thomas", "Weber")]);
eq("Namensvetter bei 2 betragsgleichen = ambiguous(name_amount_collision), NICHT auto", { o: r.orderName, c: r.confidence, reason: r.reason }, { o: "B5002", c: "ambiguous", reason: "name_amount_collision" });

// (3) Mehrere verschiedene Bestellnummern im Zweck → keine sichere Nummer
eq("zwei verschiedene Bestellnrn → extract null", m.extractOrderNumber("Zahlung B2002 und B2003"), null);
eq("gleiche Nummer doppelt → weiterhin die Nummer", m.extractOrderNumber("B2002 B2002"), "B2002");
r = m.matchTransaction(T({ amount: 29.99, remittance: "B2002 B2003", payerName: "Lena Hoffmann" }), [O("B2002", 29.99, "Lena", "Hoffmann"), O("B4000", 29.99, "Bea", "Klein")]);
eq("2 Nummern + 2 betragsgleiche → nicht order_number-auto", r.confidence === "name" || r.confidence === "ambiguous", true);

// (5) Ordinal-Dedup: zwei identische referenzlose Umsätze bekommen verschiedene Schlüssel
{
  const a = { bookingDate: "2026-07-10", amount: 12.5, remittance: "Danke", iban: "DE9" };
  const b = { bookingDate: "2026-07-10", amount: 12.5, remittance: "Danke", iban: "DE9" };
  const ka = m.computeDedupKey(a), kb = m.computeDedupKey(b);
  ok("identische referenzlose Umsätze → gleicher Roh-Hash", ka === kb);
  const list = [{ dedupKey: ka }, { dedupKey: kb }, { dedupKey: "ref:X" }];
  m.applyOrdinalDedup(list);
  ok("applyOrdinalDedup macht sie eindeutig", list[0].dedupKey !== list[1].dedupKey && list[2].dedupKey === "ref:X", JSON.stringify(list.map(x => x.dedupKey)));
}

console.log("\n[Dedup]");
const t1 = { entryReference: "REF-1", bookingDate: "2026-07-10", amount: 29.99, remittance: "B2002", iban: "DE1" };
ok("entryReference bevorzugt", m.computeDedupKey(t1) === "ref:REF-1");
const t2 = { bookingDate: "2026-07-10", amount: 29.99, remittance: "B2002", iban: "DE1" };
ok("Hash stabil bei gleichen Merkmalen", m.computeDedupKey(t2) === m.computeDedupKey(Object.assign({}, t2)));
ok("Hash unterscheidet bei anderem Betrag", m.computeDedupKey(t2) !== m.computeDedupKey(Object.assign({}, t2, { amount: 30.0 })));

console.log("\n  " + pass + " passed, " + fail + " failed\n");
process.exit(fail ? 1 : 0);
