const { createClient } = require("@libsql/client");
function json(res,status,data){res.setHeader("Content-Type","application/json; charset=utf-8");res.setHeader("Cache-Control","no-store");return res.status(status).json(data)}
function auth(req){const expected=process.env.ADMIN_API_KEY;const supplied=String(req.headers["x-admin-key"]||"");return !!expected&&supplied.length===expected.length&&supplied===expected}
const SAMPLE_PRODUCTS = [
  {name:"Velvet Oud",price:185000,image:"https://images.unsplash.com/photo-1594035910387-fea47794261f?auto=format&fit=crop&w=700&q=80",notes:"Woody · Warm · Elegant",description:"Aroma hangat, dalam, dan elegan dengan inspirasi kayu serta rempah. Cocok untuk malam hari dan acara spesial."},
  {name:"Rose Élégance",price:155000,image:"https://images.unsplash.com/photo-1541643600914-78b084683601?auto=format&fit=crop&w=700&q=80",notes:"Floral · Rose · Soft Musk",description:"Konsep wewangian floral yang lembut dan anggun, dengan inspirasi mawar dan musk yang bersih."},
  {name:"Citrus No. 09",price:125000,image:"https://images.unsplash.com/photo-1592945403244-b3fbafd7f539?auto=format&fit=crop&w=700&q=80",notes:"Citrus · Fresh · Clean",description:"Karakter aroma segar dan cerah yang terinspirasi dari buah sitrus, cocok untuk aktivitas sehari-hari."}
];
async function ensureProducts(db) {
  await db.execute(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
    price INTEGER NOT NULL CHECK(price > 0), image TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT 'EAU DE PARFUM',
    category TEXT NOT NULL DEFAULT 'full', is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT datetime('now'), updated_at TEXT NOT NULL DEFAULT datetime('now')
  )`);
  const cols = await db.execute("PRAGMA table_info(products)");
  if (!cols.rows.some(c => String(c.name) === "category")) {
    await db.execute("ALTER TABLE products ADD COLUMN category TEXT NOT NULL DEFAULT 'full'");
  }
  for (const p of SAMPLE_PRODUCTS) {
    await db.execute({sql:`INSERT OR IGNORE INTO products(name,price,image,description,notes,category,is_active) VALUES(?,?,?,?,?,'sample',1)`,args:[p.name,p.price,p.image,p.description,p.notes]});
    // Sample names stay in the sample collection even if a previous database row existed.
    await db.execute({sql:"UPDATE products SET category='sample' WHERE name=?",args:[p.name]});
  }
}
function normalize(body){
  const name=String(body?.name||"").trim(),image=String(body?.image||"").trim(),description=String(body?.description||"").trim(),notes=String(body?.notes||"EAU DE PARFUM").trim(),category=String(body?.category||"full").toLowerCase();
  const price=Number(body?.price);
  if(!name||name.length>150)throw new Error("Nama produk wajib diisi (maksimal 150 karakter).");
  if(!["sample","full"].includes(category))throw new Error("Pilih kategori Produk Contoh atau Produk Full.");
  if(!Number.isSafeInteger(price)||price<1||price>100000000)throw new Error("Harga harus berupa angka rupiah yang valid.");
  if(image&&!/^https:\/\//i.test(image))throw new Error("URL foto harus menggunakan https://.");
  if(description.length>5000||notes.length>200)throw new Error("Deskripsi atau notes terlalu panjang.");
  return {name,price,image,description,notes,category};
}
module.exports=async(req,res)=>{
  if(!auth(req))return json(res,401,{success:false,error:"Kunci admin tidak valid. Masukkan ADMIN_API_KEY dari Vercel."});
  if(!["GET","POST","PUT","DELETE"].includes(req.method)){res.setHeader("Allow","GET, POST, PUT, DELETE");return json(res,405,{success:false,error:"Metode tidak didukung."})}
  const {TURSO_DATABASE_URL:url,TURSO_AUTH_TOKEN:authToken}=process.env;if(!url||!authToken)return json(res,500,{success:false,error:"Konfigurasi database belum lengkap."});let db;
  try{db=createClient({url,authToken});await ensureProducts(db);
    if(req.method==="GET"){const result=await db.execute("SELECT id,name,price,image,description,notes,category,is_active,created_at,updated_at FROM products ORDER BY CASE category WHEN 'sample' THEN 0 ELSE 1 END,id DESC");return json(res,200,{success:true,products:result.rows.map(p=>({...p,id:Number(p.id),price:Number(p.price),is_active:Number(p.is_active),category:String(p.category||"full")}))})}
    const body=req.body||{};
    if(req.method==="POST"){const p=normalize(body);const result=await db.execute({sql:"INSERT INTO products(name,price,image,description,notes,category,is_active) VALUES(?,?,?,?,?,?,1) RETURNING id,name,price,image,description,notes,category,is_active,created_at,updated_at",args:[p.name,p.price,p.image,p.description,p.notes,p.category]});return json(res,201,{success:true,product:{...result.rows[0],id:Number(result.rows[0].id),price:Number(result.rows[0].price)}})}
    const id=Number(body.id);if(!Number.isSafeInteger(id)||id<1)return json(res,400,{success:false,error:"ID produk tidak valid."});
    if(req.method==="PUT"){const p=normalize(body);const result=await db.execute({sql:"UPDATE products SET name=?,price=?,image=?,description=?,notes=?,category=?,updated_at=datetime('now') WHERE id=? RETURNING id,name,price,image,description,notes,category,is_active,created_at,updated_at",args:[p.name,p.price,p.image,p.description,p.notes,p.category,id]});if(!result.rows.length)return json(res,404,{success:false,error:"Produk tidak ditemukan."});return json(res,200,{success:true,product:{...result.rows[0],id:Number(result.rows[0].id),price:Number(result.rows[0].price)}})}
    const result=await db.execute({sql:"UPDATE products SET is_active=0,updated_at=datetime('now') WHERE id=? AND is_active=1 RETURNING id",args:[id]});if(!result.rows.length)return json(res,404,{success:false,error:"Produk tidak ditemukan atau sudah dihapus."});return json(res,200,{success:true,message:"Produk dihapus dari katalog. Riwayat pesanan lama tetap tersimpan."});
  }catch(e){if(String(e.message||"").includes("UNIQUE constraint failed"))return json(res,409,{success:false,error:"Nama produk sudah digunakan. Pilih nama yang berbeda."});if(e instanceof Error&&/wajib diisi|Harga harus|URL foto|terlalu panjang|Pilih kategori/.test(e.message))return json(res,400,{success:false,error:e.message});console.error("admin-products:",e);return json(res,500,{success:false,error:"Gagal memproses produk. Periksa log Vercel."})}
  finally{try{db?.close()}catch(_){}}
};
