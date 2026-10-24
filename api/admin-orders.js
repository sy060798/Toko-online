
const {
  send,
  method,
  authorized,
  dbClient,
  setupCloudinary,
  ensureAdminColumns,
  parseProducts,
  localToday
} = require('../lib/admin-common');

// Membuat signed URL sementara untuk bukti transfer Cloudinary.
function createProofViewUrl(cloud, order) {
  const publicId = order.payment_proof_public_id;
  const format = String(order.payment_proof_format || '').toLowerCase();

  if (!publicId || !['jpg', 'jpeg', 'png', 'webp'].includes(format)) {
    return null;
  }

  try {
    return cloud.utils.private_download_url(publicId, format, {
      resource_type: 'image',
      type: 'authenticated',
      expires_at: Math.floor(Date.now() / 1000) + 300,
      attachment: false
    });
  } catch (error) {
    console.error(
      'Gagal membuat URL bukti transfer:',
      order.order_code,
      error.message
    );
    return null;
  }
}

module.exports = async (req, res) => {
  if (!method(req, res, ['GET'])) return;
  if (!authorized(req, res)) return;

  let db;

  try {
    db = dbClient();

    // Pastikan kolom tambahan admin tersedia.
    await ensureAdminColumns(db);

    // Inisialisasi Cloudinary menggunakan Environment Variables Vercel.
    const cloud = setupCloudinary();

    const result = await db.execute(
      'SELECT * FROM orders ORDER BY created_at DESC, id DESC'
    );

    const rows = result.rows.map((row) => {
      const order = { ...row };

      order.product_names = parseProducts(order);

      // URL sementara untuk menampilkan bukti transfer.
      order.proof_view_url = createProofViewUrl(cloud, order);

      return order;
    });

    // Tanggal mengikuti zona waktu Jakarta.
    const today = req.query?.date || localToday();

    const todayRows = rows.filter((order) => {
      if (!order.created_at) return false;

      const raw = String(order.created_at);

      const dateValue = new Date(
        raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z'
      );

      if (Number.isNaN(dateValue.getTime())) {
        return raw.slice(0, 10) === today;
      }

      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Jakarta',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(dateValue);

      const localDate = [
        parts.find((p) => p.type === 'year').value,
        parts.find((p) => p.type === 'month').value,
        parts.find((p) => p.type === 'day').value
      ].join('-');

      return localDate === today;
    });

    const sum = (list) =>
      list.reduce(
        (total, order) => total + Number(order.total_price || 0),
        0
      );

    const stats = {
      total_orders: rows.length,
      total_value: sum(rows),
      today_orders: todayRows.length,
      today_value: sum(todayRows),
      pending_orders: rows.filter((order) =>
        ['awaiting_payment', 'awaiting_verification'].includes(
          String(order.payment_status || '')
        )
      ).length
    };

    const filtered =
      req.query?.scope === 'today' ? todayRows : rows;

    send(res, 200, {
      success: true,
      orders: filtered,
      stats
    });
  } catch (error) {
    console.error('admin-orders:', error);

    send(res, 500, {
      success: false,
      error: 'Gagal mengambil data pesanan admin.'
    });
  } finally {
    try {
      db?.close();
    } catch (_) {}
  }
};
