
const { createClient } = require("@libsql/client");
const crypto = require("crypto");

const SHIPPING_FEE = 6000;

// Harga cadangan untuk tiga produk bawaan.
// Jika produk ditemukan di database, harga database yang dipakai.
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

  const freeAreas = {
    jakarta: "Jakarta",
    "kota jakarta pusat": "Jakarta",
    "kota jakarta utara": "Jakarta",
    "kota jakarta barat": "Jakarta",
    "kota jakarta selatan": "Jakarta",
    "kota jakarta timur": "Jakarta",
    "kabupaten administrasi kepulauan seribu": "Jakarta",
    bogor: "Bogor",
    "kota bogor": "Bogor",
    "kabupaten bogor": "Bogor",
    depok: "Depok",
    "kota depok": "Depok",
    tangerang: "Tangerang",
    "kota tangerang": "Tangerang",
    "kabupaten tangerang": "Tangerang",
    "kota tangerang selatan": "Tangerang",
    "tangerang selatan": "Tangerang",
    bekasi: "Bekasi",
    "kota bekasi": "Bekasi",
    "kabupaten bekasi": "Bekasi"
  };

  const freeCity = freeAreas[city];
  if (freeCity) return { city: freeCity, fee: 0 };

  const allowedOutside = [
    "Bandung", "Surabaya", "Semarang", "Yogyakarta",
    "Malang", "Medan", "Palembang", "Makassar",
    "Denpasar", "Balikpapan", "Pontianak", "Banjarmasin",
    "Pekanbaru", "Padang", "Jambi", "Bengkulu",
    "Bandar Lampung", "Serang", "Cilegon", "Cimahi",
    "Tasikmalaya", "Cirebon", "Sukabumi", "Purwakarta",
    "Karawang", "Subang", "Garut", "Sumedang",
    "Purwokerto", "Tegal", "Pekalongan", "Kudus",
    "Solo", "Madiun", "Kediri", "Jember",
    "Banyuwangi", "Mataram", "Kupang", "Manado",
    "Ambon", "Jayapura", "Sorong", "Samarinda",
    "Tarakan", "Banda Aceh", "Lhokseumawe",
    "Tanjung Pinang", "Batam", "Metro", "Prabumulih",
    "Lubuklinggau", "Pangkalpinang", "Palangka Raya",
    "Palopo", "Kendari", "Gorontalo", "Ternate",
    "Tidore", "Manokwari"
  ];

  const matched = allowedOutside.find(
    item => item.toLowerCase() === city
  );

  if (matched) {
    return { city: matched, fee: SHIPPING_FEE };
  }

  return null;
}

function makeOrderCode() {
  const d = new Date();
  const date = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0")
  ].join("");

  const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let suffix = "";

  for (let i = 0; i < 6; i++) {
    suffix += alphabet[crypto.randomInt(alphabet.length)];
  }

  return `ESS-${date}-${suffix}`;
}

