
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

  // Nama wilayah harus berasal dari pilihan dropdown.
  const areas = {
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

  const allowedOutside = new Set([
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
    "Tarakan", "Banda Aceh", "Lhokseumawe", "Tanjung Pinang",
    "Batam", "Metro", "Prabumulih", "Lubuklinggau",
    "Pangkalpinang", "Palangka Raya", "Palopo", "Kendari",
    "Gorontalo", "Ternate", "Tidore", "Manokwari"
  ]);

  const normalized = areas[city];
  if (normalized) return { city: normalized, fee: 0 };

  // Wilayah lain harus dikirim sebagai nama kota/kabupaten
  // dari daftar pilihan yang telah disediakan frontend.
  for (const item of allowedOutside) {
    if (item.toLowerCase() === city) {
      return { city: item, fee: SHIPPING_FEE };
    }
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

    let subtotal = 0;
    const normalizedItems = [];

    for (const item of items) {
      const productName = String(item?.name || "");
      const quantity = Number(item?.quantity);

      if (
        !Object.prototype.hasOwnProperty.call(PRODUCT_PRICES, productName) ||
        !Number.isSafeInteger(quantity) ||
        quantity < 1 ||
        quantity > 100
      ) {
        return json(res, 400, {
          success: false,
          error: "Produk atau jumlah tidak valid."
        });
      }

      const price = PRODUCT_PRICES[productName];
      subtotal += price * quantity;

      normalizedItems.push({
        name: productName,
        price,
        quantity
      });
    }

    const total = subtotal + area.fee;

    if (!Number.isSafeInteger(total) || total <= 0 || total > 100000000) {
      return json(res, 400, {
        success: false,
        error: "Total pesanan tidak valid."
      });
    }

    db = createClient({ url, authToken });

    for (let attempt = 0; attempt < 5; attempt++) {
      const orderCode = makeOrderCode();

      try {
        await db.execute({
          sql: `INSERT INTO orders (
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
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            orderCode,
            normalizedItems.map(p => `${p.name} x${p.quantity}`).join(", "),
            total,
            whatsapp,
            name,
            address,
            area.city,
            subtotal,
            area.fee,
            "awaiting_payment",
            new Date().toISOString()
          ]
        });

        return json(res, 201, {
          success: true,
          order_code: orderCode,
          name,
          whatsapp,
          address,
          city: area.city,
          items: normalizedItems,
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
}
 finally {
    if (db) {
      try {
        db.close();
      } catch (_) {}
    }
  }
};
