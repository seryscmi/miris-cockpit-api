"use strict";
/**
 * Shopify Admin API — Bestellungen laden + auf die Cockpit-Order-Form mappen.
 * Der Admin-Token bleibt serverseitig (ENV). Der Browser sieht ihn nie.
 */

const API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";

function shopDomain() {
  let s = (process.env.SHOPIFY_SHOP || "").trim();
  if (!s) throw new Error("SHOPIFY_SHOP nicht gesetzt");
  if (!/\.myshopify\.com$/.test(s)) s = s.replace(/\/+$/, "") + ".myshopify.com";
  return s;
}
function storeHandle() {
  // für Admin-Deeplinks; Default aus dem bekannten M.IRIS-Store
  return (process.env.SHOPIFY_STORE_HANDLE || "9zjzs5-ri").trim();
}

/**
 * Access-Token beschaffen. Zwei Wege:
 *  1) Neuer Standard (Dev Dashboard): SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET
 *     → client_credentials-Grant → 24h-Token, hier gecacht & automatisch erneuert.
 *  2) Alt/optional: statischer SHOPIFY_ADMIN_TOKEN (falls jemals verfügbar).
 */
let _tok = { value: null, expiresAt: 0 };
async function getAccessToken() {
  const cid = (process.env.SHOPIFY_CLIENT_ID || "").trim();
  const csec = (process.env.SHOPIFY_CLIENT_SECRET || "").trim();
  if (cid && csec) {
    const now = Date.now();
    if (_tok.value && now < _tok.expiresAt - 120000) return _tok.value; // 2 Min Puffer
    const url = `https://${shopDomain()}/admin/oauth/access_token`;
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: cid, client_secret: csec });
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Token-Austausch ${res.status}: ${t.slice(0, 300)}`);
    }
    const j = await res.json();
    if (!j.access_token) throw new Error("Token-Austausch: keine access_token in Antwort");
    _tok = { value: j.access_token, expiresAt: Date.now() + (Number(j.expires_in) || 86399) * 1000 };
    return _tok.value;
  }
  const staticTok = (process.env.SHOPIFY_ADMIN_TOKEN || "").trim();
  if (staticTok) return staticTok;
  throw new Error("Kein Shopify-Zugang: setze SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (Dev Dashboard) oder SHOPIFY_ADMIN_TOKEN.");
}

async function adminGraphQL(query, variables) {
  const token = await getAccessToken();
  const url = `https://${shopDomain()}/admin/api/${API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables: variables || {} }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`Shopify ${res.status}: ${t.slice(0, 200)}`);
  }
  const json = await res.json();
  if (json.errors) throw new Error("Shopify GraphQL: " + JSON.stringify(json.errors).slice(0, 300));
  return json.data;
}

const ORDERS_QUERY = `
query CockpitOrders($cursor: String) {
  orders(first: 50, sortKey: CREATED_AT, reverse: true, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      id name createdAt tags cancelledAt email phone
      displayFinancialStatus displayFulfillmentStatus
      totalPriceSet { shopMoney { amount currencyCode } }
      customer { email displayName }
      shippingAddress { firstName lastName address1 address2 zip city country countryCodeV2 phone }
      metafields(namespace: "miris", first: 40) { edges { node { key value } } }
      lineItems(first: 20) { edges { node { title quantity customAttributes { key value } } } }
      fulfillments(first: 10) { trackingInfo { number url company } }
    } }
  }
}`;

