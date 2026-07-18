"use strict";
/**
 * Shopify Admin API — Bestellungen laden + auf die Cockpit-Order-Form mappen.
 * Der Admin-Token bleibt serverseitig (ENV). Der Browser sieht ihn nie.
 */

const API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-07";

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
    media(first:20){ edges{ node{ ... on MediaImage { id image{ url altText } } } } }
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
    images: (((n.media && n.media.edges) || []).map((e) => { const nd = e.node || {}; const img = nd.image || {}; return { id: nd.id || null, url: img.url || null, alt: img.altText || "" }; }).filter((x) => x.url || x.id)),
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

/* ---------- Rabatte (Phase 1: lesen) ---------- */
const DISCOUNTS_QUERY = `
query Discounts($first:Int!){
  discountNodes(first:$first, sortKey:CREATED_AT, reverse:true){
    edges{ node{
      id
      discount{
        __typename
        ... on DiscountCodeBasic { title status startsAt endsAt asyncUsageCount codes(first:1){ edges{ node{ code } } } customerGets{ value{ __typename ... on DiscountPercentage{ percentage } ... on DiscountAmount{ amount{ amount currencyCode } } } } }
        ... on DiscountCodeFreeShipping { title status startsAt endsAt asyncUsageCount codes(first:1){ edges{ node{ code } } } }
        ... on DiscountCodeBxgy { title status startsAt endsAt asyncUsageCount codes(first:1){ edges{ node{ code } } } }
        ... on DiscountAutomaticBasic { title status startsAt endsAt customerGets{ value{ __typename ... on DiscountPercentage{ percentage } ... on DiscountAmount{ amount{ amount currencyCode } } } } }
        ... on DiscountAutomaticFreeShipping { title status startsAt endsAt }
        ... on DiscountAutomaticBxgy { title status startsAt endsAt }
      }
    } }
  }
}`;
function discountValue(d) {
  if (/FreeShipping/.test(d.__typename || "")) return { type: "free_shipping" };
  const v = d.customerGets && d.customerGets.value;
  if (!v) return null;
  if (v.__typename === "DiscountPercentage" && v.percentage != null) { const p = Number(v.percentage); return { type: "percentage", amount: p <= 1 ? Math.round(p * 100) : Math.round(p) }; }
  if (v.__typename === "DiscountAmount" && v.amount) return { type: "amount", amount: Number(v.amount.amount), currency: v.amount.currencyCode };
  return null;
}
function mapDiscount(node) {
  const d = node.discount || {};
  const t = d.__typename || "";
  const code = (d.codes && d.codes.edges && d.codes.edges[0] && d.codes.edges[0].node.code) || null;
  return {
    id: numId(node.id), gid: node.id,
    title: d.title || code || "Rabatt",
    code,
    kind: /^DiscountCode/.test(t) ? "code" : "automatic",
    type: t,
    status: String(d.status || "").toLowerCase(), // active | expired | scheduled
    value: discountValue(d),
    usage: d.asyncUsageCount == null ? null : Number(d.asyncUsageCount),
    startsAt: d.startsAt || null, endsAt: d.endsAt || null,
  };
}
async function fetchDiscounts(opts) {
  opts = opts || {};
  const first = Math.min(Math.max(Number(opts.limit) || 50, 1), 100);
  const data = await adminGraphQL(DISCOUNTS_QUERY, { first });
  return ((data.discountNodes && data.discountNodes.edges) || []).map((e) => mapDiscount(e.node)).filter((x) => x.title || x.code);
}

