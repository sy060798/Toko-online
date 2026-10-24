const crypto = require("crypto");

function json(res, status, data) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(data);
}

function checkAdmin(req) {
  const expected = process.env.ADMIN_API_KEY;
  const supplied = req.headers["x-admin-key"];

  return Boolean(
    expected &&
    supplied &&
    String(supplied) === String(expected)
  );
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, {
      success: false,
      error: "Metode request tidak diizinkan."
    });
  }

  if (!checkAdmin(req)) {
    return json(res, 401, {
      success: false,
      error: "Kunci admin tidak valid."
    });
  }

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;

  if (!cloudName || !apiKey || !apiSecret) {
    return json(res, 500, {
      success: false,
      error: "Konfigurasi Cloudinary belum lengkap di Vercel."
    });
  }

  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = "essence/products";

    // Parameter harus diurutkan berdasarkan nama.
    const toSign = `folder=${folder}&timestamp=${timestamp}`;

    const signature = crypto
      .createHash("sha1")
      .update(toSign + apiSecret, "utf8")
      .digest("hex");

    return json(res, 200, {
      success: true,
      cloudName,
      apiKey,
      timestamp,
      folder,
      signature
    });
  } catch (error) {
    console.error("product-image-signature:", error);

    return json(res, 500, {
      success: false,
      error: "Gagal menyiapkan upload gambar."
    });
  }
};
