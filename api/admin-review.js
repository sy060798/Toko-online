const { send, method, authorized, dbClient, ensureAdminColumns } = require('../lib/admin-common');
module.exports = async (req, res) => {
  if (!method(req, res, ['POST'])) return;
  if (!authorized(req, res)) return;
  let db;
  try {
    db = dbClient();
    await ensureAdminColumns(db);
    const body = req.body || {};
    const code = String(body.order_code || '').trim();
    const decision = String(body.decision || '').trim();
    const note = String(body.note || '').trim().slice(0, 1000);
    if (!/^ESS-\d{8}-[A-Z0-9]{6}$/.test(code)) return send(res, 400, { success: false, error: 'Kode pesanan tidak valid.' });
    if (!['accepted', 'rejected'].includes(decision)) return send(res, 400, { success: false, error: 'Keputusan harus accepted atau rejected.' });
    if (decision === 'rejected' && !note) return send(res, 400, { success: false, error: 'Catatan penolakan wajib diisi.' });
    const found = await db.execute({ sql: 'SELECT * FROM orders WHERE order_code = ? LIMIT 1', args: [code] });
    if (!found.rows.length) return send(res, 404, { success: false, error: 'Pesanan tidak ditemukan.' });
    const order = found.rows[0];
    if (!['awaiting_verification', 'awaiting_payment'].includes(String(order.payment_status || ''))) return send(res, 409, { success: false, error: 'Pesanan ini sudah ditinjau sebelumnya.' });
    if (decision === 'accepted' && !order.payment_proof_public_id) return send(res, 400, { success: false, error: 'Tidak dapat menerima pembayaran karena bukti transfer belum tersedia.' });
    await db.execute({
      sql: 'UPDATE orders SET payment_status = ?, admin_note = ?, reviewed_at = datetime(\'now\') WHERE order_code = ?',
      args: [decision, note || null, code]
    });
    const updated = await db.execute({ sql: 'SELECT * FROM orders WHERE order_code = ? LIMIT 1', args: [code] });
    const o = { ...updated.rows[0] };
    send(res, 200, {
      success: true,
      order: o,
      customer_message: decision === 'accepted'
        ? `Halo ${o.customer_name}, pembayaran untuk pesanan ${code} sudah kami konfirmasi. Pesanan Anda akan segera diproses. Terima kasih telah berbelanja di ESSENCE Perfume Atelier.`
        : `Halo ${o.customer_name}, pembayaran untuk pesanan ${code} belum dapat kami verifikasi. Catatan admin: ${note}. Silakan periksa kembali bukti transfer dan hubungi kami jika membutuhkan bantuan.`
    });
  } catch (e) {
    console.error('admin-review:', e);
    send(res, 500, { success: false, error: e.message || 'Gagal memperbarui status pesanan.' });
  } finally { try { db?.close(); } catch (_) {} }
};