/* ---------- Kunden (Phase 1: echte Shopify-Kundendatensätze lesen) ---------- */
const CUSTOMERS_QUERY = `
query Customers($first:Int!, $query:String){
  customers(first:$first, sortKey:UPDATED_AT, reverse:true, query:$query){
    edges{ node{ id legacyResourceId displayName firstName lastName email phone numberOfOrders amountSpent{ amount currencyCode } tags createdAt updatedAt } }
  }
}`;
function mapCustomerRow(n) {
  const spent = n.amountSpent;
  return {
    id: n.legacyResourceId != null ? String(n.legacyResourceId) : numId(n.id), gid: n.id,
    name: n.displayName || ((n.firstName || "") + " " + (n.lastName || "")).trim() || n.email || "—",
    email: n.email || "", phone: n.phone || "",
    ordersCount: Number(n.numberOfOrders || 0),
    amountSpent: spent ? Number(spent.amount) : 0, currency: spent ? spent.currencyCode : "EUR",
    tags: Array.isArray(n.tags) ? n.tags : [],
    createdAt: n.createdAt || null, updatedAt: n.updatedAt || null,
  };
}
async function fetchCustomers(opts) {
  opts = opts || {};
  const first = Math.min(Math.max(Number(opts.limit) || 100, 1), 250);
  const query = opts.query ? String(opts.query).slice(0, 200) : null;
  const data = await adminGraphQL(CUSTOMERS_QUERY, { first, query });
  return ((data.customers && data.customers.edges) || []).map((e) => mapCustomerRow(e.node));
}
const CUSTOMER_DETAIL_FIELDS = `id legacyResourceId displayName firstName lastName email phone note tags numberOfOrders amountSpent{ amount currencyCode } createdAt verifiedEmail emailMarketingConsent{ marketingState } defaultAddress{ id firstName lastName address1 address2 zip city province country phone }`;
function mapCustomerDetail(n) {
  if (!n) return null;
  const row = mapCustomerRow(n);
  return Object.assign(row, {
    note: n.note || "",
    marketingState: (n.emailMarketingConsent && n.emailMarketingConsent.marketingState) || null,
    verifiedEmail: !!n.verifiedEmail,
    defaultAddress: n.defaultAddress ? { id: n.defaultAddress.id || null, firstName: n.defaultAddress.firstName || "", lastName: n.defaultAddress.lastName || "", address1: n.defaultAddress.address1 || "", address2: n.defaultAddress.address2 || "", zip: n.defaultAddress.zip || "", city: n.defaultAddress.city || "", province: n.defaultAddress.province || "", country: n.defaultAddress.country || "", phone: n.defaultAddress.phone || "" } : null,
    adminUrl: `https://admin.shopify.com/store/${storeHandle()}/customers/${row.id}`,
  });
}
async function fetchCustomerByEmail(email) {
  const e = String(email || "").trim();
  if (!e) return null;
  const Q = `query($q:String!){ customers(first:1, query:$q){ edges{ node{ ${CUSTOMER_DETAIL_FIELDS} } } } }`;
  const data = await adminGraphQL(Q, { q: `email:${e}` });
  const node = data.customers && data.customers.edges[0] && data.customers.edges[0].node;
  return mapCustomerDetail(node);
}
async function fetchCustomer(id) {
  const s = String(id || "");
  const gid = s.startsWith("gid://") ? s : `gid://shopify/Customer/${numId(s)}`;
  const Q = `query($id:ID!){ customer(id:$id){ ${CUSTOMER_DETAIL_FIELDS} } }`;
  const data = await adminGraphQL(Q, { id: gid });
  return mapCustomerDetail(data.customer);
}

