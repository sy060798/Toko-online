
const cloudinary = require("cloudinary").v2;
const { createClient } = require("@libsql/client");

const FOLDER = "essence/payment-proofs";
const UPLOAD_PRESET = "essence_payment_proofs";
const ALLOWED_FORMATS = ["jpg", "jpeg", "png", "webp", "pdf"];

function json(res, status, data) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(status).json(data);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, {
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

  if (
    !cloudName ||
    !apiKey ||
    !apiSecret ||
    !databaseUrl ||
    !authToken
  ) {
    return json(res, 500, {
      error: "Konfigurasi server belum lengkap."
    });
  }

  const body = req.body || {};
  const orderCode = String(body.order_code || "").trim();

  if (!/^ESS-\d{8}-[A-Z0-9]{6}$/.test(orderCode)) {
    return json(res, 400, {
      error: "Kode pesanan tidak valid."
    });
  }

  let db;

  try {
    db = createClient({
      url: databaseUrl,
      authToken
    });

    const result = await db.execute({
      sql: `SELECT
              order_code,
              payment_proof_public_id,
              payment_proof_version,
              payment_proof_format
            FROM orders
            WHERE order_code = ?
            LIMIT 1`,
      args: [orderCode]
    });

    if (result.rows.length === 0) {
      return json(res, 404, {
        error: "Pesanan tidak ditemukan."
      });
    }

    const order = result.rows[0];

    if (order.payment_proof_public_id) {
      return json(res, 409, {
        error: "Bukti pembayaran untuk pesanan ini sudah tersimpan."
      });
    }

    const timestamp = Math.floor(Date.now() / 1000);

    // Public ID hanya berupa kode pesanan.
    // Folder disimpan terpisah dari public ID.
    const params = {
      timestamp,
      folder: FOLDER,
      public_id: orderCode,
      overwrite: false,
      type: "authenticated",
      upload_preset: UPLOAD_PRESET
    };

    const signature = cloudinary.utils.api_sign_request(
      params,
      apiSecret
    );

    return json(res, 200, {
      cloud_name: cloudName,
      api_key: apiKey,
      timestamp,
      folder: FOLDER,
      public_id: orderCode,
      overwrite: false,
      type: "authenticated",
      upload_preset: UPLOAD_PRESET,
      signature,
      allowed_formats: ALLOWED_FORMATS,
      max_file_size: 5242880
    });
  } catch (error) {
    console.error("Gagal menyiapkan signature pembayaran.");

    return json(res, 500, {
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
