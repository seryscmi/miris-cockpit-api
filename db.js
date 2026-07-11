"use strict";
/**
 * Shared-DB-Zugriff (Neon/Postgres) — liest die von Mary geschriebenen Tabellen
 * "Anliegen" und "ChatTranscript". Mary bleibt einziger Schreiber der Inhalte;
 * dieser Dienst macht nur SELECT / Status-UPDATE / DELETE.
 *
 * Ohne DATABASE_URL: configured() = false → Endpunkte fallen auf Klaviyo (Anliegen)
 * bzw. leere Listen (Chats) zurück, damit nichts bricht.
 */

const KIND_BY_TYPE = {
  escalation: "Chat-Nachricht",
  feedback: "Feedback",
  dsgvo: "DSGVO",
  address_change: "Adressänderung",
  repair: "Reparatur",
};

let _pool = null;
function configured() { return !!(process.env.DATABASE_URL || "").trim(); }
function pool() {
  if (_pool) return _pool;
  const { Pool } = require("pg");
  _pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL || "") ? false : { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 30000,
  });
  return _pool;
}
async function q(text, params) { return pool().query(text, params || []); }

/* ---------- Anliegen ---------- */

function mapAnliegen(r) {
  return {
    id: r.id,
    date: r.createdAt,
    kind: KIND_BY_TYPE[r.type] || "Chat-Nachricht",
    type: r.type,
    customerName: r.name || "",
    customerEmail: r.email || "",
    thema: r.thema || "",
    nachricht: r.message || "",
    relatedOrder: r.orderName || null,
    status: r.status || "neu",
    replies: r.replies || null,
    repliedAt: r.repliedAt || null,
    widerrufAdminUrl: (r.meta && r.meta.widerrufAdminUrl) || null,
  };
}

async function listAnliegen(limit) {
  const res = await q(
    `SELECT id, type, thema, email, name, "orderName", message, meta, status, replies, "createdAt", "repliedAt"
     FROM "Anliegen" ORDER BY "createdAt" DESC LIMIT $1`,
    [Math.min(limit || 200, 500)]
  );
  return res.rows.map(mapAnliegen);
}

const ANLIEGEN_STATUS = new Set(["neu", "in Arbeit", "beantwortet", "erledigt"]);
async function updateAnliegenStatus(id, status) {
  if (!ANLIEGEN_STATUS.has(status)) throw new Error("Ungültiger Status");
  const res = await q(`UPDATE "Anliegen" SET status=$2 WHERE id=$1 RETURNING id`, [id, status]);
  return res.rowCount > 0;
}

async function appendAnliegenReply(id, replyText) {
  const res = await q(
    `UPDATE "Anliegen"
     SET replies = COALESCE(replies, '[]'::jsonb) || $2::jsonb,
         status = 'beantwortet',
         "repliedAt" = NOW()
     WHERE id=$1
     RETURNING id, email, name, thema, message, "orderName"`,
    [id, JSON.stringify([{ text: String(replyText).slice(0, 4000), at: new Date().toISOString() }])]
  );
  return res.rows[0] || null;
}

async function getAnliegen(id) {
  const res = await q(
    `SELECT id, type, thema, email, name, "orderName", message, meta, status, replies, "createdAt", "repliedAt"
     FROM "Anliegen" WHERE id=$1`, [id]);
  return res.rows[0] ? mapAnliegen(res.rows[0]) : null;
}

async function deleteAnliegen(id) {
  const res = await q(`DELETE FROM "Anliegen" WHERE id=$1`, [id]);
  return res.rowCount > 0;
}

async function deleteAnliegenByEmail(email) {
  const res = await q(`DELETE FROM "Anliegen" WHERE LOWER(email)=LOWER($1)`, [email]);
  return res.rowCount;
}

/* ---------- Chat-Transkripte ---------- */

function mapChat(r, withMessages) {
  const out = {
    id: r.id,
    sessionId: r.sessionId,
    customerName: r.customerName || "",
    email: r.email || "",
    orderName: r.orderName || null,
    verified: !!r.verified,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    messageCount: Array.isArray(r.messages) ? r.messages.length : undefined,
  };
  if (withMessages) out.messages = r.messages || [];
  return out;
}

