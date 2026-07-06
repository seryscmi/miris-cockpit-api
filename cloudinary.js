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

module.exports = { deleteImage };
