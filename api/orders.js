
const { createClient } = require("@libsql/client");
const crypto = require("crypto");

const SHIPPING_FEE = 6000;

const PRODUCT_PRICES = {
  "Velvet Oud": 185000,
  "Rose Élégance": 155000,
  "Citrus No. 09": 125000
};

function json(res, status, data) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(status).json(data);
}

function makeOrderCode() {
  const d = new Date();
  const date = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0")
  ].join("");

  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let random = "";

  for (let i = 0; i < 6; i++) {
    random += alphabet[crypto.randomInt(alphabet.length)];
  }

  return `ESS-${date}-${random}`;
}

function normalizeWhatsApp(value) {
  let phone = String(value || "").replace(/\D/g, "");

  if (phone.startsWith("0")) phone = "62" + phone.slice(1);
  else if (phone.startsWith("8")) phone = "62" + phone;

  return /^62\d{8,13}$/.test(phone) ? phone : null;
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return json(res, 405, { error: "Gunakan metode POST." });
  }

  const databaseUrl = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!databaseUrl || !authToken) {
    return json(res, 500, {
      error: "Konfigurasi database belum lengkap di Vercel."
    });
  }

  let db;

  try {
    const body = req.body || {};
    const name = String(body.name || "").trim();
    const address = String(body.address || "").trim();
    const whatsapp = normalizeWhatsApp(body.whatsapp);
    const items = body.items;

    if (!name || name.length > 120) {
      return json(res, 400, { error: "Nama pembeli tidak valid." });
    }

    if (!address || address.length > 1000) {
      return json(res, 400, { error: "Alamat tidak valid." });
    }

    if (!whatsapp) {
      return json(res, 400, { error: "Nomor WhatsApp tidak valid." });
    }

    if (!Array.isArray(items) || items.length < 1 || items.length > 20) {
      return json(res, 400, { error: "Daftar produk tidak valid." });
    }

    let subtotal = 0;
    const normalizedItems = [];

    for (const item of items) {
      const productName = String(item.name || "");
      const quantity = Number(item.quantity);

      if (
        !Object.prototype.hasOwnProperty.call(PRODUCT_PRICES, productName) ||
        !Number.isSafeInteger(quantity) ||
        quantity < 1 ||
        quantity > 100
      ) {
        return json(res, 400, {
          error: "Nama produk atau jumlah tidak valid."
        });
      }

      subtotal += PRODUCT_PRICES[productName] * quantity;
      normalizedItems.push({ name: productName, quantity });
    }

    const total = subtotal + SHIPPING_FEE;

    if (!Number.isSafeInteger(total) || total > 100000000) {
      return json(res, 400, { error: "Total pesanan tidak valid." });
    }

    const productNames = normalizedItems
      .map(item => `${item.name} x${item.quantity}`)
      .join(", ");

    db = createClient({ url: databaseUrl, authToken });

    for (let attempt = 0; attempt < 3; attempt++) {
      const orderCode = makeOrderCode();

      try {
        await db.execute({
          sql: `INSERT INTO orders
            (order_code, product_names, total_price, whatsapp, customer_name, address)
            VALUES (?, ?, ?, ?, ?, ?)`,
          args: [orderCode, productNames, total, whatsapp, name, address]
        });

        return json(res, 201, {
          success: true,
          order_code: orderCode,
          product_names: productNames,
          items: normalizedItems,
          subtotal,
          shipping_fee: SHIPPING_FEE,
          total_price: total,
          whatsapp,
          name,
          address
        });
      } catch (error) {
        if (String(error.message).toLowerCase().includes("unique")) {
          continue;
        }
        throw error;
      }
    }

    return json(res, 500, {
      error: "Gagal membuat kode pesanan unik. Silakan coba lagi."
    });
  } catch (error) {
    console.error("Gagal menyimpan pesanan:", error.message);

    return json(res, 500, {
      error: "Pesanan belum tersimpan. Periksa struktur tabel database."
    });
  } finally {
    if (db) {
      try { db.close(); } catch (_) {}
    }
  }
};
