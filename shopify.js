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
      id name createdAt tags
      displayFinancialStatus displayFulfillmentStatus
      totalPriceSet { shopMoney { amount currencyCode } }
      customer { email displayName }
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
    customerEmail: (node.customer && node.customer.email) || "",
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
  const Q = `query($id: ID!){ order(id:$id){ id name email
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
    firstName: (o.customer && o.customer.firstName) || "",
    lastName: (o.customer && o.customer.lastName) || "",
    customerName: (o.customer && o.customer.displayName) || "",
    totalPrice: parseFloat((o.totalPriceSet && o.totalPriceSet.shopMoney && o.totalPriceSet.shopMoney.amount) || "0") || 0,
    currency: (o.totalPriceSet && o.totalPriceSet.shopMoney && o.totalPriceSet.shopMoney.currencyCode) || "EUR",
    miris,
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

module.exports = {
  adminGraphQL, getAccessToken, fetchOrders, mapOrder, deriveImages, cloudinaryPublicId,
  tagOrderDeleted, resolveOrderGid, addOrderTag, markOrderPaid, cancelOrder, fulfillOrder,
  getOrderPreviewData, setPreviewSentNow, ORDERS_QUERY, diag, testConnection,
};
