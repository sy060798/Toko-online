const { createClient } = require("@libsql/client");
const crypto = require("crypto");

const SHIPPING_FEE = 6000;

const OUTSIDE = new Set([
  "Bandung", "Surabaya", "Semarang", "Yogyakarta", "Malang",
  "Medan", "Palembang", "Makassar", "Denpasar", "Balikpapan",
  "Pontianak", "Banjarmasin", "Pekanbaru", "Padang", "Jambi",
  "Bengkulu", "Bandar Lampung", "Serang", "Cilegon", "Cimahi",
  "Tasikmalaya", "Cirebon", "Sukabumi", "Purwakarta", "Karawang",
  "Subang", "Garut", "Sumedang", "Purwokerto", "Tegal",
  "Pekalongan", "Kudus", "Solo", "Madiun", "Kediri", "Jember",
  "Banyuwangi", "Mataram", "Kupang", "Manado", "Ambon",
  "Jayapura", "Sorong", "Samarinda", "Tarakan", "Banda Aceh",
  "Lhokseumawe", "Tanjung Pinang", "Batam", "Metro",
  "Prabumulih", "Lubuklinggau", "Pangkalpinang",
  "Palangka Raya", "Palopo", "Kendari", "Gorontalo",
  "Ternate", "Tidore", "Manokwari"
]);

function json(res, status, data) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(data);
}

function normalizeWhatsApp(value) {
  let phone = String(value || "").replace(/\D/g, "");

  if (phone.startsWith("0")) {
    phone = "62" + phone.slice(1);
  } else if (phone.startsWith("8")) {
    phone = "62" + phone;
  }

  return /^62\d{8,13}$/.test(phone) ? phone : null;
}