async function listChats({ qtext, from, to, limit, offset }) {
  const params = [];
  const where = [];
  if (qtext) {
    params.push("%" + qtext + "%");
    where.push(`("customerName" ILIKE $${params.length} OR email ILIKE $${params.length} OR "orderName" ILIKE $${params.length})`);
  }
  if (from) { params.push(new Date(from)); where.push(`"updatedAt" >= $${params.length}`); }
  if (to) { params.push(new Date(to)); where.push(`"updatedAt" <= $${params.length}`); }
  params.push(Math.min(limit || 50, 200));
  const limIdx = params.length;
  params.push(Math.max(offset || 0, 0));
  const offIdx = params.length;
  const res = await q(
    `SELECT id, "sessionId", "customerName", email, "orderName", verified, "createdAt", "updatedAt", messages
     FROM "ChatTranscript"
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY "updatedAt" DESC LIMIT $${limIdx} OFFSET $${offIdx}`,
    params
  );
  return res.rows.map((r) => mapChat(r, false));
}

async function getChat(id) {
  const res = await q(
    `SELECT id, "sessionId", "customerName", email, "orderName", verified, "createdAt", "updatedAt", messages
     FROM "ChatTranscript" WHERE id=$1 OR "sessionId"=$1`, [id]);
  return res.rows[0] ? mapChat(res.rows[0], true) : null;
}

async function deleteChat(id) {
  const res = await q(`DELETE FROM "ChatTranscript" WHERE id=$1 OR "sessionId"=$1`, [id]);
  return res.rowCount > 0;
}

async function deleteChatsBy({ email, orderName, name }) {
  const params = [];
  const where = [];
  if (email) { params.push(email); where.push(`LOWER(email)=LOWER($${params.length})`); }
  if (orderName) { params.push(orderName); where.push(`"orderName"=$${params.length}`); }
  if (name) { params.push(name); where.push(`LOWER("customerName")=LOWER($${params.length})`); }
  if (!where.length) throw new Error("email, orderName oder name erforderlich");
  const res = await q(`DELETE FROM "ChatTranscript" WHERE ${where.join(" OR ")}`, params);
  return res.rowCount;
}

/* ---------- DSGVO (P4) ---------- */

/** Augen-Daten aus OrderSnapshot-Cache entfernen (rawJson nullen). */
async function scrubOrderSnapshots({ email, orderName }) {
  const params = [];
  const where = [];
  if (email) { params.push(email); where.push(`LOWER(email)=LOWER($${params.length})`); }
  if (orderName) { params.push(orderName); where.push(`"orderName"=$${params.length}`); }
  if (!where.length) return 0;
  const res = await q(`UPDATE "OrderSnapshot" SET "rawJson"=NULL WHERE ${where.join(" OR ")}`, params);
  return res.rowCount;
}

async function insertErasureLog({ shop, email, orderName, actions }) {
  await q(
    `INSERT INTO "ErasureLog" (id, shop, email, "orderName", actions)
     VALUES ('era_'||md5(random()::text||clock_timestamp()::text), $1, $2, $3, $4::jsonb)`,
    [shop || "", email || null, orderName || null, JSON.stringify(actions || {})]
  );
}

async function listErasureLog(limit) {
  const res = await q(`SELECT id, email, "orderName", actions, "performedAt" FROM "ErasureLog" ORDER BY "performedAt" DESC LIMIT $1`, [Math.min(limit || 50, 200)]);
  return res.rows;
}

/* ---------- Diagnose ---------- */

async function testConnection() {
  if (!configured()) return { ok: false, error: "DATABASE_URL nicht gesetzt" };
  try {
    const t = await q(`SELECT
      (SELECT COUNT(*)::int FROM "Anliegen") AS anliegen,
      (SELECT COUNT(*)::int FROM "ChatTranscript") AS chats`);
    return { ok: true, anliegen: t.rows[0].anliegen, chats: t.rows[0].chats };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 200) };
  }
}
function diag() { return { databaseUrlSet: configured() }; }

module.exports = {
  configured, listAnliegen, getAnliegen, updateAnliegenStatus, appendAnliegenReply,
  deleteAnliegen, deleteAnliegenByEmail,
  listChats, getChat, deleteChat, deleteChatsBy,
  scrubOrderSnapshots, insertErasureLog, listErasureLog,
  testConnection, diag,
};
