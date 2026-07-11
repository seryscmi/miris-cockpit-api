"use strict";
/**
 * Cloudinary-Löschung. API-Secret bleibt serverseitig (ENV).
 */
const { v2: cloudinary } = require("cloudinary");

let configured = false;
function config() {
  if (configured) return;
  cloudinary.config({
    cloud_name: (process.env.CLOUDINARY_CLOUD_NAME || "dg3k6nvwj").trim(),
    api_key: (process.env.CLOUDINARY_API_KEY || "").trim(),
    api_secret: (process.env.CLOUDINARY_API_SECRET || "").trim(),
    secure: true,
  });
  configured = true;
}

/** Bild hochladen (Farbvorschau): base64 → Cloudinary, gibt secure_url zurück. */
async function uploadImage(base64, { folder, publicId, tags, mime }) {
  if (!process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    throw new Error("Cloudinary-Zugang nicht konfiguriert (CLOUDINARY_API_KEY/SECRET)");
  }
  config();
  const dataUri = "data:" + (mime || "image/jpeg") + ";base64," + String(base64).replace(/^data:[^;]+;base64,/, "");
  const res = await cloudinary.uploader.upload(dataUri, {
    folder,
    public_id: publicId,
    resource_type: "image",
    overwrite: false,
    tags: tags || [],
  });
  if (!res || !res.secure_url) throw new Error("Cloudinary-Upload ohne URL");
  return { secureUrl: res.secure_url, publicId: res.public_id, bytes: res.bytes, width: res.width, height: res.height };
}

async function deleteImage(publicId) {
  if (!process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
    throw new Error("Cloudinary-Zugang nicht konfiguriert (CLOUDINARY_API_KEY/SECRET)");
  }
  config();
  // invalidate: löscht auch CDN-Caches
  const res = await cloudinary.uploader.destroy(publicId, { invalidate: true, resource_type: "image" });
  if (res && res.result && res.result !== "ok" && res.result !== "not found") {
    throw new Error("Cloudinary: " + res.result);
  }
  return res;
}

module.exports = { uploadImage, deleteImage };