/* ---------- Produkte bearbeiten (Phase 2: schreiben) ---------- */
/** Titel / Status / Beschreibung eines Produkts ändern. */
async function updateProduct(id, fields) {
  fields = fields || {};
  const gid = String(id).startsWith("gid://") ? String(id) : `gid://shopify/Product/${numId(id)}`;
  const input = { id: gid };
  if (fields.title != null) input.title = String(fields.title).slice(0, 255);
  if (fields.descriptionHtml != null) input.descriptionHtml = String(fields.descriptionHtml);
  if (fields.status) { const s = String(fields.status).toUpperCase(); if (["ACTIVE", "DRAFT", "ARCHIVED"].includes(s)) input.status = s; }
  const M = `mutation($input:ProductInput!){ productUpdate(input:$input){ product{ id status title } userErrors{ field message } } }`;
  const data = await adminGraphQL(M, { input });
  assertNoUserErrors(data.productUpdate, "Produkt speichern");
  return data.productUpdate.product;
}
/** Varianten-Preise setzen (bulk). variants: [{id, price}] */
async function updateVariantPrices(productId, variants) {
  const pgid = String(productId).startsWith("gid://") ? String(productId) : `gid://shopify/Product/${numId(productId)}`;
  const vars = (variants || [])
    .filter((v) => v && v.id != null && v.price != null && v.price !== "")
    .map((v) => ({ id: String(v.id).startsWith("gid://") ? String(v.id) : `gid://shopify/ProductVariant/${numId(v.id)}`, price: String(v.price) }));
  if (!vars.length) return [];
  const M = `mutation($productId:ID!, $variants:[ProductVariantsBulkInput!]!){ productVariantsBulkUpdate(productId:$productId, variants:$variants){ productVariants{ id price } userErrors{ field message } } }`;
  const data = await adminGraphQL(M, { productId: pgid, variants: vars });
  assertNoUserErrors(data.productVariantsBulkUpdate, "Preise speichern");
  return data.productVariantsBulkUpdate.productVariants;
}

/* ---------- Produktbilder (Extra) ---------- */
async function addProductImage(productId, imageUrl, alt) {
  const pgid = String(productId).startsWith("gid://") ? String(productId) : `gid://shopify/Product/${numId(productId)}`;
  const media = [{ originalSource: String(imageUrl), mediaContentType: "IMAGE" }];
  if (alt) media[0].alt = String(alt).slice(0, 200);
  const M = `mutation($productId:ID!, $media:[CreateMediaInput!]!){ productCreateMedia(productId:$productId, media:$media){ media{ ... on MediaImage { id image{ url } } } mediaUserErrors{ field message } } }`;
  const data = await adminGraphQL(M, { productId: pgid, media });
  const errs = data.productCreateMedia && data.productCreateMedia.mediaUserErrors;
  if (errs && errs.length) { const e = new Error("Bild hinzufügen: " + errs.map((x) => x.message).join("; ")); e.userErrors = errs; throw e; }
  const m0 = data.productCreateMedia.media && data.productCreateMedia.media[0];
  return { id: m0 && m0.id, url: m0 && m0.image && m0.image.url };
}
async function deleteProductImage(productId, mediaId) {
  const pgid = String(productId).startsWith("gid://") ? String(productId) : `gid://shopify/Product/${numId(productId)}`;
  const mid = String(mediaId || "");
  if (!mid.startsWith("gid://")) throw new Error("Ungültige Bild-ID");
  const M = `mutation($productId:ID!, $mediaIds:[ID!]!){ productDeleteMedia(productId:$productId, mediaIds:$mediaIds){ deletedMediaIds mediaUserErrors{ field message } } }`;
  const data = await adminGraphQL(M, { productId: pgid, mediaIds: [mid] });
  const errs = data.productDeleteMedia && data.productDeleteMedia.mediaUserErrors;
  if (errs && errs.length) { const e = new Error("Bild löschen: " + errs.map((x) => x.message).join("; ")); e.userErrors = errs; throw e; }
  return { deleted: (data.productDeleteMedia.deletedMediaIds || []).length };
}

/* ---------- Bestand bearbeiten (Phase 2b) ---------- */
let _locId = null, _locTs = 0;
async function primaryLocationId() {
  if (_locId && (Date.now() - _locTs) < 3600000) return _locId;
  const data = await adminGraphQL(`{ locations(first:1){ edges{ node{ id } } } }`);
  const node = data.locations && data.locations.edges[0] && data.locations.edges[0].node;
  if (!node) throw new Error("Keine Lager-Location gefunden");
  _locId = node.id; _locTs = Date.now();
  return _locId;
}
/** Bestand ("available") an der Haupt-Location setzen. items: [{inventoryItemId, quantity}]
 * 2026-07: InventoryQuantityInput verlangt PFLICHT-Feld changeFromQuantity (die aktuelle
 * Menge, von der aus gesetzt wird). Also erst aktuelle Menge lesen, dann setzen. */