function mapOrder(node) {
  const miris = {};
  ((node.metafields && node.metafields.edges) || []).forEach((e) => { if (e.node) miris[e.node.key] = e.node.value; });
  const lineItems = ((node.lineItems && node.lineItems.edges) || []).map((e) => {
    const props = {};
    ((e.node.customAttributes) || []).forEach((a) => { props[a.key] = a.value; });
    return { title: e.node.title || "", quantity: e.node.quantity || 1, properties: props };
  });
  const numericId = String(node.id || "").split("/").pop();
  const tags = Array.isArray(node.tags) ? node.tags : [];
  const track = [];
  ((node.fulfillments) || []).forEach((f) => ((f.trackingInfo) || []).forEach((t) => { if (t && (t.number || t.url)) track.push(t); }));
  return {
    name: node.name,
    customerName: (node.customer && node.customer.displayName) || "",
    customerEmail: node.email || (node.customer && node.customer.email) || "",
    cancelledAt: node.cancelledAt || null,
    shippingAddress: node.shippingAddress || null,
    createdAt: node.createdAt,
    totalPrice: parseFloat((node.totalPriceSet && node.totalPriceSet.shopMoney && node.totalPriceSet.shopMoney.amount) || "0") || 0,
    currency: (node.totalPriceSet && node.totalPriceSet.shopMoney && node.totalPriceSet.shopMoney.currencyCode) || "EUR",
    financialStatus: node.displayFinancialStatus || "",
    fulfillmentStatus: node.displayFulfillmentStatus || "",
    lineItems,
    miris,
    tracking: track.length ? track[0] : null,
    adminUrl: `https://admin.shopify.com/store/${storeHandle()}/orders/${numericId}`,
    isWiderruf: tags.some((t) => /widerruf|withdrawal/i.test(String(t))),
    autoPaidByBank: tags.some((t) => /bank-auto-bezahlt|bank-bezahlt-bestaetigt/i.test(String(t))),
  };
}

