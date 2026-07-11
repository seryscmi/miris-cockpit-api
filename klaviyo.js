"use strict";
/**
 * Klaviyo — Kundenanliegen live lesen (Phase 3).
 *
 * Der Mary-Chat feuert bei jeder Eskalation/Feedback/Adressänderung ein Klaviyo-Event
 * auf die Metrik MIRIS_CHAT_ESCALATION mit event_properties
 *   { message, topic, customer_name, customer_email, order_name, verified, admin_subject }.
 * Wir lesen diese Events per Klaviyo-API (privater API-Key, serverseitig) und mappen sie
 * auf die Cockpit-Anliegen-Form. KEIN Eingriff in den Live-Chat, keine eigene DB.
 */

const BASE = "https://a.klaviyo.com/api";
const REVISION = process.env.KLAVIYO_REVISION || "2026-04-15";
const METRIC_NAME =
  process.env.KLAVIYO_ESCALATION_METRIC ||
  process.env.KLAVIYO_CHAT_ESCALATION_EVENT ||
  "MIRIS_CHAT_ESCALATION";

let _metricIdCache = null;

function apiKey() {
  const k = (process.env.KLAVIYO_PRIVATE_API_KEY || "").trim();
  if (!k) throw new Error("KLAVIYO_PRIVATE_API_KEY nicht gesetzt");
  return k;
}
function headers() {
  return { Authorization: `Klaviyo-API-Key ${apiKey()}`, Accept: "application/vnd.api+json", revision: REVISION };
}
async function kfetch(pathOrUrl) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : BASE + pathOrUrl;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Klaviyo ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

async function resolveMetricId() {
  if (_metricIdCache) return _metricIdCache;
  let url = `/metrics?fields[metric]=name`;
  for (let i = 0; i < 5 && url; i++) {
    const data = await kfetch(url);
    const m = (data.data || []).find((x) => x.attributes && x.attributes.name === METRIC_NAME);
    if (m) { _metricIdCache = m.id; return m.id; }
    url = (data.links && data.links.next) || null;
  }
  throw new Error(`Klaviyo-Metrik "${METRIC_NAME}" nicht gefunden`);
}

function deriveKind(p) {
  const subj = String(p.admin_subject || "").toLowerCase();
  const topic = String(p.topic || "").toLowerCase();
  if (subj.startsWith("feedback") || topic === "feedback") return "Feedback";
  if (subj.includes("adressänderung") || subj.includes("adressaenderung") || topic.includes("adress")) return "Adressänderung";
  if (topic.includes("widerruf") || subj.includes("widerruf")) return "Widerruf";
  return "Chat-Nachricht";
}

function mapEvent(ev) {
  const attrs = ev.attributes || {};
  const p = attrs.event_properties || {};
  return {
    id: ev.id,
    date: attrs.datetime || attrs.timestamp || null,
    kind: deriveKind(p),
    customerName: p.customer_name || "",
    customerEmail: p.customer_email || "",
    thema: p.topic || p.admin_subject || "",
    nachricht: p.message || "",
    relatedOrder: p.order_name ? String(p.order_name) : null,
    widerrufAdminUrl: null,
  };
}

async function fetchAnliegen(limit) {
  const metricId = await resolveMetricId();
  const size = Math.min(limit || 100, 200);
  const filter = encodeURIComponent(`equals(metric_id,"${metricId}")`);
  const data = await kfetch(`/events?filter=${filter}&fields[event]=datetime,event_properties&sort=-datetime&page[size]=${size}`);
  return (data.data || []).map(mapEvent);
}

/* ---------- Schreiben: Event feuern (Muster wie Marys trackEvent) ---------- */

const REPLY_METRIC = process.env.KLAVIYO_REPLY_METRIC || "MIRIS_ANLIEGEN_REPLY";

