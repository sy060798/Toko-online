
const { createClient } = require("@libsql/client");

function json(res, status, data) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(data);
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, {
      error: "Gunakan metode POST."
    });
  }

  const databaseUrl = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;

  if (!databaseUrl || !authToken || !cloudName) {
    return json(res, 500, {
      error: "Konfigurasi server belum lengkap."
    });
  }

  const body = req.body || {};
  const orderCode = String(body.order_code || "");
  const publicId = String(body.public_id || "");
  const version = String(body.version || "");
  const format = String(body.format || "").toLowerCase();

  if (!/^ESS-\d{8}-[A-Z0-9]{6}$/.test(orderCode)) {
    return json(res, 400, {
      error: "Kode pesanan tidak valid."
    });
  }

  // Public ID harus persis mengikuti format yang ditetapkan server.
  if (publicId !== `essence/payment-proofs/${orderCode}`) {
    return json(res, 400, {
      error: "Identitas file tidak sesuai."
    });
  }

  if (!/^\d{1,12}$/.test(version)) {
    return json(res, 400, {
      error: "Versi file tidak valid."
    });
  }

  if (!["jpg", "jpeg", "png", "webp", "pdf"].includes(format)) {
    return json(res, 400, {
      error: "Format file tidak diizinkan."
    });
  }

  let db;

  try {
    db = createClient({
      url: databaseUrl,
      authToken
    });

    const result = await db.execute({
      sql: "SELECT id FROM orders WHERE order_code = ? LIMIT 1",
      args: [orderCode]
    });

    if (result.rows.length === 0) {
      return json(res, 404, {
        error: "Pesanan tidak ditemukan."
      });
    }

    // URL authenticated asset bukan tautan publik yang dapat dibuka
    // begitu saja. Akses admin perlu menggunakan mekanisme privat.
    const proofUrl =
      `https://res.cloudinary.com/${cloudName}/` +
      `authenticated/upload/v${version}/` +
      `essence/payment-proofs/${orderCode}.${format}`;

    await db.execute({
      sql: `UPDATE orders
            SET payment_proof_url = ?
            WHERE order_code = ?`,
      args: [proofUrl, orderCode]
    });

    return json(res, 200, {
      success: true,
      order_code: orderCode,
      message: "Referensi bukti transfer berhasil disimpan."
    });
  } catch (error) {
    console.error("Gagal menyimpan referensi bukti transfer.");

    return json(res, 500, {
      error: "Gagal menyimpan referensi bukti transfer."
    });
  } finally {
    if (db) {
      try {
        db.close();
      } catch (_) {}
    }
  }
};
