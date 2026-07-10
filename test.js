"use strict";
/* Standalone-Tests (kein echter Shopify/Cloudinary-Zugriff nötig). Lauf: node test.js */
process.env.ADMIN_TOKEN = "test-secret-token";
process.env.ALLOWED_ORIGIN = "https://seryscmi.github.io";
process.env.SHOPIFY_STORE_HANDLE = "9zjzs5-ri";

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
const mockShopify = { fetchOrders: async () => MOCK_ORDERS, deriveImages: shopify.deriveImages, tagOrderDeleted: async () => {} };
const mockCloud = { deleteImage: async (id) => { deleted.push(id); return { result: "ok" }; } };
const mockKlaviyo = { fetchAnliegen: async () => [klaviyo.mapEvent(evEscalation), klaviyo.mapEvent(evFeedback), klaviyo.mapEvent(evAddr)], diag: () => ({ klaviyoKeySet: true }), testConnection: async () => ({ ok: true }) };

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
