"use strict";
/* Standalone-Tests (kein echter Shopify/Cloudinary-Zugriff nötig). Lauf: node test.js */
process.env.ADMIN_TOKEN = "test-secret-token";
process.env.ALLOWED_ORIGIN = "https://seryscmi.github.io";
process.env.SHOPIFY_STORE_HANDLE = "9zjzs5-ri";
process.env.BANK_SYNC_SECRET = "cron-secret-xyz";
process.env.BANK_REDIRECT_URL = "https://miris-cockpit-api.onrender.com/bank/callback";
process.env.BANK_DRYRUN = "false"; // Tests prüfen den scharfen Auto-Mark-Pfad explizit

const assert = require("assert");
const { createApp, timingEqual } = require("./server");
const shopify = require("./shopify");
const klaviyo = require("./klaviyo");

let pass = 0, fail = 0;
function ok(name, cond, extra) { if (cond) { pass++; console.log("  ✓ " + name); } else { fail++; console.log("  ✗ " + name + (extra ? "  →  " + extra : "")); } }

/* ---- 1. Shopify mapping (echte Node-Form aus Live-GraphQL) ---- */
console.log("\n[1] Shopify mapOrder / deriveImages");
const nodeB1027 = {
  id: "gid://shopify/Order/7644066808149", name: "B1027", createdAt: "2026-07-01T12:22:19Z", tags: [],
  displayFinancialStatus: "PENDING", displayFulfillmentStatus: "UNFULFILLED",
  totalPriceSet: { shopMoney: { amount: "29.99", currencyCode: "EUR" } },
  customer: { email: "seryschewmi@gmail.com", displayName: "Michail Seryschew" },
  metafields: { edges: [
    { node: { key: "approval_status", value: "versandbereit" } },
    { node: { key: "customer_decision", value: "freigegeben" } },
    { node: { key: "preview_url", value: "https://res.cloudinary.com/dg3k6nvwj/image/upload/v1782908617/miris/farbvorschau/x.jpg" } },
  ] },
  lineItems: { edges: [ { node: { title: "M.IRIS - Set", quantity: 1, customAttributes: [
    { key: "Auge 1 Bild", value: "https://res.cloudinary.com/dg3k6nvwj/image/upload/v1782908441/kunden-augenfotos/ygsx0esi3s8ontkh70uf.jpg" },
    { key: "Augenfarbe 1 Beschreibung", value: "Rot" },
    { key: "Auge 2 Bild", value: "https://res.cloudinary.com/dg3k6nvwj/image/upload/v1782908476/kunden-augenfotos/yzc9eewhhgcnklidcfuc.jpg" },
  ] } } ] },
  fulfillments: [],
};
const m = shopify.mapOrder(nodeB1027);
ok("financialStatus mapped", m.financialStatus === "PENDING", m.financialStatus);
ok("miris.approval_status mapped", m.miris.approval_status === "versandbereit", m.miris.approval_status);
ok("miris.customer_decision mapped", m.miris.customer_decision === "freigegeben");
ok("line-item property Auge 1 Bild present", /kunden-augenfotos/.test(m.lineItems[0].properties["Auge 1 Bild"]));
ok("adminUrl built with store handle + numeric id", m.adminUrl === "https://admin.shopify.com/store/9zjzs5-ri/orders/7644066808149", m.adminUrl);
ok("totalPrice parsed to number", m.totalPrice === 29.99, String(m.totalPrice));
ok("isWiderruf false (no tag)", m.isWiderruf === false);
const withTag = shopify.mapOrder(Object.assign({}, nodeB1027, { tags: ["Widerruf", "vip"] }));
ok("isWiderruf true when tag present", withTag.isWiderruf === true);
const imgs = shopify.deriveImages([m]);
ok("deriveImages finds 2 eye images", imgs.length === 2, "n=" + imgs.length);
ok("cloudinary public_id parsed", imgs[0].cloudinaryPublicId === "kunden-augenfotos/ygsx0esi3s8ontkh70uf", imgs[0].cloudinaryPublicId);

/* ---- 1b. Klaviyo Anliegen-Mapping (echte Event-Form aus Klaviyo) ---- */
console.log("\n[1b] Klaviyo mapEvent / deriveKind");
const evEscalation = { id: "7fTk8gNxCd7", attributes: { datetime: "2026-07-04T15:01:58+00:00", event_properties: { customer_name: "Michail Seryschew", admin_subject: "Chat-Nachricht von Michail Seryschew", topic: "Fehlende Perle im Set", customer_email: "cognacs-gesprochen0t@icloud.com", order_name: "B1001", verified: true, message: "Im Set der Bestellung B1001 fehlt eine Perle. Kunde bittet um Lösung." } } };
const evFeedback = { id: "7fTgjuWu8Fq", attributes: { datetime: "2026-07-04T14:49:41+00:00", event_properties: { message: "Ich mag Mary!", topic: "Feedback", admin_subject: "Feedback von Michail Seryschew", customer_name: "Michail Seryschew", customer_email: "x@y.de", order_name: "" } } };
const evAddr = { id: "7fADzHDHfeq", attributes: { datetime: "2026-07-02T14:05:11+00:00", event_properties: { message: "Adressänderung über den Chat.", topic: "Adressänderung", admin_subject: "Adressänderung B1027", customer_name: "M. S.", customer_email: "x@y.de", order_name: "B1027" } } };
const a1 = klaviyo.mapEvent(evEscalation);
ok("mapEvent id = klaviyo event id", a1.id === "7fTk8gNxCd7");
ok("mapEvent kind = Chat-Nachricht", a1.kind === "Chat-Nachricht", a1.kind);
ok("mapEvent nachricht = message", /fehlt eine Perle/.test(a1.nachricht));
ok("mapEvent thema = topic", a1.thema === "Fehlende Perle im Set");
ok("mapEvent relatedOrder = order_name", a1.relatedOrder === "B1001");
ok("mapEvent customerEmail mapped", a1.customerEmail === "cognacs-gesprochen0t@icloud.com");
ok("deriveKind Feedback", klaviyo.mapEvent(evFeedback).kind === "Feedback");
ok("deriveKind Adressänderung", klaviyo.mapEvent(evAddr).kind === "Adressänderung");
ok("empty order_name → relatedOrder null", klaviyo.mapEvent(evFeedback).relatedOrder === null);