function normalizeArea(value) {
  const city = String(value || "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

  const freeCities = {
    "jakarta": "Jakarta",
    "kota jakarta pusat": "Jakarta",
    "kota jakarta utara": "Jakarta",
    "kota jakarta barat": "Jakarta",
    "kota jakarta selatan": "Jakarta",
    "kota jakarta timur": "Jakarta",
    "kabupaten administrasi kepulauan seribu": "Jakarta",

    "bogor": "Bogor",
    "kota bogor": "Bogor",
    "kabupaten bogor": "Bogor",

    "depok": "Depok",
    "kota depok": "Depok",

    "tangerang": "Tangerang",
    "kota tangerang": "Tangerang",
    "kabupaten tangerang": "Tangerang",
    "kota tangerang selatan": "Tangerang",
    "tangerang selatan": "Tangerang",

    "bekasi": "Bekasi",
    "kota bekasi": "Bekasi",
    "kabupaten bekasi": "Bekasi"
  };

  if (freeCities[city]) {
    return {
      city: freeCities[city],
      fee: 0
    };
  }

  for (const name of OUTSIDE) {
    if (name.toLowerCase() === city) {
      return {
        city: name,
        fee: SHIPPING_FEE
      };
    }
  }

  return null;
}

function makeOrderCode() {
  const d = new Date();

  const date =
    d.getFullYear() +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0");

  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let suffix = "";

  for (let i = 0; i < 6; i++) {
    suffix += chars[crypto.randomInt(chars.length)];
  }

  return `ESS-${date}-${suffix}`;
}

// Produk contoh bawaan.
const SAMPLE_PRODUCTS = [
  {
    name: "Velvet Oud",
    price: 185000,
    image: "https://images.unsplash.com/photo-1594035910387-fea47794261f?auto=format&fit=crop&w=700&q=80",
    notes: "Woody · Warm · Elegant",
    description: "Aroma hangat, dalam, dan elegan."
  },
  {
    name: "Rose Élégance",
    price: 155000,
    image: "https://images.unsplash.com/photo-1541643600914-78b084683601?auto=format&fit=crop&w=700&q=80",
    notes: "Floral · Rose · Soft Musk",
    description: "Aroma floral lembut dan anggun."
  },
  {
    name: "Citrus No. 09",
    price: 125000,
    image: "https://images.unsplash.com/photo-1592945403244-b3fbafd7f539?auto=format&fit=crop&w=700&q=80",
    notes: "Citrus · Fresh · Clean",
    description: "Aroma segar untuk aktivitas sehari-hari."
  }
];

// Pastikan tabel produk tersedia dan produk contoh tersimpan.
async function ensureProducts(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      price INTEGER NOT NULL CHECK(price > 0),
      image TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT 'EAU DE PARFUM',
      category TEXT NOT NULL DEFAULT 'full',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT datetime('now'),
      updated_at TEXT NOT NULL DEFAULT datetime('now')
    )
  `);

  const columns = await db.execute("PRAGMA table_info(products)");

  if (!columns.rows.some(c => String(c.name) === "category")) {
    await db.execute(
      "ALTER TABLE products ADD COLUMN category TEXT NOT NULL DEFAULT 'full'"
    );
  }

  for (const p of SAMPLE_PRODUCTS) {
    await db.execute({
      sql: `
        INSERT OR IGNORE INTO products
          (name, price, image, description, notes, category, is_active)
        VALUES (?, ?, ?, ?, ?, 'sample', 1)
      `,
      args: [p.name, p.price, p.image, p.description, p.notes]
    });

    await db.execute({
      sql: "UPDATE products SET category='sample' WHERE name=?",
      args: [p.name]
    });
  }
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
    TURSO_DATABASE_URL: url,
    TURSO_AUTH_TOKEN: authToken
  } = process.env;

  if (!url || !authToken) {
    return json(res, 500, {
      success: false,
      error: "Konfigurasi database belum lengkap."
    });
  }

  let db;

  try {
    db = createClient({
      url,
      authToken
    });

    await ensureProducts(db);

    const body = req.body || {};

    const name = String(body.name || "").trim();
    const address = String(body.address || "").trim();
    const whatsapp = normalizeWhatsApp(body.whatsapp);
    const area = normalizeArea(body.city);
    const items = body.items;

    if (name.length < 2 || name.length > 120) {
      return json(res, 400, {
        success: false,
        error: "Nama pembeli harus berisi 2–120 karakter."
      });
    }

    if (address.length < 8 || address.length > 1000) {
      return json(res, 400, {
        success: false,
        error: "Alamat tidak valid."
      });
    }

    if (!whatsapp) {
      return json(res, 400, {
        success: false,
        error: "Nomor WhatsApp tidak valid."
      });
    }

    if (!area) {
      return json(res, 400, {
        success: false,
        error: "Pilih kota atau kabupaten tujuan yang tersedia."
      });
    }

    if (!Array.isArray(items) || items.length < 1 || items.length > 20) {
      return json(res, 400, {
        success: false,
        error: "Daftar produk tidak valid."
      });
    }

    // Ambil harga terkini dari database, bukan dari browser pelanggan.
    const catalog = await db.execute(
      "SELECT name, price FROM products WHERE is_active = 1"
    );

    const prices = {};

    for (const product of catalog.rows) {
      prices[String(product.name)] = Number(product.price);
    }

    let subtotal = 0;
    const cleanItems = [];
    const seen = new Set();

    for (const item of items) {
      const productName = String(item?.name || "").trim();
      const quantity = Number(item?.quantity);

      if (
        !Object.prototype.hasOwnProperty.call(prices, productName) ||
        !Number.isSafeInteger(quantity) ||
        quantity < 1 ||
        quantity > 100
      ) {
        return json(res, 400, {
          success: false,
          error: `Produk atau jumlah tidak valid: ${productName || "tidak diketahui"}.`
        });
      }

      if (seen.has(productName)) {
        return json(res, 400, {
          success: false,
          error: "Nama produk ganda terdeteksi. Gabungkan jumlahnya."
        });
      }

      seen.add(productName);

      const price = prices[productName];
      const lineTotal = price * quantity;

      subtotal += lineTotal;

      cleanItems.push({
        name: productName,
        price,
        quantity,
        total: lineTotal
      });
    }

    const shippingFee = area.fee;
    const totalPrice = subtotal + shippingFee;

    if (
      !Number.isSafeInteger(totalPrice) ||
      totalPrice <= 0 ||
      totalPrice > 100000000
    ) {
      return json(res, 400, {
        success: false,
        error: "Total pesanan tidak valid."
      });
    }

    const productNames = JSON.stringify(cleanItems);
    let orderCode;
    let saved = false;

    // Coba ulang jika kode pesanan kebetulan sudah dipakai.
    for (let i = 0; i < 4 && !saved; i++) {
      orderCode = makeOrderCode();

      try {
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
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_payment', datetime('now'))
          `,
          args: [
            orderCode,
            name,
            whatsapp,
            address,
            area.city,
            productNames,
            subtotal,
            shippingFee,
            totalPrice
          ]
        });

        saved = true;
      } catch (error) {
        if (!String(error.message || "").includes("UNIQUE constraint failed")) {
          throw error;
        }
      }
    }

    if (!saved) {
      throw new Error("Tidak dapat membuat kode pesanan unik.");
    }

    return json(res, 201, {
      success: true,
      order_code: orderCode,
      name,
      whatsapp,
      address,
      city: area.city,
      items: cleanItems,
      subtotal,
      shipping_fee: shippingFee,
      total_price: totalPrice,
      payment_status: "awaiting_payment"
    });

  } catch (error) {
    console.error("Orders API error:", {
      message: error.message,
      code: error.code
    });

    return json(res, 500, {
      success: false,
      error: "Pesanan gagal disimpan. Periksa log API."
    });

  } finally {
    try {
      db?.close();
    } catch (_) {}
  }
};
