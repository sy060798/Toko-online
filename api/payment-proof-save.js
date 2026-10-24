
const cloudinary = require("cloudinary").v2;
const { createClient } = require("@libsql/client");

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_FORMATS = new Set(["jpg", "jpeg", "png", "webp", "pdf"]);

function json(res, status, data) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");

  return res.status(status).json(data);
}

function validOrderCode(value) {
  return /^ESS-\d{8}-[A-Z0-9]{6}$/.test(value);
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
    TURSO_DATABASE_URL: databaseUrl,
    TURSO_AUTH_TOKEN: authToken,
    CLOUDINARY_CLOUD_NAME: cloudName,
    CLOUDINARY_API_KEY: apiKey,
    CLOUDINARY_API_SECRET: apiSecret
  } = process.env;

  if (!databaseUrl || !authToken || !cloudName || !apiKey || !apiSecret) {
    return json(res, 500, {
      success: false,
      error: "Konfigurasi server belum lengkap."
    });
  }

  const body = req.body || {};
  const orderCode = String(body.order_code || "").trim();
  const publicId = String(body.public_id || "").trim();
  const version = Number(body.version);
  const format = String(body.format || "").trim().toLowerCase();

  if (!validOrderCode(orderCode)) {
    return json(res, 400, {
      success: false,
      error: "Kode pesanan tidak valid."
    });
  }

  if (publicId !== orderCode) {
    return json(res, 400, {
      success: false,
      error: "Identitas file tidak sesuai dengan kode pesanan."
    });
  }

  if (!Number.isSafeInteger(version) || version <= 0) {
    return json(res, 400, {
      success: false,
      error: "Versi file tidak valid."
    });
  }

  if (!ALLOWED_FORMATS.has(format)) {
    return json(res, 400, {
      success: false,
      error: "Format file tidak diizinkan."
    });
  }

  let db;

  try {
    cloudinary.config({
      cloud_name: cloudName,
      api_key: apiKey,
      api_secret: apiSecret,
      secure: true
    });

    db = createClient({
      url: databaseUrl,
      authToken
    });

    const result = await db.execute({
      sql: `SELECT order_code, payment_proof_public_id, payment_status
            FROM orders
            WHERE order_code = ?
            LIMIT 1`,
      args: [orderCode]
    });

    if (result.rows.length === 0) {
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

    if (
      order.payment_status !== "awaiting_payment" &&
      order.payment_status !== "awaiting_verification"
    ) {
      return json(res, 409, {
        success: false,
        error: "Status pesanan tidak mengizinkan upload bukti."
      });
    }

    // Verifikasi aset di sisi server.
    // Konfigurasi upload harus menggunakan resource_type=image
    // dan type=authenticated agar sesuai dengan pemeriksaan ini.
    const asset = await cloudinary.api.resource(publicId, {
      resource_type: "image",
      type: "authenticated"
    });

    const assetFormat = String(asset.format || "").toLowerCase();

    if (
      asset.public_id !== orderCode ||
      Number(asset.version) !== version ||
      assetFormat !== format ||
      asset.type !== "authenticated" ||
      asset.resource_type !== "image" ||
      !Number.isSafeInteger(Number(asset.bytes)) ||
      Number(asset.bytes) <= 0 ||
      Number(asset.bytes) > MAX_FILE_SIZE ||
      !ALLOWED_FORMATS.has(assetFormat)
    ) {
      return json(res, 400, {
        success: false,
        error: "File tidak memenuhi ketentuan upload."
      });
    }

    // Update bersyarat mencegah dua permintaan menyimpan bukti
    // untuk pesanan yang sama secara bersamaan.
    const saved = await db.execute({
      sql: `UPDATE orders
            SET payment_proof_public_id = ?,
                payment_proof_version = ?,
                payment_proof_format = ?,
                payment_proof_resource_type = ?,
                payment_proof_uploaded_at = ?,
                payment_status = 'awaiting_verification'
            WHERE order_code = ?
              AND payment_proof_public_id IS NULL
              AND payment_status IN ('awaiting_payment', 'awaiting_verification')`,
      args: [
        asset.public_id,
        Number(asset.version),
        assetFormat,
        asset.resource_type,
        new Date().toISOString(),
        orderCode
      ]
    });

    if (saved.rowsAffected !== 1) {
      return json(res, 409, {
        success: false,
        error: "Bukti sudah tersimpan atau status pesanan berubah."
      });
    }

    return json(res, 200, {
      success: true,
      order_code: orderCode,
      payment_status: "awaiting_verification",
      message: "Bukti pembayaran tersimpan dan menunggu verifikasi admin."
    });
  } catch (error) {
    console.error("Payment proof save error:", {
      message: error.message,
      code: error.code,
      http_code: error.http_code
    });

    if (Number(error.http_code) === 404) {
      return json(res, 400, {
        success: false,
        error: "File belum ditemukan. Pastikan upload berhasil."
      });
    }

    return json(res, 500, {
      success: false,
      error: "Gagal memverifikasi atau menyimpan bukti pembayaran."
    });
  } finally {
    if (db) {
      try {
        db.close();
      } catch (_) {}
    }
  }
};
