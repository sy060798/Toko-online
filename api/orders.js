
const { createClient } = require("@libsql/client");
const crypto = require("crypto");

const SHIPPING_FEE = 6000;

const PRODUCT_PRICES = {
  "Velvet Oud": 185000,
  "Rose Élégance": 155000,
  "Citrus No. 09": 125000
};

const FREE_SHIPPING_CITIES = [
  "jakarta",
  "bogor",
  "depok",
  "tangerang",
  "bekasi"
];

function json(res, status, data) {
  return res.status(status).json(data);
}

function getDb() {
  if (
    !process.env.TURSO_DATABASE_URL ||
    !process.env.TURSO_AUTH_TOKEN
  ) {
    throw new Error("Konfigurasi database Turso belum lengkap.");
  }

  return createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
  });
}

function normalizeWhatsApp(value) {
  let phone = String(value || "").trim();
  phone = phone.replace(/[\s()+.-]/g, "");

  if (phone.startsWith("0")) {
    phone = "62" + phone.slice(1);
  } else if (phone.startsWith("8")) {
    phone = "62" + phone;
  }

  return phone;
}

function normalizeCity(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function makeOrderCode() {
  const date = new Date();
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const random = crypto.randomBytes(4)
    .toString("hex")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6)
    .padEnd(6, "0");

  return `ESS-${yyyy}${mm}${dd}-${random}`;
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
    const body = req.body || {};

    const name = String(body.name || "").trim();
    const whatsapp = normalizeWhatsApp(body.whatsapp);
    const address = String(body.address || "").trim();
    const city = String(body.city || "").trim();
    const items = body.items;

    if (name.length < 2 || name.length > 120) {
      return json(res, 400, {
        success: false,
        error: "Nama penerima harus berisi 2–120 karakter."
      });
    }

    if (!/^62\d{8,15}$/.test(whatsapp)) {
      return json(res, 400, {
        success: false,
        error: "Nomor WhatsApp tidak valid. Gunakan nomor aktif."
      });
    }

    if (address.length < 8 || address.length > 500) {
      return json(res, 400, {
        success: false,
        error: "Alamat harus berisi 8–500 karakter."
      });
    }

    if (city.length < 2 || city.length > 100) {
      return json(res, 400, {
        success: false,
        error: "Kota atau kabupaten belum valid."
      });
    }

    if (!Array.isArray(items) || items.length === 0) {
      return json(res, 400, {
        success: false,
        error: "Keranjang belanja masih kosong."
      });
    }

    if (items.length > 20) {
      return json(res, 400, {
        success: false,
        error: "Jumlah jenis produk terlalu banyak."
      });
    }

    let subtotal = 0;
    const cleanItems = [];

    for (const item of items) {
      const productName = String(item?.name || "").trim();
      const quantity = Number(item?.quantity);

      if (
        !Object.prototype.hasOwnProperty.call(
          PRODUCT_PRICES,
          productName
        )
      ) {
        return json(res, 400, {
          success: false,
          error: `Produk tidak tersedia: ${productName || "tidak diketahui"}.`
        });
      }

      if (
        !Number.isSafeInteger(quantity) ||
        quantity < 1 ||
        quantity > 50
      ) {
        return json(res, 400, {
          success: false,
          error: `Jumlah produk ${productName} tidak valid.`
        });
      }

      const unitPrice = PRODUCT_PRICES[productName];
      subtotal += unitPrice * quantity;

      cleanItems.push({
        name: productName,
        quantity,
        price: unitPrice,
        total: unitPrice * quantity
      });
    }

    const cityNormalized = normalizeCity(city);
    const isFreeShipping = FREE_SHIPPING_CITIES.some(
      (freeCity) =>
        cityNormalized === freeCity ||
        cityNormalized.startsWith(freeCity + " ") ||
        cityNormalized.startsWith(freeCity + ",")
    );

    const shippingFee = isFreeShipping ? 0 : SHIPPING_FEE;
    const totalPrice = subtotal + shippingFee;

    const orderCode = makeOrderCode();
    const productNames = JSON.stringify(cleanItems);

    const db = getDb();

    await db.execute({
      sql: `
        INSERT INTO orders (
          order_code,
          customer_name,
          whatsapp,
          address,
          city,
          product_names,
          subtotal,
          shipping_fee,
          total_price,
          payment_status,
          created_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'awaiting_payment',
          datetime('now')
        )
      `,
      args: [
        orderCode,
        name,
        whatsapp,
        address,
        city,
        productNames,
        subtotal,
        shippingFee,
        totalPrice
      ]
    });

    return json(res, 201, {
      success: true,
      order_code: orderCode,
      name,
      whatsapp,
      address,
      city,
      items: cleanItems,
      subtotal,
      shipping_fee: shippingFee,
      total_price: totalPrice,
      payment_status: "awaiting_payment"
    });
  } catch (error) {
    console.error("Order API error:", {
      message: error.message,
      code: error.code
    });

    return json(res, 500, {
      success: false,
      error: "Pesanan gagal disimpan. Periksa log API."
    });
  }
};