async function setInventoryQuantities(items) {
  const clean = (items || [])
    .filter((x) => x && x.inventoryItemId && x.quantity != null && x.quantity !== "")
    .map((x) => ({ gid: String(x.inventoryItemId).startsWith("gid://") ? String(x.inventoryItemId) : `gid://shopify/InventoryItem/${numId(x.inventoryItemId)}`, quantity: Math.round(Number(x.quantity)) }));
  if (!clean.length) return [];
  const locationId = await primaryLocationId();
  const q = await adminGraphQL(
    `query($ids:[ID!]!, $loc:ID!){ nodes(ids:$ids){ ... on InventoryItem { id inventoryLevel(locationId:$loc){ quantities(names:["available"]){ name quantity } } } } }`,
    { ids: clean.map((c) => c.gid), loc: locationId }
  );
  const currentById = {};
  ((q && q.nodes) || []).forEach((n) => {
    if (!n) return;
    const lvl = n.inventoryLevel && n.inventoryLevel.quantities;
    const av = Array.isArray(lvl) ? lvl.find((x) => x.name === "available") : null;
    currentById[n.id] = av ? Number(av.quantity) : 0;
  });
  const quantities = clean.map((c) => ({ inventoryItemId: c.gid, locationId, quantity: c.quantity, changeFromQuantity: currentById[c.gid] != null ? currentById[c.gid] : 0 }));
  // 2026-07 verlangt die @idempotent-Directive (Schutz vor Doppel-Buchung bei Retries).
  const idemKey = crypto.randomUUID();
  const M = `mutation($input:InventorySetQuantitiesInput!, $idemKey:String!){ inventorySetQuantities(input:$input) @idempotent(key:$idemKey){ inventoryAdjustmentGroup{ createdAt } userErrors{ field message } } }`;
  const data = await adminGraphQL(M, { input: { name: "available", reason: "correction", quantities }, idemKey });
  assertNoUserErrors(data.inventorySetQuantities, "Bestand speichern");
  return quantities;
}

/* ---------- Erstattung (Phase 3: Refund) ---------- */
/** Erstattungs-Infos: max. erstattbarer Betrag + Eltern-Transaktion (für das Modal). */
async function getRefundInfo(orderName) {
  const id = await resolveOrderGid(orderName);
  const Q = `query($id:ID!){ order(id:$id){ id name currencyCode
    totalReceivedSet{ shopMoney{ amount currencyCode } }
    totalRefundedSet{ shopMoney{ amount } }
    transactions(first:25){ id kind status gateway } } }`;
  const data = await adminGraphQL(Q, { id });
  const o = data.order;
  if (!o) throw new Error("Bestellung nicht gefunden");
  const received = Number((o.totalReceivedSet && o.totalReceivedSet.shopMoney && o.totalReceivedSet.shopMoney.amount) || 0);
  const refunded = Number((o.totalRefundedSet && o.totalRefundedSet.shopMoney && o.totalRefundedSet.shopMoney.amount) || 0);
  const currency = (o.totalReceivedSet && o.totalReceivedSet.shopMoney && o.totalReceivedSet.shopMoney.currencyCode) || o.currencyCode || "EUR";
  const maxRefundable = Math.max(0, Math.round((received - refunded) * 100) / 100);
  const success = (o.transactions || []).filter((t) => /SALE|CAPTURE/i.test(t.kind || "") && /SUCCESS/i.test(t.status || ""));
  const parent = success[success.length - 1] || null;
  return { orderId: o.id, name: o.name, maxRefundable, currency, parentTransactionId: parent && parent.id, gateway: parent && parent.gateway };
}
/** Betrag erstatten (Teil oder voll). opts: {amount, note, notify} */
async function refundOrder(orderName, opts) {
  opts = opts || {};
  const info = await getRefundInfo(orderName);
  const amount = Math.round(Number(opts.amount) * 100) / 100;
  if (!(amount > 0)) { const e = new Error("Betrag muss größer als 0 sein"); e.userErrors = [{ message: e.message }]; throw e; }
  if (amount > info.maxRefundable + 0.001) { const e = new Error(`Höchstens ${info.maxRefundable.toFixed(2)} ${info.currency} erstattbar`); e.userErrors = [{ message: e.message }]; throw e; }
  if (!info.parentTransactionId) { const e = new Error("Keine erstattbare Zahlung gefunden"); e.userErrors = [{ message: e.message }]; throw e; }
  const input = {
    orderId: info.orderId,
    notify: opts.notify !== false,
    note: opts.note ? String(opts.note).slice(0, 255) : undefined,
    transactions: [{ orderId: info.orderId, parentId: info.parentTransactionId, gateway: info.gateway, kind: "REFUND", amount: amount.toFixed(2) }],
  };
  const M = `mutation($input:RefundInput!){ refundCreate(input:$input){ refund{ id totalRefundedSet{ shopMoney{ amount currencyCode } } } userErrors{ field message } } }`;
  const data = await adminGraphQL(M, { input });
  assertNoUserErrors(data.refundCreate, "Erstattung");
  return data.refundCreate.refund;
}

