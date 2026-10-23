
const { createClient } = require("@libsql/client");
const crypto = require("crypto");

const SHIPPING_FEE = 6000;

// Harga harus sama dengan harga resmi di index.html.
const PRODUCT_PRICES = {
  "Velvet Oud": 185000,
  "Rose Élégance": 155000,
  "Citrus No. 09": 125000
};

function json(res, status, data) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(data);
}


function makeOrderCode() {
  const date = new Date();
  const ymd = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("");

  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let random = "";

  for (let i = 0; i < 6; i++) {
    random += alphabet[crypto.randomInt(alphabet.length)];
  }

  return `ESS-${ymd}-${random}`;
}


function normalizeWhatsApp(value) {
  let phone = String(value || "").replace(/\D/g, "");

  if (phone.startsWith("0")) {
    phone = "62" + phone.slice(1);
  }

  if (phone.startsWith("8")) {
    phone = "62" + phone;
  }

  if (!/^62\d{8,13}$/.test(phone)) {
    return null;
  }

  return phone;
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
    const items = body.items;
    const whatsapp = normalizeWhatsApp(body.whatsapp);

    if (!whatsapp) {
      return json(res, 400, {
        error: "Nomor WhatsApp tidak valid."
      });
    }

    if (
      !Array.isArray(items) ||
      items.length < 1 ||
      items.length > 20
    ) {
      return json(res, 400, {
        error: "Daftar produk tidak valid."
      });
    }

    let subtotal = 0;
    const normalizedItems = [];

    for (const item of items) {
      const name = String(item.name || "");
      const quantity = Number(item.quantity);

      if (
        !Object.prototype.hasOwnProperty.call(PRODUCT_PRICES, name) ||
        !Number.isSafeInteger(quantity) ||
        quantity < 1 ||
        quantity > 100
      ) {
        return json(res, 400, {
          error: "Nama produk atau jumlah tidak valid."
        });
      }

      subtotal += PRODUCT_PRICES[name] * quantity;

      normalizedItems.push({
        name,
        quantity
      });
    }

    const total = subtotal + SHIPPING_FEE;

    if (!Number.isSafeInteger(total) || total > 100000000) {
      return json(res, 400, {
        error: "Total pesanan tidak valid."
      });
    }

    const productNames = normalizedItems
      .map(item => `${item.name} x${item.quantity}`)
      .join(", ");

    db = createClient({
      url: databaseUrl,
      authToken
    });

    // Beberapa percobaan untuk menghindari kode pesanan duplikat.
    for (let attempt = 0; attempt < 3; attempt++) {
      const orderCode = makeOrderCode();

      try {
        await db.execute({
          sql: `INSERT INTO orders
            (order_code, product_names, total_price, whatsapp)
            VALUES (?, ?, ?, ?)`,
          args: [orderCode, productNames, total, whatsapp]
        });

        return json(res, 201, {
          success: true,
          order_code: orderCode,
          product_names: productNames,
          total_price: total,
          whatsapp
        });
      } catch (error) {
        if (
          error.message &&
          error.message.toLowerCase().includes("unique")
        ) {
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
      error: "Pesanan belum tersimpan. Silakan coba kembali."
    });
  } finally {
    if (db) {
      try {
        db.close();
      } catch (_) {}
    }
  }
};
