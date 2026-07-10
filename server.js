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

  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(express.json({ limit: "64kb" }));

  const origin = (process.env.ALLOWED_ORIGIN || "https://seryscmi.github.io").split(",").map((s) => s.trim());
  app.use(cors({ origin, methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Authorization", "Content-Type"], maxAge: 86400 }));

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

  // Diagnose: zeigt (ohne Secrets) die Konfiguration + testet Shopify- und Klaviyo-Verbindung.
  app.get("/admin/diag", async (req, res) => {
    try {
      const config = shopify.diag ? shopify.diag() : {};
      const klaviyoCfg = klaviyo.diag ? klaviyo.diag() : {};
      const shopify_test = shopify.testConnection ? await shopify.testConnection() : { ok: false, error: "diag n/a" };
      const klaviyo_test = klaviyo.testConnection ? await klaviyo.testConnection() : { ok: false, error: "diag n/a" };
      res.json({ ok: true, config: Object.assign({}, config, klaviyoCfg), shopify_test, klaviyo_test });
    } catch (e) { res.status(500).json({ error: String((e && e.message) || e) }); }
  });

  // Kundenanliegen live aus Klaviyo (Chat-Eskalationen/Feedback/Adressänderungen).
  app.get("/admin/anliegen", async (req, res) => {
    try { res.json({ anliegen: await klaviyo.fetchAnliegen() }); }
    catch (e) { res.status(502).json({ error: String((e && e.message) || e), anliegen: [] }); }
  });
  // Chat-Transkripte werden serverseitig nicht persistiert (Mary ist ephemer) → leer.
  app.get("/admin/chats", (req, res) => res.json({ chats: [], note: "Mary speichert keine Transkripte (ephemer)" }));

  app.use((req, res) => res.status(404).json({ error: "not found" }));
  return app;
}

if (require.main === module) {
  const port = process.env.PORT || 8080;
  createApp().listen(port, () => console.log("miris-cockpit-api läuft auf :" + port));
}

module.exports = { createApp, timingEqual };
