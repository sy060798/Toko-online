
const { createClient } = require("@libsql/client");

function json(res, status, data) {
  res.setHeader("Cache-Control", "no-store");
  return res.status(status).json(data);
}

function getDb() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url || !authToken) {
    throw new Error("Konfigurasi database Turso belum lengkap.");
  }

  return createClient({ url, authToken });
}

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
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const result = await db.execute("PRAGMA table_info(products)");
  const columns = result.rows.map(row => String(row.name));

  const additions = [
    ["image", "TEXT NOT NULL DEFAULT ''"],
    ["description", "TEXT NOT NULL DEFAULT ''"],
    ["notes", "TEXT NOT NULL DEFAULT 'EAU DE PARFUM'"],
    ["category", "TEXT NOT NULL DEFAULT 'full'"],
    ["is_active", "INTEGER NOT NULL DEFAULT 1"],
    ["created_at", "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP"],
    ["updated_at", "TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP"]
  ];

  for (const [column, definition] of additions) {
    if (!columns.includes(column)) {
      await db.execute(
        `ALTER TABLE products ADD COLUMN ${column} ${definition}`
      );
    }
  }
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

function cleanProduct(body) {
  const name = String(body.name || "").trim();
  const price = Number(body.price);
  const image = String(body.image || "").trim();
  const description = String(body.description || "").trim();
  const notes = String(body.notes || "").trim();
  const category = String(body.category || "full").trim();

  if (name.length < 2 || name.length > 150) {
    throw new Error("Nama produk harus 2–150 karakter.");
  }

  if (!Number.isSafeInteger(price) || price < 1 || price > 100000000) {
    throw new Error("Harga produk tidak valid.");
  }

  if (image && !/^https:\/\//i.test(image)) {
    throw new Error("URL gambar harus menggunakan HTTPS.");
  }

  if (!["sample", "full"].includes(category)) {
    throw new Error("Kategori harus sample atau full.");
  }

  return { name, price, image, description, notes, category };
}

module.exports = async (req, res) => {
  let db;

  try {
    if (!checkAdmin(req)) {
      return json(res, 401, {
        success: false,
        error: "Kunci admin tidak valid."
      });
    }

    db = getDb();
    await ensureProducts(db);

    if (req.method === "GET") {
      const result = await db.execute(`
        SELECT id, name, price, image, description, notes,
               category, is_active, created_at, updated_at
        FROM products
        ORDER BY id DESC
      `);

      return json(res, 200, {
        success: true,
        products: result.rows
      });
    }

    if (req.method === "POST") {
      const product = cleanProduct(req.body || {});

      const result = await db.execute({
        sql: `
          INSERT INTO products
            (name, price, image, description, notes, category,
             is_active, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        `,
        args: [
          product.name,
          product.price,
          product.image,
          product.description,
          product.notes,
          product.category
        ]
      });

      return json(res, 201, {
        success: true,
        id: Number(result.lastInsertRowid),
        message: "Produk berhasil ditambahkan."
      });
    }

    if (req.method === "PUT") {
      const body = req.body || {};
      const id = Number(body.id);

      if (!Number.isSafeInteger(id) || id < 1) {
        return json(res, 400, {
          success: false,
          error: "ID produk tidak valid."
        });
      }

      const product = cleanProduct(body);

      // Cari berdasarkan ID tanpa membatasi is_active.
      // Jika produk sebelumnya nonaktif, penyimpanan akan mengaktifkannya lagi.
      const result = await db.execute({
        sql: `
          UPDATE products
          SET name = ?, price = ?, image = ?, description = ?,
              notes = ?, category = ?, is_active = 1,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
        args: [
          product.name,
          product.price,
          product.image,
          product.description,
          product.notes,
          product.category,
          id
        ]
      });

      if (Number(result.rowsAffected) === 0) {
        return json(res, 404, {
          success: false,
          error: "ID produk tidak ditemukan di database. Muat ulang daftar produk."
        });
      }

      return json(res, 200, {
        success: true,
        message: "Produk berhasil diperbarui dan diaktifkan."
      });
    }

    if (req.method === "DELETE") {
      const id = Number((req.body || {}).id);

      if (!Number.isSafeInteger(id) || id < 1) {
        return json(res, 400, {
          success: false,
          error: "ID produk tidak valid."
        });
      }

      // Pastikan ID benar-benar ada.
      const existing = await db.execute({
        sql: "SELECT id, is_active FROM products WHERE id = ?",
        args: [id]
      });

      if (existing.rows.length === 0) {
        return json(res, 404, {
          success: false,
          error: "ID produk tidak ditemukan di database."
        });
      }

      if (Number(existing.rows[0].is_active) === 0) {
        return json(res, 200, {
          success: true,
          message: "Produk memang sudah dihapus dari katalog."
        });
      }

      await db.execute({
        sql: `
          UPDATE products
          SET is_active = 0, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `,
        args: [id]
      });

      return json(res, 200, {
        success: true,
        message: "Produk berhasil dihapus dari katalog."
      });
    }

    res.setHeader("Allow", "GET, POST, PUT, DELETE");

    return json(res, 405, {
      success: false,
      error: "Metode request tidak diizinkan."
    });
  } catch (error) {
    console.error("admin-products:", error);

    const message = String(error.message || "");

    if (message.includes("UNIQUE constraint failed")) {
      return json(res, 409, {
        success: false,
        error: "Nama produk sudah digunakan. Gunakan nama lain."
      });
    }

    if (
      message.includes("Nama produk") ||
      message.includes("Harga produk") ||
      message.includes("URL gambar") ||
      message.includes("Kategori")
    ) {
      return json(res, 400, {
        success: false,
        error: message
      });
    }

    return json(res, 500, {
      success: false,
      error: "Gagal memproses produk. Periksa log Vercel."
    });
  } finally {
    try {
      db?.close();
    } catch (_) {}
  }
};
