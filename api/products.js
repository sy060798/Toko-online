
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

let setupPromise;

async function ensureProducts() {
  if (setupPromise) return setupPromise;

  setupPromise = (async () => {
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

    const columnsResult = await db.execute(
      "PRAGMA table_info(products)"
    );

    const existingColumns = new Set(
      columnsResult.rows.map((column) => String(column.name))
    );

    const migrations = [
      ["image", "TEXT DEFAULT ''"],
      ["description", "TEXT DEFAULT ''"],
      ["notes", "TEXT DEFAULT ''"],
      ["category", "TEXT NOT NULL DEFAULT 'full'"],
      ["is_active", "INTEGER NOT NULL DEFAULT 1"],
      ["created_at", "TEXT"],
      ["updated_at", "TEXT"],
    ];

    for (const [column, definition] of migrations) {
      if (!existingColumns.has(column)) {
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
  })();

  try {
    await setupPromise;
  } catch (error) {
    setupPromise = null;
    throw error;
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({
      success: false,
      message: "Method tidak diizinkan.",
    });
  }

  try {
    await ensureProducts();

    const result = await db.execute({
      sql: `
        SELECT
          id,
          name,
          price,
          image,
          description,
          notes,
          category,
          is_active,
          created_at,
          updated_at
        FROM products
        WHERE is_active = 1
        ORDER BY
          CASE
            WHEN category = 'sample' THEN 0
            ELSE 1
          END,
          id DESC
      `,
      args: [],
    });

    const products = result.rows.map((row) => ({
      id: Number(row.id),
      name: String(row.name ?? ""),
      price: Number(row.price ?? 0),
      image: String(row.image ?? ""),
      description: String(row.description ?? ""),
      notes: String(row.notes ?? ""),
      category: String(row.category ?? "full"),
      is_active: Number(row.is_active ?? 1),
      created_at: row.created_at ?? null,
      updated_at: row.updated_at ?? null,
    }));

    return res.status(200).json({
      success: true,
      products,
    });
  } catch (error) {
    console.error("products API:", error);

    return res.status(500).json({
      success: false,
      message: "Gagal mengambil data produk.",
    });
  }
}