// Mempertahankan kolom lama agar cocok dengan admin pesanan.
async function ensureOrdersTable(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_code TEXT NOT NULL UNIQUE,
      product_names TEXT DEFAULT '',
      total_price INTEGER NOT NULL DEFAULT 0,
      whatsapp TEXT DEFAULT '',
      customer_name TEXT DEFAULT '',
      address TEXT DEFAULT '',
      city TEXT DEFAULT '',
      subtotal INTEGER NOT NULL DEFAULT 0,
      shipping_fee INTEGER NOT NULL DEFAULT 0,
      payment_status TEXT NOT NULL DEFAULT 'awaiting_payment',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      items TEXT DEFAULT '[]'
    )
  `);

  const result = await db.execute("PRAGMA table_info(orders)");
  const columns = new Set(
    result.rows.map(row => String(row.name))
  );

  const migrations = [
    ["product_names", "TEXT DEFAULT ''"],
    ["total_price", "INTEGER NOT NULL DEFAULT 0"],
    ["whatsapp", "TEXT DEFAULT ''"],
    ["customer_name", "TEXT DEFAULT ''"],
    ["address", "TEXT DEFAULT ''"],
    ["city", "TEXT DEFAULT ''"],
    ["subtotal", "INTEGER NOT NULL DEFAULT 0"],
    ["shipping_fee", "INTEGER NOT NULL DEFAULT 0"],
    ["payment_status", "TEXT NOT NULL DEFAULT 'awaiting_payment'"],
    ["created_at", "TEXT"],
    ["items", "TEXT DEFAULT '[]'"]
  ];

  for (const [column, definition] of migrations) {
    if (!columns.has(column)) {
      await db.execute(
        `ALTER TABLE orders ADD COLUMN ${column} ${definition}`
      );
    }
  }

  await db.execute(`
    UPDATE orders
    SET created_at = CURRENT_TIMESTAMP
    WHERE created_at IS NULL OR created_at = ''
  `);
}

// Memastikan tabel produk tersedia tanpa menghapus data yang sudah ada.
async function ensureProductsTable(db) {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      price INTEGER NOT NULL DEFAULT 0,
      image TEXT DEFAULT '',
      description TEXT DEFAULT '',
      notes TEXT DEFAULT '',
      category TEXT NOT NULL DEFAULT 'full',
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const result = await db.execute("PRAGMA table_info(products)");
  const columns = new Set(
    result.rows.map(row => String(row.name))
  );

  const migrations = [
    ["image", "TEXT DEFAULT ''"],
    ["description", "TEXT DEFAULT ''"],
    ["notes", "TEXT DEFAULT ''"],
    ["category", "TEXT NOT NULL DEFAULT 'full'"],
    ["is_active", "INTEGER NOT NULL DEFAULT 1"],
    ["created_at", "TEXT"],
    ["updated_at", "TEXT"]
  ];

  for (const [column, definition] of migrations) {
    if (!columns.has(column)) {
      await db.execute(
        `ALTER TABLE products ADD COLUMN ${column} ${definition}`
      );
    }
  }

  await db.execute(`
    UPDATE products
    SET created_at = CURRENT_TIMESTAMP
    WHERE created_at IS NULL OR created_at = ''
  `);

  await db.execute(`
    UPDATE products
    SET updated_at = CURRENT_TIMESTAMP
    WHERE updated_at IS NULL OR updated_at = ''
  `);
}

// Ambil harga terkini dari database berdasarkan nama produk.
// Harga cadangan hanya berlaku untuk tiga produk bawaan lama.
async function getProductPrices(db, names) {
  const uniqueNames = [...new Set(names)];

  const placeholders = uniqueNames.map(() => "?").join(", ");
  const result = await db.execute({
    sql: `
      SELECT name, price
      FROM products
      WHERE is_active = 1
        AND name IN (${placeholders})
    `,
    args: uniqueNames
  });

  const prices = new Map();

  for (const row of result.rows) {
    const price = Number(row.price);

    if (Number.isSafeInteger(price) && price >= 0) {
      prices.set(String(row.name), price);
    }
  }

  for (const productName of uniqueNames) {
    if (
      !prices.has(productName) &&
      Object.prototype.hasOwnProperty.call(PRODUCT_PRICES, productName)
    ) {
      prices.set(productName, PRODUCT_PRICES[productName]);
    }
  }

  return prices;
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
    const body = req.body || {};
    const name = String(body.name || "").trim();
    const address = String(body.address || "").trim();
    const whatsapp = normalizeWhatsApp(body.whatsapp);
    const area = normalizeArea(body.city);
    const items = body.items;

    if (!name || name.length > 120) {
      return json(res, 400, {
        success: false,
        error: "Nama pembeli tidak valid."
      });
    }

    if (!address || address.length > 1000) {
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

    const normalizedItems = [];
    const requestedNames = [];

    for (const item of items) {
      const productName = String(item?.name || "").trim();
      const quantity = Number(item?.quantity);

      if (
        !productName ||
        !Number.isSafeInteger(quantity) ||
        quantity < 1 ||
        quantity > 100
      ) {
        return json(res, 400, {
          success: false,
          error: "Produk atau jumlah tidak valid."
        });
      }

      requestedNames.push(productName);
      normalizedItems.push({
        name: productName,
        quantity
      });
    }

    db = createClient({ url, authToken });

    await ensureProductsTable(db);
    await ensureOrdersTable(db);

    const prices = await getProductPrices(db, requestedNames);

    let subtotal = 0;
    const pricedItems = [];

    for (const item of normalizedItems) {
      if (!prices.has(item.name)) {
        return json(res, 400, {
          success: false,
          error: `Produk "${item.name}" tidak ditemukan atau sudah tidak aktif. Perbarui daftar produk toko.`
        });
      }

      const price = prices.get(item.name);
      const itemSubtotal = price * item.quantity;

      if (!Number.isSafeInteger(itemSubtotal)) {
        return json(res, 400, {
          success: false,
          error: "Nilai harga produk tidak valid."
        });
      }

      subtotal += itemSubtotal;

      pricedItems.push({
        name: item.name,
        price,
        quantity: item.quantity
      });
    }

    const total = subtotal + area.fee;

    if (
      !Number.isSafeInteger(total) ||
      total <= 0 ||
      total > 100000000
    ) {
      return json(res, 400, {
        success: false,
        error: "Total pesanan tidak valid."
      });
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      const orderCode = makeOrderCode();

      try {
        await db.execute({
          sql: `
            INSERT INTO orders (
              order_code,
              product_names,
              total_price,
              whatsapp,
              customer_name,
              address,
              city,
              subtotal,
              shipping_fee,
              payment_status,
              created_at,
              items
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          args: [
            orderCode,
            pricedItems.map(p => `${p.name} x${p.quantity}`).join(", "),
            total,
            whatsapp,
            name,
            address,
            area.city,
            subtotal,
            area.fee,
            "awaiting_payment",
            new Date().toISOString(),
            JSON.stringify(pricedItems)
          ]
        });

        return json(res, 201, {
          success: true,
          order_code: orderCode,
          name,
          whatsapp,
          address,
          city: area.city,
          items: pricedItems,
          subtotal,
          shipping_fee: area.fee,
          total_price: total,
          payment_status: "awaiting_payment"
        });
      } catch (error) {
        if (
          String(error.message || "").toLowerCase().includes("unique") &&
          attempt < 4
        ) {
          continue;
        }

        throw error;
      }
    }

    return json(res, 500, {
      success: false,
      error: "Gagal membuat kode pesanan."
    });
  } catch (error) {
    console.error("Order API error:", {
      message: error.message,
      code: error.code,
      stack: error.stack
    });

    return json(res, 500, {
      success: false,
      error: "Pesanan gagal disimpan. Periksa log API."
    });
  } finally {
    if (db) {
      try {
        db.close();
      } catch (_) {}
    }
  }
};
