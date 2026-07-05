/**
 * review-server.js
 *
 * Production human review server for the UGC dropship pipeline.
 * Serves a mobile-first review UI for validating AI-identified products,
 * sources, images, and metadata before dropshipping pages are created.
 *
 * Env: ORCH_MONGODB_URI, ORCH_MONGODB_DB, ORCH_MONGODB_COLLECTION
 *      REVIEW_PORT (default 3456), NGROK_AUTHTOKEN
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
//  HTML UI (static string — no template literals to avoid escaping issues)
// ═══════════════════════════════════════════════════════════════════════════════
const REVIEW_UI_HTML = [
'<!DOCTYPE html>',
'<html lang="en">',
'<head>',
'<meta charset="utf-8">',
'<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">',
'<meta name="theme-color" content="#0a0a0a">',
'<title>DropShip Review</title>',
'<style>',
'*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}',
'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:#0a0a0a;color:#e5e5e5;line-height:1.5;min-height:100dvh;overflow-x:hidden}',
'button{cursor:pointer;border:none;border-radius:12px;padding:12px 16px;font-size:15px;font-weight:600;touch-action:manipulation;min-height:44px;transition:transform .05s,opacity .15s}',
'button:active{transform:scale(.97)}',
'button:disabled{opacity:.5;cursor:not-allowed}',
'.btn-primary{background:#4ade80;color:#000}',
'.btn-danger{background:#dc2626;color:#fff}',
'.btn-ghost{background:#1a1a1a;color:#e5e5e5;border:1px solid #333}',
'.btn-secondary{background:#262626;color:#e5e5e5}',
'input,select,textarea{background:#141414;border:1px solid #2a2a2a;color:#e5e5e5;padding:12px 14px;border-radius:10px;font-size:15px;width:100%;-webkit-appearance:none}',
'input:focus,select:focus,textarea:focus{outline:none;border-color:#4ade80}',
'select{background-image:url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'12\' height=\'12\' fill=\'%23888\'%3E%3Cpath d=\'M6 8L1 3h10z\'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 12px center;padding-right:32px}',
'textarea{resize:vertical;min-height:80px}',
'img{max-width:100%;display:block}',
'.screen{display:none;min-height:100dvh}',
'.screen.active{display:block}',
'.topbar{position:sticky;top:0;z-index:50;background:rgba(10,10,10,.92);backdrop-filter:blur(10px);border-bottom:1px solid #222;padding:12px 16px;display:flex;align-items:center;gap:12px}',
'.topbar h1{font-size:17px;font-weight:700;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.badge{font-size:12px;font-weight:700;padding:4px 10px;border-radius:20px;background:#333}',
'.badge.pending{background:#f59e0b;color:#000}',
'.badge.partial{background:#3b82f6;color:#fff}',
'.badge.done{background:#4ade80;color:#000}',
'.loading{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100dvh;gap:16px;color:#888}',
'.spinner{width:32px;height:32px;border:3px solid #333;border-top-color:#4ade80;border-radius:50%;animation:spin .8s linear infinite}',
'@keyframes spin{to{transform:rotate(360deg)}}',
'.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;padding:12px}',
'@media(min-width:500px){.grid{grid-template-columns:repeat(3,1fr)}}',
'@media(min-width:768px){.grid{grid-template-columns:repeat(4,1fr)}}',
'.q-card{background:#141414;border:1px solid #222;border-radius:16px;overflow:hidden;cursor:pointer}',
'.q-card:active{transform:scale(.98)}',
'.q-thumb{position:relative;aspect-ratio:3/4;background:#1a1a1a}',
'.q-thumb img{width:100%;height:100%;object-fit:cover}',
'.q-badge{position:absolute;top:8px;left:8px;font-size:11px;font-weight:700;padding:3px 8px;border-radius:8px;background:rgba(0,0,0,.75);backdrop-filter:blur(4px)}',
'.q-info{padding:10px 12px}',
'.q-id{font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.q-type{font-size:12px;color:#888;margin-top:2px}',
'.hero{position:relative;background:#111}',
'.hero img{width:100%;aspect-ratio:3/4;object-fit:contain;background:#0a0a0a}',
'.hero-meta{position:absolute;bottom:0;left:0;right:0;padding:40px 16px 16px;background:linear-gradient(transparent,rgba(0,0,0,.85));display:flex;gap:8px;flex-wrap:wrap}',
'.section{padding:16px}',
'.section h2{font-size:18px;font-weight:700;margin-bottom:12px;display:flex;align-items:center;gap:8px}',
'.p-card{background:#141414;border:1px solid #222;border-radius:16px;padding:12px;display:flex;gap:12px;cursor:pointer;margin-bottom:10px}',
'.p-card:active{transform:scale(.98)}',
'.p-img{width:80px;height:80px;border-radius:12px;overflow:hidden;background:#1a1a1a;flex-shrink:0}',
'.p-img img{width:100%;height:100%;object-fit:cover}',
'.p-img .no-img{width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:#666;font-size:11px}',
'.p-info{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center}',
'.p-title{font-size:15px;font-weight:600;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.p-brand{font-size:13px;color:#888;margin-bottom:6px}',
'.p-status{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:500}',
'.dot{width:8px;height:8px;border-radius:50%;display:inline-block}',
'.actions-bar{position:fixed;bottom:0;left:0;right:0;padding:12px 16px 24px;background:linear-gradient(transparent,#0a0a0a 30%);display:flex;gap:10px;z-index:40}',
'.actions-bar button{flex:1;padding:14px;font-size:16px}',
'.modal{position:fixed;inset:0;z-index:100;background:#0a0a0a;display:none;flex-direction:column}',
'.modal.active{display:flex}',
'.modal-header{position:sticky;top:0;z-index:10;background:rgba(10,10,10,.95);backdrop-filter:blur(10px);border-bottom:1px solid #222;padding:12px 16px;display:flex;align-items:center;gap:12px}',
'.modal-header h2{font-size:17px;font-weight:700;flex:1}',
'.modal-body{flex:1;overflow-y:auto;padding:16px;padding-bottom:100px}',
'.card{background:#141414;border:1px solid #222;border-radius:16px;padding:16px;margin-bottom:12px}',
'.card h3{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#888;margin-bottom:12px;font-weight:700}',
'.img-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px}',
'.img-cell{aspect-ratio:1;border-radius:12px;overflow:hidden;position:relative;border:2px solid transparent;background:#1a1a1a;cursor:pointer}',
'.img-cell.on{border-color:#4ade80}',
'.img-cell img{width:100%;height:100%;object-fit:cover}',
'.img-cell .check{position:absolute;top:6px;right:6px;width:24px;height:24px;background:#4ade80;border-radius:50%;display:none;align-items:center;justify-content:center;font-size:14px;color:#000;font-weight:700}',
'.img-cell.on .check{display:flex}',
'.src-row{display:flex;align-items:center;gap:10px;padding:12px;background:#1a1a1a;border-radius:10px;margin-bottom:8px}',
'.src-row .info{flex:1;min-width:0}',
'.src-row .name{font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.src-row .url{font-size:12px;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
'.src-row .actions{display:flex;gap:6px}',
'.src-row button{padding:8px 12px;font-size:12px;min-height:36px;border-radius:8px}',
'.field{margin-bottom:14px}',
'.field label{display:block;font-size:12px;font-weight:600;color:#888;margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em}',
'.field-row{display:flex;gap:10px}',
'.field-row .field{flex:1}',
'.empty{color:#666;text-align:center;padding:24px;font-size:14px}',
'.toast{position:fixed;top:16px;left:50%;transform:translateX(-50%) translateY(-100px);background:#262626;color:#fff;padding:12px 20px;border-radius:12px;font-size:14px;font-weight:500;z-index:200;transition:transform .3s ease;border:1px solid #333}',
'.toast.show{transform:translateX(-50%) translateY(0)}',
'.check-indicator{font-size:11px;font-weight:700;padding:2px 6px;border-radius:6px;margin-left:auto}',
'.check-indicator.ok{background:#4ade80;color:#000}',
'.check-indicator.fail{background:#dc2626;color:#fff}',
'.check-indicator.warn{background:#f59e0b;color:#000}',
'</style>',
'</head>',
'<body>',
'<div id="app">',
'  <div id="loading" class="screen active"><div class="loading"><div class="spinner"></div><p>Loading queue...</p></div></div>',
'  <div id="queue" class="screen">',
'    <div class="topbar"><h1>Review Queue</h1><span class="badge" id="qCount">0</span></div>',
'    <div class="grid" id="qGrid"></div>',
'  </div>',
'  <div id="review" class="screen">',
'    <div class="topbar">',
'      <button class="btn-ghost" onclick="showQueue()">Back</button>',
'      <h1 id="rTitle">Item</h1>',
'      <div style="width:60px"></div>',
'    </div>',
'    <div class="hero">',
'      <img id="rImage" src="" alt="">',
'      <div class="hero-meta" id="rMeta"></div>',
'    </div>',
'    <div class="section">',
'      <h2>Products <span class="badge" id="pCount">0</span></h2>',
'      <div id="pList"></div>',
'    </div>',
'    <div class="actions-bar">',
'      <button class="btn-danger" onclick="deleteItem()">Delete Item</button>',
'      <button class="btn-primary" onclick="commitItem()">Commit Item</button>',
'    </div>',
'  </div>',
'  <div id="editor" class="modal">',
'    <div class="modal-header">',
'      <button class="btn-ghost" onclick="closeEditor()">Cancel</button>',
'      <h2>Edit Product</h2>',
'      <button class="btn-primary" onclick="saveProduct()">Save</button>',
'    </div>',
'    <div class="modal-body" id="eBody"></div>',
'  </div>',
'</div>',
'<div class="toast" id="toast"></div>',
'<script>',
'const state={queue:[],current:null,editingIdx:null};',
'function showScreen(id){document.querySelectorAll(".screen,.modal").forEach(function(el){el.classList.remove("active");});document.getElementById(id).classList.add("active");}',
'function toast(msg){const t=document.getElementById("toast");t.textContent=msg;t.classList.add("show");setTimeout(function(){t.classList.remove("show");},2500);}',
'function escapeHtml(str){if(str==null)return"";return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}',
'function getImageUrl(u){if(!u)return"";if(typeof u==="object"&&u!==null&&u.url)return String(u.url);return String(u);}',
'function formatPrice(p){if(!p)return"TBD";if(typeof p==="string")return p;if(typeof p==="object"&&p!==null){if(p.current)return p.current+(p.currency?" "+p.currency:"");return JSON.stringify(p);}return String(p);}',
'function formatAvail(a){if(!a)return"Unknown";return String(a);}',

'async function loadQueue(){',
'  try{const r=await fetch("/api/queue");state.queue=await r.json();}',
'  catch(e){state.queue=[];toast("Failed to load queue");}',
'  document.getElementById("loading").classList.remove("active");',
'  showScreen("queue");renderQueue();',
'}',

'function renderQueue(){',
'  const grid=document.getElementById("qGrid");',
'  if(!state.queue.length){grid.innerHTML=\'<div class="empty" style="grid-column:1/-1">Nothing to review</div>\';document.getElementById("qCount").textContent="0";return;}',
'  grid.innerHTML=state.queue.map(function(item,i){',
'    return \'<div class="q-card" onclick="openItem(\'+i+\')">\'+',
'      \'<div class="q-thumb"><img src="\'+escapeHtml(item.thumb)+\'" loading="lazy" alt=""><span class="q-badge \'+item.status+\'">\'+item.status+\'</span></div>\'+',
'      \'<div class="q-info"><div class="q-id">\'+escapeHtml(item.postId)+\'</div><div class="q-type">\'+(item.type==="frame"?"Frame":"Image")+" #"+(item.frameIdx!==null?item.frameIdx:item.fileIdx)+\'</div></div>\'+',
'    \'</div>\';',
'  }).join("");',
'  document.getElementById("qCount").textContent=state.queue.length;',
'}',

'async function openItem(queueIdx){',
'  const item=state.queue[queueIdx];',
'  try{',
'    let url="/api/item/"+item._id+"/"+item.fileIdx;',
'    if(item.frameIdx!==null)url+="/"+item.frameIdx;',
'    const r=await fetch(url);',
'    if(!r.ok)throw new Error("Fetch failed");',
'    state.current=await r.json();',
'    state.current._queueIdx=queueIdx;',
'  }catch(e){toast("Failed to load item");return;}',
'  renderItem();showScreen("review");',
'}',

'function renderItem(){',
'  const item=state.current;',
'  document.getElementById("rTitle").textContent=item.postId;',
'  document.getElementById("rImage").src=item.url;',
'  const prods=item.response&&item.response.products?item.response.products:[];',
'  const pending=prods.filter(function(p){return p.reviewStatus!=="completed"&&p.reviewStatus!=="rejected";}).length;',
'  document.getElementById("rMeta").innerHTML=\'<span class="badge">\'+(item.type==="frame"?"Frame":"Image")+\'</span><span class="badge">\'+prods.length+\' products</span>\'+(pending?\'<span class="badge pending">\'+pending+\' pending</span>\':"");',
'  document.getElementById("pCount").textContent=prods.length;',
'  const list=document.getElementById("pList");',
'  if(!prods.length){list.innerHTML=\'<div class="empty">No products identified by AI</div>\';return;}',
'  list.innerHTML=prods.map(function(p,i){',
'    const color=p.reviewStatus==="completed"?"#4ade80":p.reviewStatus==="rejected"?"#dc2626":"#f59e0b";',
'    const imgUrl=getImageUrl((p.selectedImages&&p.selectedImages[0])||(p.sources&&p.sources[0]&&p.sources[0].images&&p.sources[0].images[0]));',
'    return \'<div class="p-card" onclick="openProduct(\'+i+\')">\'+',
'      \'<div class="p-img">\'+(imgUrl?\'<img src="\'+escapeHtml(imgUrl)+\'" alt="">\':\'<div class="no-img">No img</div>\')+\'</div>\'+',
'      \'<div class="p-info"><div class="p-title">\'+escapeHtml(p.title||"Untitled")+\'</div><div class="p-brand">\'+escapeHtml(p.brand||"Unknown")+" &middot; "+escapeHtml(formatPrice(p.price))+\'</div><div class="p-status"><span class="dot" style="background:\'+color+\'"></span>\'+(p.reviewStatus||"pending")+\'</div></div>\'+',
'    \'</div>\';',
'  }).join("");',
'}',

'function getAllImages(p){',
'  const sourceUrls=new Set();',
'  const allUrls=new Set();',
'  (p.sources||[]).forEach(function(s){',
'    (s.images||[]).forEach(function(u){',
'      const url=getImageUrl(u);',
'      if(url){sourceUrls.add(url);allUrls.add(url);}',
'    });',
'  });',
'  (p.customImages||[]).forEach(function(u){if(u)allUrls.add(String(u));});',
'  (p.selectedImages||[]).forEach(function(u){if(u)allUrls.add(String(u));});',
'  return{urls:Array.from(allUrls),sourceUrls:sourceUrls};',
'}',

'function openProduct(idx){',
'  state.editingIdx=idx;',
'  const p=state.current.response.products[idx];',
'  const allImages=getAllImages(p);',
'  const selectedSet=new Set((p.selectedImages||[]).map(String));',
'  let html=\'<div class="card"><h3>Basic Info</h3>\'+',
'    \'<div class="field"><label>Title</label><input id="eTitle" value="\'+escapeHtml(p.title||"")+\'"></div>\'+',
'    \'<div class="field"><label>Brand</label><input id="eBrand" value="\'+escapeHtml(p.brand||"")+\'"></div>\'+',
'    \'<div class="field"><label>Category</label><input id="eCategory" value="\'+escapeHtml(p.category||"")+\'"></div>\'+',
'    \'<div class="field-row"><div class="field"><label>Price</label><input id="ePrice" value="\'+escapeHtml((p.price&&p.price.current)?p.price.current:"")+\'"></div><div class="field" style="width:100px"><label>Currency</label><select id="eCurrency">\'+',
'      \'<option \'+(p.price&&p.price.currency==="USD"?"selected":"")+\'>USD</option>\'+',
'      \'<option \'+(p.price&&p.price.currency==="EUR"?"selected":"")+\'>EUR</option>\'+',
'      \'<option \'+(p.price&&p.price.currency==="GBP"?"selected":"")+\'>GBP</option>\'+',
'      \'<option \'+(p.price&&p.price.currency==="CAD"?"selected":"")+\'>CAD</option>\'+',
'      \'<option \'+(p.price&&p.price.currency==="AUD"?"selected":"")+\'>AUD</option>\'+',
'      \'<option \'+(p.price&&p.price.currency==="JPY"?"selected":"")+\'>JPY</option>\'+',
'    \'</select></div></div>\'+',
'    \'<div class="field"><label>Base Price</label><input id="eBasePrice" value="\'+escapeHtml(p.basePrice||"")+\'"></div>\'+',
'    \'<div class="field"><label>Availability</label><select id="eAvail"><option \'+(p.availability==="In stock"?"selected":"")+\'>In stock</option><option \'+(p.availability==="Out of stock"?"selected":"")+\'>Out of stock</option><option \'+(p.availability==="Pre-order"?"selected":"")+\'>Pre-order</option></select></div>\'+',
'    \'<div class="field"><label>Sizes (comma separated)</label><input id="eSizes" value="\'+escapeHtml((p.sizing||[]).join(", "))+\'"></div>\'+',
'    \'<div class="field"><label>Description</label><textarea id="eDesc">\'+escapeHtml(p.description||"")+\'</textarea></div>\'+',
'    \'<div class="field"><label>Sizing Guide</label><textarea id="eSizingGuide">\'+escapeHtml(p.sizingGuide||"")+\'</textarea></div>\'+',
'    \'<div class="field"><label>Shipping & Returns</label><textarea id="eShipping">\'+escapeHtml(p.shippingAndReturns||"")+\'</textarea></div>\'+',
'  \'</div>\'+',
'  \'<div class="card"><h3>Images &mdash; Tap to select</h3><div class="img-grid" id="eImgGrid"></div><button class="btn-ghost" onclick="addImage()" style="width:100%;margin-top:8px">+ Add Image URL</button></div>\'+',
'  \'<div class="card"><h3>Sources</h3><div id="eSrcList"></div><button class="btn-ghost" onclick="addSource()" style="width:100%;margin-top:8px">+ Add Source</button></div>\'+',
'  \'<div class="card"><h3>Actions</h3><div style="display:flex;gap:10px"><button class="btn-danger" onclick="rejectProduct()" style="flex:1">Reject Product</button><button class="btn-primary" onclick="saveProduct()" style="flex:1">Save Product</button></div></div>\';',
'  document.getElementById("eBody").innerHTML=html;',
'  renderImgGrid(allImages.urls,selectedSet,allImages.sourceUrls);',
'  renderSrcList(p);',
'  showScreen("editor");',
'}',

'function renderImgGrid(urls,selectedSet,sourceUrls){',
'  const grid=document.getElementById("eImgGrid");',
'  if(!urls.length){grid.innerHTML=\'<div class="empty" style="grid-column:1/-1">No images available</div>\';return;}',
'  grid.innerHTML=urls.map(function(url){',
'    const isOn=selectedSet.has(url);',
'    const isFromSource=sourceUrls.has(url);',
'    return \'<div class="img-cell \'+(isOn?"on":"")+\'" data-source="\'+isFromSource+\'" onclick="this.classList.toggle(\\\'on\\\')"><img src="\'+escapeHtml(url)+\'" loading="lazy" alt=""><div class="check">&#10003;</div></div>\';',
'  }).join("");',
'}',

'function addImage(){',
'  const url=prompt("Paste image URL:");if(!url)return;',
'  const grid=document.getElementById("eImgGrid");',
'  const empty=grid.querySelector(".empty");if(empty)empty.remove();',
'  const div=document.createElement("div");div.className="img-cell on";div.dataset.source="false";',
'  div.innerHTML=\'<img src="\'+escapeHtml(url)+\'" loading="lazy" alt=""><div class="check">&#10003;</div>\';',
'  div.onclick=function(){this.classList.toggle("on");};',
'  grid.appendChild(div);',
'}',

'function renderSrcList(p){',
'  const list=document.getElementById("eSrcList");',
'  const all=[];',
'  (p.sources||[]).forEach(function(s,i){all.push({store:s.store,url:s.url,price:s.price,availability:s.availability,idx:i,type:"ai",images:s.images});});',
'  (p.customSources||[]).forEach(function(s,i){all.push({store:s.store,url:s.url,price:s.price,availability:s.availability,idx:i,type:"custom",images:s.images});});',
'  if(!all.length){list.innerHTML=\'<div class="empty">No sources</div>\';return;}',
'  list.innerHTML=all.map(function(s){',
'    const imagesAttr=s.images&&s.images.length?encodeURIComponent(JSON.stringify(s.images)):"";',
'    return \'<div class="src-row" data-type="\'+s.type+\'" data-idx="\'+s.idx+\'" data-images="\'+imagesAttr+\'">\'+',
'      \'<div class="info"><div class="name">\'+escapeHtml(s.store||"Unknown")+(s.type==="ai"?" <span style=\\\'opacity:.5\\\'>AI</span>":" <span style=\\\'opacity:.5\\\'>Custom</span>")+\'</div><div class="url">\'+escapeHtml(s.url)+\'</div></div>\'+',
'      \'<div class="actions"><button class="btn-secondary" onclick="window.open(\\\'\'+escapeHtml(s.url)+\'\\\',\\\'_blank\\\')">Visit</button><button class="btn-ghost" onclick="validateSource(this)">Check</button><button class="btn-danger" onclick="removeSource(this)">Remove</button></div>\'+',
'    \'</div>\';',
'  }).join("");',
'}',

'function removeSource(btn){btn.closest(".src-row").remove();}',
'function addSource(){',
'  const url=prompt("Paste product source URL:");if(!url)return;',
'  const store=prompt("Store name (optional):")||"Custom";',
'  const list=document.getElementById("eSrcList");',
'  const empty=list.querySelector(".empty");if(empty)empty.remove();',
'  const div=document.createElement("div");div.className="src-row";div.dataset.type="custom";div.dataset.idx="new";div.dataset.images="";',
'  div.innerHTML=\'<div class="info"><div class="name">\'+escapeHtml(store)+\' <span style="opacity:.5">Custom</span></div><div class="url">\'+escapeHtml(url)+\'</div></div><div class="actions"><button class="btn-secondary" onclick="window.open(\\\'\'+escapeHtml(url)+\'\\\',\\\'_blank\\\')">Visit</button><button class="btn-ghost" onclick="validateSource(this)">Check</button><button class="btn-danger" onclick="removeSource(this)">Remove</button></div>\';',
'  list.appendChild(div);',
'}',

'async function validateSource(btn){',
'  const row=btn.closest(".src-row");',
'  const url=row.querySelector(".url").textContent;',
'  btn.textContent="...";btn.disabled=true;',
'  try{',
'    const r=await fetch("/api/validate-source",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({url:url})});',
'    const data=await r.json();',
'    if(data.ok){btn.textContent="OK";btn.style.background="#4ade80";btn.style.color="#000";}',
'    else{btn.textContent="FAIL";btn.style.background="#dc2626";}',
'  }catch(e){btn.textContent="ERR";btn.style.background="#f59e0b";}',
'  setTimeout(function(){btn.textContent="Check";btn.disabled=false;btn.style.background="";btn.style.color="";},2000);',
'}',

'async function saveProduct(){',
'  const idx=state.editingIdx;',
'  const p=state.current.response.products[idx];',
'  p.title=document.getElementById("eTitle").value;',
'  p.brand=document.getElementById("eBrand").value;',
'  p.category=document.getElementById("eCategory").value;',
'  p.price={current:document.getElementById("ePrice").value,currency:document.getElementById("eCurrency").value};',
'  p.basePrice=document.getElementById("eBasePrice").value;',
'  p.availability=document.getElementById("eAvail").value;',
'  const sizesRaw=document.getElementById("eSizes").value;',
'  p.sizing=sizesRaw.split(",").map(function(s){return s.trim();}).filter(Boolean);',
'  p.sizes=p.sizing;',
'  p.description=document.getElementById("eDesc").value;',
'  p.sizingGuide=document.getElementById("eSizingGuide").value;',
'  p.shippingAndReturns=document.getElementById("eShipping").value;',
'  const cells=document.querySelectorAll("#eImgGrid .img-cell");',
'  p.selectedImages=[];p.customImages=[];',
'  cells.forEach(function(c){',
'    const img=c.querySelector("img").src;',
'    if(c.classList.contains("on")){',
'      p.selectedImages.push(img);',
'      if(c.dataset.source!=="true")p.customImages.push(img);',
'    }',
'  });',
'  const srcRows=document.querySelectorAll("#eSrcList .src-row");',
'  p.sources=[];p.customSources=[];',
'  srcRows.forEach(function(row){',
'    const url=row.querySelector(".url").textContent;',
'    const name=row.querySelector(".name").childNodes[0].textContent.trim();',
'    const imagesAttr=row.getAttribute("data-images");',
'    const images=imagesAttr?JSON.parse(decodeURIComponent(imagesAttr)):[{url:url,width:0,height:0,alt:"",score:0,similarity:0,weighted_score:0}];',
'    const obj={store:name,url:url,price:null,availability:null,images:images};',
'    if(row.dataset.type==="ai")p.sources.push(obj);else p.customSources.push(obj);',
'  });',
'  p.reviewStatus="completed";',
'  p.reviewedAt=new Date().toISOString();',
'  try{',
'    const body={docId:state.current._id,fileIdx:state.current.fileIdx,frameIdx:state.current.frameIdx,prodIdx:idx,product:p};',
'    const r=await fetch("/api/product",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});',
'    if(!r.ok)throw new Error("Save failed");',
'    toast("Saved");renderItem();closeEditor();',
'  }catch(e){toast("Save failed: "+e.message);}',
'}',

'function rejectProduct(){',
'  const idx=state.editingIdx;',
'  const p=state.current.response.products[idx];',
'  p.reviewStatus="rejected";p.selectedImages=[];p.customImages=[];p.customSources=[];',
'  saveProduct();',
'}',

'function closeEditor(){showScreen("review");}',

'async function commitItem(){',
'  const prods=state.current.response&&state.current.response.products?state.current.response.products:[];',
'  const pending=prods.filter(function(p){return p.reviewStatus!=="completed"&&p.reviewStatus!=="rejected";});',
'  if(pending.length){if(!confirm(pending.length+" product(s) still pending. Commit anyway?"))return;}',
'  try{',
'    const body={docId:state.current._id,fileIdx:state.current.fileIdx,frameIdx:state.current.frameIdx};',
'    const r=await fetch("/api/commit",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});',
'    if(!r.ok)throw new Error("Commit failed");',
'    toast("Committed");state.queue.splice(state.current._queueIdx,1);showQueue();renderQueue();',
'  }catch(e){toast("Commit failed: "+e.message);}',
'}',

'async function deleteItem(){',
'  if(!confirm("Delete this item? It will be marked as discarded."))return;',
'  try{',
'    const body={docId:state.current._id,fileIdx:state.current.fileIdx,frameIdx:state.current.frameIdx};',
'    const r=await fetch("/api/delete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});',
'    if(!r.ok)throw new Error("Delete failed");',
'    toast("Deleted");state.queue.splice(state.current._queueIdx,1);showQueue();renderQueue();',
'  }catch(e){toast("Delete failed: "+e.message);}',
'}',

'function showQueue(){showScreen("queue");}',
'loadQueue();',
'</script>',
'</body>',
'</html>'
].join('\n');

// ═══════════════════════════════════════════════════════════════════════════════
//  MONGODB HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

function normalizeResponse(item) {
    let resp = item.response;
    if (typeof resp === 'string') {
        try { resp = JSON.parse(resp); } catch { resp = null; }
    }
    if (!resp || typeof resp !== 'object') resp = { products: [] };
    if (!Array.isArray(resp.products)) resp.products = [];

    resp.products = resp.products.map(p => ({
        ...p,
        reviewStatus: p.reviewStatus || 'pending',
        selectedImages: p.selectedImages || [],
        customImages: p.customImages || [],
        customSources: p.customSources || [],
        sources: (p.sources || []).map(s => ({
            ...s,
            images: s.images || [],
            price: s.price || null,
            availability: s.availability || null
        })),
        images: p.images || [],
        price: p.price || { current: '', original: null, currency: 'USD' },
        sizing: Array.isArray(p.sizing) ? p.sizing : (p.sizes ? String(p.sizes).split(',').map(s => s.trim()).filter(Boolean) : []),
        sizes: p.sizes || p.sizing || []
    }));

    return resp;
}

function getItemStatus(item) {
    const resp = normalizeResponse(item);
    const products = resp.products;
    if (!products.length) return 'pending';
    const allDone = products.every(p => p.reviewStatus === 'completed' || p.reviewStatus === 'rejected');
    const someDone = products.some(p => p.reviewStatus === 'completed' || p.reviewStatus === 'rejected');
    if (allDone) return 'done';
    if (someDone) return 'partial';
    return 'pending';
}

async function buildQueue(collection) {
    const posts = await collection.find({
        discarded: { $ne: true },
        $or: [
            {
                file_urls: {
                    $elemMatch: {
                        type: 'image',
                        reviewed: true,
                        humanReviewed: { $ne: true },
                        discarded: { $ne: true }
                    }
                }
            },
            {
                'file_urls.frames': {
                    $elemMatch: {
                        type: 'image',
                        reviewed: true,
                        humanReviewed: { $ne: true },
                        discarded: { $ne: true }
                    }
                }
            }
        ]
    }).project({ post_id: 1, file_urls: 1 }).limit(100).toArray();

    const queue = [];
    for (const post of posts) {
        if (!Array.isArray(post.file_urls)) continue;
        for (let i = 0; i < post.file_urls.length; i++) {
            const f = post.file_urls[i];
            if (!f || f.discarded) continue;

            if (f.type === 'image') {
                if (f.reviewed && !f.humanReviewed) {
                    queue.push({
                        _id: post._id.toString(),
                        postId: post.post_id,
                        fileIdx: i,
                        frameIdx: null,
                        thumb: f.url,
                        status: getItemStatus(f),
                        type: 'image'
                    });
                }
            } else if (f.type === 'video' && Array.isArray(f.frames)) {
                for (let j = 0; j < f.frames.length; j++) {
                    const frame = f.frames[j];
                    if (frame && frame.reviewed && !frame.humanReviewed && !frame.discarded) {
                        queue.push({
                            _id: post._id.toString(),
                            postId: post.post_id,
                            fileIdx: i,
                            frameIdx: j,
                            thumb: frame.url,
                            status: getItemStatus(frame),
                            type: 'frame'
                        });
                    }
                }
            }
        }
    }
    return queue;
}

async function checkDone(collection) {
    const remaining = await collection.countDocuments({
        discarded: { $ne: true },
        $or: [
            {
                file_urls: {
                    $elemMatch: {
                        type: 'image',
                        reviewed: true,
                        humanReviewed: { $ne: true },
                        discarded: { $ne: true }
                    }
                }
            },
            {
                'file_urls.frames': {
                    $elemMatch: {
                        type: 'image',
                        reviewed: true,
                        humanReviewed: { $ne: true },
                        discarded: { $ne: true }
                    }
                }
            }
        ]
    });
    log('info', `Queue: ${remaining} item(s) remaining`);
    return remaining;
}

async function validateSourceUrl(url) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        const resp = await fetch(url, {
            redirect: 'follow',
            signal: controller.signal,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
            }
        });
        clearTimeout(timeout);
        const text = await resp.text();
        const titleMatch = text.match(/<title[^>]*>([^<]*)<\/title>/i);
        return {
            ok: resp.ok,
            status: resp.status,
            url,
            title: titleMatch ? titleMatch[1].trim().slice(0, 100) : null
        };
    } catch (err) {
        return { ok: false, error: err.message, url };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  NGROK
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
        let buffer = '';
        let resolved = false;

        const onData = (chunk) => {
            if (resolved) return;
            buffer += chunk.toString();
            const match = buffer.match(/https:\/\/[a-zA-Z0-9-]+\.ngrok(?:-free)?\.(?:app|io)/);
            if (match) { url = match[0]; resolved = true; }
        };

        ngrok.stdout.on('data', onData);
        ngrok.stderr.on('data', onData);

        await new Promise(r => setTimeout(r, 12000));

        if (url) {
            log('info', `ngrok tunnel: ${url}`);
            return { url, process: ngrok };
        }

        log('warn', 'ngrok URL not found in logs, trying API fallback...');
        try {
            const apiRes = await fetch('http://127.0.0.1:4040/api/tunnels');
            const apiData = await apiRes.json();
            const tunnel = apiData.tunnels?.find(t => t.public_url?.startsWith('https'));
            if (tunnel) {
                url = tunnel.public_url;
                log('info', `ngrok tunnel (via API): ${url}`);
                return { url, process: ngrok };
            }
        } catch (e) {
            log('warn', 'ngrok API fallback failed:', e.message);
        }

        log('warn', 'ngrok started but no URL captured — check your NGROK_AUTHTOKEN');
        ngrok.kill();
        return null;
    } catch (err) {
        log('error', 'ngrok failed:', err.message);
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SERVER
// ═══════════════════════════════════════════════════════════════════════════════
async function main() {
    log('info', '═══════════════════════════════════════════════════════════════');
    log('info', '  REVIEW SERVER — Production Human Review');
    log('info', '═══════════════════════════════════════════════════════════════');

    if (!CONFIG.mongodb.uri) {
        log('error', 'ORCH_MONGODB_URI is required');
        process.exit(1);
    }

    log('info', 'Connecting to MongoDB...');
    const client = new MongoClient(CONFIG.mongodb.uri, { serverSelectionTimeoutMS: 15000 });
    await client.connect();
    const db = client.db(CONFIG.mongodb.db);
    const collection = db.collection(CONFIG.mongodb.collection);
    log('info', `Connected: ${CONFIG.mongodb.db}.${CONFIG.mongodb.collection}`);

    let serverResolve;
    const donePromise = new Promise(r => serverResolve = r);
    let ngrokProc = null;

    const server = http.createServer(async (req, res) => {
        const parsed = new URL(req.url, `http://localhost:${CONFIG.port}`);

        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

        // ── UI ──
        if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(REVIEW_UI_HTML);
            return;
        }

        // ── GET /api/queue ──
        if (parsed.pathname === '/api/queue' && req.method === 'GET') {
            try {
                const q = await buildQueue(collection);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(q));
            } catch (e) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        // ── GET /api/item/:docId/:fileIdx/:frameIdx? ──
        const itemMatch = parsed.pathname.match(/^\/api\/item\/([^\/]+)\/(\d+)(?:\/(\d+))?$/);
        if (itemMatch && req.method === 'GET') {
            try {
                const docId = itemMatch[1];
                const fileIdx = parseInt(itemMatch[2], 10);
                const frameIdx = itemMatch[3] !== undefined ? parseInt(itemMatch[3], 10) : null;

                const post = await collection.findOne(
                    { _id: new ObjectId(docId) },
                    { projection: { post_id: 1, file_urls: 1 } }
                );
                if (!post || !post.file_urls || !post.file_urls[fileIdx]) {
                    res.writeHead(404);
                    res.end(JSON.stringify({ error: 'Not found' }));
                    return;
                }

                const file = post.file_urls[fileIdx];
                let item;
                if (frameIdx !== null) {
                    if (!file.frames || !file.frames[frameIdx]) {
                        res.writeHead(404);
                        res.end(JSON.stringify({ error: 'Frame not found' }));
                        return;
                    }
                    item = file.frames[frameIdx];
                    item.type = 'frame';
                    item.parentUrl = file.url;
                } else {
                    item = file;
                    item.type = 'image';
                }

                const response = normalizeResponse(item);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    _id: post._id.toString(),
                    postId: post.post_id,
                    fileIdx,
                    frameIdx,
                    url: item.url,
                    type: item.type,
                    response
                }));
            } catch (e) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        // ── POST /api/product ──
        if (parsed.pathname === '/api/product' && req.method === 'POST') {
            let body = '';
            req.on('data', d => body += d);
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body);
                    const { docId, fileIdx, frameIdx, prodIdx, product } = data;

                    const basePath = frameIdx !== null && frameIdx !== undefined
                        ? `file_urls.${fileIdx}.frames.${frameIdx}.response.products.${prodIdx}`
                        : `file_urls.${fileIdx}.response.products.${prodIdx}`;

                    await collection.updateOne(
                        { _id: new ObjectId(docId) },
                        { $set: {
                            [`${basePath}.title`]: product.title,
                            [`${basePath}.brand`]: product.brand,
                            [`${basePath}.category`]: product.category,
                            [`${basePath}.description`]: product.description,
                            [`${basePath}.price`]: product.price,
                            [`${basePath}.basePrice`]: product.basePrice,
                            [`${basePath}.availability`]: product.availability,
                            [`${basePath}.sizing`]: product.sizing,
                            [`${basePath}.sizes`]: product.sizes,
                            [`${basePath}.sizingGuide`]: product.sizingGuide,
                            [`${basePath}.shippingAndReturns`]: product.shippingAndReturns,
                            [`${basePath}.sources`]: product.sources,
                            [`${basePath}.customSources`]: product.customSources,
                            [`${basePath}.selectedImages`]: product.selectedImages,
                            [`${basePath}.customImages`]: product.customImages,
                            [`${basePath}.reviewStatus`]: product.reviewStatus,
                            [`${basePath}.reviewedAt`]: new Date()
                        }}
                    );

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                } catch (e) {
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }

        // ── POST /api/commit ──
        if (parsed.pathname === '/api/commit' && req.method === 'POST') {
            let body = '';
            req.on('data', d => body += d);
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body);
                    const { docId, fileIdx, frameIdx } = data;

                    const path = frameIdx !== null && frameIdx !== undefined
                        ? `file_urls.${fileIdx}.frames.${frameIdx}`
                        : `file_urls.${fileIdx}`;

                    await collection.updateOne(
                        { _id: new ObjectId(docId) },
                        { $set: { [`${path}.humanReviewed`]: true, [`${path}.humanReviewedAt`]: new Date() } }
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

        // ── POST /api/delete ──
        if (parsed.pathname === '/api/delete' && req.method === 'POST') {
            let body = '';
            req.on('data', d => body += d);
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body);
                    const { docId, fileIdx, frameIdx } = data;

                    const path = frameIdx !== null && frameIdx !== undefined
                        ? `file_urls.${fileIdx}.frames.${frameIdx}`
                        : `file_urls.${fileIdx}`;

                    await collection.updateOne(
                        { _id: new ObjectId(docId) },
                        { $set: { [`${path}.discarded`]: true } }
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

        // ── POST /api/validate-source ──
        if (parsed.pathname === '/api/validate-source' && req.method === 'POST') {
            let body = '';
            req.on('data', d => body += d);
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body);
                    const result = await validateSourceUrl(data.url);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result));
                } catch (e) {
                    res.writeHead(500);
                    res.end(JSON.stringify({ ok: false, error: e.message }));
                }
            });
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
