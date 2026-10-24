const { createClient } = require('@libsql/client');
const cloudinary = require('cloudinary').v2;
const crypto = require('crypto');

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}
function method(req, res, allowed) {
  if (!allowed.includes(req.method)) {
    res.setHeader('Allow', allowed.join(', '));
    send(res, 405, { success: false, error: 'Metode tidak diizinkan.' });
    return false;
  }
  return true;
}
function authorized(req, res) {
  const expected = process.env.ADMIN_API_KEY || '';
  const supplied = String(req.headers['x-admin-key'] || '');
  if (!expected || !supplied) {
    send(res, 401, { success: false, error: 'Kunci admin belum diatur atau belum dimasukkan. Atur ADMIN_API_KEY di Vercel.' });
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    send(res, 401, { success: false, error: 'Kunci admin salah.' });
    return false;
  }
  return true;
}
function dbClient() {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (!url || !authToken) throw new Error('TURSO_DATABASE_URL dan TURSO_AUTH_TOKEN wajib diatur.');
  return createClient({ url, authToken });
}
function setupCloudinary() {
  const { CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET } = process.env;
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) throw new Error('Environment Cloudinary belum lengkap.');
  cloudinary.config({ cloud_name: CLOUDINARY_CLOUD_NAME, api_key: CLOUDINARY_API_KEY, api_secret: CLOUDINARY_API_SECRET, secure: true });
  return cloudinary;
}
async function ensureAdminColumns(db) {
  // Aman untuk skema lama: SQLite mengembalikan error jika kolom sudah ada.
  for (const sql of [
    'ALTER TABLE orders ADD COLUMN admin_note TEXT NULL',
    'ALTER TABLE orders ADD COLUMN reviewed_at TEXT NULL'
  ]) {
    try { await db.execute(sql); } catch (e) { if (!/duplicate column name|already exists/i.test(String(e.message))) throw e; }
  }
}
function proofUrl(cloud, row) {
  if (!row.payment_proof_public_id) return null;
  const options = { secure: true, sign_url: true, type: 'authenticated', resource_type: 'image' };
  if (row.payment_proof_version) options.version = Number(row.payment_proof_version);
  return cloud.url(row.payment_proof_public_id, options);
}
function parseProducts(row) {
  const raw = row.product_names;
  if (typeof raw !== 'string') return raw || '';
  try { const parsed = JSON.parse(raw); return parsed; } catch { return raw; }
}
function localToday() {
  const now = new Date(Date.now() + 7 * 60 * 60 * 1000);
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,'0')}-${String(now.getUTCDate()).padStart(2,'0')}`;
}
module.exports = { send, method, authorized, dbClient, setupCloudinary, ensureAdminColumns, proofUrl, parseProducts, localToday };
