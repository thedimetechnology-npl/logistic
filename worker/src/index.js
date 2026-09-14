/**
 * Moto Logistics — D1 backend (Cloudflare Worker)
 * Motorcycle Parts & Accessories — Warehouse / Vendor / Dispatch / Finance (Nepal VAT)
 */
const COLLECTIONS = [
  'parts', 'categories', 'brands', 'units',
  'godowns', 'vendors', 'dealers',
  'purchaseOrders', 'grns',
  'dispatchOrders', 'salesInvoices', 'purchaseInvoices',
  'payments', 'expenses',
  'inventoryLedger',
  'users'
];

function corsHeaders(origin){
  const allow = origin && origin !== 'null' ? origin : '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Max-Age': '86400',
    'Vary': 'Origin',
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
    'Content-Security-Policy': "default-src 'none'",
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
}
function getOrigin(req){ try{ return req.headers.get('Origin') || '*'; }catch(_){ return '*'; } }
function json(obj, status=200, req){
  const origin = req ? getOrigin(req) : '*';
  return new Response(JSON.stringify(obj), { status, headers:{'Content-Type':'application/json;charset=utf-8', ...corsHeaders(origin)} });
}
async function sha256(text){
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,'0')).join('');
}
const BOOTSTRAP_USERNAME = env => env.BOOTSTRAP_USERNAME || 'demo';
const BOOTSTRAP_PASSWORD = env => env.BOOTSTRAP_PASSWORD || 'demo123';

