
const cloudinary = require("cloudinary").v2;
const { createClient } = require("@libsql/client");

const MAX_FILE_SIZE = 5 * 1024 * 1024;
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

  if (
    !databaseUrl ||
    !authToken ||
    !cloudName ||
    !apiKey ||
    !apiSecret
  ) {
    return json(res, 500, {
      success: false,
      error: "Konfigurasi server belum lengkap."
    });
  }

  const body = req.body || {};
  const orderCode = String(body.order_code || "").trim();
  const publicId = String(body.public_id || "").trim();
  const version = Number(body.version);
  const format = String(body.format || "").toLowerCase();

  if (!/^ESS-\d{8}-[A-Z0-9]{6}$/.test(orderCode)) {
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

  if (!ALLOWED_FORMATS.includes(format)) {
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
      api_secret: apiSecret
    });

    db = createClient({
      url: databaseUrl,
      authToken
    });

    const result = await db.execute({
      sql: `SELECT order_code, payment_proof_public_id
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

    if (result.rows[0].payment_proof_public_id) {
      return json(res, 409, {
        success: false,
        error: "Bukti pembayaran sudah tersimpan."
      });
    }

    // Verifikasi aset langsung ke Cloudinary.
    // Jangan mempercayai metadata yang dikirim browser.
    const asset = await cloudinary.api.resource(publicId, {
      resource_type: "image",
      type: "authenticated"
    });

    if (
      asset.public_id !== orderCode ||
      asset.version !== version ||
      asset.format !== format ||
      asset.type !== "authenticated" ||
      asset.resource_type !== "image" ||
      !Number.isFinite(asset.bytes) ||
      asset.bytes <= 0 ||
      asset.bytes > MAX_FILE_SIZE
    ) {
      return json(res, 400, {
        success: false,
        error: "File Cloudinary tidak memenuhi ketentuan."
      });
    }

    if (
      !ALLOWED_FORMATS.includes(String(asset.format).toLowerCase())
    ) {
      return json(res, 400, {
        success: false,
        error: "Format file tidak diizinkan."
      });
    }

    // Simpan metadata aset dan status konfirmasi.
    // Pembayaran tetap menunggu verifikasi admin.
    const saved = await db.execute({
      sql: `UPDATE orders
            SET payment_proof_public_id = ?,
                payment_proof_version = ?,
                payment_proof_format = ?,
                payment_proof_resource_type = ?,
                payment_proof_uploaded_at = ?,
                payment_status = ?
            WHERE order_code = ?
              AND payment_proof_public_id IS NULL`,
      args: [
        asset.public_id,
        asset.version,
        asset.format,
        asset.resource_type,
        new Date().toISOString(),
        "awaiting_verification",
        orderCode
      ]
    });

    if (saved.rowsAffected !== 1) {
      return json(res, 409, {
        success: false,
        error: "Bukti sudah tersimpan atau pesanan berubah."
      });
    }

    return json(res, 200, {
      success: true,
      order_code: orderCode,
      payment_status: "awaiting_verification",
      message: "Bukti pembayaran berhasil disimpan dan menunggu verifikasi admin."
    });
  } catch (error) {
    if (error.http_code === 404) {
      return json(res, 400, {
        success: false,
        error: "File belum ditemukan di Cloudinary. Pastikan upload berhasil."
      });
    }

    console.error("Gagal menyimpan bukti pembayaran:", error.message);

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
