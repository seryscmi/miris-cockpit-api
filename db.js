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

/* ---------- Zahlungsabgleich (Bank) ---------- */

async function getBankConnection(shop) {
  const res = await q(`SELECT id, shop, "aspspName", country, "sessionId", "accountUid", "ibanMasked",
    "validUntil", status, "pendingState", "pendingAuthId", "pendingAt", "lastSyncAt", "createdAt", "updatedAt"
    FROM "BankConnection" WHERE shop=$1 LIMIT 1`, [shop]);
  return res.rows[0] || null;
}

async function upsertBankConnectionPending(shop, { aspspName, country, pendingState, pendingAuthId, validUntil }) {
  await q(
    `INSERT INTO "BankConnection" (id, shop, "aspspName", country, status, "pendingState", "pendingAuthId", "validUntil", "pendingAt", "updatedAt")
     VALUES ('bc_'||md5(random()::text||clock_timestamp()::text), $1, $2, $3, 'pending', $4, $5, $6, now(), now())
     ON CONFLICT (shop) DO UPDATE SET "aspspName"=$2, country=$3, status='pending',
       "pendingState"=$4, "pendingAuthId"=$5, "validUntil"=$6, "pendingAt"=now(), "updatedAt"=now()`,
    [shop, aspspName || null, country || "DE", pendingState || null, pendingAuthId || null, validUntil || null]
  );
}

async function activateBankConnection(shop, { sessionId, accountUid, ibanMasked, validUntil, aspspName }) {
  await q(
    `INSERT INTO "BankConnection" (id, shop, "aspspName", "sessionId", "accountUid", "ibanMasked", "validUntil", status, "pendingState", "pendingAuthId", "updatedAt")
     VALUES ('bc_'||md5(random()::text||clock_timestamp()::text), $1, $2, $3, $4, $5, $6, 'active', NULL, NULL, now())
     ON CONFLICT (shop) DO UPDATE SET "sessionId"=$3, "accountUid"=$4, "ibanMasked"=$5,
       "validUntil"=$6, status='active', "pendingState"=NULL, "pendingAuthId"=NULL,
       "aspspName"=COALESCE($2,"BankConnection"."aspspName"), "updatedAt"=now()`,
    [shop, aspspName || null, sessionId, accountUid, ibanMasked || null, validUntil || null]
  );
}

async function expireBankConnection(shop) {
  await q(`UPDATE "BankConnection" SET status='expired', "updatedAt"=now() WHERE shop=$1`, [shop]);
}

async function touchBankSync(shop, ts) {
  await q(`UPDATE "BankConnection" SET "lastSyncAt"=$2, "updatedAt"=now() WHERE shop=$1`, [shop, ts || new Date()]);
}

async function findBankTransaction(shop, dedupKey) {
  const res = await q(`SELECT id, status, "orderName" FROM "BankTransaction" WHERE shop=$1 AND "dedupKey"=$2 LIMIT 1`, [shop, dedupKey]);
  return res.rows[0] || null;
}

/** Idempotenter Insert. Rückgabe {inserted:bool}. Doppelte (shop,dedupKey) werden verschluckt. */
async function insertBankTransaction(row) {
  const res = await q(
    `INSERT INTO "BankTransaction" (id, shop, "dedupKey", amount, currency, "bookingDate", direction,
       "orderName", confidence, reason, status, "payerName", "remittanceExcerpt", "updatedAt")
     VALUES ('bt_'||md5(random()::text||clock_timestamp()::text), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
     ON CONFLICT (shop, "dedupKey") DO NOTHING`,
    [row.shop, row.dedupKey, row.amount, row.currency || "EUR", row.bookingDate || null, row.direction || "CRDT",
     row.orderName || null, row.confidence, row.reason, row.status, row.payerName || null, row.remittanceExcerpt || null]
  );
  return { inserted: res.rowCount > 0 };
}

async function listBankReview(shop) {
  const res = await q(
    `SELECT "dedupKey", amount, currency, "bookingDate", "orderName", confidence, reason,
       "payerName", "remittanceExcerpt", "createdAt"
     FROM "BankTransaction" WHERE shop=$1 AND status='review' ORDER BY "createdAt" DESC LIMIT 100`, [shop]);
  return res.rows.map((r) => Object.assign({}, r, { amount: Number(r.amount) }));
}

async function countBankReview(shop) {
  const res = await q(`SELECT COUNT(*)::int AS n FROM "BankTransaction" WHERE shop=$1 AND status='review'`, [shop]);
  return res.rows[0] ? res.rows[0].n : 0;
}

/** Review auflösen (confirmed|dismissed) + PII scrubben. */
async function resolveBankTransaction(shop, dedupKey, status, orderName) {
  const res = await q(
    `UPDATE "BankTransaction" SET status=$3, "orderName"=COALESCE($4,"orderName"),
       "payerName"=NULL, "remittanceExcerpt"=NULL, "resolvedAt"=now(), "updatedAt"=now()
     WHERE shop=$1 AND "dedupKey"=$2`,
    [shop, dedupKey, status, orderName || null]
  );
  return res.rowCount > 0;
}

/** Retention: PII alter Zeilen nullen (Buchungs-Fakt bleibt für den Nachweis). */
async function purgeBankPII(days) {
  const res = await q(
    `UPDATE "BankTransaction" SET "payerName"=NULL, "remittanceExcerpt"=NULL
     WHERE ("payerName" IS NOT NULL OR "remittanceExcerpt" IS NOT NULL)
       AND "createdAt" < now() - ($1 || ' days')::interval`,
    [String(parseInt(days, 10) || 90)]
  );
  return res.rowCount;
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
  getBankConnection, upsertBankConnectionPending, activateBankConnection, expireBankConnection,
  touchBankSync, findBankTransaction, insertBankTransaction, listBankReview, countBankReview,
  resolveBankTransaction, purgeBankPII,
  testConnection, diag,
};
