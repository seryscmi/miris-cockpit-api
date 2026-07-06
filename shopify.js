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

async function adminGraphQL(query, variables) {
  const token = (process.env.SHOPIFY_ADMIN_TOKEN || "").trim();
  if (!token) throw new Error("SHOPIFY_ADMIN_TOKEN nicht gesetzt");
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
async function tagOrderDeleted(orderName) {
  if (!orderName) return;
  // Order-GID über name auflösen und Audit-Tag setzen (best effort)
  const q = `query($q:String!){ orders(first:1, query:$q){ edges{ node{ id } } } }`;
  const data = await adminGraphQL(q, { q: `name:${orderName}` });
  const node = data.orders.edges[0] && data.orders.edges[0].node;
  if (node) await adminGraphQL(TAGS_ADD, { id: node.id, tags: ["augenbild-geloescht"] });
}

module.exports = { adminGraphQL, fetchOrders, mapOrder, deriveImages, cloudinaryPublicId, tagOrderDeleted, ORDERS_QUERY };
