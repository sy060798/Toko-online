
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
      error: "Kode pesanan tidak valid."
    });
  }

  // Public ID hanya kode pesanan, bukan path folder.
  if (publicId !== orderCode) {
    return json(res, 400, {
      error: "Identitas file tidak sesuai."
    });
  }

  if (!Number.isSafeInteger(version) || version <= 0) {
    return json(res, 400, {
      error: "Versi file tidak valid."
    });
  }

  if (!ALLOWED_FORMATS.includes(format)) {
    return json(res, 400, {
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
      sql: `SELECT
              id,
              payment_proof_public_id
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

    if (result.rows[0].payment_proof_public_id) {
      return json(res, 409, {
        error: "Bukti pembayaran sudah tersimpan."
      });
    }

    // Ambil metadata dari Cloudinary, bukan memercayai
    // versi dan format yang dikirim browser.
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
        error: "Aset Cloudinary tidak sesuai dengan ketentuan."
      });
    }

    // Simpan metadata. Jangan membentuk URL seolah-olah
    // aset authenticated merupakan tautan publik.
    const saved = await db.execute({
      sql: `UPDATE orders
            SET payment_proof_public_id = ?,
                payment_proof_version = ?,
                payment_proof_format = ?,
                payment_proof_resource_type = ?,
                payment_proof_uploaded_at = ?
            WHERE order_code = ?
              AND payment_proof_public_id IS NULL`,
      args: [
        asset.public_id,
        asset.version,
        asset.format,
        asset.resource_type,
        new Date().toISOString(),
        orderCode
      ]
    });

    if (saved.rowsAffected !== 1) {
      return json(res, 409, {
        error: "Bukti pembayaran gagal disimpan atau sudah tersimpan."
      });
    }

    return json(res, 200, {
      success: true,
      order_code: orderCode,
      message: "Referensi bukti pembayaran berhasil diverifikasi dan disimpan."
    });
  } catch (error) {
    if (error.http_code === 404) {
      return json(res, 400, {
        error: "Aset belum ditemukan di Cloudinary."
      });
    }

    console.error("Gagal memverifikasi atau menyimpan bukti pembayaran.");

    return json(res, 500, {
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
