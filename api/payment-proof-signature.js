
const cloudinary = require("cloudinary").v2;
const { createClient } = require("@libsql/client");

const FOLDER = "essence/payment-proofs";
const UPLOAD_PRESET = "essence_payment_proofs";
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_FORMATS = ["jpg", "jpeg", "png", "webp", "pdf"];

function json(res, status, data) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");

  return res.status(status).json(data);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, {
      success: false,
      error: "Gunakan metode POST."
    });
  }

  const {
    CLOUDINARY_CLOUD_NAME: cloudName,
    CLOUDINARY_API_KEY: apiKey,
    CLOUDINARY_API_SECRET: apiSecret,
    TURSO_DATABASE_URL: databaseUrl,
    TURSO_AUTH_TOKEN: authToken
  } = process.env;

  if (!cloudName || !apiKey || !apiSecret || !databaseUrl || !authToken) {
    return json(res, 500, {
      success: false,
      error: "Konfigurasi server belum lengkap."
    });
  }

  const orderCode = String(req.body?.order_code || "").trim();

  if (!/^ESS-\d{8}-[A-Z0-9]{6}$/.test(orderCode)) {
    return json(res, 400, {
      success: false,
      error: "Kode pesanan tidak valid."
    });
  }

  let db;

  try {
    db = createClient({ url: databaseUrl, authToken });

    const result = await db.execute({
      sql: `SELECT order_code, payment_status, payment_proof_public_id
            FROM orders
            WHERE order_code = ?
            LIMIT 1`,
      args: [orderCode]
    });

    if (!result.rows.length) {
      return json(res, 404, {
        success: false,
        error: "Pesanan tidak ditemukan."
      });
    }

    const order = result.rows[0];

    if (order.payment_proof_public_id) {
      return json(res, 409, {
        success: false,
        error: "Bukti pembayaran sudah tersimpan."
      });
    }

    if (order.payment_status !== "awaiting_payment") {
      return json(res, 409, {
        success: false,
        error: "Status pesanan tidak mengizinkan upload bukti."
      });
    }

    cloudinary.config({
      cloud_name: cloudName,
      api_key: apiKey,
      api_secret: apiSecret,
      secure: true
    });

    const timestamp = Math.floor(Date.now() / 1000);

    const params = {
      timestamp,
      folder: FOLDER,
      public_id: orderCode,
      overwrite: false,
      type: "authenticated",
      upload_preset: UPLOAD_PRESET,
      allowed_formats: ALLOWED_FORMATS.join(","),
      max_file_size: MAX_FILE_SIZE
    };

    const signature = cloudinary.utils.api_sign_request(
      params,
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
    console.error("Payment signature error:", {
      message: error.message,
      code: error.code
    });

    return json(res, 500, {
      success: false,
      error: "Tidak dapat menyiapkan upload bukti pembayaran."
    });
  } finally {
    if (db) {
      try {
        db.close();
      } catch (_) {}
    }
  }
};
