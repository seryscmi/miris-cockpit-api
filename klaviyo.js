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

function diag() {
  return { klaviyoKeySet: !!(process.env.KLAVIYO_PRIVATE_API_KEY || "").trim(), metricName: METRIC_NAME, revision: REVISION };
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

module.exports = { fetchAnliegen, resolveMetricId, mapEvent, deriveKind, diag, testConnection };