async function trackEvent({ email, firstName, lastName, metricName, properties, uniqueId }) {
  if (!email || !metricName) throw new Error("email und metricName erforderlich");
  const payload = {
    data: {
      type: "event",
      attributes: {
        time: new Date().toISOString(),
        unique_id: uniqueId,
        properties: properties || {},
        metric: { data: { type: "metric", attributes: { name: metricName } } },
        profile: { data: { type: "profile", attributes: { email, first_name: firstName || "", last_name: lastName || "" } } },
      },
    },
  };
  const res = await fetch(BASE + "/events", {
    method: "POST",
    headers: Object.assign({}, headers(), { "Content-Type": "application/vnd.api+json" }),
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Klaviyo Event ${res.status}: ${t.slice(0, 200)}`);
  }
  return { sent: true };
}

/**
 * Antwort auf ein Anliegen als Klaviyo-Event ans KUNDEN-Profil.
 * Die E-Mail verschickt der Klaviyo-Flow "MIRIS Anliegen Antwort"
 * (Trigger-Metrik MIRIS_ANLIEGEN_REPLY, Template TjsM6Z).
 */
async function sendAnliegenReply({ email, customerName, thema, orderName, replyText, originalMessage, anliegenId }) {
  const firstName = String(customerName || "").trim().split(/\s+/)[0] || "";
  return trackEvent({
    email,
    firstName,
    metricName: REPLY_METRIC,
    uniqueId: "anliegen-reply-" + anliegenId + "-" + Date.now(),
    properties: {
      reply_text: String(replyText).slice(0, 4000),
      thema: thema || "",
      order_name: orderName || "",
      customer_name: customerName || "",
      customer_first_name: firstName, // Anrede im Template: "Hallo {Vorname},"
      original_message: originalMessage ? String(originalMessage).slice(0, 1500) : "",
    },
  });
}

/**
 * Freie Kunden-E-Mail im M.IRIS-Stil: Event MIRIS_KUNDEN_MAIL ans Kundenprofil,
 * der Klaviyo-Flow "MIRIS Nachricht" verschickt sie (Betreff = event.subject).
 */
async function sendCustomerMail({ email, firstName, subject, message, orderName }) {
  return trackEvent({
    email,
    firstName: firstName || "",
    metricName: process.env.KLAVIYO_KUNDEN_MAIL_METRIC || "MIRIS_KUNDEN_MAIL",
    uniqueId: "kunden-mail-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
    properties: {
      subject: String(subject).slice(0, 200),
      message: String(message).slice(0, 5000),
      customer_first_name: String(firstName || "").trim().split(/\s+/)[0] || "",
      order_name: orderName || "",
      event_source: "miris-cockpit",
    },
  });
}

/** DSGVO: komplettes Klaviyo-Profil (inkl. aller Events) zur Löschung einreichen.
 *  Braucht einen Key mit Data-Privacy-Schreibrecht. */
async function requestProfileDeletion(email) {
  const payload = { data: { type: "data-privacy-deletion-job", attributes: { profile: { data: { type: "profile", attributes: { email } } } } } };
  const res = await fetch(BASE + "/data-privacy-deletion-jobs", {
    method: "POST",
    headers: Object.assign({}, headers(), { "Content-Type": "application/vnd.api+json" }),
    body: JSON.stringify(payload),
  });
  if (res.status === 202 || res.ok) return { requested: true };
  const t = await res.text().catch(() => "");
  throw new Error(`Klaviyo Profil-Löschung ${res.status}: ${t.slice(0, 200)}`);
}

function diag() {
  return { klaviyoKeySet: !!(process.env.KLAVIYO_PRIVATE_API_KEY || "").trim(), metricName: METRIC_NAME, replyMetric: REPLY_METRIC, revision: REVISION };
}
async function testConnection() {
  try {
    const metricId = await resolveMetricId();
    const sample = await fetchAnliegen(3);
    return { ok: true, metricId, sampleCount: sample.length };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 300) };
  }
}

module.exports = { fetchAnliegen, resolveMetricId, mapEvent, deriveKind, trackEvent, sendAnliegenReply, sendCustomerMail, requestProfileDeletion, diag, testConnection };