async function fetchOrders(maxPages) {
  const out = [];
  let cursor = null;
  const cap = maxPages || 5; // bis zu 250 Bestellungen
  for (let i = 0; i < cap; i++) {
    const data = await adminGraphQL(ORDERS_QUERY, { cursor });
    const conn = data.orders;
    (conn.edges || []).forEach((e) => out.push(mapOrder(e.node)));
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return out;
}

function isCloudinary(url) { return /res\.cloudinary\.com/.test(String(url || "")); }
function cloudinaryPublicId(url) {
  const m = String(url || "").match(/\/upload\/(?:v\d+\/)?(.+?)(?:\.[a-z0-9]+)?(?:\?.*)?$/i);
  return m ? m[1] : "";
}
function deriveImages(orders) {
  const now = Date.now();
  const out = [];
  orders.forEach((o) => {
    const created = Date.parse(o.createdAt) || now;
    (o.lineItems || []).forEach((li) => {
      Object.keys(li.properties || {}).forEach((key) => {
        const val = li.properties[key];
        if (/^Auge\s*\d+\s*Bild$/i.test(key) && val && isCloudinary(val)) {
          out.push({ orderName: o.name, imageUrl: val, label: key, cloudinaryPublicId: cloudinaryPublicId(val), ageDays: Math.round((now - created) / 86400000) });
        }
      });
    });
  });
  return out;
}

const TAGS_ADD = `mutation($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`;

/** Order-GID über den Namen (z. B. "B1027") auflösen. */
async function resolveOrderGid(orderName) {
  const q = `query($q:String!){ orders(first:1, query:$q){ edges{ node{ id name } } } }`;
  const data = await adminGraphQL(q, { q: `name:${orderName}` });
  const node = data.orders.edges[0] && data.orders.edges[0].node;
  if (!node) throw new Error(`Bestellung ${orderName} nicht gefunden`);
  return node.id;
}

/** userErrors einer Mutation prüfen — wirft mit lesbarer Meldung (Route → 422). */
function assertNoUserErrors(payload, label) {
  const errs = (payload && payload.userErrors) || (payload && payload.orderCancelUserErrors) || [];
  if (errs.length) {
    const e = new Error(label + ": " + errs.map((x) => x.message).join("; "));
    e.userErrors = errs;
    throw e;
  }
}

async function tagOrderDeleted(orderName) {
  if (!orderName) return;
  // Audit-Tag setzen (best effort)
  try {
    const id = await resolveOrderGid(orderName);
    await adminGraphQL(TAGS_ADD, { id, tags: ["augenbild-geloescht"] });
  } catch (_) { /* nicht blockierend */ }
}

/* ---------- Bestell-Aktionen (P3) ---------- */

/** Tag setzen (z. B. "MAHNUNG" → löst die bestehende Shopify-Flow→Klaviyo-Automation aus). */
async function addOrderTag(orderName, tag) {
  const id = await resolveOrderGid(orderName);
  const data = await adminGraphQL(TAGS_ADD, { id, tags: [tag] });
  assertNoUserErrors(data.tagsAdd, "Tag setzen");
  return { id, tag };
}

/** Bestellung als bezahlt markieren (Banküberweisung eingegangen). */
async function markOrderPaid(orderName) {
  const id = await resolveOrderGid(orderName);
  const M = `mutation($input: OrderMarkAsPaidInput!){ orderMarkAsPaid(input:$input){ order { id displayFinancialStatus } userErrors { field message } } }`;
  const data = await adminGraphQL(M, { input: { id } });
  assertNoUserErrors(data.orderMarkAsPaid, "Als bezahlt markieren");
  return { id, financialStatus: data.orderMarkAsPaid.order && data.orderMarkAsPaid.order.displayFinancialStatus };
}

/** Bestellung stornieren. */
async function cancelOrder(orderName, opts) {
  const id = await resolveOrderGid(orderName);
  const o = opts || {};
  const M = `mutation($orderId: ID!, $notifyCustomer: Boolean, $refund: Boolean!, $restock: Boolean!, $reason: OrderCancelReason!){
    orderCancel(orderId:$orderId, notifyCustomer:$notifyCustomer, refund:$refund, restock:$restock, reason:$reason){
      job { id } orderCancelUserErrors { field message }
    } }`;
  const data = await adminGraphQL(M, {
    orderId: id,
    notifyCustomer: o.notify !== false,
    refund: o.refund !== false,
    restock: o.restock !== false,
    reason: o.reason || "OTHER",
  });
  assertNoUserErrors(data.orderCancel, "Stornieren");
  return { id, jobId: data.orderCancel.job && data.orderCancel.job.id };
}

/** Als versendet markieren mit Tracking (fulfillmentCreateV2, Kunde bekommt Shopify-Versandmail). */
async function fulfillOrder(orderName, trackingNumber, trackingCompany) {
  const id = await resolveOrderGid(orderName);
  const Q = `query($id: ID!){ order(id:$id){ fulfillmentOrders(first:10){ edges{ node{ id status } } } } }`;
  const qd = await adminGraphQL(Q, { id });
  const fos = ((qd.order && qd.order.fulfillmentOrders && qd.order.fulfillmentOrders.edges) || [])
    .map((e) => e.node)
    .filter((n) => n.status === "OPEN" || n.status === "IN_PROGRESS");
  if (!fos.length) throw new Error("Keine offene Versandposition gefunden (schon versendet oder storniert?)");
  const M = `mutation($fulfillment: FulfillmentV2Input!){ fulfillmentCreateV2(fulfillment:$fulfillment){ fulfillment { id status } userErrors { field message } } }`;
  const fulfillment = {
    notifyCustomer: true,
    lineItemsByFulfillmentOrder: fos.map((f) => ({ fulfillmentOrderId: f.id })),
  };
  if (trackingNumber) {
    fulfillment.trackingInfo = { number: String(trackingNumber) };
    if (trackingCompany) fulfillment.trackingInfo.company = String(trackingCompany);
  }
  const data = await adminGraphQL(M, { fulfillment });
  assertNoUserErrors(data.fulfillmentCreateV2, "Versendet markieren");
  return { id, fulfillmentId: data.fulfillmentCreateV2.fulfillment && data.fulfillmentCreateV2.fulfillment.id };
}

/** Kunden-/Bestelldaten für E-Mail-Aktionen (Vorschau erneut, Mahnung): E-Mail, Name, Betrag, miris-Metafelder. */
async function getOrderPreviewData(orderName) {
  const id = await resolveOrderGid(orderName);
  const Q = `query($id: ID!){ order(id:$id){ id name email cancelledAt displayFinancialStatus
    totalPriceSet { shopMoney { amount currencyCode } }
    customer { email firstName lastName displayName }
    metafields(namespace:"miris", first: 30){ edges{ node{ key value } } } } }`;
  const data = await adminGraphQL(Q, { id });
  const o = data.order;
  const miris = {};
  ((o.metafields && o.metafields.edges) || []).forEach((e) => { miris[e.node.key] = e.node.value; });
  return {
    id: o.id,
    name: o.name,
    email: o.email || (o.customer && o.customer.email) || "",
    cancelledAt: o.cancelledAt || null,
    financialStatus: o.displayFinancialStatus || "",
    firstName: (o.customer && o.customer.firstName) || "",
    lastName: (o.customer && o.customer.lastName) || "",
    customerName: (o.customer && o.customer.displayName) || "",
    totalPrice: parseFloat((o.totalPriceSet && o.totalPriceSet.shopMoney && o.totalPriceSet.shopMoney.amount) || "0") || 0,
    currency: (o.totalPriceSet && o.totalPriceSet.shopMoney && o.totalPriceSet.shopMoney.currencyCode) || "EUR",
    miris,
  };
}

/* ---------- Adresse/Kontakt bearbeiten (v2) — Muster aus Marys update_shipping_address ---------- */

function sanitizeAddrField(v, max) {
  return String(v == null ? "" : v).replace(/[\r\n\t<>]/g, "").replace(/\s+/g, " ").trim().slice(0, max || 100);
}

/**
 * Lieferadresse und/oder Bestell-E-Mail ändern (orderUpdate).
 * Guards: Adresse nur wenn nicht storniert UND UNFULFILLED; E-Mail immer erlaubt; Land unveränderbar.
 */
async function updateShippingAddress(orderName, { email, shippingAddress }) {
  const id = await resolveOrderGid(orderName);
  const Q = `query($id: ID!){ order(id:$id){ cancelledAt displayFulfillmentStatus shippingAddress { country } } }`;
  const qd = await adminGraphQL(Q, { id });
  const cur = qd.order || {};
  const input = { id };
  if (email) {
    const em = sanitizeAddrField(email, 200);
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) { const e = new Error("Ungültige E-Mail-Adresse"); e.status = 400; throw e; }
    input.email = em;
  }
  if (shippingAddress) {
    if (cur.cancelledAt) { const e = new Error("Bestellung ist storniert – Adresse nicht änderbar"); e.status = 409; throw e; }
    if (cur.displayFulfillmentStatus !== "UNFULFILLED") { const e = new Error("Bestellung ist (teilweise) versendet – Adresse nicht änderbar"); e.status = 409; throw e; }
    if (shippingAddress.country || shippingAddress.countryCode) { const e = new Error("Land ist nicht änderbar"); e.status = 400; throw e; }
    input.shippingAddress = {
      firstName: sanitizeAddrField(shippingAddress.firstName, 60),
      lastName: sanitizeAddrField(shippingAddress.lastName, 60),
      address1: sanitizeAddrField(shippingAddress.address1, 120),
      address2: sanitizeAddrField(shippingAddress.address2, 120),
      zip: sanitizeAddrField(shippingAddress.zip, 20),
      city: sanitizeAddrField(shippingAddress.city, 80),
      phone: sanitizeAddrField(shippingAddress.phone, 40),
      country: (cur.shippingAddress && cur.shippingAddress.country) || undefined, // Land bleibt
    };
  }
  if (!input.email && !input.shippingAddress) { const e = new Error("email oder shippingAddress erforderlich"); e.status = 400; throw e; }
  const M = `mutation($input: OrderInput!){ orderUpdate(input:$input){ order { id } userErrors { field message } } }`;
  const data = await adminGraphQL(M, { input });
  assertNoUserErrors(data.orderUpdate, "Adresse ändern");
  if (input.shippingAddress) { try { await adminGraphQL(TAGS_ADD, { id, tags: ["adresse-geaendert"] }); } catch (_) {} }
  return { id, updated: { email: !!input.email, address: !!input.shippingAddress } };
}