/* ---- 2/3. Endpoints (auth, CORS, mapping, delete) ---- */
const MOCK_ORDERS = [ m, shopify.mapOrder({ id: "gid://shopify/Order/1", name: "B1001", createdAt: "2026-05-28T16:26:02Z", tags: [], displayFinancialStatus: "PAID", displayFulfillmentStatus: "FULFILLED", totalPriceSet: { shopMoney: { amount: "0.0", currencyCode: "EUR" } }, customer: {}, metafields: { edges: [] }, lineItems: { edges: [] }, fulfillments: [] }) ];
const deleted = [];
const actions = [];
const mockShopify = {
  fetchOrders: async () => MOCK_ORDERS, deriveImages: shopify.deriveImages, tagOrderDeleted: async () => {},
  addOrderTag: async (name, tag) => { actions.push(["tag", name, tag]); return { id: "gid://x/1", tag }; },
  markOrderPaid: async (name) => { actions.push(["paid", name]); return { id: "gid://x/1", financialStatus: "PAID" }; },
  fulfillOrder: async (name, nr, co) => {
    if (name === "B1023") { const e = new Error("Versendet markieren: bereits storniert"); e.userErrors = [{ message: "bereits storniert" }]; throw e; }
    actions.push(["fulfill", name, nr, co]); return { id: "gid://x/1", fulfillmentId: "gid://x/F1" };
  },
  cancelOrder: async (name, o) => { actions.push(["cancel", name, o]); return { id: "gid://x/1", jobId: "gid://x/J1" }; },
  getOrderPreviewData: async (name) => name === "B1023"
    ? { id: "gid://x/2", name, email: "k@x.de", firstName: "K", customerName: "K X", totalPrice: 29.99, currency: "EUR", miris: {} }
    : { id: "gid://x/1", name, email: "k@x.de", firstName: "K", customerName: "K X", totalPrice: 29.99, currency: "EUR", miris: { approval_url: "https://m-iris.de/apps/vorschau?x", preview_url: "https://res.cloudinary.com/x.jpg" } },
  setPreviewSentNow: async () => { actions.push(["previewSentAt"]); },
  updateShippingAddress: async (name, { email, shippingAddress }) => {
    if (shippingAddress && name === "B1001") { const e = new Error("Bestellung ist (teilweise) versendet – Adresse nicht änderbar"); e.status = 409; throw e; }
    if (shippingAddress && (shippingAddress.country || shippingAddress.countryCode)) { const e = new Error("Land ist nicht änderbar"); e.status = 400; throw e; }
    if (!email && !shippingAddress) { const e = new Error("email oder shippingAddress erforderlich"); e.status = 400; throw e; }
    actions.push(["shipping", name, email || null, shippingAddress || null]);
    return { id: "gid://x/1", updated: { email: !!email, address: !!shippingAddress } };
  },
  sendPreviewComplete: async (name, url) => {
    actions.push(["previewComplete", name, url]);
    const crypto = require("crypto");
    const token = crypto.randomBytes(32).toString("hex");
    return {
      order: { id: "gid://x/1", name, email: "k@x.de", firstName: "K", lastName: "X", customerName: "K X" },
      approvalUrl: "https://m-iris.de/apps/vorschau?order=gid&token=" + token,
      previewUrl: url,
      previewSentAt: new Date().toISOString(),
      deadlineAt: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
    };
  },
};
const uploads = [];
const mockCloud = {
  deleteImage: async (id) => { deleted.push(id); return { result: "ok" }; },
  uploadImage: async (b64, opts) => {
    if (b64 === "FAIL") throw new Error("simulierter Cloudinary-Ausfall");
    uploads.push(opts);
    return { secureUrl: "https://res.cloudinary.com/dg3k6nvwj/image/upload/v1/" + opts.publicId + ".jpg", publicId: opts.publicId, bytes: 1000 };
  },
};
const sentReplies = [];
const sentEvents = [];
const sentMails = [];
const mockKlaviyo = { fetchAnliegen: async () => [klaviyo.mapEvent(evEscalation), klaviyo.mapEvent(evFeedback), klaviyo.mapEvent(evAddr)], sendAnliegenReply: async (x) => { sentReplies.push(x); return { sent: true }; }, sendCustomerMail: async (x) => { sentMails.push(x); return { sent: true }; }, trackEvent: async (x) => { if (x.email === "klaviyofail@x.de") throw new Error("simulierter Klaviyo-Ausfall"); sentEvents.push(x); return { sent: true }; }, diag: () => ({ klaviyoKeySet: true }), testConnection: async () => ({ ok: true }) };