/* ---------- Direktverkauf: Entwurf-Bestellung + Bezahllink (Extra) ---------- */
async function createDraftOrder(opts) {
  opts = opts || {};
  const lineItems = (opts.lineItems || [])
    .filter((li) => li && li.variantId && Number(li.quantity) > 0)
    .map((li) => ({ variantId: String(li.variantId).startsWith("gid://") ? String(li.variantId) : `gid://shopify/ProductVariant/${numId(li.variantId)}`, quantity: Math.round(Number(li.quantity)) }));
  if (!lineItems.length) { const e = new Error("Mindestens eine Position nötig"); e.userErrors = [{ message: e.message }]; throw e; }
  const input = { lineItems };
  if (opts.email) input.email = String(opts.email).trim();
  if (opts.note) input.note = String(opts.note).slice(0, 1000);
  const M = `mutation($input:DraftOrderInput!){ draftOrderCreate(input:$input){ draftOrder{ id name invoiceUrl totalPriceSet{ shopMoney{ amount currencyCode } } } userErrors{ field message } } }`;
  const data = await adminGraphQL(M, { input });
  assertNoUserErrors(data.draftOrderCreate, "Bestellung anlegen");
  const d = data.draftOrderCreate.draftOrder || {};
  const money = d.totalPriceSet && d.totalPriceSet.shopMoney;
  return { id: numId(d.id), name: d.name, invoiceUrl: d.invoiceUrl, total: money ? Number(money.amount) : null, currency: money ? money.currencyCode : "EUR" };
}

/* ---------- Kunde bearbeiten (Phase 5: Tags + Notiz) ---------- */
async function updateCustomer(id, fields) {
  fields = fields || {};
  const gid = String(id).startsWith("gid://") ? String(id) : `gid://shopify/Customer/${numId(id)}`;
  const input = { id: gid };
  if (fields.note != null) input.note = String(fields.note).slice(0, 5000);
  if (Array.isArray(fields.tags)) input.tags = fields.tags.map((t) => String(t).trim()).filter(Boolean).slice(0, 50);
  if (fields.address && typeof fields.address === "object") {
    const a = fields.address, addr = {};
    ["firstName", "lastName", "address1", "address2", "zip", "city", "province", "country", "phone"].forEach((k) => { if (a[k] != null) addr[k] = String(a[k]); });
    if (a.id) addr.id = String(a.id); // vorhandene Adresse aktualisieren, nicht ersetzen
    if (Object.keys(addr).length) input.addresses = [addr];
  }
  const M = `mutation($input:CustomerInput!){ customerUpdate(input:$input){ customer{ id tags note } userErrors{ field message } } }`;
  const data = await adminGraphQL(M, { input });
  assertNoUserErrors(data.customerUpdate, "Kunde speichern");
  return data.customerUpdate.customer;
}