/* ---------- Farbvorschau komplett senden (v2) — Vertrag aus Marys app.preview-upload.jsx ---------- */

const crypto = require("crypto");
const PUBLIC_CUSTOMER_BASE_URL = process.env.PUBLIC_CUSTOMER_BASE_URL || "https://m-iris.de";

/**
 * Setzt nach dem Cloudinary-Upload alle 8 miris-Metafelder + Tags exakt wie Mary
 * (Freigabeseite vergleicht sha256(token); 24h-Auto-Freigabe liest Tag+Status+preview_sent_at).
 */
async function sendPreviewComplete(orderName, previewUrl) {
  const o = await getOrderPreviewData(orderName);
  if (!o.email) { const e = new Error("Bestellung hat keine Kunden-E-Mail"); e.status = 422; throw e; }
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const previewSentAt = new Date();
  const approvalUrl = PUBLIC_CUSTOMER_BASE_URL + "/apps/vorschau?order=" + encodeURIComponent(o.id) + "&token=" + encodeURIComponent(token);
  const M = `mutation($mf: [MetafieldsSetInput!]!, $id: ID!, $addTags: [String!]!, $removeTags: [String!]!){
    metafieldsSet(metafields:$mf){ userErrors { field message } }
    tagsAdd(id:$id, tags:$addTags){ userErrors { message } }
    tagsRemove(id:$id, tags:$removeTags){ userErrors { message } }
  }`;
  const mf = [
    { key: "approval_status", type: "single_line_text_field", value: "gesendet" },
    { key: "preview_url", type: "url", value: previewUrl },
    { key: "approval_url", type: "url", value: approvalUrl },
    { key: "approval_token", type: "single_line_text_field", value: tokenHash },
    { key: "preview_sent_at", type: "date_time", value: previewSentAt.toISOString() },
    { key: "customer_decision", type: "single_line_text_field", value: "-" },
    { key: "customer_feedback", type: "multi_line_text_field", value: "-" },
    { key: "internal_note", type: "multi_line_text_field", value: "Farbvorschau über das Cockpit gesendet." },
  ].map((m) => Object.assign({ ownerId: o.id, namespace: "miris" }, m));
  const data = await adminGraphQL(M, { mf, id: o.id, addTags: ["Farbvorschau gesendet"], removeTags: ["Farbvorschau offen", "Anpassung gewünscht"] });
  assertNoUserErrors(data.metafieldsSet, "Vorschau-Metafelder");
  return {
    order: o,
    approvalUrl,
    previewUrl,
    previewSentAt: previewSentAt.toISOString(),
    deadlineAt: new Date(previewSentAt.getTime() + 24 * 3600 * 1000).toISOString(),
  };
}