// DB-Mock (Shared-DB-Schicht): Anliegen + Chats in-memory, gleiche API wie db.js
function makeMockDb(configuredFlag) {
  const anliegen = [
    { id: "an1", date: "2026-07-09T10:00:00Z", kind: "Chat-Nachricht", type: "escalation", customerName: "Test Kunde", customerEmail: "k@x.de", thema: "Fehlende Perle", nachricht: "Im Set fehlt eine Perle.", relatedOrder: "B1001", status: "neu", replies: null, repliedAt: null, widerrufAdminUrl: null },
    { id: "an2", date: "2026-07-08T10:00:00Z", kind: "Reparatur", type: "repair", customerName: "Test Kunde", customerEmail: "k@x.de", thema: "Neue Reparatur REP-X – B1001", nachricht: "Schaden: gerissen", relatedOrder: "B1001", status: "neu", replies: null, repliedAt: null, widerrufAdminUrl: null },
  ];
  const chats = [
    { id: "ct1", sessionId: "sess1", customerName: "Test Kunde", email: "k@x.de", orderName: "B1001", verified: true, createdAt: "2026-07-09T09:00:00Z", updatedAt: "2026-07-09T09:30:00Z", messageCount: 4, messages: [{ role: "user", content: "Hallo" }, { role: "assistant", content: "Hi!" }] },
    { id: "ct2", sessionId: "sess2", customerName: "Andere Person", email: "a@y.de", orderName: null, verified: false, createdAt: "2026-07-07T09:00:00Z", updatedAt: "2026-07-07T09:10:00Z", messageCount: 2, messages: [] },
  ];
  let bankConn = null;
  const bankTx = [];
  return {
    _anliegen: anliegen, _chats: chats, lastListParams: null,
    configured: () => configuredFlag,
    listAnliegen: async () => anliegen.slice(),
    getAnliegen: async (id) => anliegen.find(a => a.id === id) || null,
    updateAnliegenStatus: async (id, status) => { if (!["neu","in Arbeit","beantwortet","erledigt"].includes(status)) throw new Error("Ungültiger Status"); const a = anliegen.find(x => x.id === id); if (!a) return false; a.status = status; return true; },
    appendAnliegenReply: async (id, text) => { const a = anliegen.find(x => x.id === id); if (!a) return null; a.replies = (a.replies || []).concat([{ text, at: "now" }]); a.status = "beantwortet"; return { id: a.id, email: a.customerEmail, name: a.customerName, thema: a.thema, message: a.nachricht, orderName: a.relatedOrder }; },
    deleteAnliegen: async (id) => { const i = anliegen.findIndex(x => x.id === id); if (i < 0) return false; anliegen.splice(i, 1); return true; },
    deleteAnliegenByEmail: async (email) => { const before = anliegen.length; for (let i = anliegen.length - 1; i >= 0; i--) if (anliegen[i].customerEmail === email) anliegen.splice(i, 1); return before - anliegen.length; },
    listChats: async (p) => chats
      .filter(c => !p.qtext || (c.customerName + c.email + (c.orderName || "")).toLowerCase().includes(String(p.qtext).toLowerCase()))
      .map(({ messages, ...rest }) => rest),
    getChat: async (id) => chats.find(c => c.id === id || c.sessionId === id) || null,
    deleteChat: async (id) => { const i = chats.findIndex(c => c.id === id || c.sessionId === id); if (i < 0) return false; chats.splice(i, 1); return true; },
    deleteChatsBy: async ({ email, orderName, name }) => { if (!email && !orderName && !name) throw new Error("email, orderName oder name erforderlich"); const before = chats.length; for (let i = chats.length - 1; i >= 0; i--) { const c = chats[i]; if ((email && c.email === email) || (orderName && c.orderName === orderName) || (name && c.customerName === name)) chats.splice(i, 1); } return before - chats.length; },
    _erasures: [],
    scrubOrderSnapshots: async () => 1,
    insertErasureLog: async function (row) { this._erasures.push(row); },
    listErasureLog: async () => [],
    // --- Bank-Zahlungsabgleich (in-memory) ---
    _bankConn: null, _bankTx: bankTx,
    _seedBankConn: (c) => { bankConn = c; },
    getBankConnection: async () => bankConn,
    upsertBankConnectionPending: async (shop, o) => { bankConn = Object.assign({}, bankConn, { shop, aspspName: o.aspspName, country: o.country, status: "pending", pendingState: o.pendingState, pendingAuthId: o.pendingAuthId, validUntil: o.validUntil || null }); },
    activateBankConnection: async (shop, o) => { bankConn = Object.assign({}, bankConn, { shop, sessionId: o.sessionId, accountUid: o.accountUid, ibanMasked: o.ibanMasked, validUntil: o.validUntil || (bankConn && bankConn.validUntil) || null, status: "active", pendingState: null, pendingAuthId: null, aspspName: o.aspspName || (bankConn && bankConn.aspspName) }); },
    expireBankConnection: async () => { if (bankConn) bankConn.status = "expired"; },
    touchBankSync: async (shop, ts) => { if (bankConn) bankConn.lastSyncAt = ts; },
    findBankTransaction: async (shop, key) => bankTx.find((t) => t.dedupKey === key) || null,
    insertBankTransaction: async (row) => { if (bankTx.find((t) => t.dedupKey === row.dedupKey)) return { inserted: false }; bankTx.push(Object.assign({}, row)); return { inserted: true }; },
    listBankReview: async () => bankTx.filter((t) => t.status === "review"),
    countBankReview: async () => bankTx.filter((t) => t.status === "review").length,
    resolveBankTransaction: async (shop, key, status, orderName) => { const t = bankTx.find((x) => x.dedupKey === key); if (!t) return false; t.status = status; if (orderName) t.orderName = orderName; t.payerName = null; t.remittanceExcerpt = null; return true; },
    purgeBankPII: async () => 0,
    testConnection: async () => ({ ok: configuredFlag, anliegen: anliegen.length, chats: chats.length }),
    diag: () => ({ databaseUrlSet: configuredFlag }),
  };
}
const mockDb = makeMockDb(true);

const app = createApp({ shopify: mockShopify, cloud: mockCloud, klaviyo: mockKlaviyo, db: mockDb });
const server = app.listen(0, run);

