
const cloudinary = require("cloudinary").v2;
const { createClient } = require("@libsql/client");

const FOLDER = "essence/payment-proofs";
const UPLOAD_PRESET = "essence_payment_proofs";
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_FORMATS = ["jpg", "jpeg", "png", "webp"];

function json(res, status, data) {
  return res.status(status).json(data);
}

function getDb() {
  if (!process.env.TURSO_DATABASE_URL ||
      !process.env.TURSO_AUTH_TOKEN) {
    throw new Error("Konfigurasi database Turso belum lengkap.");
  }

  return createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
  });
}

function configureCloudinary() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error("Konfigurasi Cloudinary belum lengkap.");
  }

  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true
  });

  return { cloudName, apiKey, apiSecret };
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, {
      success: false,
      error: "Metode request tidak diizinkan."
    });
  }

  try {
    const { cloudName, apiKey, apiSecret } =
      configureCloudinary();

    const orderCode = String(
      req.body?.order_code || ""
    ).trim().toUpperCase();

    if (!/^ESS-\d{8}-[A-Z0-9]{6}$/.test(orderCode)) {
      return json(res, 400, {
        success: false,
        error: "Kode pesanan tidak valid."
      });
    }

    const db = getDb();

    const result = await db.execute({
      sql: `
        SELECT order_code, payment_status
        FROM orders
        WHERE order_code = ?
        LIMIT 1
      `,
      args: [orderCode]
    });

    if (!result.rows.length) {
      return json(res, 404, {
        success: false,
        error: "Pesanan tidak ditemukan."
      });
    }

    const order = result.rows[0];

    if (order.payment_status === "paid") {
      return json(res, 409, {
        success: false,
        error: "Pesanan ini sudah dibayar."
      });
    }

    const timestamp = Math.floor(Date.now() / 1000);

    // Hanya parameter yang benar-benar ditandatangani
    // yang dimasukkan ke parameter signature.
    const paramsToSign = {
      allowed_formats: ALLOWED_FORMATS.join(","),
      folder: FOLDER,
      overwrite: "false",
      public_id: orderCode,
      timestamp,
      type: "authenticated",
      upload_preset: UPLOAD_PRESET
    };

    const signature = cloudinary.utils.api_sign_request(
      paramsToSign,
      apiSecret
    );

    return json(res, 200, {
      success: true,
      cloud_name: cloudName,
      api_key: apiKey,
      timestamp,
      folder: FOLDER,
      public_id: orderCode,
      overwrite: false,
      type: "authenticated",
      upload_preset: UPLOAD_PRESET,
      allowed_formats: ALLOWED_FORMATS,
      max_file_size: MAX_FILE_SIZE,
      signature
    });
  } catch (error) {
    console.error("Payment signature API error:", error);

    return json(res, 500, {
      success: false,
      error: "Gagal menyiapkan upload bukti pembayaran."
    });
  }
};