/** preview_sent_at-Metafeld auf jetzt setzen (hält Auto-Freigabe-Frist konsistent zur Mail). */
async function setPreviewSentNow(orderGid, iso) {
  const M = `mutation($mf: [MetafieldsSetInput!]!){ metafieldsSet(metafields:$mf){ userErrors { field message } } }`;
  const data = await adminGraphQL(M, { mf: [{ ownerId: orderGid, namespace: "miris", key: "preview_sent_at", type: "date_time", value: iso }] });
  assertNoUserErrors(data.metafieldsSet, "preview_sent_at setzen");
}

/* ---------- Diagnose (verrät keine Secrets) ---------- */
function diag() {
  const shopRaw = (process.env.SHOPIFY_SHOP || "").trim();
  let shopResolved = "";
  try { shopResolved = shopDomain(); } catch (e) { shopResolved = "(SHOPIFY_SHOP fehlt)"; }
  const token = (process.env.SHOPIFY_ADMIN_TOKEN || "").trim();
  const cid = (process.env.SHOPIFY_CLIENT_ID || "").trim();
  const csec = (process.env.SHOPIFY_CLIENT_SECRET || "").trim();
  const authMode = (cid && csec) ? "client_credentials" : (token ? "static_token" : "NONE");
  return {
    shopifyShopRaw: shopRaw || "(leer)",
    shopifyShopResolved: shopResolved,
    apiVersion: API_VERSION,
    storeHandle: storeHandle(),
    authMode,
    clientIdSet: !!cid,
    clientSecretSet: !!csec,
    staticTokenPresent: !!token,
    cloudinaryKeySet: !!process.env.CLOUDINARY_API_KEY,
    cloudinarySecretSet: !!process.env.CLOUDINARY_API_SECRET,
  };
}
async function testConnection() {
  try {
    const d = await adminGraphQL(`{ shop { name myshopifyDomain } }`);
    return { ok: true, shopName: d.shop && d.shop.name, myshopifyDomain: d.shop && d.shop.myshopifyDomain };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e).slice(0, 400) };
  }
}

/* ---------- Produkte / Katalog (Phase 1: nur lesen) ---------- */
const PRODUCTS_QUERY = `
query Products($first:Int!, $query:String){
  products(first:$first, sortKey:UPDATED_AT, reverse:true, query:$query){
    edges{ node{
      id legacyResourceId title handle status totalInventory updatedAt
      featuredImage{ url altText }
      priceRangeV2{ minVariantPrice{ amount currencyCode } maxVariantPrice{ amount currencyCode } }
    } }
  }
}`;

