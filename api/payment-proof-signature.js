
const cloudinary = require("cloudinary").v2;
const crypto = require("crypto");

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

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    return json(res, 500, {
      error: "Konfigurasi Cloudinary belum lengkap."
    });
  }

  try {
    const body = req.body || {};
    const orderCode = String(body.order_code || "");

    // Hanya menerima kode pesanan dengan format ESSENCE.
    if (!/^ESS-\d{8}-[A-Z0-9]{6}$/.test(orderCode)) {
      return json(res, 400, {
        error: "Kode pesanan tidak valid."
      });
    }

    const timestamp = Math.floor(Date.now() / 1000);

    const params = {
      timestamp,
      folder: "essence/payment-proofs",
      public_id: orderCode,
      overwrite: false,
      type: "authenticated"
    };

    const signature = cloudinary.utils.api_sign_request(
      params,
      apiSecret
    );

    return json(res, 200, {
      cloud_name: cloudName,
      api_key: apiKey,
      timestamp,
      folder: params.folder,
      public_id: params.public_id,
      overwrite: false,
      type: params.type,
      signature
    });
  } catch (error) {
    console.error("Gagal membuat tanda tangan upload.");

    return json(res, 500, {
      error: "Tidak dapat menyiapkan upload bukti transfer."
    });
  }
};