async function getSetting(env, key){
  const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
  return row ? JSON.parse(row.value) : null;
}
async function setSetting(env, key, value){
  await env.DB.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(key, JSON.stringify(value)).run();
}
let _schemaDone=false;
async function ensureSchema(env){
  const stmts = [
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)`,
    ...COLLECTIONS.map(t=>`CREATE TABLE IF NOT EXISTS ${t} (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT, owner TEXT)`),
    `CREATE TABLE IF NOT EXISTS financeData (key TEXT, value TEXT, owner TEXT)`,
    `CREATE TABLE IF NOT EXISTS ledgerKV (key TEXT, value TEXT, owner TEXT)`
  ];
  for(const s of stmts){ try{ await env.DB.prepare(s).run(); }catch(e){} }
}
async function ensureSchemaOnce(env){
  if(_schemaDone) return;
  await ensureSchema(env);
  _schemaDone=true;
}

async function checkPassword(env, username, password){
  await ensureSchemaOnce(env);
  let admin = await getSetting(env, 'admin');
  if(!admin){
    if(username === BOOTSTRAP_USERNAME(env) && password === BOOTSTRAP_PASSWORD(env)){
      admin = { username, passwordHash: await sha256(password) };
      await setSetting(env, 'admin', admin);
      return true;
    }
    // first user auto-creates admin
    admin = { username, passwordHash: await sha256(password) };
    await setSetting(env, 'admin', admin);
    return true;
  }
  if(admin.username === username && admin.passwordHash === await sha256(password)) return true;
  // check users collection (global owner = admin username)
  try{
    const res = await env.DB.prepare('SELECT data FROM users').all();
    for(const row of res.results||[]){
      try{ const u=JSON.parse(row.data); if(u.username===username && u.password===password) return true; }catch(_){}
    }
  }catch(_){}
  return false;
}
async function findAll(env, table, owner){
  try{
    const res = await env.DB.prepare(`SELECT data FROM ${table} WHERE owner = ?`).bind(owner).all();
    return (res.results||[]).map(r=>{ try{ return JSON.parse(r.data); }catch(_){ return r.data; } });
  }catch(e){ return []; }
}
async function replaceAll(env, table, arr, owner){
  await env.DB.prepare(`DELETE FROM ${table} WHERE owner = ?`).bind(owner).run();
  for(const item of arr){
    const data = JSON.stringify(item);
    await env.DB.prepare(`INSERT INTO ${table} (data, owner) VALUES (?, ?)`).bind(data, owner).run();
  }
}
async function findAllKV(env, table, owner){
  try{
    const res = await env.DB.prepare(`SELECT key, value FROM ${table} WHERE owner = ?`).bind(owner).all();
    const out={}; for(const r of res.results||[]){ try{ out[r.key]=JSON.parse(r.value);}catch(_){ out[r.key]=r.value; } } return out;
  }catch(_){ return {}; }
}
async function replaceKV(env, table, obj, owner){
  await env.DB.prepare(`DELETE FROM ${table} WHERE owner = ?`).bind(owner).run();
  for(const [k,v] of Object.entries(obj||{})){
    await env.DB.prepare(`INSERT INTO ${table} (key, value, owner) VALUES (?, ?, ?)`).bind(k, JSON.stringify(v), owner).run();
  }
}

async function handleGetAll(env, body){
  await ensureSchemaOnce(env);
  if(!await checkPassword(env, body.username, body.password)) return { ok:false, error:'Invalid username or password' };
  const owner = body.username;
  // batch all finds in one roundtrip — much faster than 17 sequential queries
  try {
    const stmts = COLLECTIONS.map(c=> env.DB.prepare(`SELECT data FROM ${c} WHERE owner = ?`).bind(owner));
    stmts.push(env.DB.prepare(`SELECT key, value FROM financeData WHERE owner = ?`).bind(owner));
    stmts.push(env.DB.prepare(`SELECT value FROM settings WHERE key = ?`).bind('appSettings'));
    const batchRes = await env.DB.batch(stmts);
    const map={};
    for(let i=0;i<COLLECTIONS.length;i++){
      const r=batchRes[i];
      map[COLLECTIONS[i]] = (r.results||[]).map(x=>{ try{ return JSON.parse(x.data); }catch(_){ return x.data; } });
    }
    if(!map.godowns || map.godowns.length===0){
      map.godowns = [{id:'g1', name:'Main Godown', location:'Kathmandu', code:'GD-01'}, {id:'g2', name:'Secondary Godown', location:'Branch', code:'GD-02'}];
    }
    const finR=batchRes[COLLECTIONS.length];
    const financeData={}; for(const row of finR.results||[]){ try{ financeData[row.key]=JSON.parse(row.value);}catch(_){ financeData[row.key]=row.value; } }
    const appSetR=batchRes[COLLECTIONS.length+1];
    const appSettings = appSetR.results && appSetR.results[0] ? JSON.parse(appSetR.results[0].value) : null;
    return { ok:true, data:{ ...map, financeData, settings: appSettings } };
  } catch(e){
    // fallback to old method
    const results = await Promise.all(COLLECTIONS.map(c=> findAll(env,c,owner)));
    const map={}; COLLECTIONS.forEach((c,i)=> map[c]=results[i]);
    if(!map.godowns || map.godowns.length===0) map.godowns = [{id:'g1', name:'Main Godown', location:'Kathmandu', code:'GD-01'}, {id:'g2', name:'Secondary Godown', location:'Branch', code:'GD-02'}];
    const financeData = await findAllKV(env,'financeData', owner);
    return { ok:true, data:{ ...map, financeData, settings: await getSetting(env,'appSettings') } };
  }
}
async function handleSaveAll(env, body){
  await ensureSchemaOnce(env);
  if(!await checkPassword(env, body.username, body.password)) return { ok:false, error:'Invalid username or password' };
  // Viewer read-only check
  try{
    const allUsers = await env.DB.prepare('SELECT data FROM users').all();
    for(const row of allUsers.results||[]){ try{ const u=JSON.parse(row.data); if(u.username===body.username && u.role==='Viewer') return {ok:false, error:'Viewer role — view only'}; }catch(_){} }
  }catch(_){}
  const data = body.data||{};
  const owner = body.username;
  const safeReplace = async (table, arr)=>{
    if(arr == null){
      const cnt = await env.DB.prepare(`SELECT COUNT(*) as c FROM ${table} WHERE owner = ?`).bind(owner).first();
      if(cnt && cnt.c>0) return;
      arr=[];
    }
    await replaceAll(env, table, arr||[], owner);
  };
  await Promise.all(COLLECTIONS.map(t=> safeReplace(t, data[t])));
  if(data.financeData) await replaceKV(env,'financeData', data.financeData, owner);
  if(data.appSettings) await setSetting(env,'appSettings', data.appSettings);
  return { ok:true };
}
async function handleChangePassword(env, body){
  if(!await checkPassword(env, body.username, body.password)) return { ok:false, error:'Invalid username or password' };
  const admin = await getSetting(env,'admin');
  admin.passwordHash = await sha256(body.newPassword);
  await setSetting(env,'admin', admin);
  return { ok:true };
}
async function handleStoreRecoveryEmail(env, body){
  if(!await checkPassword(env, body.username, body.password)) return { ok:false, error:'Invalid username or password' };
  const email=String(body.email||'').trim();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok:false, error:'Invalid email' };
  const admin=await getSetting(env,'admin'); admin.recoveryEmail=email; await setSetting(env,'admin', admin); return {ok:true};
}
function randomCode(){ return String(Math.floor(100000+Math.random()*900000)); }
async function handleSendResetCode(env, body){
  const email=String(body.email||'').trim().toLowerCase();
  const admin=await getSetting(env,'admin');
  if(admin && admin.recoveryEmail && admin.recoveryEmail.toLowerCase()===email){
    const code=randomCode(); admin.resetCode=code; admin.resetCodeExpiry=Date.now()+15*60*1000; await setSetting(env,'admin', admin);
  }
  return { ok:true };
}
async function handleResetPassword(env, body){
  const email=String(body.email||'').trim().toLowerCase();
  const code=String(body.code||'').trim();
  const np=String(body.newPassword||'');
  if(np.length<6) return {ok:false, error:'Password min 6 chars'};
  const admin=await getSetting(env,'admin');
  if(!admin || !admin.recoveryEmail || admin.recoveryEmail.toLowerCase()!==email) return {ok:false, error:'Invalid email or code'};
  if(!admin.resetCode || admin.resetCode!==code) return {ok:false, error:'Invalid or expired code'};
  if(Date.now()>admin.resetCodeExpiry) return {ok:false, error:'Code expired'};
  admin.passwordHash=await sha256(np); delete admin.resetCode; delete admin.resetCodeExpiry; await setSetting(env,'admin', admin); return {ok:true};
}
async function backupAllToR2(env){
  if(!env.BACKUP_BUCKET) return {ok:false, error:'No R2'};
  await ensureSchemaOnce(env);
  const owners=new Set();
  try{ const a=await getSetting(env,'admin'); if(a?.username) owners.add(a.username); }catch(_){}
  try{ const p=await env.DB.prepare('SELECT DISTINCT owner FROM parts').all(); for(const r of p.results||[]) if(r.owner) owners.add(r.owner); }catch(_){}
  if(owners.size===0) owners.add('demo');
  const all={ time:new Date().toISOString(), owners:[...owners], data:{} };
  for(const owner of owners){
    const vals=await Promise.all(COLLECTIONS.map(c=>findAll(env,c,owner)));
    const map={}; COLLECTIONS.forEach((c,i)=>map[c]=vals[i]);
    map.financeData=await findAllKV(env,'financeData', owner);
    all.data[owner]=map;
  }
  try{ const s=await env.DB.prepare('SELECT key, value FROM settings').all(); all.settings=s.results||[]; }catch(_){ all.settings=[]; }
  const key=`backup-${new Date().toISOString().slice(0,16).replace(/[:T]/g,'-')}.json`;
  const body=JSON.stringify(all,null,2);
  await env.BACKUP_BUCKET.put(key, body, { httpMetadata:{contentType:'application/json'}, customMetadata:{created:new Date().toISOString()} });
  return { ok:true, key, size:body.length, owners:[...owners] };
}
async function cleanupOldBackups(env){
  if(!env.BACKUP_BUCKET) return {ok:false, error:'No R2'};
  const list=await env.BACKUP_BUCKET.list({limit:1000});
  const cutoff=Date.now()-7*24*60*60*1000; let deleted=0;
  for(const obj of list.objects||[]){
    let ts=obj.uploaded? new Date(obj.uploaded).getTime():0;
    if(!ts){ const m=obj.key.match(/backup-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})/); if(m) ts=new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00Z`).getTime(); }
    if(ts && ts<cutoff){ await env.BACKUP_BUCKET.delete(obj.key); deleted++; }
  }
  return { ok:true, deleted, scanned:(list.objects||[]).length };
}

