"use strict";
/**
 * M.IRIS — Enable Banking Adapter (PSD2 / AIS). Liest eingehende Umsätze des eigenen
 * Sparkassen-Kontos. Alle Secrets serverseitig (ENV). Auth = selbst-signiertes JWT (RS256),
 * das direkt der Bearer ist. Ein einziger Browser-Redirect (Consent) — alles andere S2S.
 *
 * ENV: ENABLE_BANKING_APP_ID, ENABLE_BANKING_PRIVATE_KEY (volles PEM), optional
 *      ENABLE_BANKING_BASE (default https://api.enablebanking.com).
 */

const match = require("./match");

const BASE = (process.env.ENABLE_BANKING_BASE || "https://api.enablebanking.com").replace(/\/$/, "");

function appId() { return (process.env.ENABLE_BANKING_APP_ID || "").trim(); }
function privateKey() { return (process.env.ENABLE_BANKING_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim(); }
function configured() { return !!(appId() && privateKey()); }

let _jwtCache = { token: null, exp: 0 };
function jwtToken() {
  const now = Math.floor(Date.now() / 1000);
  if (_jwtCache.token && _jwtCache.exp - 60 > now) return _jwtCache.token;
  if (!configured()) throw new Error("Enable Banking nicht konfiguriert (ENABLE_BANKING_APP_ID/PRIVATE_KEY)");
  const jwt = require("jsonwebtoken");
  const exp = now + 3600; // ≤ 24h erlaubt; 1h reicht
  const token = jwt.sign(
    { iss: "enablebanking.com", aud: "api.enablebanking.com", iat: now, exp },
    privateKey(),
    { algorithm: "RS256", keyid: appId() }
  );
  _jwtCache = { token, exp };
  return token;
}

function isSessionError(status, body) {
  const s = (body && (body.code || body.error || "")) + " " + (body && body.message ? body.message : "");
  return /EXPIRED_SESSION|SESSION_NOT_FOUND|invalid.*session|session.*(expired|invalid)/i.test(s) || status === 401;
}

async function api(method, path, { body, query } = {}) {
  let url = BASE + path;
  if (query) {
    const qs = Object.entries(query).filter(([, v]) => v != null && v !== "").map(([k, v]) => k + "=" + encodeURIComponent(v)).join("&");
    if (qs) url += "?" + qs;
  }
  const res = await fetch(url, {
    method,
    headers: Object.assign({ Authorization: "Bearer " + jwtToken(), Accept: "application/json" }, body ? { "Content-Type": "application/json" } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  const text = await res.text().catch(() => "");
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
  if (!res.ok) {
    const e = new Error("Enable Banking " + res.status + ": " + String(text).slice(0, 200));
    e.status = res.status;
    if (isSessionError(res.status, data)) e.code = "EXPIRED_SESSION";
    throw e;
  }
  return data;
}

/** ASPSP-Liste (einmal beim Einrichten, um den exakten Sparkasse-Namen + max. Consent-Dauer zu holen). */
async function listAspsps(country) {
  const data = await api("GET", "/aspsps", { query: { country: country || "DE" } });
  return (data && data.aspsps) || (Array.isArray(data) ? data : []) || [];
}

/** Autorisierung starten → Redirect-URL für den Consent. */
async function startAuth({ redirectUrl, aspspName, country, validUntilDays, state, psuType }) {
  const days = Math.min(Math.max(parseInt(validUntilDays, 10) || 90, 1), 180);
  const validUntil = new Date(Date.now() + days * 24 * 3600 * 1000).toISOString();
  const data = await api("POST", "/auth", {
    body: {
      access: { valid_until: validUntil },
      aspsp: { name: aspspName, country: country || "DE" },
      redirect_url: redirectUrl,
      psu_type: psuType || "personal",
      state: state,
    },
  });
  return { url: data.url, authorizationId: data.authorization_id, validUntil };
}

/** Session aus dem Redirect-Code erzeugen → session_id + Konten. */
async function createSession(code) {
  const data = await api("POST", "/sessions", { body: { code } });
  const accounts = (data.accounts || []).map((a) => ({
    uid: a.uid,
    iban: (a.account_id && a.account_id.iban) || (a.account_id && a.account_id.other && a.account_id.other.identification) || "",
    currency: a.currency || "EUR",
    name: a.name || "",
  }));
  return { sessionId: data.session_id, accounts, aspsp: data.aspsp || null };
}

function normalizeTxn(raw) {
  const amt = raw.transaction_amount || {};
  const remArr = raw.remittance_information || [];
  const remittance = (Array.isArray(remArr) ? remArr.join(" ") : String(remArr || "")).trim();
  const debtor = raw.debtor || {};
  const debtorAcc = raw.debtor_account || {};
  const t = {
    txId: raw.entry_reference || raw.transaction_id || null,
    entryReference: raw.entry_reference || null,
    transactionId: raw.transaction_id || null,
    amount: Number(amt.amount),
    currency: amt.currency || "EUR",
    direction: raw.credit_debit_indicator || "CRDT",
    status: raw.status || "BOOK",
    bookingDate: raw.booking_date || raw.value_date || null,
    remittance,
    payerName: (debtor && debtor.name) || null,
    iban: (debtorAcc && debtorAcc.iban) || null,
  };
  t.dedupKey = match.computeDedupKey(t);
  return t;
}

/** Gebuchte Umsätze der letzten `sinceDays` Tage (paginiert über continuation_key). */
async function listTransactions(accountUid, sinceDays) {
  const to = new Date();
  const from = new Date(to.getTime() - (parseInt(sinceDays, 10) || 14) * 24 * 3600 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  const out = [];
  let contKey = null;
  for (let page = 0; page < 20; page++) { // Sicherheitslimit
    const data = await api("GET", "/accounts/" + encodeURIComponent(accountUid) + "/transactions", {
      query: { date_from: fmt(from), date_to: fmt(to), transaction_status: "BOOK", continuation_key: contKey || undefined },
    });
    (data.transactions || []).forEach((raw) => out.push(normalizeTxn(raw)));
    contKey = data.continuation_key || null;
    if (!contKey) break;
  }
  // Merkmalsgleiche referenzlose Umsätze eindeutig machen (siehe match.applyOrdinalDedup).
  return match.applyOrdinalDedup(out);
}

function diag() { return { enableBankingConfigured: configured(), base: BASE, appIdSet: !!appId() }; }
async function testConnection() {
  if (!configured()) return { ok: false, error: "ENABLE_BANKING_APP_ID/PRIVATE_KEY nicht gesetzt" };
  try { const a = await listAspsps("DE"); return { ok: true, aspspCount: a.length }; }
  catch (e) { return { ok: false, error: String((e && e.message) || e).slice(0, 200) }; }
}

module.exports = { configured, listAspsps, startAuth, createSession, listTransactions, normalizeTxn, diag, testConnection };