/* ---------- Rabatte anlegen / löschen (Phase 4: schreiben) ---------- */
/** Rabattcode anlegen. opts: {code, kind:"percentage"|"amount", value, title?, endsAt?, usageLimit?, oncePerCustomer?} */
async function createDiscount(opts) {
  opts = opts || {};
  const code = String(opts.code || "").trim();
  if (!code) { const e = new Error("Code erforderlich"); e.userErrors = [{ message: e.message }]; throw e; }
  const val = Number(opts.value);
  if (!(val > 0)) { const e = new Error("Wert muss größer als 0 sein"); e.userErrors = [{ message: e.message }]; throw e; }
  const value = opts.kind === "amount"
    ? { discountAmount: { amount: (Math.round(val * 100) / 100).toFixed(2), appliesOnEachItem: false } }
    : { percentage: Math.max(0, Math.min(1, val / 100)) };
  const input = {
    title: opts.title ? String(opts.title).slice(0, 255) : code,
    code,
    startsAt: new Date().toISOString(),
    customerSelection: { all: true },
    customerGets: { value, items: { all: true } },
    appliesOncePerCustomer: !!opts.oncePerCustomer,
  };
  if (opts.endsAt) input.endsAt = String(opts.endsAt);
  if (opts.usageLimit && Number(opts.usageLimit) > 0) input.usageLimit = Math.round(Number(opts.usageLimit));
  const M = `mutation($d:DiscountCodeBasicInput!){ discountCodeBasicCreate(basicCodeDiscount:$d){ codeDiscountNode{ id } userErrors{ field message } } }`;
  const data = await adminGraphQL(M, { d: input });
  assertNoUserErrors(data.discountCodeBasicCreate, "Rabatt anlegen");
  return { id: numId(data.discountCodeBasicCreate.codeDiscountNode && data.discountCodeBasicCreate.codeDiscountNode.id), code };
}
/** Rabatt aktivieren/deaktivieren (gid + kind aus der Liste). */
async function setDiscountActive(gid, kind, active) {
  const id = String(gid || "");
  if (!id.startsWith("gid://")) throw new Error("Ungültige Rabatt-ID");
  let key;
  if (kind === "automatic") key = active ? "discountAutomaticActivate" : "discountAutomaticDeactivate";
  else key = active ? "discountCodeActivate" : "discountCodeDeactivate";
  const wrap = kind === "automatic" ? "automaticDiscountNode" : "codeDiscountNode";
  const M = `mutation($id:ID!){ ${key}(id:$id){ ${wrap}{ id } userErrors{ field message } } }`;
  const data = await adminGraphQL(M, { id });
  assertNoUserErrors(data[key], active ? "Rabatt aktivieren" : "Rabatt deaktivieren");
  return { active };
}
/** Rabatt löschen (gid + kind aus der Liste). */
async function deleteDiscount(gid, kind) {
  const id = String(gid || "");
  if (!id.startsWith("gid://")) throw new Error("Ungültige Rabatt-ID");
  const M = kind === "automatic"
    ? `mutation($id:ID!){ discountAutomaticDelete(id:$id){ deletedAutomaticDiscountId userErrors{ field message } } }`
    : `mutation($id:ID!){ discountCodeDelete(id:$id){ deletedCodeDiscountId userErrors{ field message } } }`;
  const data = await adminGraphQL(M, { id });
  assertNoUserErrors(kind === "automatic" ? data.discountAutomaticDelete : data.discountCodeDelete, "Rabatt löschen");
  return { deleted: true };
}

module.exports = {
  adminGraphQL, getAccessToken, fetchOrders, mapOrder, deriveImages, cloudinaryPublicId,
  tagOrderDeleted, resolveOrderGid, addOrderTag, markOrderPaid, cancelOrder, fulfillOrder,
  getOrderPreviewData, setPreviewSentNow, updateShippingAddress, sendPreviewComplete,
  fetchProducts, fetchProduct, mapProductRow, mapProductDetail,
  fetchDiscounts, mapDiscount, fetchCustomers, mapCustomerRow, fetchCustomer, fetchCustomerByEmail, mapCustomerDetail,
  updateProduct, updateVariantPrices, setInventoryQuantities, primaryLocationId, addProductImage, deleteProductImage,
  getRefundInfo, refundOrder, createDiscount, deleteDiscount, setDiscountActive, updateCustomer, createDraftOrder,
  ORDERS_QUERY, diag, testConnection,
};