export default {
  async fetch(request, env){
    if(request.method==='OPTIONS') return new Response(null,{status:204, headers:corsHeaders(getOrigin(request))});
    const url=new URL(request.url);
    if(url.pathname==='/health' || url.searchParams.get('health')==='1'){
      return json({ ok:true, service:'moto-logistics-d1', time:new Date().toISOString(), hasDB:!!env.DB, hasR2:!!env.BACKUP_BUCKET },200,request);
    }
    if(url.searchParams.get('backup')==='1'){ try{ const r=await backupAllToR2(env); return json({ok:true, manualBackup:r},200,request);}catch(e){ return json({ok:false,error:e.message},500,request); } }
    if(url.searchParams.get('listBackups')==='1'){
      if(!env.BACKUP_BUCKET) return json({ok:false,error:'No R2'},500,request);
      const list=await env.BACKUP_BUCKET.list({limit:1000});
      const sorted=(list.objects||[]).map(o=>({key:o.key,size:o.size,uploaded:o.uploaded})).sort((a,b)=>{
        const ta=a.uploaded?new Date(a.uploaded).getTime():0; const tb=b.uploaded?new Date(b.uploaded).getTime():0;
        if(tb!==ta) return tb-ta; return b.key.localeCompare(a.key);
      });
      return json({ok:true, backups:sorted},200,request);
    }
    if(url.searchParams.get('cleanup')==='1'){ const r=await cleanupOldBackups(env); return json({ok:true, cleanup:r},200,request); }
    if(url.searchParams.get('getBackup')){
      const key=url.searchParams.get('getBackup'); if(!key) return json({ok:false,error:'Missing key'},400,request);
      if(!env.BACKUP_BUCKET) return json({ok:false,error:'No R2'},500,request);
      let obj=await env.BACKUP_BUCKET.get(key); if(!obj && !key.startsWith('moto-logistics-backup/')) obj=await env.BACKUP_BUCKET.get('moto-logistics-backup/'+key);
      if(!obj) return json({ok:false,error:'Not found: '+key},404,request);
      const text=await obj.text(); return new Response(text,{status:200, headers:{'Content-Type':'application/json', ...corsHeaders(getOrigin(request))}});
    }
    if(request.method==='GET') return json({ok:false, error:'POST only — use POST with {action:...}'},405);
    if(request.method!=='POST') return json({ok:false, error:'POST only'},405);
    let body; try{ body=await request.json(); }catch(e){ return json({ok:false, error:'Invalid JSON'},400); }
    const known=new Set(['getAll','saveAll','changePassword','storeRecoveryEmail','sendResetCode','resetPassword']);
    if(body.action && !known.has(body.action)) return json({ok:false, error:'Unknown action: '+body.action},400);
    try{
      let resp;
      switch(body.action){
        case 'getAll': resp=await handleGetAll(env,body); break;
        case 'saveAll': resp=await handleSaveAll(env,body); break;
        case 'changePassword': resp=await handleChangePassword(env,body); break;
        case 'storeRecoveryEmail': resp=await handleStoreRecoveryEmail(env,body); break;
        case 'sendResetCode': resp=await handleSendResetCode(env,body); break;
        case 'resetPassword': resp=await handleResetPassword(env,body); break;
        default: resp={ok:false, error:'Unknown action: '+body.action};
      }
      return json(resp,200,request);
    }catch(err){ console.error('Worker error',err); return json({ok:false, error:err.message||'DB error'},500,request); }
  },
  async scheduled(event, env, ctx){
    ctx.waitUntil((async()=>{
      try{ const b=await backupAllToR2(env); console.log('R2 backup',b.key);}catch(e){ console.error('backup fail',e); }
      try{ const c=await cleanupOldBackups(env); console.log('cleanup',c);}catch(e){ console.error('cleanup fail',e); }
    })());
  }
};