async function run() {
  const base = "http://127.0.0.1:" + server.address().port;
  const B = "Bearer test-secret-token";
  const ORIGIN = "https://seryscmi.github.io";
  try {
    console.log("\n[2] Health & Auth");
    let r = await fetch(base + "/health");
    ok("GET /health = 200 without auth", r.status === 200);
    ok("health payload ok:true", (await r.json()).ok === true);

    r = await fetch(base + "/admin/orders");
    ok("GET /admin/orders without token = 401", r.status === 401, String(r.status));
    r = await fetch(base + "/admin/orders", { headers: { Authorization: "Bearer WRONG" } });
    ok("GET /admin/orders wrong token = 401", r.status === 401);
    r = await fetch(base + "/admin/orders", { headers: { Authorization: B } });
    ok("GET /admin/orders correct token = 200", r.status === 200);
    const od = await r.json();
    ok("orders array returned", Array.isArray(od.orders) && od.orders.length === 2, "n=" + (od.orders || []).length);
    ok("order carries miris metafields", od.orders[0].miris.approval_status === "versandbereit");

    console.log("\n[3] Images & Delete");
    r = await fetch(base + "/admin/images", { headers: { Authorization: B } });
    const im = await r.json();
    ok("GET /admin/images = 200 with images", r.status === 200 && im.images.length === 2, "n=" + (im.images || []).length);

    r = await fetch(base + "/admin/images/delete", { method: "POST", headers: { Authorization: B, "Content-Type": "application/json" }, body: JSON.stringify({}) });
    ok("POST delete without publicId = 400", r.status === 400);
    r = await fetch(base + "/admin/images/delete", { method: "POST", headers: { Authorization: B, "Content-Type": "application/json" }, body: JSON.stringify({ publicId: "kunden-augenfotos/abc", orderName: "B1027" }) });
    ok("POST delete with publicId = 200", r.status === 200);
    ok("cloud.deleteImage was called with publicId", deleted.includes("kunden-augenfotos/abc"), deleted.join(","));

    console.log("\n[3b] Anliegen (DB primär)");
    r = await fetch(base + "/admin/anliegen", { headers: { Authorization: B } });
    ok("GET /admin/anliegen with token 200", r.status === 200);
    const an = await r.json();
    ok("anliegen from DB (source=db, 2 rows)", an.source === "db" && an.anliegen.length === 2, "source=" + an.source + " n=" + (an.anliegen || []).length);
    ok("anliegen carries kind + nachricht + status", an.anliegen[0].kind === "Chat-Nachricht" && /Perle/.test(an.anliegen[0].nachricht) && an.anliegen[0].status === "neu");
    ok("repair anliegen mapped", an.anliegen[1].kind === "Reparatur");
    r = await fetch(base + "/admin/anliegen");
    ok("GET /admin/anliegen without token = 401", r.status === 401);

    r = await fetch(base + "/admin/anliegen/an1", { method: "PATCH", headers: { Authorization: B, "Content-Type": "application/json" }, body: JSON.stringify({ status: "erledigt" }) });
    ok("PATCH anliegen status = 200", r.status === 200);
    ok("status persisted in db", mockDb._anliegen.find(a => a.id === "an1").status === "erledigt");
    r = await fetch(base + "/admin/anliegen/an1", { method: "PATCH", headers: { Authorization: B, "Content-Type": "application/json" }, body: JSON.stringify({ status: "quatsch" }) });
    ok("PATCH invalid status = 400", r.status === 400);
    r = await fetch(base + "/admin/anliegen/nope", { method: "PATCH", headers: { Authorization: B, "Content-Type": "application/json" }, body: JSON.stringify({ status: "neu" }) });
    ok("PATCH unknown id = 404", r.status === 404);
    console.log("\n[3b2] Anliegen beantworten");
    r = await fetch(base + "/admin/anliegen/an1/reply", { method: "POST", headers: { Authorization: B, "Content-Type": "application/json" }, body: JSON.stringify({ reply_text: "Wir schicken dir kostenlos eine Ersatzperle zu!" }) });
    const rep = await r.json();
    ok("POST reply = 200 + beantwortet", r.status === 200 && rep.status === "beantwortet", JSON.stringify(rep));
    ok("Klaviyo-Event an Kunden-E-Mail gefeuert", sentReplies.length === 1 && sentReplies[0].email === "k@x.de", JSON.stringify(sentReplies[0] || {}));
    ok("Reply-Event trägt thema + originalMessage", sentReplies[0].thema === "Fehlende Perle" && /fehlt eine Perle/.test(sentReplies[0].originalMessage));
    ok("Reply in DB protokolliert + Status beantwortet", mockDb._anliegen.find(a => a.id === "an1").replies.length === 1 && mockDb._anliegen.find(a => a.id === "an1").status === "beantwortet");
    r = await fetch(base + "/admin/anliegen/an1/reply", { method: "POST", headers: { Authorization: B, "Content-Type": "application/json" }, body: JSON.stringify({ reply_text: "" }) });
    ok("POST reply ohne Text = 400", r.status === 400);
    r = await fetch(base + "/admin/anliegen/nope/reply", { method: "POST", headers: { Authorization: B, "Content-Type": "application/json" }, body: JSON.stringify({ reply_text: "hi" }) });
    ok("POST reply unbekannte id = 404", r.status === 404);

    r = await fetch(base + "/admin/anliegen/an2", { method: "DELETE", headers: { Authorization: B } });
    ok("DELETE anliegen = 200", r.status === 200);
    ok("anliegen really deleted", mockDb._anliegen.length === 1);

    console.log("\n[3c] Chats (DB)");
    r = await fetch(base + "/admin/chats", { headers: { Authorization: B } });
    let ch = await r.json();
    ok("GET /admin/chats = 200 with 2 chats", r.status === 200 && ch.chats.length === 2, "n=" + (ch.chats || []).length);
    ok("chat list has no messages payload", ch.chats[0].messages === undefined);
    r = await fetch(base + "/admin/chats?q=B1001", { headers: { Authorization: B } });
    ch = await r.json();
    ok("chat search by order matches 1", ch.chats.length === 1 && ch.chats[0].orderName === "B1001", "n=" + ch.chats.length);
    r = await fetch(base + "/admin/chats/ct1", { headers: { Authorization: B } });
    const one = await r.json();
    ok("GET chat detail includes messages", r.status === 200 && Array.isArray(one.chat.messages) && one.chat.messages.length === 2);
    r = await fetch(base + "/admin/chats/nope", { headers: { Authorization: B } });
    ok("GET unknown chat = 404", r.status === 404);
    r = await fetch(base + "/admin/chats?email=a%40y.de", { method: "DELETE", headers: { Authorization: B } });
    const delBy = await r.json();
    ok("DELETE chats by email = 200, deleted 1", r.status === 200 && delBy.deleted === 1, JSON.stringify(delBy));
    r = await fetch(base + "/admin/chats/sess1", { method: "DELETE", headers: { Authorization: B } });
    ok("DELETE chat by sessionId = 200", r.status === 200);
    ok("all chats gone", mockDb._chats.length === 0);
    r = await fetch(base + "/admin/chats", { method: "DELETE", headers: { Authorization: B } });
    ok("DELETE chats without filter = 400", r.status === 400);

    console.log("\n[3f] DSGVO-Ein-Klick");
    // mockShopify.fetchOrders liefert B1027 (kunde cognacs…? nein: customerEmail aus mapOrder = seryschewmi@gmail.com laut Fixture) — nutze orderName-Pfad
    r = await fetch(base + "/admin/dsgvo/erase", { method: "POST", headers: { Authorization: B, "Content-Type": "application/json" }, body: JSON.stringify({ orderName: "B1027", email: "k@x.de", options: { klaviyo: false } }) });
    const er = await r.json();
    ok("POST erase = 200 mit Report", r.status === 200 && er.ok && er.report, JSON.stringify(er).slice(0, 120));
    ok("Fotos gefunden+gelöscht (2 aus B1027)", er.report.photos && er.report.photos.found === 2 && er.report.photos.deleted === 2, JSON.stringify(er.report.photos));
    ok("Cloudinary wirklich aufgerufen", deleted.length >= 3, "deleted=" + deleted.length);
    ok("Order getaggt (augenfotos-geloescht)", actions.some(a => a[0] === "tag" && a[2] === "augenfotos-geloescht"));
    ok("Chats+Anliegen+Snapshots im Report", !!er.report.chats && !!er.report.anliegen && !!er.report.snapshots, JSON.stringify(Object.keys(er.report)));
    ok("ErasureLog geschrieben", mockDb._erasures.length === 1);
    r = await fetch(base + "/admin/dsgvo/erase", { method: "POST", headers: { Authorization: B, "Content-Type": "application/json" }, body: JSON.stringify({}) });
    ok("erase ohne email/orderName = 400", r.status === 400);
    r = await fetch(base + "/admin/dsgvo/log", { headers: { Authorization: B } });
    ok("GET dsgvo/log = 200", r.status === 200 && Array.isArray((await r.json()).log));

    console.log("\n[3e] Bestell-Aktionen");
    r = await fetch(base + "/admin/orders/B1027/mahnung", { method: "POST", headers: { Authorization: B } });
    ok("POST mahnung = 200 + Tag MAHNUNG", r.status === 200 && actions.some(a => a[0] === "tag" && a[1] === "B1027" && a[2] === "MAHNUNG"));
    const mahnEv = sentEvents.find(e => e.metricName === "MIRIS_MAHNUNG");
    ok("MIRIS_MAHNUNG-Event mit amount/currency/order_name", !!mahnEv && mahnEv.properties.order_name === "B1027" && /,/.test(mahnEv.properties.amount) && mahnEv.properties.currency === "EUR", JSON.stringify(mahnEv && mahnEv.properties));
    r = await fetch(base + "/admin/orders/B1027/mark-paid", { method: "POST", headers: { Authorization: B } });
    ok("POST mark-paid = 200 → PAID", r.status === 200 && (await r.json()).financialStatus === "PAID");
    r = await fetch(base + "/admin/orders/B1027/fulfill", { method: "POST", headers: { Authorization: B, "Content-Type": "application/json" }, body: JSON.stringify({ trackingNumber: "12345", trackingCompany: "DHL" }) });
    ok("POST fulfill = 200 mit Tracking", r.status === 200 && actions.some(a => a[0] === "fulfill" && a[2] === "12345" && a[3] === "DHL"));
    r = await fetch(base + "/admin/orders/B1023/fulfill", { method: "POST", headers: { Authorization: B, "Content-Type": "application/json" }, body: JSON.stringify({}) });
    ok("POST fulfill mit userErrors = 422", r.status === 422 && Array.isArray((await r.json()).userErrors));
    r = await fetch(base + "/admin/orders/B1027/cancel", { method: "POST", headers: { Authorization: B, "Content-Type": "application/json" }, body: JSON.stringify({ refund: true, restock: true }) });
    ok("POST cancel = 200", r.status === 200 && actions.some(a => a[0] === "cancel"));
    r = await fetch(base + "/admin/orders/B1027/resend-preview", { method: "POST", headers: { Authorization: B } });
    const rp = await r.json();
    ok("POST resend-preview = 200 an Kunden-E-Mail", r.status === 200 && rp.to === "k@x.de", JSON.stringify(rp));
    const pv = sentEvents.find(e => e.metricName === "MIRIS_PREVIEW_SENT");
    ok("MIRIS_PREVIEW_SENT-Event mit approval_url + 24h-Frist", !!pv && /vorschau/.test(pv.properties.approval_url) && pv.properties.deadline_hours === 24);
    ok("preview_sent_at in Shopify angeglichen", actions.some(a => a[0] === "previewSentAt"));
    r = await fetch(base + "/admin/orders/B1023/resend-preview", { method: "POST", headers: { Authorization: B } });
    ok("resend-preview ohne Vorschau = 422", r.status === 422);
    r = await fetch(base + "/admin/orders/B1027/mahnung", { method: "POST" });
    ok("Aktion ohne Token = 401", r.status === 401);

    console.log("\n[3g] v2: Adresse bearbeiten");
    r = await fetch(base + "/admin/orders/B1027/shipping", { method: "PATCH", headers: { Authorization: B, "Content-Type": "application/json" }, body: JSON.stringify({ shippingAddress: { firstName: "Max", lastName: "Muster", address1: "Neue Str. 1", zip: "41468", city: "Neuss" } }) });
    ok("PATCH shipping (UNFULFILLED) = 200", r.status === 200 && actions.some(a => a[0] === "shipping" && a[1] === "B1027" && a[3] && a[3].address1 === "Neue Str. 1"));
    r = await fetch(base + "/admin/orders/B1001/shipping", { method: "PATCH", headers: { Authorization: B, "Content-Type": "application/json" }, body: JSON.stringify({ shippingAddress: { address1: "X" } }) });
    ok("PATCH shipping auf versendete Order = 409", r.status === 409);
    r = await fetch(base + "/admin/orders/B1001/shipping", { method: "PATCH", headers: { Authorization: B, "Content-Type": "application/json" }, body: JSON.stringify({ email: "neu@kunde.de" }) });
    ok("PATCH nur E-Mail auf versendete Order = 200", r.status === 200 && actions.some(a => a[0] === "shipping" && a[1] === "B1001" && a[2] === "neu@kunde.de"));
    r = await fetch(base + "/admin/orders/B1027/shipping", { method: "PATCH", headers: { Authorization: B, "Content-Type": "application/json" }, body: JSON.stringify({ shippingAddress: { country: "Österreich" } }) });
    ok("PATCH mit Land = 400", r.status === 400);
    r = await fetch(base + "/admin/orders/B1027/shipping", { method: "PATCH", headers: { Authorization: B, "Content-Type": "application/json" }, body: JSON.stringify({}) });
    ok("PATCH ohne Felder = 400", r.status === 400);

    console.log("\n[3h] v2: Farbvorschau senden");
    const PNG = Buffer.from("fake-image-bytes-1234567890").toString("base64");
    r = await fetch(base + "/admin/orders/B1027/send-preview", { method: "POST", headers: { Authorization: B, "Content-Type": "application/json" }, body: JSON.stringify({ imageBase64: PNG, mimeType: "image/png" }) });
    const sp = await r.json();
    ok("POST send-preview = 200", r.status === 200 && sp.ok, JSON.stringify(sp).slice(0, 120));
    ok("Cloudinary-Upload mit Ordner+publicId", uploads.some(u => u.folder === "miris/farbvorschau" && /^order-B1027-\d+$/.test(u.publicId)));
    ok("sendPreviewComplete mit Upload-URL aufgerufen", actions.some(a => a[0] === "previewComplete" && a[1] === "B1027" && /cloudinary/.test(a[2])));
    const pvEv = sentEvents.filter(e => e.metricName === "MIRIS_PREVIEW_SENT").pop();
    ok("MIRIS_PREVIEW_SENT mit approval_url+deadline 24h", !!pvEv && /token=/.test(pvEv.properties.approval_url) && pvEv.properties.deadline_hours === 24 && (new Date(pvEv.properties.deadline_at) - new Date(pvEv.properties.preview_sent_at)) === 24 * 3600 * 1000, pvEv && JSON.stringify(Object.keys(pvEv.properties)));
    r = await fetch(base + "/admin/orders/B1027/send-preview", { method: "POST", headers: { Authorization: B, "Content-Type": "application/json" }, body: JSON.stringify({ imageBase64: PNG, mimeType: "image/gif" }) });
    ok("send-preview mit GIF = 400", r.status === 400);
    r = await fetch(base + "/admin/orders/B1027/send-preview", { method: "POST", headers: { Authorization: B, "Content-Type": "application/json" }, body: JSON.stringify({ mimeType: "image/png" }) });
    ok("send-preview ohne Bild = 400", r.status === 400);
    const before = actions.filter(a => a[0] === "previewComplete").length;
    r = await fetch(base + "/admin/orders/B1027/send-preview", { method: "POST", headers: { Authorization: B, "Content-Type": "application/json" }, body: JSON.stringify({ imageBase64: "FAIL", mimeType: "image/png" }) });
    const spf = await r.json();
    ok("Cloudinary-Fail = 502 stage:cloudinary, KEINE Metafelder", r.status === 502 && spf.stage === "cloudinary" && actions.filter(a => a[0] === "previewComplete").length === before);

    console.log("\n[3i] v2: freie Kunden-E-Mail");
    r = await fetch(base + "/admin/customers/email", { method: "POST", headers: { Authorization: B, "Content-Type": "application/json" }, body: JSON.stringify({ email: "kunde@test.de", firstName: "Lena Hoffmann", subject: "Frage zu deiner Bestellung B1027", message: "Hallo,\nwelche Augenfarbe wünschst du für Auge 2?", orderName: "B1027" }) });
    ok("POST customers/email = 200", r.status === 200);
    ok("sendCustomerMail mit subject+message+order", sentMails.length === 1 && sentMails[0].subject.includes("B1027") && /Augenfarbe/.test(sentMails[0].message) && sentMails[0].orderName === "B1027");
    r = await fetch(base + "/admin/customers/email", { method: "POST", headers: { Authorization: B, "Content-Type": "application/json" }, body: JSON.stringify({ email: "keine-mail", subject: "x", message: "y" }) });
    ok("ungültige E-Mail = 400", r.status === 400);
    r = await fetch(base + "/admin/customers/email", { method: "POST", headers: { Authorization: B, "Content-Type": "application/json" }, body: JSON.stringify({ email: "a@b.de", subject: "", message: "y" }) });
    ok("leerer Betreff = 400", r.status === 400);
    r = await fetch(base + "/admin/customers/email", { method: "POST", headers: { Authorization: B, "Content-Type": "application/json" }, body: JSON.stringify({ email: "a@b.de", subject: "x", message: "" }) });
    ok("leere Nachricht = 400", r.status === 400);

    console.log("\n[3d] Fallback ohne DB (Klaviyo-Quelle)");
    {
      const appNoDb = createApp({ shopify: mockShopify, cloud: mockCloud, klaviyo: mockKlaviyo, db: makeMockDb(false) });
      const s2 = appNoDb.listen(0);
      const base2 = "http://127.0.0.1:" + s2.address().port;
      const r2 = await fetch(base2 + "/admin/anliegen", { headers: { Authorization: B } });
      const a2 = await r2.json();
      ok("ohne DB: anliegen source=klaviyo (3 events)", a2.source === "klaviyo" && a2.anliegen.length === 3, "source=" + a2.source);
      const r3 = await fetch(base2 + "/admin/chats", { headers: { Authorization: B } });
      const c3 = await r3.json();
      ok("ohne DB: chats leer mit note", r3.status === 200 && c3.chats.length === 0 && !!c3.note);
      const r4 = await fetch(base2 + "/admin/anliegen/an1", { method: "DELETE", headers: { Authorization: B } });
      ok("ohne DB: DELETE anliegen = 503", r4.status === 503);
      s2.close();
    }

    console.log("\n[3z] Bank-Zahlungsabgleich");
    {
      const bankActions = [];
      let paidCalls = 0;
      const bankShopify = {
        fetchOrders: async () => [
          { name: "B2002", financialStatus: "PENDING", cancelledAt: null, totalPrice: 29.99, currency: "EUR", customerName: "Lena Hoffmann", shippingAddress: { firstName: "Lena", lastName: "Hoffmann" } },
          { name: "B2005", financialStatus: "PENDING", cancelledAt: null, totalPrice: 49.99, currency: "EUR", customerName: "Max Weber", shippingAddress: { firstName: "Max", lastName: "Weber" } },
          { name: "B2006", financialStatus: "PENDING", cancelledAt: null, totalPrice: 49.99, currency: "EUR", customerName: "Max Weber", shippingAddress: { firstName: "Max", lastName: "Weber" } },
          { name: "B2007", financialStatus: "PENDING", cancelledAt: null, totalPrice: 29.99, currency: "EUR", customerName: "Anna Klein", shippingAddress: { firstName: "Anna", lastName: "Klein" } },
          { name: "B2008", financialStatus: "PENDING", cancelledAt: null, totalPrice: 61.00, currency: "EUR", customerName: "Otto Kern", shippingAddress: { firstName: "Otto", lastName: "Kern" } },
        ],
        markOrderPaid: async (name) => { paidCalls++; bankActions.push(["paid", name]); return { financialStatus: "PAID" }; },
        addOrderTag: async (name, tag) => { bankActions.push(["tag", name, tag]); return { tag }; },
        getOrderPreviewData: async (name) => {
          if (name === "B9001") return { id: "g9001", name: "B9001", email: "o@x.de", cancelledAt: null, financialStatus: "PENDING", firstName: "Olaf", lastName: "Fern", customerName: "Olaf Fern", totalPrice: 77.77, currency: "EUR", miris: {} };
          if (name === "B9002") return { id: "g9002", name: "B9002", email: "p@x.de", cancelledAt: null, financialStatus: "PAID", firstName: "Petra", lastName: "Los", customerName: "Petra Los", totalPrice: 88.88, currency: "EUR", miris: {} };
          throw new Error("nicht gefunden");
        },
      };
      const BANK_TXNS = [
        { dedupKey: "k1", direction: "CRDT", amount: 29.99, currency: "EUR", bookingDate: "2026-07-10", remittance: "SVWZ+B2002 vielen dank", payerName: "Lena Hoffmann", iban: "DE1" },
        { dedupKey: "k2", direction: "CRDT", amount: 49.99, currency: "EUR", bookingDate: "2026-07-10", remittance: "Zahlung Armband", payerName: "Max Weber", iban: "DE2" },
        { dedupKey: "k3", direction: "CRDT", amount: 39.99, currency: "EUR", bookingDate: "2026-07-10", remittance: "B2007", payerName: "Anna Klein", iban: "DE3" },
        { dedupKey: "k4", direction: "CRDT", amount: 5.00, currency: "EUR", bookingDate: "2026-07-10", remittance: "Trinkgeld", payerName: "Niemand", iban: "DE4" },
        { dedupKey: "k5", direction: "DBIT", amount: 99.00, currency: "EUR", bookingDate: "2026-07-10", remittance: "Miete", payerName: "x", iban: "DE5" },
        // k6: Bestellnr außerhalb des Fensters, per gezieltem Lookup offen → auto
        { dedupKey: "k6", direction: "CRDT", amount: 77.77, currency: "EUR", bookingDate: "2026-07-10", remittance: "SVWZ+B9001", payerName: "Olaf Fern", iban: "DE6" },
        // k7: Bestellnr außerhalb des Fensters, aber bereits BEZAHLT → Review, NICHT auto
        { dedupKey: "k7", direction: "CRDT", amount: 88.88, currency: "EUR", bookingDate: "2026-07-10", remittance: "B9002 zahlung", payerName: "Petra Los", iban: "DE7" },
        // k8: getippte/falsche Bestellnr (unauffindbar) + perfekter Name/Betrag → Review statt ignoriert
        { dedupKey: "k8", direction: "CRDT", amount: 61.00, currency: "EUR", bookingDate: "2026-07-10", remittance: "B9999 danke", payerName: "Otto Kern", iban: "DE8" },
      ];
      const mockBank = {
        configured: () => true,
        listAspsps: async () => [{ name: "Mock ASPSP", country: "DE", maximum_consent_validity: 7776000 }, { name: "Sparkasse", country: "DE", maximum_consent_validity: 7776000 }],
        startAuth: async () => ({ url: "https://api.enablebanking.com/auth/redirect?x", authorizationId: "auth1", validUntil: new Date(Date.now() + 90 * 86400000).toISOString() }),
        createSession: async (code) => ({ sessionId: "sess-" + code, accounts: [{ uid: "acc1", account_id: { iban: "DE00111122223333" }, iban: "DE00111122223333", currency: "EUR", name: "Giro" }], aspsp: { name: "Sparkasse" } }),
        listTransactions: async () => BANK_TXNS.slice(),
        diag: () => ({}), testConnection: async () => ({ ok: true }),
      };

      // App mit aktiver Verbindung (Sync-Tests)
      const bankDb = makeMockDb(true);
      bankDb._seedBankConn({ shop: "9zjzs5-ri.myshopify.com", sessionId: "s", accountUid: "acc1", status: "active", validUntil: new Date(Date.now() + 90 * 86400000).toISOString(), lastSyncAt: null, aspspName: "Sparkasse", ibanMasked: "DE00…3333" });
      const bankApp = createApp({ shopify: bankShopify, cloud: mockCloud, klaviyo: mockKlaviyo, db: bankDb, bank: mockBank });
      const bs = bankApp.listen(0);
      const bb = "http://127.0.0.1:" + bs.address().port;

      // Dry-Run: rechnet, markiert NICHTS
      let rr = await (await fetch(bb + "/admin/bank/sync?dry=1", { method: "POST", headers: { Authorization: B } })).json();
      ok("Dry-Run: dryRun=true, kein markOrderPaid", rr.dryRun === true && paidCalls === 0 && bankDb._bankTx.length === 0, JSON.stringify(rr).slice(0, 120));
      ok("Dry-Run: Vorschau autoPay enthält B2002", (rr.preview.autoPay || []).some((x) => x.orderName === "B2002"));

      // Live-Sync scharf
      rr = await (await fetch(bb + "/admin/bank/sync?force=1", { method: "POST", headers: { Authorization: B } })).json();
      ok("Live: autoPaid = B2002 + B9001 (Lookup-Auto)", rr.autoPaid.length === 2 && rr.autoPaid.includes("B2002") && rr.autoPaid.includes("B9001"), JSON.stringify(rr.autoPaid));
      ok("Live: markOrderPaid + Tag bank-auto-bezahlt", bankActions.some((a) => a[0] === "paid" && a[1] === "B2002") && bankActions.some((a) => a[0] === "tag" && a[1] === "B2002" && a[2] === "bank-auto-bezahlt"));
      ok("SICHERHEIT: bezahlte Out-of-Window-Order (B9002) NICHT auto-bezahlt", !rr.autoPaid.includes("B9002") && !bankActions.some((a) => a[0] === "paid" && a[1] === "B9002"));
      ok("Live: 4 Review (name_multiple, mismatch, paid-lookup, typo-namehit), 1 ignored", rr.review === 4 && rr.ignored === 1, "review=" + rr.review + " ignored=" + rr.ignored);
      ok("Live: fetched=8, keine Fehler", rr.fetched === 8 && rr.errors.length === 0, "fetched=" + rr.fetched + " errs=" + rr.errors.length);

      // Idempotenz
      const paidBefore = paidCalls;
      rr = await (await fetch(bb + "/admin/bank/sync?force=1", { method: "POST", headers: { Authorization: B } })).json();
      ok("Idempotent: 2. Lauf markiert nicht erneut", rr.autoPaid.length === 0 && paidCalls === paidBefore && rr.skippedDup === 7, "skippedDup=" + rr.skippedDup);

      // Rate-Cap (ohne force, lastSyncAt frisch)
      rr = await (await fetch(bb + "/admin/bank/sync", { method: "POST", headers: { Authorization: B } })).json();
      ok("Rate-Cap: ohne force geskippt", rr.skipped === true && rr.reason === "rate_cap");

      // Review-Liste + Auflösen
      let rev = (await (await fetch(bb + "/admin/bank/review", { headers: { Authorization: B } })).json()).review;
      ok("Review-Liste hat 4 Einträge", rev.length === 4, "n=" + rev.length);
      let rc = await fetch(bb + "/admin/bank/review/k3/resolve", { method: "POST", headers: { Authorization: B, "Content-Type": "application/json" }, body: JSON.stringify({ status: "confirmed", orderName: "B2007" }) });
      ok("Resolve confirmed → markOrderPaid(B2007)", rc.status === 200 && bankActions.some((a) => a[0] === "paid" && a[1] === "B2007"));
      rc = await fetch(bb + "/admin/bank/review/k2/resolve", { method: "POST", headers: { Authorization: B, "Content-Type": "application/json" }, body: JSON.stringify({ status: "dismissed" }) });
      ok("Resolve dismissed = 200", rc.status === 200);
      rev = (await (await fetch(bb + "/admin/bank/review", { headers: { Authorization: B } })).json()).review;
      ok("Review-Liste jetzt 2 (k7, k8 offen)", rev.length === 2, "n=" + rev.length);
      rc = await fetch(bb + "/admin/bank/review/k3/resolve", { method: "POST", headers: { Authorization: B, "Content-Type": "application/json" }, body: JSON.stringify({ status: "quatsch" }) });
      ok("Resolve mit falschem status = 400", rc.status === 400);

      // ASPSP-Liste (Bank-Namen ermitteln)
      const asp = await (await fetch(bb + "/admin/bank/aspsps?q=sparkasse", { headers: { Authorization: B } })).json();
      ok("ASPSP-Liste filterbar (Sparkasse)", asp.aspsps.length === 1 && asp.aspsps[0].name === "Sparkasse" && asp.aspsps[0].maxConsentDays === 90, JSON.stringify(asp).slice(0, 100));

      // Status
      const st = await (await fetch(bb + "/admin/bank/status", { headers: { Authorization: B } })).json();
      ok("Status: connected=true, ibanMasked gesetzt", st.connected === true && !!st.ibanMasked, JSON.stringify(st).slice(0, 120));

      // Cron
      rc = await fetch(bb + "/jobs/bank-sync", { method: "POST" });
      ok("Cron ohne Secret = 401", rc.status === 401);
      rc = await fetch(bb + "/jobs/bank-sync?secret=FALSCH", { method: "POST" });
      ok("Cron falsches Secret = 401", rc.status === 401);
      rc = await fetch(bb + "/jobs/bank-sync?secret=cron-secret-xyz&dry=1&force=1", { method: "POST" });
      ok("Cron korrektes Secret = 200 + no-store", rc.status === 200 && /no-store/.test(rc.headers.get("cache-control") || ""));

      bs.close();

      // Connect/Callback-Flow (leere Verbindung)
      const bankDb2 = makeMockDb(true);
      const bankApp2 = createApp({ shopify: bankShopify, cloud: mockCloud, klaviyo: mockKlaviyo, db: bankDb2, bank: mockBank });
      const bs2 = bankApp2.listen(0);
      const bb2 = "http://127.0.0.1:" + bs2.address().port;

      const conn = await (await fetch(bb2 + "/admin/bank/connect", { method: "POST", headers: { Authorization: B } })).json();
      ok("Connect liefert Enable-Banking-URL", /enablebanking/.test(conn.url || ""), conn.url);
      const pend = await bankDb2.getBankConnection();
      ok("Connect setzt pendingState + status pending", pend.status === "pending" && !!pend.pendingState);
      let cb = await fetch(bb2 + "/bank/callback?code=abc&state=WRONG");
      let cbtext = await cb.text();
      ok("Callback mit falschem state → nicht verbunden", /Sicherheitspr/.test(cbtext));
      cb = await fetch(bb2 + "/bank/callback?code=abc&state=" + encodeURIComponent(pend.pendingState));
      cbtext = await cb.text();
      ok("Callback korrekt → Bank verbunden", /Bank verbunden/.test(cbtext) && /no-store/.test(cb.headers.get("cache-control") || ""));
      const active = await bankDb2.getBankConnection();
      ok("Callback aktiviert Verbindung (accountUid acc1)", active.status === "active" && active.accountUid === "acc1" && !!active.ibanMasked);
      bs2.close();
    }

    console.log("\n[4] CORS");
    r = await fetch(base + "/admin/orders", { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" } });
    ok("preflight OPTIONS = 204", r.status === 204, String(r.status));
    ok("preflight allows our origin", r.headers.get("access-control-allow-origin") === ORIGIN, r.headers.get("access-control-allow-origin"));
    r = await fetch(base + "/admin/orders", { headers: { Authorization: B, Origin: ORIGIN } });
    ok("actual request echoes allowed origin", r.headers.get("access-control-allow-origin") === ORIGIN);
    r = await fetch(base + "/admin/orders", { headers: { Authorization: B, Origin: "https://evil.example.com" } });
    ok("disallowed origin gets no ACAO header", !r.headers.get("access-control-allow-origin"), r.headers.get("access-control-allow-origin"));

    console.log("\n[5] Misc");
    ok("timingEqual true for equal", timingEqual("abc", "abc") === true);
    ok("timingEqual false for different length", timingEqual("abc", "abcd") === false);
    r = await fetch(base + "/nope");
    ok("unknown route = 404", r.status === 404);
  } catch (e) {
    fail++; console.log("  ✗ exception: " + (e && e.message));
  } finally {
    server.close();
    console.log("\n========================================");
    console.log("  " + pass + " passed, " + fail + " failed");
    console.log("========================================\n");
    process.exit(fail ? 1 : 0);
  }
}
