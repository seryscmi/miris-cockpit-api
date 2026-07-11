"use strict";
/**
 * M.IRIS Cockpit — Admin-Dienst (Phase 2).
 *
 * Stateless: liest Bestellungen aus Shopify, löscht Augenbilder aus Cloudinary.
 * Alle Secrets liegen serverseitig (ENV). Der Browser authentifiziert sich mit
 * einem Bearer-Token (ADMIN_TOKEN), CORS ist auf die Cockpit-Origin beschränkt.
 *
 * Endpoints (alle unter /admin verlangen Bearer-Auth):
 *   GET  /health                 -> { ok:true }             (ohne Auth)
 *   GET  /admin/orders           -> { orders:[…] }
 *   GET  /admin/images           -> { images:[…] }
 *   POST /admin/images/delete    -> { ok:true }             body:{ publicId, orderName? }
 *   GET  /admin/anliegen         -> { anliegen:[] }         (Phase 3)
 *   GET  /admin/chats            -> { chats:[] }            (Phase 3)
 */

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const crypto = require("crypto");

const defaultShopify = require("./shopify");
const defaultCloud = require("./cloudinary");
const defaultKlaviyo = require("./klaviyo");
const defaultDb = require("./db");

function timingEqual(a, b) {
  const ab = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (ab.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ab, bb); } catch (e) { return false; }
}

