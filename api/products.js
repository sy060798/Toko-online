const { createClient } = require("@libsql/client");
function json(res,status,data){res.setHeader("Content-Type","application/json; charset=utf-8");res.setHeader("Cache-Control","no-store");return res.status(status).json(data)}
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
module.exports = async (req,res) => {
  if(req.method!=="GET"){res.setHeader("Allow","GET");return json(res,405,{success:false,error:"Gunakan metode GET."})}
  const {TURSO_DATABASE_URL:url,TURSO_AUTH_TOKEN:authToken}=process.env;
  if(!url||!authToken)return json(res,500,{success:false,error:"Konfigurasi database belum lengkap."});
  let db;
  try{db=createClient({url,authToken});await ensureProducts(db);
    const result=await db.execute("SELECT id,name,price,image,description,notes,category FROM products WHERE is_active=1 ORDER BY CASE category WHEN 'sample' THEN 0 ELSE 1 END,id ASC");
    return json(res,200,{success:true,products:result.rows.map(p=>({...p,id:Number(p.id),price:Number(p.price),category:String(p.category||"full")}))});
  }catch(e){console.error("products:",e);return json(res,500,{success:false,error:"Gagal mengambil katalog produk."})}
  finally{try{db?.close()}catch(_){}}
};
