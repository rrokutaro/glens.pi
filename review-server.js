/**
 * review-server.js
 *
 * Standalone human review server for the UGC dropship pipeline.
 * Serves a mobile review UI, blocks until all pending items are reviewed,
 * then exits cleanly.
 *
 * Env: same as orchestrator (ORCH_MONGODB_URI, ORCH_MONGODB_DB, etc.)
 * Plus: REVIEW_PORT (default 3456), NGROK_AUTHTOKEN
 */

import http from 'http';
import { MongoClient, ObjectId } from 'mongodb';

// ═══════════════════════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════════════════════
const CONFIG = {
    mongodb: {
        uri:        process.env.ORCH_MONGODB_URI        || '',
        db:         process.env.ORCH_MONGODB_DB         || 'ugc-dropship',
        collection: process.env.ORCH_MONGODB_COLLECTION || 'scraped-posts',
    },
    port: parseInt(process.env.REVIEW_PORT || '3456', 10),
    ngrokToken: process.env.NGROK_AUTHTOKEN || '',
};

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LOG_LEVEL  = LOG_LEVELS[process.env.ORCH_LOG_LEVEL || 'info'] || 1;

function log(level, ...args) {
    if ((LOG_LEVELS[level] ?? 1) < LOG_LEVEL) return;
    const ts = new Date().toISOString().slice(11, 23);
    const prefix = `[${ts}] [${level.toUpperCase()}]`;
    if (level === 'error') console.error(prefix, ...args);
    else if (level === 'warn') console.warn(prefix, ...args);
    else console.log(prefix, ...args);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MOBILE REVIEW UI (inline, no external files)
// ═══════════════════════════════════════════════════════════════════════════════
const REVIEW_UI_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta name="theme-color" content="#111">
<title>Review</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;-webkit-tap-highlight-color:transparent}
body{background:#0a0a0a;color:#e5e5e5;min-height:100dvh;overflow-x:hidden}
button{cursor:pointer;padding:12px 16px;border:none;border-radius:10px;background:#262626;color:#e5e5e5;font-size:15px;font-weight:500;touch-action:manipulation;min-height:44px}
button:active{transform:scale(0.97)}
button.primary{background:#4ade80;color:#000}
button.danger{background:#dc2626;color:#fff}
button.ghost{background:transparent;border:1px solid #404040}
input,select,textarea{background:#1a1a1a;border:1px solid #333;color:#e5e5e5;padding:12px;border-radius:10px;font-size:15px;width:100%;-webkit-appearance:none}
input:focus,select:focus,textarea:focus{outline:none;border-color:#4ade80}
select{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%23888'%3E%3Cpath d='M6 8L1 3h10z'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;padding-right:32px}
img{max-width:100%;border-radius:10px;display:block}
.topbar{position:sticky;top:0;z-index:100;background:#0a0a0a;border-bottom:1px solid #222;padding:12px 16px;display:flex;align-items:center;gap:12px}
.topbar h1{font-size:17px;font-weight:600;flex:1}
.topbar .count{background:#4ade80;color:#000;font-size:12px;font-weight:700;padding:4px 10px;border-radius:20px}
.queue{padding:12px;display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.qitem{position:relative;aspect-ratio:3/4;border-radius:12px;overflow:hidden;background:#1a1a1a}
.qitem img{width:100%;height:100%;object-fit:cover}
.qitem .badge{position:absolute;top:8px;left:8px;padding:4px 8px;border-radius:8px;font-size:10px;font-weight:600;background:rgba(0,0,0,0.7);backdrop-filter:blur(4px)}
.qitem .badge.done{background:#4ade80;color:#000}
.qitem .badge.partial{background:#f59e0b;color:#000}
.qitem .id{position:absolute;bottom:0;left:0;right:0;padding:20px 8px 8px;background:linear-gradient(transparent,rgba(0,0,0,0.8));font-size:11px;color:#aaa}
.reviewview{padding:0 0 100px}
.media-scroll{display:flex;gap:10px;padding:12px;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch}
.media-scroll::-webkit-scrollbar{display:none}
.media-item{flex:0 0 85%;scroll-snap-align:center;border-radius:14px;overflow:hidden;border:2px solid transparent;background:#1a1a1a}
.media-item.on{border-color:#4ade80}
.media-item img{width:100%;aspect-ratio:3/4;object-fit:cover}
.media-item .label{padding:10px;font-size:12px;color:#888;text-align:center}
.chips{padding:0 12px 12px;display:flex;gap:8px;overflow-x:auto;white-space:nowrap}
.chips::-webkit-scrollbar{display:none}
.chip{display:inline-flex;align-items:center;gap:6px;padding:10px 16px;background:#1a1a1a;border:1.5px solid #333;border-radius:24px;font-size:14px;font-weight:500}
.chip.on{border-color:#4ade80;background:#142818}
.chip .dot{width:8px;height:8px;border-radius:50%}
.editor{padding:12px}
.editor h2{font-size:20px;font-weight:700;margin-bottom:4px;padding:0 4px}
.editor .subtitle{color:#888;font-size:13px;margin-bottom:16px;padding:0 4px}
.card{background:#141414;border:1px solid #222;border-radius:16px;padding:16px;margin-bottom:12px}
.card h3{font-size:13px;text-transform:uppercase;letter-spacing:0.08em;color:#888;margin-bottom:12px;font-weight:600}
.img-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px}
.img-cell{aspect-ratio:1;border-radius:12px;overflow:hidden;position:relative;border:2px solid transparent;background:#1a1a1a}
.img-cell.on{border-color:#4ade80}
.img-cell img{width:100%;height:100%;object-fit:cover}
.img-cell .check{position:absolute;top:6px;right:6px;width:24px;height:24px;background:#4ade80;border-radius:50%;display:none;align-items:center;justify-content:center;font-size:14px;color:#000;font-weight:bold}
.img-cell.on .check{display:flex}
.source-row{display:flex;align-items:center;gap:12px;padding:14px;background:#1a1a1a;border-radius:12px;margin-bottom:8px}
.source-row .info{flex:1;min-width:0}
.source-row .name{font-size:15px;font-weight:500;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.source-row .price{font-size:13px;color:#888}
.source-row .actions{display:flex;gap:8px}
.source-row button{padding:8px 14px;font-size:13px;min-height:40px;border-radius:8px}
.field{margin-bottom:14px}
.field label{display:block;font-size:13px;color:#888;margin-bottom:6px;font-weight:500}
.field input,.field select,.field textarea{font-size:15px}
.actions-row{display:flex;gap:10px;padding:4px}
.actions-row button{flex:1;padding:14px;font-size:16px;font-weight:600;border-radius:12px}
.sheet{position:fixed;bottom:0;left:0;right:0;background:#0a0a0a;border-top:1px solid #333;border-radius:20px 20px 0 0;padding:20px 16px 32px;z-index:200;transform:translateY(100%);transition:transform 0.25s ease}
.sheet.open{transform:translateY(0)}
.sheet .handle{width:40px;height:4px;background:#444;border-radius:2px;margin:0 auto 16px}
.sheet h3{font-size:18px;font-weight:700;margin-bottom:16px}
.sheet .option{padding:14px 16px;border-radius:12px;font-size:16px;margin-bottom:8px;background:#1a1a1a}
.sheet .option:active{background:#262626}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:150;opacity:0;pointer-events:none;transition:opacity 0.2s}
.overlay.on{opacity:1;pointer-events:auto}
.loading{display:flex;align-items:center;justify-content:center;height:100dvh;color:#888}
.spinner{width:28px;height:28px;border:2px solid #333;border-top-color:#4ade80;border-radius:50%;animation:spin 0.8s linear infinite;margin-right:12px}
@keyframes spin{to{transform:rotate(360deg)}}
.hide{display:none}
#commitBar{position:fixed;bottom:0;left:0;right:0;padding:12px 16px 24px;background:linear-gradient(transparent,#0a0a0a 20%);display:flex;gap:10px;z-index:50}
</style>
</head>
<body>
<div id="app">
  <div class="loading" id="loadScreen"><div class="spinner"></div>Loading queue...</div>
  <div id="queueView" class="hide">
    <div class="topbar"><h1>Review</h1><span class="count" id="qCount">0</span></div>
    <div class="queue" id="queue"></div>
  </div>
  <div id="reviewView" class="reviewview hide">
    <div class="topbar">
      <button class="ghost" onclick="back()">← Back</button>
      <h1 id="rTitle">Post</h1>
      <div style="width:60px"></div>
    </div>
    <div class="media-scroll" id="mediaScroll"></div>
    <div class="chips" id="chips"></div>
    <div class="editor" id="editor">
      <h2 id="eTitle">Product</h2>
      <div class="subtitle" id="eSub"></div>
      <div class="card">
        <h3>Images</h3>
        <div class="img-grid" id="imgGrid"></div>
        <button class="ghost" onclick="addImage()" style="width:100%">+ Add Image URL</button>
      </div>
      <div class="card">
        <h3>Sources</h3>
        <div id="srcList"></div>
        <button class="ghost" onclick="addSource()" style="width:100%;margin-top:8px">+ Add Source URL</button>
      </div>
      <div class="card">
        <h3>Details</h3>
        <div class="field"><label>Brand</label><input id="fBrand"></div>
        <div class="field" style="display:flex;gap:10px">
          <div style="flex:1"><label>Price</label><input id="fPrice" type="text" inputmode="decimal"></div>
          <div style="width:100px"><label>Currency</label><select id="fCurr"><option>USD</option><option>EUR</option><option>GBP</option><option>CAD</option><option>AUD</option></select></div>
        </div>
        <div class="field"><label>Availability</label><select id="fStock"><option>In stock</option><option>Out of stock</option><option>Pre-order</option></select></div>
        <div class="field"><label>Sizes</label><input id="fSizes" placeholder="S, M, L or 36-40"></div>
        <div class="field"><label>Description</label><textarea id="fDesc" rows="3"></textarea></div>
      </div>
      <div class="actions-row">
        <button class="danger" onclick="rejectProduct()">Not This</button>
        <button class="primary" onclick="saveProduct()">Save</button>
      </div>
    </div>
    <div id="commitBar">
      <button class="danger" onclick="deleteItem()" style="flex:1">Delete</button>
      <button class="primary" onclick="commitItem()" style="flex:2">Commit Item</button>
    </div>
  </div>
</div>
<div class="overlay" id="overlay" onclick="closeSheet()"></div>
<div class="sheet" id="sheet">
  <div class="handle"></div>
  <h3 id="sheetTitle">Actions</h3>
  <div id="sheetContent"></div>
</div>
<script>
let queue=[],post=null,fileIdx=0,prodIdx=0,selected=new Set();
async function load(){
  try{const r=await fetch('/api/queue');queue=await r.json();}catch(e){queue=[];}
  document.getElementById('loadScreen').classList.add('hide');
  document.getElementById('queueView').classList.remove('hide');
  document.getElementById('qCount').textContent=queue.length;
  renderQueue();
}
function renderQueue(){
  document.getElementById('queue').innerHTML=queue.map((q,i)=>\`<div class="qitem" onclick="openPost(\${i})"><img src="\${q.thumb}" loading="lazy"><span class="badge \${q.status}">\${q.status}</span><div class="id">\${q.postId}</div></div>\`).join('');
}
function openPost(i){
  post=queue[i];fileIdx=0;prodIdx=0;
  document.getElementById('queueView').classList.add('hide');
  document.getElementById('reviewView').classList.remove('hide');
  document.getElementById('rTitle').textContent=post.postId;
  renderMedia();renderChips();closeEditor();
}
function back(){document.getElementById('reviewView').classList.add('hide');document.getElementById('queueView').classList.remove('hide');load();}
function renderMedia(){
  const files=post.fileUrl.fileUrls;
  document.getElementById('mediaScroll').innerHTML=files.map((f,i)=>\`<div class="media-item \${i===fileIdx?'on':''}" onclick="selFile(\${i})"><img src="\${f.url}"><div class="label">\${f.type} \${i+1}/\${files.length}</div></div>\`).join('');
  setTimeout(()=>{const el=document.querySelectorAll('.media-item')[fileIdx];if(el)el.scrollIntoView({behavior:'smooth',inline:'center'});},50);
}
function selFile(i){fileIdx=i;prodIdx=0;renderMedia();renderChips();closeEditor();}
function renderChips(){
  const prods=post.fileUrl.fileUrls[fileIdx].response?.products||[];
  document.getElementById('chips').innerHTML=prods.map((p,i)=>{
    const color=p.reviewStatus==='completed'?'#4ade80':p.reviewStatus==='rejected'?'#dc2626':'#f59e0b';
    return \`<div class="chip \${i===prodIdx?'on':''}" onclick="openProduct(\${i})"><span class="dot" style="background:\${color}"></span>\${p.title}</div>\`;
  }).join('');
}
function openProduct(i){
  prodIdx=i;const p=post.fileUrl.fileUrls[fileIdx].response.products[i];
  selected=new Set(p.selectedImages?.map((_,idx)=>idx)||(p.images?.length?[0]:[]));
  document.getElementById('editor').classList.remove('hide');
  document.getElementById('eTitle').textContent=p.title;
  document.getElementById('eSub').textContent=(p.brand||'')+' · '+(p.category||'');
  document.getElementById('fBrand').value=p.brand||'';
  document.getElementById('fPrice').value=p.price||'';
  document.getElementById('fCurr').value=p.currency||'USD';
  document.getElementById('fStock').value=p.availability||'In stock';
  document.getElementById('fSizes').value=(p.sizing||[]).join(',')||p.sizes||'';
  document.getElementById('fDesc').value=p.description||'';
  renderImages(p);renderSources(p);renderChips();
  setTimeout(()=>document.getElementById('editor').scrollIntoView({behavior:'smooth'}),100);
}
function closeEditor(){document.getElementById('editor').classList.add('hide');}
function renderImages(p){
  const imgs=p.images||[];
  let html=imgs.length?imgs.map((u,i)=>\`<div class="img-cell \${selected.has(i)?'on':''}" onclick="togImg(\${i})"><img src="\${u}" loading="lazy"><div class="check">✓</div></div>\`).join(''):'<div style="color:#666;padding:20px;text-align:center">No images extracted</div>';
  document.getElementById('imgGrid').innerHTML=html;
}
function togImg(i){selected.has(i)?selected.delete(i):selected.add(i);renderImages(post.fileUrl.fileUrls[fileIdx].response.products[prodIdx]);}
function addImage(){const u=prompt('Paste image URL:');if(!u)return;const p=post.fileUrl.fileUrls[fileIdx].response.products[prodIdx];p.images=p.images||[];p.images.push(u);selected.add(p.images.length-1);renderImages(p);}
function renderSources(p){
  const srcs=p.sources||[];
  document.getElementById('srcList').innerHTML=srcs.map((s,i)=>\`<div class="source-row"><div class="info"><div class="name">\${s.store}</div><div class="price">\${s.price}</div></div><div class="actions"><button class="ghost" onclick="window.open('\${s.url}')">Visit</button><button class="danger" onclick="rmSrc(\${i})">Remove</button></div></div>\`).join('');
}
function rmSrc(i){post.fileUrl.fileUrls[fileIdx].response.products[prodIdx].sources.splice(i,1);renderSources(post.fileUrl.fileUrls[fileIdx].response.products[prodIdx]);}
function addSource(){const u=prompt('Paste source product URL:');if(!u)return;const p=post.fileUrl.fileUrls[fileIdx].response.products[prodIdx];p.sources=p.sources||[];p.sources.push({store:'Custom',price:'TBD',url:u});renderSources(p);}
async function saveProduct(){
  const p=post.fileUrl.fileUrls[fileIdx].response.products[prodIdx];
  p.title=document.getElementById('eTitle').textContent;
  p.brand=document.getElementById('fBrand').value;
  p.price=document.getElementById('fPrice').value;
  p.currency=document.getElementById('fCurr').value;
  p.availability=document.getElementById('fStock').value;
  p.sizes=document.getElementById('fSizes').value;
  p.description=document.getElementById('fDesc').value;
  p.selectedImages=Array.from(selected).map(i=>p.images[i]).filter(Boolean);
  p.reviewStatus='completed';
  try{await fetch('/api/product/'+post._id+'/'+fileIdx+'/'+prodIdx,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});}catch(e){}
  renderChips();
  const prods=post.fileUrl.fileUrls[fileIdx].response.products;
  const next=prods.findIndex((pr,i)=>i>prodIdx&&pr.reviewStatus!=='completed'&&pr.reviewStatus!=='rejected');
  if(next!==-1){openProduct(next);}else{const first=prods.findIndex(pr=>pr.reviewStatus!=='completed'&&pr.reviewStatus!=='rejected');if(first!==-1)openProduct(first);else{closeEditor();window.scrollTo({top:0,behavior:'smooth'});}}
}
async function rejectProduct(){
  const p=post.fileUrl.fileUrls[fileIdx].response.products[prodIdx];
  p.reviewStatus='rejected';p.selectedImages=[];
  try{await fetch('/api/product/'+post._id+'/'+fileIdx+'/'+prodIdx,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});}catch(e){}
  renderChips();closeEditor();
}
async function deleteItem(){
  showSheet('Delete Item?',[
    {text:'Yes, delete this file_url',action:async()=>{try{await fetch('/api/delete/'+post._id+'/'+fileIdx,{method:'POST'});}catch(e){}back();closeSheet();}},
    {text:'Cancel',action:()=>closeSheet()}
  ]);
}
async function commitItem(){
  const f=post.fileUrl.fileUrls[fileIdx];
  const pending=(f.response?.products||[]).filter(p=>p.reviewStatus!=='completed'&&p.reviewStatus!=='rejected');
  if(pending.length){showSheet('Pending Products',pending.map(p=>({text:p.title,action:()=>{closeSheet();openProduct(f.response.products.indexOf(p));}})));return;}
  try{await fetch('/api/commit/'+post._id+'/'+fileIdx,{method:'POST'});}catch(e){}
  if(fileIdx<post.fileUrl.fileUrls.length-1){fileIdx++;renderMedia();renderChips();closeEditor();window.scrollTo({top:0,behavior:'smooth'});}else{back();}
}
function showSheet(title,options){
  document.getElementById('sheetTitle').textContent=title;
  document.getElementById('sheetContent').innerHTML=options.map(o=>\`<div class="option" onclick="(\${o.action.toString()})()">\${o.text}</div>\`).join('');
  document.getElementById('overlay').classList.add('on');
  document.getElementById('sheet').classList.add('open');
}
function closeSheet(){document.getElementById('overlay').classList.remove('on');document.getElementById('sheet').classList.remove('open');}
load();
</script>
</body>
</html>`;

// ═══════════════════════════════════════════════════════════════════════════════
//  SERVER
// ═══════════════════════════════════════════════════════════════════════════════

async function startNgrok(port) {
    if (!CONFIG.ngrokToken) {
        log('warn', 'No NGROK_AUTHTOKEN set. Server only available locally.');
        return null;
    }
    try {
        const { spawn } = await import('child_process');
        const ngrok = spawn('ngrok', ['http', String(port), '--authtoken', CONFIG.ngrokToken], { stdio: 'pipe' });

        let url = null;
        for await (const chunk of ngrok.stdout) {
            const text = chunk.toString();
            const match = text.match(/https:\/\/[a-z0-9-]+\.ngrok-free\.app/);
            if (match) { url = match[0]; break; }
        }

        if (url) {
            log('info', `ngrok tunnel: ${url}`);
            return { url, process: ngrok };
        }
        log('warn', 'ngrok started but no URL captured');
        return null;
    } catch (err) {
        log('error', 'ngrok failed:', err.message);
        return null;
    }
}

async function buildQueue(collection) {
    const posts = await collection.find({
        discarded: { $ne: true },
        file_urls: {
            $elemMatch: {
                reviewed: true,
                humanReviewed: { $ne: true },
                $or: [
                    { response: { $exists: false } },
                    { 'response.products.reviewStatus': { $ne: 'completed' } }
                ]
            }
        }
    }).project({ post_id: 1, file_urls: 1 }).limit(100).toArray();

    const queue = [];
    for (const post of posts) {
        for (let i = 0; i < post.file_urls.length; i++) {
            const f = post.file_urls[i];
            if (!f.reviewed || f.humanReviewed) continue;
            const hasPending = !f.response || f.response.products.some(p => p.reviewStatus !== 'completed');
            if (!hasPending) continue;
            queue.push({
                _id: post._id.toString(),
                postId: post.post_id,
                fileIndex: i,
                thumb: f.url,
                status: f.response ? 'partial' : 'pending',
                fileUrl: { fileUrls: post.file_urls }
            });
        }
    }
    return queue;
}

async function checkDone(collection) {
    const remaining = await collection.countDocuments({
        discarded: { $ne: true },
        file_urls: {
            $elemMatch: {
                reviewed: true,
                humanReviewed: { $ne: true },
                $or: [
                    { response: { $exists: false } },
                    { 'response.products.reviewStatus': { $ne: 'completed' } }
                ]
            }
        }
    });
    log('info', `Queue: ${remaining} item(s) remaining`);
    return remaining;
}

async function main() {
    log('info', '═══════════════════════════════════════════════════════════════');
    log('info', '  REVIEW SERVER');
    log('info', '═══════════════════════════════════════════════════════════════');

    if (!CONFIG.mongodb.uri) {
        log('error', 'ORCH_MONGODB_URI is required');
        process.exit(1);
    }

    // Connect MongoDB
    log('info', 'Connecting to MongoDB...');
    const client = new MongoClient(CONFIG.mongodb.uri, { serverSelectionTimeoutMS: 15000 });
    await client.connect();
    const db = client.db(CONFIG.mongodb.db);
    const collection = db.collection(CONFIG.mongodb.collection);
    log('info', `Connected: ${CONFIG.mongodb.db}.${CONFIG.mongodb.collection}`);

    // Start server
    let serverResolve;
    const donePromise = new Promise(r => serverResolve = r);
    let ngrokProc = null;

    const server = http.createServer(async (req, res) => {
        const parsed = new URL(req.url, `http://localhost:${CONFIG.port}`);

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

        // Serve UI
        if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(REVIEW_UI_HTML);
            return;
        }

        // GET /api/queue
        if (parsed.pathname === '/api/queue' && req.method === 'GET') {
            const q = await buildQueue(collection);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(q));
            return;
        }

        // POST /api/product/:docId/:fileIdx/:prodIdx
        const prodMatch = parsed.pathname.match(/^\/api\/product\/([^\/]+)\/(\d+)\/(\d+)$/);
        if (prodMatch && req.method === 'POST') {
            const docId = prodMatch[1];
            const fileIdx = parseInt(prodMatch[2], 10);
            const prodIdx = parseInt(prodMatch[3], 10);
            let body = '';
            req.on('data', d => body += d);
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body);
                    const path = `file_urls.${fileIdx}.response.products.${prodIdx}`;
                    await collection.updateOne(
                        { _id: new ObjectId(docId) },
                        { $set: {
                            [`${path}.title`]: data.title,
                            [`${path}.brand`]: data.brand,
                            [`${path}.price`]: data.price,
                            [`${path}.currency`]: data.currency,
                            [`${path}.availability`]: data.availability,
                            [`${path}.sizes`]: data.sizes,
                            [`${path}.description`]: data.description,
                            [`${path}.selectedImages`]: data.selectedImages,
                            [`${path}.sources`]: data.sources,
                            [`${path}.reviewStatus`]: data.reviewStatus,
                            [`${path}.reviewedAt`]: new Date()
                        }}
                    );
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                    const remaining = await checkDone(collection);
                    if (remaining === 0) serverResolve();
                } catch (e) {
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }

        // POST /api/commit/:docId/:fileIdx
        const commitMatch = parsed.pathname.match(/^\/api\/commit\/([^\/]+)\/(\d+)$/);
        if (commitMatch && req.method === 'POST') {
            const docId = commitMatch[1];
            const fileIdx = parseInt(commitMatch[2], 10);
            await collection.updateOne(
                { _id: new ObjectId(docId) },
                { $set: { [`file_urls.${fileIdx}.humanReviewed`]: true, [`file_urls.${fileIdx}.humanReviewedAt`]: new Date() } }
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            const remaining = await checkDone(collection);
            if (remaining === 0) serverResolve();
            return;
        }

        // POST /api/delete/:docId/:fileIdx
        const delMatch = parsed.pathname.match(/^\/api\/delete\/([^\/]+)\/(\d+)$/);
        if (delMatch && req.method === 'POST') {
            const docId = delMatch[1];
            const fileIdx = parseInt(delMatch[2], 10);
            await collection.updateOne(
                { _id: new ObjectId(docId) },
                { $set: { [`file_urls.${fileIdx}.discarded`]: true } }
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
            const remaining = await checkDone(collection);
            if (remaining === 0) serverResolve();
            return;
        }

        res.writeHead(404);
        res.end('Not found');
    });

    server.listen(CONFIG.port, '0.0.0.0', async () => {
        log('info', `Server: http://0.0.0.0:${CONFIG.port}`);

        const ngrok = await startNgrok(CONFIG.port);
        if (ngrok) {
            log('info', '═══════════════════════════════════════════════════════════════');
            log('info', `  OPEN ON YOUR PHONE: ${ngrok.url}`);
            log('info', '═══════════════════════════════════════════════════════════════');
            ngrokProc = ngrok.process;
        }

        const initial = await checkDone(collection);
        if (initial === 0) {
            log('info', 'Nothing to review. Exiting.');
            serverResolve();
        }
    });

    await donePromise;

    log('info', 'Shutting down...');
    server.close(() => {});
    if (ngrokProc) ngrokProc.kill();
    await client.close();
    log('info', 'Done.');
}

main().catch(err => {
    log('error', 'Fatal:', err.message);
    process.exit(1);
}); 
