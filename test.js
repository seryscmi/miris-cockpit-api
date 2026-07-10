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

const app = createApp({ shopify: mockShopify, cloud: mockCloud, klaviyo: mockKlaviyo });
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

    console.log("\n[3b] Anliegen (Klaviyo)");
    r = await fetch(base + "/admin/anliegen", { headers: { Authorization: B } });
    ok("GET /admin/anliegen without token would 401 — with token 200", r.status === 200);
    const an = await r.json();
    ok("anliegen array returned (3)", Array.isArray(an.anliegen) && an.anliegen.length === 3, "n=" + (an.anliegen || []).length);
    ok("anliegen carries kind + nachricht", an.anliegen[0].kind === "Chat-Nachricht" && /Perle/.test(an.anliegen[0].nachricht));
    r = await fetch(base + "/admin/anliegen");
    ok("GET /admin/anliegen without token = 401", r.status === 401);

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