function createApp(deps) {
  deps = deps || {};
  const shopify = deps.shopify || defaultShopify;
  const cloud = deps.cloud || defaultCloud;
  const klaviyo = deps.klaviyo || defaultKlaviyo;
  const db = deps.db || defaultDb;

  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(express.json({ limit: "64kb" }));

  const origin = (process.env.ALLOWED_ORIGIN || "https://seryscmi.github.io").split(",").map((s) => s.trim());
  app.use(cors({ origin, methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"], allowedHeaders: ["Authorization", "Content-Type"], maxAge: 86400 }));

  app.get("/health", (req, res) => res.json({ ok: true, service: "miris-cockpit-api", ts: Date.now() }));

  // Auth-Grenze für alles unter /admin
  const auth = (req, res, next) => {
    const configured = (process.env.ADMIN_TOKEN || "").trim();
    if (!configured) return res.status(503).json({ error: "ADMIN_TOKEN nicht konfiguriert" });
    const header = req.get("Authorization") || "";
    const token = header.replace(/^Bearer\s+/i, "").trim();
    if (!timingEqual(token, configured)) return res.status(401).json({ error: "unauthorized" });
    next();
  };
  app.use("/admin", rateLimit({ windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false }), auth);

  app.get("/admin/orders", async (req, res) => {
    try { res.json({ orders: await shopify.fetchOrders() }); }
    catch (e) { res.status(502).json({ error: String((e && e.message) || e) }); }
  });

  app.get("/admin/images", async (req, res) => {
    try { const orders = await shopify.fetchOrders(); res.json({ images: shopify.deriveImages(orders) }); }
    catch (e) { res.status(502).json({ error: String((e && e.message) || e) }); }
  });

  app.post("/admin/images/delete", async (req, res) => {
    try {
      const publicId = req.body && req.body.publicId;
      const orderName = req.body && req.body.orderName;
      if (!publicId) return res.status(400).json({ error: "publicId erforderlich" });
      const result = await cloud.deleteImage(publicId);
      // Audit-Tag setzen (nicht blockierend)
      Promise.resolve().then(() => shopify.tagOrderDeleted(orderName)).catch(() => {});
      res.json({ ok: true, result });
    } catch (e) { res.status(502).json({ error: String((e && e.message) || e) }); }
  });

  /* ---------- Bestell-Aktionen (P3) ---------- */

  // Fehler-Mapper: userErrors → 422 (fachlich), Scope-/Zugriffsfehler klar benennen, sonst 502.
  const actionError = (res, e) => {
    const msg = String((e && e.message) || e);
    if (e && e.userErrors) return res.status(422).json({ error: msg, userErrors: e.userErrors });
    if (/ACCESS_DENIED|access denied|permission|scope/i.test(msg)) {
      return res.status(403).json({ error: "Shopify-Berechtigung fehlt (App-Scopes im Dev-Dashboard erweitern): " + msg.slice(0, 220) });
    }
    res.status(502).json({ error: msg.slice(0, 300) });
  };

  app.post("/admin/orders/:name/mahnung", async (req, res) => {
    try {
      const r = await shopify.addOrderTag(req.params.name, "MAHNUNG");
      res.json({ ok: true, tagged: r.tag });
    } catch (e) { actionError(res, e); }
  });

  app.post("/admin/orders/:name/mark-paid", async (req, res) => {
    try {
      const r = await shopify.markOrderPaid(req.params.name);
      res.json({ ok: true, financialStatus: r.financialStatus });
    } catch (e) { actionError(res, e); }
  });

  app.post("/admin/orders/:name/fulfill", async (req, res) => {
    try {
      const { trackingNumber, trackingCompany } = req.body || {};
      const r = await shopify.fulfillOrder(req.params.name, trackingNumber, trackingCompany);
      res.json({ ok: true, fulfillmentId: r.fulfillmentId });
    } catch (e) { actionError(res, e); }
  });

  app.post("/admin/orders/:name/cancel", async (req, res) => {
    try {
      const { refund, restock, notify } = req.body || {};
      const r = await shopify.cancelOrder(req.params.name, { refund, restock, notify });
      res.json({ ok: true, jobId: r.jobId });
    } catch (e) { actionError(res, e); }
  });

  // Vorschau-Mail erneut senden: feuert MIRIS_PREVIEW_SENT (bestehender Klaviyo-Flow "Farbvorschau bereit")
  // mit frischer 24h-Frist und hält preview_sent_at in Shopify konsistent.
  app.post("/admin/orders/:name/resend-preview", async (req, res) => {
    try {
      const o = await shopify.getOrderPreviewData(req.params.name);
      if (!o.email) return res.status(422).json({ error: "Bestellung hat keine Kunden-E-Mail" });
      if (!o.miris.approval_url || !o.miris.preview_url) {
        return res.status(422).json({ error: "Für diese Bestellung gibt es noch keine Farbvorschau (approval_url/preview_url fehlt)" });
      }
      const now = new Date();
      const deadline = new Date(now.getTime() + 24 * 3600 * 1000);
      await klaviyo.trackEvent({
        email: o.email,
        firstName: o.firstName,
        lastName: o.lastName,
        metricName: "MIRIS_PREVIEW_SENT",
        uniqueId: "resend-preview-" + o.name + "-" + now.getTime(),
        properties: {
          order_id: o.id,
          order_name: o.name,
          customer_name: o.customerName,
          approval_url: o.miris.approval_url,
          preview_url: o.miris.preview_url,
          preview_sent_at: now.toISOString(),
          deadline_at: deadline.toISOString(),
          deadline_hours: 24,
          brand: "M.iris",
          event_source: "miris-cockpit-resend",
        },
      });
      // Frist in Shopify angleichen (best effort — Mail ist schon raus)
      try { await shopify.setPreviewSentNow(o.id, now.toISOString()); } catch (_) {}
      res.json({ ok: true, to: o.email, deadlineAt: deadline.toISOString() });
    } catch (e) { actionError(res, e); }
  });

  // Diagnose: zeigt (ohne Secrets) die Konfiguration + testet Shopify-, Klaviyo- und DB-Verbindung.
  app.get("/admin/diag", async (req, res) => {
    try {
      const config = Object.assign({}, shopify.diag ? shopify.diag() : {}, klaviyo.diag ? klaviyo.diag() : {}, db.diag ? db.diag() : {});
      const shopify_test = shopify.testConnection ? await shopify.testConnection() : { ok: false, error: "diag n/a" };
      const klaviyo_test = klaviyo.testConnection ? await klaviyo.testConnection() : { ok: false, error: "diag n/a" };
      const db_test = db.testConnection ? await db.testConnection() : { ok: false, error: "diag n/a" };
      res.json({ ok: true, config, shopify_test, klaviyo_test, db_test });
    } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
  });

  /* ---------- Kundenanliegen: primär aus der DB (Mary schreibt), Fallback Klaviyo ---------- */

  app.get("/admin/anliegen", async (req, res) => {
    // DB primär; bei DB-Fehler ODER fehlender Konfiguration auf Klaviyo zurückfallen —
    // die Inbox darf nie wegen einer falschen DATABASE_URL leer sein.
    if (db.configured()) {
      try { return res.json({ anliegen: await db.listAnliegen(), source: "db" }); }
      catch (e) { console.warn("[anliegen] DB-Fehler, Fallback Klaviyo:", String((e && e.message) || e).slice(0, 120)); }
    }
    try { res.json({ anliegen: await klaviyo.fetchAnliegen(), source: "klaviyo" }); }
    catch (e) { res.status(502).json({ error: String((e && e.message) || e), anliegen: [] }); }
  });

  app.patch("/admin/anliegen/:id", async (req, res) => {
    try {
      if (!db.configured()) return res.status(503).json({ error: "DB nicht konfiguriert" });
      const status = req.body && req.body.status;
      const ok = await db.updateAnliegenStatus(req.params.id, status);
      if (!ok) return res.status(404).json({ error: "Anliegen nicht gefunden" });
      res.json({ ok: true, status });
    } catch (e) { res.status(400).json({ error: String((e && e.message) || e) }); }
  });

  // Antwort auf ein Anliegen: E-Mail an den Kunden (Klaviyo-Flow) + in der DB protokollieren.
  app.post("/admin/anliegen/:id/reply", async (req, res) => {
    try {
      if (!db.configured()) return res.status(503).json({ error: "DB nicht konfiguriert" });
      const replyText = String((req.body && req.body.reply_text) || "").trim();
      if (replyText.length < 2) return res.status(400).json({ error: "reply_text erforderlich" });
      const anliegen = await db.getAnliegen(req.params.id);
      if (!anliegen) return res.status(404).json({ error: "Anliegen nicht gefunden" });
      if (!anliegen.customerEmail) return res.status(422).json({ error: "Anliegen hat keine Kunden-E-Mail" });
      await klaviyo.sendAnliegenReply({
        email: anliegen.customerEmail,
        customerName: anliegen.customerName,
        thema: anliegen.thema,
        orderName: anliegen.relatedOrder,
        replyText,
        originalMessage: anliegen.nachricht,
        anliegenId: anliegen.id,
      });
      const row = await db.appendAnliegenReply(anliegen.id, replyText);
      res.json({ ok: true, status: "beantwortet", to: anliegen.customerEmail, logged: !!row });
    } catch (e) { res.status(502).json({ error: String((e && e.message) || e) }); }
  });

  app.delete("/admin/anliegen/:id", async (req, res) => {
    try {
      if (!db.configured()) return res.status(503).json({ error: "DB nicht konfiguriert" });
      const ok = await db.deleteAnliegen(req.params.id);
      if (!ok) return res.status(404).json({ error: "Anliegen nicht gefunden" });
      res.json({ ok: true });
    } catch (e) { res.status(502).json({ error: String((e && e.message) || e) }); }
  });

  /* ---------- Chat-Transkripte (Mary speichert; hier Suche/Ansicht/Löschung) ---------- */

  app.get("/admin/chats", async (req, res) => {
    try {
      if (!db.configured()) return res.json({ chats: [], note: "DB nicht konfiguriert" });
      const { q, from, to, limit, offset } = req.query;
      const chats = await db.listChats({ qtext: q, from, to, limit: parseInt(limit, 10) || undefined, offset: parseInt(offset, 10) || undefined });
      res.json({ chats });
    } catch (e) { res.status(502).json({ error: String((e && e.message) || e), chats: [] }); }
  });

  app.get("/admin/chats/:id", async (req, res) => {
    try {
      if (!db.configured()) return res.status(503).json({ error: "DB nicht konfiguriert" });
      const chat = await db.getChat(req.params.id);
      if (!chat) return res.status(404).json({ error: "Chat nicht gefunden" });
      res.json({ chat });
    } catch (e) { res.status(502).json({ error: String((e && e.message) || e) }); }
  });

  app.delete("/admin/chats/:id", async (req, res) => {
    try {
      if (!db.configured()) return res.status(503).json({ error: "DB nicht konfiguriert" });
      const ok = await db.deleteChat(req.params.id);
      if (!ok) return res.status(404).json({ error: "Chat nicht gefunden" });
      res.json({ ok: true });
    } catch (e) { res.status(502).json({ error: String((e && e.message) || e) }); }
  });

  // Löschen pro Kunde: DELETE /admin/chats?email=… (oder orderName=/name=)
  app.delete("/admin/chats", async (req, res) => {
    try {
      if (!db.configured()) return res.status(503).json({ error: "DB nicht konfiguriert" });
      const { email, orderName, name } = req.query;
      const n = await db.deleteChatsBy({ email, orderName, name });
      res.json({ ok: true, deleted: n });
    } catch (e) { res.status(400).json({ error: String((e && e.message) || e) }); }
  });

  app.use((req, res) => res.status(404).json({ error: "not found" }));
  return app;
}

if (require.main === module) {
  const port = process.env.PORT || 8080;
  createApp().listen(port, () => console.log("miris-cockpit-api läuft auf :" + port));
}

module.exports = { createApp, timingEqual };
