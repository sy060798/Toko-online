
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

const FREE_SHIPPING_CITIES = new Set([
  "jakarta",
  "bogor",
  "depok",
  "tangerang",
  "bekasi",
]);

const SHIPPING_FEE = 6000;

function normalizeCity(city) {
  return String(city || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function getShippingFee(city) {
  const normalized = normalizeCity(city);

  for (const freeCity of FREE_SHIPPING_CITIES) {
    if (
      normalized === freeCity ||
      normalized.startsWith(freeCity + " ") ||
      normalized.startsWith(freeCity + ",")
    ) {
      return 0;
    }
  }

  return SHIPPING_FEE;
}

function makeOrderCode() {
  const time = Date.now().toString().slice(-8);
  const random = Math.floor(1000 + Math.random() * 9000);
  return `ESS-${time}-${random}`;
}

function parseItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Keranjang produk masih kosong.");
  }

  return items.map((item) => {
    const id = Number(item.id ?? item.product_id);
    const quantity = Number(item.quantity ?? item.qty);

    if (!Number.isInteger(id) || id <= 0) {
      throw new Error("ID produk tidak valid.");
    }

    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
      throw new Error("Jumlah produk tidak valid.");
    }

    return { id, quantity };
  });
}

async function ensureOrdersTable() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      whatsapp TEXT NOT NULL,
      address TEXT NOT NULL,
      city TEXT NOT NULL,
      items TEXT NOT NULL,
      subtotal INTEGER NOT NULL,
      shipping_fee INTEGER NOT NULL,
      total_price INTEGER NOT NULL,
      payment_status TEXT NOT NULL DEFAULT 'awaiting_payment',
      payment_proof TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const info = await db.execute("PRAGMA table_info(orders)");
  const columns = new Set(info.rows.map((row) => String(row.name)));

  const migrations = [
    ["order_code", "TEXT"],
    ["name", "TEXT DEFAULT ''"],
    ["whatsapp", "TEXT DEFAULT ''"],
    ["address", "TEXT DEFAULT ''"],
    ["city", "TEXT DEFAULT ''"],
    ["items", "TEXT DEFAULT '[]'"],
    ["subtotal", "INTEGER NOT NULL DEFAULT 0"],
    ["shipping_fee", "INTEGER NOT NULL DEFAULT 0"],
    ["total_price", "INTEGER NOT NULL DEFAULT 0"],
    ["payment_status", "TEXT NOT NULL DEFAULT 'awaiting_payment'"],
    ["payment_proof", "TEXT DEFAULT ''"],
    ["created_at", "TEXT"],
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

async function ensureProductsTable() {
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

  const info = await db.execute("PRAGMA table_info(products)");
  const columns = new Set(info.rows.map((row) => String(row.name)));

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

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      success: false,
      message: "Method tidak diizinkan.",
    });
  }

  try {
    await ensureProductsTable();
    await ensureOrdersTable();

    const body = req.body || {};
    const name = String(body.name || "").trim();
    const whatsapp = String(body.whatsapp || "").trim();
    const address = String(body.address || "").trim();
    const city = String(body.city || "").trim();

    if (!name || !whatsapp || !address || !city) {
      return res.status(400).json({
        success: false,
        message: "Nama, WhatsApp, alamat, dan kota wajib diisi.",
      });
    }

    const requestedItems = parseItems(body.items);
    const uniqueIds = [...new Set(requestedItems.map((item) => item.id))];
    const placeholders = uniqueIds.map(() => "?").join(",");

    const productResult = await db.execute({
      sql: `
        SELECT id, name, price, image, description, notes, category
        FROM products
        WHERE is_active = 1
          AND id IN (${placeholders})
      `,
      args: uniqueIds,
    });

    const productMap = new Map(
      productResult.rows.map((row) => [Number(row.id), row])
    );

    if (productMap.size !== uniqueIds.length) {
      return res.status(400).json({
        success: false,
        message: "Ada produk yang tidak ditemukan atau sudah tidak tersedia.",
      });
    }

    const orderItems = requestedItems.map(({ id, quantity }) => {
      const product = productMap.get(id);
      const price = Number(product.price);

      if (!Number.isFinite(price) || price < 0) {
        throw new Error(`Harga produk ${product.name} tidak valid.`);
      }

      return {
        id,
        name: String(product.name),
        price,
        quantity,
        subtotal: price * quantity,
        image: String(product.image || ""),
      };
    });

    const subtotal = orderItems.reduce(
      (sum, item) => sum + item.subtotal,
      0
    );

    const shippingFee = getShippingFee(city);
    const totalPrice = subtotal + shippingFee;
    const orderCode = makeOrderCode();

    await db.execute({
      sql: `
        INSERT INTO orders (
          order_code, name, whatsapp, address, city, items,
          subtotal, shipping_fee, total_price, payment_status
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        orderCode,
        name,
        whatsapp,
        address,
        city,
        JSON.stringify(orderItems),
        subtotal,
        shippingFee,
        totalPrice,
        "awaiting_payment",
      ],
    });

    return res.status(201).json({
      success: true,
      order_code: orderCode,
      name,
      whatsapp,
      address,
      city,
      items: orderItems,
      subtotal,
      shipping_fee: shippingFee,
      total_price: totalPrice,
      payment_status: "awaiting_payment",
      message: "Pesanan berhasil dibuat.",
    });
  } catch (error) {
    console.error("orders API:", error);

    return res.status(500).json({
      success: false,
      message: error.message || "Gagal membuat pesanan.",
    });
  }
}
