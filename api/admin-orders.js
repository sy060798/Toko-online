const { send, method, authorized, dbClient, setupCloudinary, ensureAdminColumns, proofUrl, parseProducts, localToday } = require('../lib/admin-common');
module.exports = async (req, res) => {
  if (!method(req, res, ['GET'])) return;
  if (!authorized(req, res)) return;
  let db;
  try {
    db = dbClient();
    await ensureAdminColumns(db);
    const cloud = setupCloudinary();
    const result = await db.execute('SELECT * FROM orders ORDER BY created_at DESC, id DESC');
    const rows = result.rows.map(r => {
      const o = { ...r };
      o.product_names = parseProducts(o);
      o.proof_view_url = proofUrl(cloud, o);
      return o;
    });
    const today = req.query?.date || localToday();
    const todayRows = rows.filter(o => { if (!o.created_at) return false; const raw = String(o.created_at); const d = new Date(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z'); if (Number.isNaN(d.getTime())) return raw.slice(0, 10) === today; const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d); const localDate = `${parts.find(p => p.type === 'year').value}-${parts.find(p => p.type === 'month').value}-${parts.find(p => p.type === 'day').value}`; return localDate === today; });
    const sum = list => list.reduce((n, o) => n + Number(o.total_price || 0), 0);
    const stats = {
      total_orders: rows.length,
      total_value: sum(rows),
      today_orders: todayRows.length,
      today_value: sum(todayRows),
      pending_orders: rows.filter(o => ['awaiting_payment', 'awaiting_verification'].includes(String(o.payment_status || ''))).length
    };
    const filtered = req.query?.scope === 'today' ? todayRows : rows;
    send(res, 200, { success: true, orders: filtered, stats });
  } catch (e) {
    console.error('admin-orders:', e);
    send(res, 500, { success: false, error: e.message || 'Gagal mengambil data pesanan.' });
  } finally { try { db?.close(); } catch (_) {} }
};
