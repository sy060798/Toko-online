
const cloudinary = require("cloudinary").v2;
const { createClient } = require("@libsql/client");

const FOLDER = "essence/payment-proofs";
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_FORMATS = ["jpg", "jpeg", "png", "webp"];

function json(res, status, data) {
  return res.status(status).json(data);
}

function configure() {
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

  return cloudinary;
}

function getDb() {
  if (!process.env.TURSO_DATABASE_URL ||
      !process.env.TURSO_AUTH_TOKEN) {
    throw new Error("Konfigurasi Turso belum lengkap.");
  }

  return createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
  });
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
    const cloud = configure();
    const db = getDb();

    const orderCode = String(
      req.body?.order_code || ""
    ).trim().toUpperCase();

    const publicId = String(
      req.body?.public_id || ""
    ).trim();

    const version = Number(req.body?.version);
    const format = String(
      req.body?.format || ""
    ).trim().toLowerCase();

    if (!/^ESS-\d{8}-[A-Z0-9]{6}$/.test(orderCode)) {
      return json(res, 400, {
        success: false,
        error: "Kode pesanan tidak valid."
      });
    }

    // Terima hanya dua bentuk ID yang sesuai dengan
    // kode pesanan, bukan ID arbitrer dari browser.
    const allowedPublicIds = [
      orderCode,
      `${FOLDER}/${orderCode}`
    ];

    if (!allowedPublicIds.includes(publicId)) {
      console.error("Public ID tidak cocok:", {
        orderCode,
        receivedPublicId: publicId
      });

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

    const orderResult = await db.execute({
      sql: `
        SELECT order_code, payment_status
        FROM orders
        WHERE order_code = ?
        LIMIT 1
      `,
      args: [orderCode]
    });

    if (!orderResult.rows.length) {
      return json(res, 404, {
        success: false,
        error: "Pesanan tidak ditemukan."
      });
    }

    if (orderResult.rows[0].payment_status === "paid") {
      return json(res, 409, {
        success: false,
        error: "Pesanan ini sudah dibayar."
      });
    }

    // Verifikasi file langsung ke Cloudinary.
    // Coba ID yang diterima; jika folder merupakan bagian
    // dari public_id, gunakan ID tersebut apa adanya.
    let asset;

    try {
      asset = await cloud.api.resource(publicId, {
        resource_type: "image",
        type: "authenticated"
      });
    } catch (firstError) {
      // Jangan menebak ID lain atau menyimpan file
      // yang belum berhasil diverifikasi.
      console.error("Cloudinary resource lookup gagal:", {
        publicId,
        message: firstError.message
      });

      return json(res, 400, {
        success: false,
        error: "File bukti tidak ditemukan di Cloudinary. Periksa folder dan public_id."
      });
    }

    if (
      asset.public_id !== publicId ||
      Number(asset.version) !== version ||
      String(asset.format || "").toLowerCase() !== format ||
      asset.resource_type !== "image" ||
      asset.type !== "authenticated" ||
      Number(asset.bytes) > MAX_FILE_SIZE ||
      !ALLOWED_FORMATS.includes(
        String(asset.format || "").toLowerCase()
      )
    ) {
      console.error("Validasi aset Cloudinary gagal:", {
        expectedPublicId: publicId,
        actualPublicId: asset.public_id,
        expectedVersion: version,
        actualVersion: asset.version,
        format: asset.format,
        resourceType: asset.resource_type,
        type: asset.type,
        bytes: asset.bytes
      });

      return json(res, 400, {
        success: false,
        error: "Data file di Cloudinary tidak cocok atau formatnya tidak diizinkan."
      });
    }

    const uploadedAt = new Date().toISOString();

    const update = await db.execute({
      sql: `
        UPDATE orders
        SET
          payment_proof_url = ?,
          payment_proof_public_id = ?,
          payment_proof_version = ?,
          payment_proof_resource_type = ?,
          payment_proof_uploaded_at = ?,
          payment_proof_format = ?,
          payment_status = 'awaiting_verification'
        WHERE order_code = ?
          AND payment_status != 'paid'
      `,
      args: [
        asset.secure_url,
        asset.public_id,
        Number(asset.version),
        asset.resource_type,
        uploadedAt,
        String(asset.format).toLowerCase(),
        orderCode
      ]
    });

    if (Number(update.rowsAffected || 0) !== 1) {
      return json(res, 409, {
        success: false,
        error: "Status pesanan berubah. Muat ulang pesanan dan coba lagi."
      });
    }

    return json(res, 200, {
      success: true,
      message: "Bukti pembayaran berhasil disimpan.",
      order_code: orderCode,
      payment_status: "awaiting_verification"
    });
  } catch (error) {
    console.error("Payment proof save API error:", {
      message: error.message,
      code: error.code
    });

    return json(res, 500, {
      success: false,
      error: "Gagal menyimpan bukti pembayaran."
    });
  }
};
