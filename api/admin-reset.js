const { send, method, authorized, dbClient, setupCloudinary, localToday } = require('../lib/admin-common');
module.exports = async (req, res) => {
  if (!method(req, res, ['POST'])) return;
  if (!authorized(req, res)) return;
  let db;
  try {
    const body = req.body || {};
    const date = String(body.date || '');
    if (body.confirm !== 'RESET HARI INI' || body.exported !== true) return send(res, 400, { success: false, error: 'Konfirmasi reset tidak lengkap. Ekspor laporan terlebih dahulu.' });
    if (date !== localToday()) return send(res, 400, { success: false, error: 'Reset hanya diizinkan untuk tanggal hari ini menurut waktu Jakarta.' });
    db = dbClient();
    const cloud = setupCloudinary();
    const found = await db.execute({
      sql: "SELECT order_code, payment_proof_public_id FROM orders WHERE date(datetime(created_at, '+7 hours')) = ?",
      args: [date]
    });
    const rows = found.rows;
    const failures = [];
    for (const row of rows) {
      if (!row.payment_proof_public_id) continue;
      try {
        const result = await cloud.uploader.destroy(row.payment_proof_public_id, { resource_type: 'image', type: 'authenticated', invalidate: true });
        if (!['ok', 'not found'].includes(String(result.result || '').toLowerCase())) failures.push(row.order_code);
      } catch (e) { failures.push(row.order_code); }
    }
    if (failures.length) return send(res, 502, { success: false, error: 'Sebagian bukti Cloudinary gagal dihapus. Data Turso belum dihapus agar tidak kehilangan catatan. Pesanan bermasalah: ' + failures.join(', ') });
    const deleted = await db.execute({ sql: "DELETE FROM orders WHERE date(datetime(created_at, '+7 hours')) = ?", args: [date] });
    send(res, 200, { success: true, deleted_orders: rows.length, message: `Reset selesai. ${rows.length} pesanan hari ini dan bukti terkait telah dihapus.` });
  } catch (e) {
    console.error('admin-reset:', e);
    send(res, 500, { success: false, error: e.message || 'Gagal mereset data hari ini.' });
  } finally { try { db?.close(); } catch (_) {} }
};