function numId(gidOrId) {
  if (gidOrId == null) return "";
  const s = String(gidOrId);
  return s.startsWith("gid://") ? s.replace(/^.*\//, "") : s.replace(/\D/g, "");
}
function mapProductRow(n) {
  const min = n.priceRangeV2 && n.priceRangeV2.minVariantPrice;
  const max = n.priceRangeV2 && n.priceRangeV2.maxVariantPrice;
  const id = n.legacyResourceId != null ? String(n.legacyResourceId) : numId(n.id);
  return {
    id, gid: n.id,
    title: n.title || "",
    handle: n.handle || "",
    status: String(n.status || "").toLowerCase(), // active | draft | archived
    totalInventory: n.totalInventory == null ? null : Number(n.totalInventory),
    image: (n.featuredImage && n.featuredImage.url) || null,
    priceMin: min ? Number(min.amount) : null,
    priceMax: max ? Number(max.amount) : null,
    currency: (min && min.currencyCode) || "EUR",
    updatedAt: n.updatedAt || null,
    adminUrl: `https://admin.shopify.com/store/${storeHandle()}/products/${id}`,
  };
}
async function fetchProducts(opts) {
  opts = opts || {};
  const first = Math.min(Math.max(Number(opts.limit) || 50, 1), 250);
  const query = opts.query ? String(opts.query).slice(0, 200) : null;
  const data = await adminGraphQL(PRODUCTS_QUERY, { first, query });
  return ((data.products && data.products.edges) || []).map((e) => mapProductRow(e.node));
}

const PRODUCT_QUERY = `
query Product($id:ID!){
  product(id:$id){
    id legacyResourceId title handle status descriptionHtml totalInventory updatedAt
    featuredImage{ url altText }
    images(first:12){ edges{ node{ url altText } } }
    options{ name values }
    priceRangeV2{ minVariantPrice{ amount currencyCode } maxVariantPrice{ amount currencyCode } }
    collections(first:20){ edges{ node{ id title } } }
    variants(first:100){ edges{ node{
      id legacyResourceId title sku price inventoryQuantity
      selectedOptions{ name value }
      inventoryItem{ id legacyResourceId }
    } } }
  }
}`;
function mapProductDetail(n) {
  if (!n) return null;
  const row = mapProductRow(n);
  return Object.assign(row, {
    descriptionHtml: n.descriptionHtml || "",
    images: (((n.images && n.images.edges) || []).map((e) => ({ url: e.node.url, alt: e.node.altText || "" }))),
    options: (n.options || []).map((o) => ({ name: o.name, values: o.values || [] })),
    collections: (((n.collections && n.collections.edges) || []).map((e) => ({ id: e.node.id, title: e.node.title }))),
    variants: (((n.variants && n.variants.edges) || []).map((e) => {
      const v = e.node;
      return {
        id: v.legacyResourceId != null ? String(v.legacyResourceId) : numId(v.id),
        gid: v.id,
        title: v.title || "",
        sku: v.sku || "",
        price: v.price != null ? Number(v.price) : null,
        inventoryQuantity: v.inventoryQuantity == null ? null : Number(v.inventoryQuantity),
        options: (v.selectedOptions || []).map((o) => ({ name: o.name, value: o.value })),
        inventoryItemId: v.inventoryItem && v.inventoryItem.legacyResourceId != null ? String(v.inventoryItem.legacyResourceId) : null,
      };
    })),
  });
}
async function fetchProduct(id) {
  const s = String(id || "");
  const gid = s.startsWith("gid://") ? s : `gid://shopify/Product/${numId(s)}`;
  const data = await adminGraphQL(PRODUCT_QUERY, { id: gid });
  return mapProductDetail(data.product);
}

module.exports = {
  adminGraphQL, getAccessToken, fetchOrders, mapOrder, deriveImages, cloudinaryPublicId,
  tagOrderDeleted, resolveOrderGid, addOrderTag, markOrderPaid, cancelOrder, fulfillOrder,
  getOrderPreviewData, setPreviewSentNow, updateShippingAddress, sendPreviewComplete,
  fetchProducts, fetchProduct, mapProductRow, mapProductDetail,
  ORDERS_QUERY, diag, testConnection,
};
