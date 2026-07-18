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
const defaultBank = require("./bank");
const match = require("./match");

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
  const bank = deps.bank || defaultBank;

  const SHOP = process.env.SHOPIFY_SHOP || "9zjzs5-ri.myshopify.com";
  // SICHER PER DEFAULT: nur echtes Abhaken, wenn BANK_DRYRUN ausdrücklich auf false/0/no gesetzt ist.
  // Fehlt/leer/„true" → Dry-Run (rechnet nur, markiert nichts). So kann eine vergessene ENV nie auto-markieren.
  const BANK_DRYRUN = !/^(0|false|no|off)$/i.test(process.env.BANK_DRYRUN || "");
  const BANK_MIN_SYNC_MS = 6 * 3600 * 1000; // 4/Tag-Cap der Bank respektieren

  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  // 20mb wegen Farbvorschau-Upload (base64); Ein-Nutzer-Dienst hinter Bearer+Rate-Limit.
  app.use(express.json({ limit: "20mb" }));

  const origin = (process.env.ALLOWED_ORIGIN || "https://seryscmi.github.io").split(",").map((s) => s.trim());
  app.use(cors({ origin, methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"], allowedHeaders: ["Authorization", "Content-Type"], maxAge: 86400 }));

  app.get("/health", (req, res) => res.json({ ok: true, service: "miris-cockpit-api", ts: Date.now() }));

  /* ---------- Bank-Zahlungsabgleich: öffentliche Routen (ohne Bearer) ---------- */

  // Redirect-Ziel nach dem Enable-Banking-Consent. state timing-safe gegen pendingState.
  app.get("/bank/callback", async (req, res) => {
    res.set("Cache-Control", "no-store");
    const done = (title, msg) => res.status(200).send(
      "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>" +
      "<div style=\"font-family:system-ui;max-width:420px;margin:16vh auto;text-align:center;color:#1c1c1c\">" +
      "<h1 style=\"font-size:20px;letter-spacing:.08em;text-transform:uppercase\">" + title + "</h1><p style=\"color:#555\">" + msg +
      "</p><p style=\"margin-top:20px\"><a href=\"https://seryscmi.github.io/miris-cockpit/#/einstellungen\" style=\"color:#1c1c1c\">Zurück zum Cockpit</a></p></div>");
    try {
      if (req.query.error) return done("Nicht verbunden", "Der Consent wurde abgebrochen. Du kannst es erneut versuchen.");
      const code = String(req.query.code || "");
      const state = String(req.query.state || "");
      if (!code) return done("Nicht verbunden", "Kein Autorisierungs-Code erhalten.");
      const conn = await db.getBankConnection(SHOP);
      if (!conn || !conn.pendingState || !timingEqual(state, conn.pendingState)) return done("Nicht verbunden", "Sicherheitsprüfung (state) fehlgeschlagen. Bitte im Cockpit neu starten.");
      const sess = await bank.createSession(code);
      const acc = (sess.accounts || []).find((a) => (a.currency || "EUR") === "EUR") || (sess.accounts || [])[0];
      if (!acc) return done("Nicht verbunden", "Kein Konto in der Session gefunden.");
      const ibanMasked = acc.iban ? acc.iban.slice(0, 4) + "…" + acc.iban.slice(-4) : "";
      await db.activateBankConnection(SHOP, { sessionId: sess.sessionId, accountUid: acc.uid, ibanMasked, validUntil: conn.validUntil || null, aspspName: (sess.aspsp && sess.aspsp.name) || conn.aspspName });
      done("Bank verbunden", "Dein Konto ist verbunden. Der Zahlungsabgleich läuft ab jetzt automatisch.");
    } catch (e) {
      done("Fehler", "Verbindung fehlgeschlagen: " + String((e && e.message) || e).slice(0, 160));
    }
  });

  // Cron-Endpoint (cron-job.org, alle 6–8h). Secret via ?secret= ODER Header x-bank-sync-secret.
  // GET UND POST akzeptieren, damit der cron-job.org-„Testlauf" (GET) genauso klappt wie der Zeitplan (POST).
  const bankSyncJob = async (req, res) => {
    res.set("Cache-Control", "no-store");
    const configured = (process.env.BANK_SYNC_SECRET || "").trim();
    const provided = String(req.query.secret || req.get("x-bank-sync-secret") || "");
    if (!configured || !timingEqual(provided, configured)) return res.status(401).json({ ok: false, error: "unauthorized" });
    try {
      const out = await runBankSync({ force: /^(1|true|yes)$/i.test(req.query.force || ""), dryRun: /^(1|true|yes)$/i.test(req.query.dry || "") || undefined });
      // Kompakte Antwort — cron-job.org begrenzt die Response-Größe ("Ausgabe zu groß").
      // Die Details (Review-Liste, Audit) stehen ohnehin in der DB / im Cockpit.
      res.json({
        ok: out.ok, dryRun: !!out.dryRun, skipped: !!out.skipped, reason: out.reason || undefined,
        needsConnect: out.needsConnect || undefined, needsReconsent: out.needsReconsent || undefined,
        error: out.error || undefined,
        fetched: out.fetched || 0,
        autoPaid: Array.isArray(out.autoPaid) ? out.autoPaid.length : 0,
        review: out.review || 0, ignored: out.ignored || 0, skippedDup: out.skippedDup || 0,
        errors: Array.isArray(out.errors) ? out.errors.length : 0,
      });
    } catch (e) { res.status(502).json({ ok: false, error: String((e && e.message) || e).slice(0, 200) }); }
  };
  app.post("/jobs/bank-sync", bankSyncJob);
  app.get("/jobs/bank-sync", bankSyncJob);

  // Auth-Grenze für alles unter /admin
  const auth = (req, res, next) => {
    const configured = (process.env.ADMIN_TOKEN || "").trim();
    if (!configured) return res.status(503).json({ error: "ADMIN_TOKEN nicht konfiguriert" });
    const header = req.get("Authorization") || "";
    const token = header.replace(/^Bearer\s+/i, "").trim();
    if (!timingEqual(token, configured)) return res.status(401).json({ error: "unauthorized" });
    next();
  };
  const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 240; // pro Minute/IP; höher wegen vieler Cockpit-Ansichten (Produkte/Kunden/Bestellungen im Burst)
  app.use("/admin", rateLimit({ windowMs: 60 * 1000, limit: RATE_LIMIT_MAX, standardHeaders: true, legacyHeaders: false }), auth);

  app.get("/admin/orders", async (req, res) => {
    try { res.json({ orders: await shopify.fetchOrders() }); }
    catch (e) { res.status(502).json({ error: String((e && e.message) || e) }); }
  });

  /* ---------- Produkte / Katalog (Phase 1: lesen) ---------- */
  app.get("/admin/products", async (req, res) => {
    try {
      const products = await shopify.fetchProducts({ query: req.query.q, limit: req.query.limit });
      res.json({ products });
    } catch (e) { actionError(res, e); }
  });

  app.get("/admin/products/:id", async (req, res) => {
    try {
      const product = await shopify.fetchProduct(req.params.id);
      if (!product) return res.status(404).json({ error: "Produkt nicht gefunden" });
      res.json({ product });
    } catch (e) { actionError(res, e); }
  });

  // Produkt bearbeiten (Phase 2): Titel/Status + Varianten-Preise
  app.patch("/admin/products/:id", async (req, res) => {
    try {
      const { title, descriptionHtml, status, variants, inventory } = req.body || {};
      const out = { ok: true };
      if (title != null || descriptionHtml != null || status) out.product = await shopify.updateProduct(req.params.id, { title, descriptionHtml, status });
      if (Array.isArray(variants) && variants.length) out.variants = await shopify.updateVariantPrices(req.params.id, variants);
      if (Array.isArray(inventory) && inventory.length) out.inventory = await shopify.setInventoryQuantities(inventory);
      res.json(out);
    } catch (e) { actionError(res, e); }
  });

  /* ---------- Rabatte (Phase 1: lesen; Phase 4: anlegen/löschen) ---------- */
  app.get("/admin/discounts", async (req, res) => {
    try { res.json({ discounts: await shopify.fetchDiscounts({ limit: req.query.limit }) }); }
    catch (e) { actionError(res, e); }
  });
  app.post("/admin/discounts", async (req, res) => {
    try {
      const { code, kind, value, title, endsAt, usageLimit, oncePerCustomer } = req.body || {};
      const d = await shopify.createDiscount({ code, kind, value, title, endsAt, usageLimit, oncePerCustomer });
      res.json({ ok: true, discount: d });
    } catch (e) { actionError(res, e); }
  });
  app.post("/admin/discounts/delete", async (req, res) => {
    try {
      const { gid, kind } = req.body || {};
      if (!gid) return res.status(400).json({ error: "gid erforderlich" });
      const r = await shopify.deleteDiscount(gid, kind);
      res.json({ ok: true, ...r });
    } catch (e) { actionError(res, e); }
  });
  app.post("/admin/discounts/toggle", async (req, res) => {
    try {
      const { gid, kind, active } = req.body || {};
      if (!gid) return res.status(400).json({ error: "gid erforderlich" });
      const r = await shopify.setDiscountActive(gid, kind, active !== false);
      res.json({ ok: true, ...r });
    } catch (e) { actionError(res, e); }
  });

  /* ---------- Kunden (Phase 1: echte Shopify-Datensätze lesen) ---------- */
  app.get("/admin/customers", async (req, res) => {
    try { res.json({ customers: await shopify.fetchCustomers({ query: req.query.q, limit: req.query.limit }) }); }
    catch (e) { actionError(res, e); }
  });
  // by-email MUSS vor :id stehen, sonst fängt :id "by-email" ab.
  app.get("/admin/customers/by-email", async (req, res) => {
    try { res.json({ customer: await shopify.fetchCustomerByEmail(req.query.email) }); }
    catch (e) { actionError(res, e); }
  });
  app.get("/admin/customers/:id", async (req, res) => {
    try {
      const customer = await shopify.fetchCustomer(req.params.id);
      if (!customer) return res.status(404).json({ error: "Kunde nicht gefunden" });
      res.json({ customer });
    } catch (e) { actionError(res, e); }
  });
  // Kunde bearbeiten (Phase 5): Tags + Notiz
  app.patch("/admin/customers/:id", async (req, res) => {
    try {
      const { note, tags } = req.body || {};
      const customer = await shopify.updateCustomer(req.params.id, { note, tags });
      res.json({ ok: true, customer });
    } catch (e) { actionError(res, e); }
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

  /* ---------- v2: Adresse/Kontakt bearbeiten ---------- */

  app.patch("/admin/orders/:name/shipping", async (req, res) => {
    try {
      const { email, shippingAddress } = req.body || {};
      const r = await shopify.updateShippingAddress(req.params.name, { email, shippingAddress });
      res.json({ ok: true, updated: r.updated });
    } catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: String(e.message) });
      actionError(res, e);
    }
  });

  /* ---------- v2: Farbvorschau komplett senden (Upload + Metafelder + Mail) ---------- */

  app.post("/admin/orders/:name/send-preview", async (req, res) => {
    try {
      const { imageBase64, mimeType } = req.body || {};
      const mime = String(mimeType || "").toLowerCase();
      if (!imageBase64) return res.status(400).json({ error: "imageBase64 erforderlich" });
      if (!["image/jpeg", "image/jpg", "image/png", "image/webp"].includes(mime)) {
        return res.status(400).json({ error: "Nur JPG, PNG oder WebP erlaubt" });
      }
      const b64 = String(imageBase64).replace(/^data:[^;]+;base64,/, "");
      if (b64.length * 0.75 > 15 * 1024 * 1024) return res.status(400).json({ error: "Bild größer als 15 MB" });
      // 1) Cloudinary (Fehler hier → nichts wurde verändert)
      const sanitized = req.params.name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
      let up;
      try {
        up = await cloud.uploadImage(b64, { folder: "miris/farbvorschau", publicId: "order-" + sanitized + "-" + Date.now(), tags: ["miris", "farbvorschau", "cockpit-upload"], mime });
      } catch (e) { return res.status(502).json({ error: "Upload fehlgeschlagen: " + String(e.message).slice(0, 200), stage: "cloudinary" }); }
      // 2) Metafelder + Tags (Mary-Vertrag)
      const sent = await shopify.sendPreviewComplete(req.params.name, up.secureUrl);
      // 3) Klaviyo-Mail (Fehler hier → Metafelder stehen; "erneut senden" heilt)
      try {
        await klaviyo.trackEvent({
          email: sent.order.email,
          firstName: sent.order.firstName,
          lastName: sent.order.lastName,
          metricName: "MIRIS_PREVIEW_SENT",
          uniqueId: "cockpit-preview-" + sent.order.name + "-" + Date.now(),
          properties: {
            order_id: sent.order.id,
            order_name: sent.order.name,
            customer_name: sent.order.customerName,
            approval_url: sent.approvalUrl,
            preview_url: sent.previewUrl,
            preview_sent_at: sent.previewSentAt,
            deadline_at: sent.deadlineAt,
            deadline_hours: 24,
            brand: "M.iris",
            event_source: "miris-cockpit",
          },
        });
      } catch (e) { return res.status(502).json({ error: "Vorschau gespeichert, aber Mail fehlgeschlagen: " + String(e.message).slice(0, 160), stage: "klaviyo", previewUrl: up.secureUrl }); }
      res.json({ ok: true, to: sent.order.email, previewUrl: up.secureUrl, approvalUrl: sent.approvalUrl, deadlineAt: sent.deadlineAt });
    } catch (e) {
      if (e && e.status) return res.status(e.status).json({ error: String(e.message) });
      actionError(res, e);
    }
  });

  /* ---------- v2: freie Kunden-E-Mail ---------- */

  app.post("/admin/customers/email", async (req, res) => {
    try {
      const { email, firstName, subject, message, orderName } = req.body || {};
      const em = String(email || "").trim();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return res.status(400).json({ error: "Gültige E-Mail erforderlich" });
      const subj = String(subject || "").trim();
      const msg = String(message || "").trim();
      if (subj.length < 1 || subj.length > 200) return res.status(400).json({ error: "Betreff (1–200 Zeichen) erforderlich" });
      if (msg.length < 1 || msg.length > 5000) return res.status(400).json({ error: "Nachricht (1–5000 Zeichen) erforderlich" });
      await klaviyo.sendCustomerMail({ email: em, firstName, subject: subj, message: msg, orderName });
      res.json({ ok: true, to: em });
    } catch (e) { actionError(res, e); }
  });

  /* ---------- DSGVO-Ein-Klick (P4) ---------- */

  // Kompletter Kunden-Erase: Augenfotos (Cloudinary) + Chats + Anliegen + Snapshot-Cache + Klaviyo-Profil.
  // Jeder Schritt einzeln abwählbar; Ergebnis-Report + Audit-Zeile (ErasureLog).
  app.post("/admin/dsgvo/erase", async (req, res) => {
    const { email, orderName, options } = req.body || {};
    const opt = Object.assign({ photos: true, chats: true, anliegen: true, snapshots: true, klaviyo: false }, options || {});
    if (!email && !orderName) return res.status(400).json({ error: "email oder orderName erforderlich" });
    const report = {};
    // 1) Augenfotos: passende Bestellungen finden, Cloudinary-Assets löschen, Order taggen
    if (opt.photos) {
      try {
        const orders = await shopify.fetchOrders();
        const matching = orders.filter((o) =>
          (orderName && o.name === orderName) ||
          (email && (o.customerEmail || "").toLowerCase() === String(email).toLowerCase()));
        const images = shopify.deriveImages(matching);
        let deleted = 0;
        for (const im of images) {
          try { await cloud.deleteImage(im.cloudinaryPublicId); deleted++; } catch (e) { /* einzeln tolerieren */ }
        }
        for (const o of matching) { try { await shopify.addOrderTag(o.name, "augenfotos-geloescht"); } catch (_) {} }
        report.photos = { ok: true, found: images.length, deleted, orders: matching.map((o) => o.name) };
      } catch (e) { report.photos = { ok: false, error: String(e.message).slice(0, 200) }; }
    }
    // 2) Chat-Verläufe
    if (opt.chats && db.configured()) {
      try { report.chats = { ok: true, deleted: await db.deleteChatsBy({ email, orderName }) }; }
      catch (e) { report.chats = { ok: false, error: String(e.message).slice(0, 200) }; }
    }
    // 3) Anliegen
    if (opt.anliegen && db.configured() && email) {
      try { report.anliegen = { ok: true, deleted: await db.deleteAnliegenByEmail(email) }; }
      catch (e) { report.anliegen = { ok: false, error: String(e.message).slice(0, 200) }; }
    }
    // 4) OrderSnapshot-Cache scrubben
    if (opt.snapshots && db.configured()) {
      try { report.snapshots = { ok: true, scrubbed: await db.scrubOrderSnapshots({ email, orderName }) }; }
      catch (e) { report.snapshots = { ok: false, error: String(e.message).slice(0, 200) }; }
    }
    // 5) Klaviyo-Profil (inkl. aller Events) — braucht Data-Privacy-Scope am Key
    if (opt.klaviyo && email) {
      try { await klaviyo.requestProfileDeletion(email); report.klaviyo = { ok: true, requested: true }; }
      catch (e) { report.klaviyo = { ok: false, error: String(e.message).slice(0, 200) }; }
    }
    // Audit
    try { if (db.configured()) await db.insertErasureLog({ shop: "9zjzs5-ri.myshopify.com", email, orderName, actions: report }); } catch (_) {}
    res.json({ ok: true, report });
  });

  app.get("/admin/dsgvo/log", async (req, res) => {
    try {
      if (!db.configured()) return res.json({ log: [] });
      res.json({ log: await db.listErasureLog() });
    } catch (e) { res.status(502).json({ error: String(e.message).slice(0, 200), log: [] }); }
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

  // Mahnung: Tag setzen (Markierung in Shopify) + Klaviyo-Event MIRIS_MAHNUNG feuern —
  // der Flow "MIRIS Mahnung" schickt die Zahlungserinnerung mit dem bestehenden Template (S6xt5n).
  app.post("/admin/orders/:name/mahnung", async (req, res) => {
    try {
      const o = await shopify.getOrderPreviewData(req.params.name);
      if (!o.email) return res.status(422).json({ error: "Bestellung hat keine Kunden-E-Mail" });
      await shopify.addOrderTag(req.params.name, "MAHNUNG");
      await klaviyo.trackEvent({
        email: o.email,
        firstName: o.firstName,
        lastName: o.lastName,
        metricName: process.env.KLAVIYO_MAHNUNG_METRIC || "MIRIS_MAHNUNG",
        uniqueId: "mahnung-" + o.name + "-" + Date.now(),
        properties: {
          order_name: o.name,
          amount: o.totalPrice.toFixed(2).replace(".", ","), // Template zeigt "{{ amount }} {{ currency }}"
          currency: o.currency,
          customer_name: o.customerName,
          event_source: "miris-cockpit",
        },
      });
      res.json({ ok: true, tagged: "MAHNUNG", to: o.email });
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

  // Erstattung: erst Info (max. Betrag), dann ausführen
  app.get("/admin/orders/:name/refund-info", async (req, res) => {
    try { res.json(await shopify.getRefundInfo(req.params.name)); }
    catch (e) { actionError(res, e); }
  });
  app.post("/admin/orders/:name/refund", async (req, res) => {
    try {
      const { amount, note, notify } = req.body || {};
      const refund = await shopify.refundOrder(req.params.name, { amount, note, notify });
      res.json({ ok: true, refund });
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

  /* ---------- Bank-Zahlungsabgleich: Admin-Routen ---------- */

  app.post("/admin/bank/connect", async (req, res) => {
    try {
      if (!bank.configured()) return res.status(503).json({ error: "Enable Banking nicht konfiguriert (ENV fehlt)" });
      if (!db.configured()) return res.status(503).json({ error: "DB nicht konfiguriert" });
      const state = crypto.randomBytes(24).toString("hex");
      const aspspName = process.env.BANK_ASPSP_NAME || "Sparkasse";
      const country = process.env.BANK_ASPSP_COUNTRY || "DE";
      const started = await bank.startAuth({
        redirectUrl: process.env.BANK_REDIRECT_URL,
        aspspName, country,
        validUntilDays: parseInt(process.env.BANK_CONSENT_DAYS, 10) || 90,
        state, psuType: process.env.BANK_PSU_TYPE || "personal",
      });
      await db.upsertBankConnectionPending(SHOP, { aspspName, country, pendingState: state, pendingAuthId: started.authorizationId, validUntil: started.validUntil });
      res.json({ url: started.url });
    } catch (e) { actionError(res, e); }
  });

  // Verfügbare Banken (ASPSPs) auflisten — zum Ermitteln des exakten BANK_ASPSP_NAME beim Einrichten.
  app.get("/admin/bank/aspsps", async (req, res) => {
    try {
      if (!bank.configured()) return res.status(503).json({ error: "Enable Banking nicht konfiguriert (ENV fehlt)" });
      const list = await bank.listAspsps(req.query.country || process.env.BANK_ASPSP_COUNTRY || "DE");
      const q = String(req.query.q || "").toLowerCase();
      const out = (list || [])
        .map((a) => ({ name: a.name, country: a.country, maxConsentDays: a.maximum_consent_validity ? Math.floor(a.maximum_consent_validity / 86400) : null }))
        .filter((a) => !q || String(a.name || "").toLowerCase().includes(q));
      res.json({ count: out.length, aspsps: out });
    } catch (e) { actionError(res, e); }
  });

  app.get("/admin/bank/status", async (req, res) => {
    try {
      const configured = bank.configured();
      if (!db.configured()) return res.json({ configured, connected: false });
      const conn = await db.getBankConnection(SHOP);
      const reviewCount = await db.countBankReview(SHOP).catch(() => 0);
      const connected = !!(conn && conn.sessionId && conn.accountUid && conn.status === "active");
      let daysUntilExpiry = null;
      if (conn && conn.validUntil) daysUntilExpiry = Math.floor((new Date(conn.validUntil).getTime() - Date.now()) / 86400000);
      const needsReconsent = !!(conn && (conn.status === "expired" || (daysUntilExpiry != null && daysUntilExpiry < 0)));
      res.json({
        configured, connected,
        ibanMasked: (conn && conn.ibanMasked) || null,
        aspspName: (conn && conn.aspspName) || null,
        validUntil: (conn && conn.validUntil) || null,
        lastSyncAt: (conn && conn.lastSyncAt) || null,
        status: (conn && conn.status) || "none",
        daysUntilExpiry, needsReconsent, reviewCount, dryRun: BANK_DRYRUN,
      });
    } catch (e) { res.status(502).json({ error: String((e && e.message) || e).slice(0, 200) }); }
  });

  app.post("/admin/bank/sync", async (req, res) => {
    try {
      const out = await runBankSync({ force: /^(1|true|yes)$/i.test(req.query.force || ""), dryRun: /^(1|true|yes)$/i.test(req.query.dry || "") || undefined });
      res.json(out);
    } catch (e) { actionError(res, e); }
  });

  app.get("/admin/bank/review", async (req, res) => {
    try {
      if (!db.configured()) return res.json({ review: [] });
      res.json({ review: await db.listBankReview(SHOP) });
    } catch (e) { res.status(502).json({ error: String((e && e.message) || e).slice(0, 200), review: [] }); }
  });

  app.post("/admin/bank/review/:dedupKey/resolve", async (req, res) => {
    try {
      if (!db.configured()) return res.status(503).json({ error: "DB nicht konfiguriert" });
      const status = String((req.body && req.body.status) || "");
      const orderName = (req.body && req.body.orderName) || null;
      if (!["confirmed", "dismissed"].includes(status)) return res.status(400).json({ error: "status muss confirmed|dismissed sein" });
      if (status === "confirmed") {
        if (!orderName) return res.status(400).json({ error: "orderName erforderlich für confirmed" });
        await shopify.markOrderPaid(orderName);
        try { await shopify.addOrderTag(orderName, "bank-bezahlt-bestaetigt"); } catch (_) {}
      }
      const ok = await db.resolveBankTransaction(SHOP, req.params.dedupKey, status, orderName);
      if (!ok) return res.status(404).json({ error: "Eintrag nicht gefunden" });
      res.json({ ok: true, status });
    } catch (e) { actionError(res, e); }
  });

  // Serialisiert gleichzeitige Läufe (Cron + manuell) im selben Prozess: verhindert das
  // Check-then-act-Race beim Dedup/markOrderPaid. (Render-Free = 1 Instanz → prozessweit ausreichend.)
  let bankSyncChain = Promise.resolve();
  function runBankSync(opts) {
    const run = () => runBankSyncInner(opts);
    const p = bankSyncChain.then(run, run);
    bankSyncChain = p.then(() => {}, () => {});
    return p;
  }

  /**
   * Kernablauf: Umsätze holen → matchen → eindeutige exakte Treffer automatisch als bezahlt
   * markieren, alles Unsichere in die Review-Liste. dryRun: nur rechnen, NICHTS schreiben/markieren.
   */
  async function runBankSyncInner(opts) {
    opts = opts || {};
    const dryRun = opts.dryRun != null ? opts.dryRun : BANK_DRYRUN;
    if (!bank.configured()) return { ok: false, error: "Enable Banking nicht konfiguriert" };
    if (!db.configured()) return { ok: false, error: "DB nicht konfiguriert" };
    const conn = await db.getBankConnection(SHOP);
    if (!conn || !conn.sessionId || !conn.accountUid) return { ok: false, needsConnect: true, error: "Bank nicht verbunden" };
    if (conn.status === "expired") return { ok: false, needsReconsent: true, error: "Consent abgelaufen" };
    if (conn.validUntil && new Date(conn.validUntil).getTime() < Date.now()) {
      await db.expireBankConnection(SHOP); return { ok: false, needsReconsent: true, error: "Consent abgelaufen" };
    }
    if (!dryRun && !opts.force && conn.lastSyncAt && (Date.now() - new Date(conn.lastSyncAt).getTime()) < BANK_MIN_SYNC_MS) {
      return { ok: true, skipped: true, reason: "rate_cap" };
    }

    let txns;
    try { txns = await bank.listTransactions(conn.accountUid, 14); }
    catch (e) {
      if (e && e.code === "EXPIRED_SESSION") { await db.expireBankConnection(SHOP); return { ok: false, needsReconsent: true, error: "Consent abgelaufen" }; }
      throw e;
    }

    const orders = await shopify.fetchOrders();
    let unpaid = (orders || []).filter((o) =>
      ["pending", "authorized", "partially_paid"].includes(String(o.financialStatus || "").toLowerCase()) && !o.cancelledAt);

    const result = { ok: true, dryRun: !!dryRun, fetched: txns.length, autoPaid: [], review: 0, ignored: 0, skippedDup: 0, errors: [], preview: { autoPay: [], review: [], ignore: 0 } };

    for (const txn of txns) {
      if (txn.direction && txn.direction !== "CRDT") continue; // nur Eingänge
      try {
        if (!dryRun) {
          const existing = await db.findBankTransaction(SHOP, txn.dedupKey);
          if (existing) { result.skippedDup++; continue; }
        }
        let m = match.matchTransaction(txn, unpaid);

        // Bestellnummer da, aber Bestellung außerhalb des 250-Fensters → gezielt nachladen
        if (m.confidence === "none" && m.reason === "order_ref_not_in_window" && m.ref) {
          let resolved = false;
          try {
            const od = await shopify.getOrderPreviewData(m.ref);
            if (od && od.name) {
              resolved = true;
              // nur auto, wenn die nachgeladene Bestellung wirklich offen (unbezahlt, nicht storniert) ist
              const odOpen = !od.cancelledAt && ["pending", "authorized", "partially_paid"].includes(String(od.financialStatus || "").toLowerCase());
              const single = [{ name: od.name, totalPrice: od.totalPrice, currency: od.currency, customerName: od.customerName, shippingAddress: { firstName: od.firstName, lastName: od.lastName } }];
              const m2 = match.matchTransaction(txn, single);
              m = (m2.confidence === "order_number" && odOpen)
                ? { orderName: od.name, confidence: "order_number", reason: "order_number_exact_lookup", ref: m.ref }
                : { orderName: od.name, confidence: "ambiguous", reason: odOpen ? "order_ref_amount_mismatch_lookup" : "order_ref_not_open_lookup", ref: m.ref };
            }
          } catch (_) { /* nicht auffindbar */ }
          if (!resolved) {
            // Nummer zitiert, aber unauffindbar (Tippfehler/andere Nr) → Name/Betrag-Fallback, aber NIE auto
            const stripped = Object.assign({}, txn, { remittance: String(txn.remittance || "").replace(/B\d{3,6}/gi, " ") });
            const mf = match.matchTransaction(stripped, unpaid);
            m = (mf.confidence === "order_number" || mf.confidence === "name")
              ? { orderName: mf.orderName, confidence: "ambiguous", reason: "order_ref_unresolved_namehit", ref: m.ref }
              : mf;
          }
        }

        const excerpt = (txn.remittance || "").slice(0, 140);
        const auto = (m.confidence === "order_number" || m.confidence === "name") && m.orderName;

        if (dryRun) {
          if (auto) result.preview.autoPay.push({ orderName: m.orderName, confidence: m.confidence, amount: txn.amount, payer: txn.payerName, remittance: excerpt });
          else if (m.confidence === "ambiguous") result.preview.review.push({ orderName: m.orderName || null, reason: m.reason, amount: txn.amount, payer: txn.payerName, remittance: excerpt, candidates: m.candidates || null });
          else result.preview.ignore++;
          continue;
        }

        const base = { shop: SHOP, dedupKey: txn.dedupKey, amount: txn.amount, currency: txn.currency, bookingDate: txn.bookingDate, direction: txn.direction };
        if (auto) {
          try {
            await shopify.markOrderPaid(m.orderName);
            try { await shopify.addOrderTag(m.orderName, "bank-auto-bezahlt"); } catch (_) {}
            await db.insertBankTransaction(Object.assign({}, base, { orderName: m.orderName, confidence: m.confidence, reason: m.reason, status: "auto_paid", payerName: null, remittanceExcerpt: null }));
            unpaid = unpaid.filter((o) => o.name !== m.orderName); // aus dem Pool nehmen (kein Doppel-Mapping)
            result.autoPaid.push(m.orderName);
          } catch (e) {
            await db.insertBankTransaction(Object.assign({}, base, { orderName: m.orderName, confidence: m.confidence, reason: "markpaid_failed", status: "review", payerName: txn.payerName, remittanceExcerpt: excerpt }));
            result.review++; result.errors.push({ order: m.orderName, error: String(e.message).slice(0, 120) });
          }
        } else if (m.confidence === "ambiguous") {
          await db.insertBankTransaction(Object.assign({}, base, { orderName: m.orderName || null, confidence: m.confidence, reason: m.reason, status: "review", payerName: txn.payerName, remittanceExcerpt: excerpt }));
          result.review++;
        } else {
          await db.insertBankTransaction(Object.assign({}, base, { orderName: null, confidence: m.confidence, reason: m.reason, status: "ignored", payerName: null, remittanceExcerpt: null }));
          result.ignored++;
        }
      } catch (e) { result.errors.push({ dedupKey: txn.dedupKey, error: String((e && e.message) || e).slice(0, 120) }); }
    }

    if (!dryRun) {
      try { await db.touchBankSync(SHOP, new Date()); } catch (_) {}
      // Retention: PII alter Review-Zeilen nullen (Buchungs-Fakt bleibt fürs Audit).
      try { await db.purgeBankPII(parseInt(process.env.BANK_PII_RETENTION_DAYS, 10) || 90); } catch (_) {}
    }
    return result;
  }

  app.use((req, res) => res.status(404).json({ error: "not found" }));
  return app;
}

if (require.main === module) {
  const port = process.env.PORT || 8080;
  createApp().listen(port, () => console.log("miris-cockpit-api läuft auf :" + port));
}

module.exports = { createApp, timingEqual };
