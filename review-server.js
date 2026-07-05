/**
 * review-server.js
 *
 * Production human review server for the UGC dropship pipeline.
 * Grouped by post, virtualized rendering, lazy-loaded images, mobile-first.
 * 
 * Auto-flattens nested AI sources into independent 1-to-1 products for dropshipping.
 *
 * Env: ORCH_MONGODB_URI, ORCH_MONGODB_DB, ORCH_MONGODB_COLLECTION
 *      REVIEW_PORT (default 3456)
 */

import http from 'http';
import { MongoClient, ObjectId } from 'mongodb';

/* -------------------------------------------------------------------------- */
/* CONFIG                                                                     */
/* -------------------------------------------------------------------------- */
const CONFIG = {
    mongodb: {
        uri:        process.env.ORCH_MONGODB_URI        || '',
        db:         process.env.ORCH_MONGODB_DB         || 'ugc-dropship',
        collection: process.env.ORCH_MONGODB_COLLECTION || 'scraped-posts',
    },
    port: parseInt(process.env.REVIEW_PORT || '3456', 10),
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

/* -------------------------------------------------------------------------- */
/* HTML UI (Brutalist / Minimal Technical Aesthetic)                          */
/* -------------------------------------------------------------------------- */
const REVIEW_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#000000">
<title>DropShip Review</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500&family=JetBrains+Mono:wght@400;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#000000;
  --surface:#000000;
  --surface-2:#111111;
  --border:#333333;
  --border-focus:#ffffff;
  --text:#ffffff;
  --text-2:#888888;
  --accent:#ffffff;
}
body {
  font-family:'Inter', sans-serif;
  background:var(--bg);
  color:var(--text);
  line-height:1.4;
  min-height:100dvh;
  overflow-x:hidden;
  -webkit-font-smoothing:antialiased;
}

/* Typography Overrides */
h1, h2, h3, .badge, button, label, .item-type, .p-brand, .post-id, .src-row .name, .empty {
  font-family:'JetBrains Mono', monospace;
  text-transform:uppercase;
  font-weight:normal;
  letter-spacing:-0.02em;
}

/* Controls */
button {
  cursor:pointer;
  border:1px solid var(--border);
  border-radius:0;
  padding:12px 16px;
  font-size:13px;
  background:var(--bg);
  color:var(--text);
  min-height:48px;
  transition:background 0s, color 0s;
}
button:active { background:var(--text); color:var(--bg); border-color:var(--text); }
button:disabled { opacity:0.3; cursor:not-allowed; border-color:var(--border); }

.btn-primary { background:var(--text); color:var(--bg); border-color:var(--text); font-weight:700; }
.btn-danger { background:var(--bg); color:var(--text); border:1px dashed #666; }
.btn-danger:active { background:var(--text); color:var(--bg); border:1px solid var(--text); }
.btn-ghost { border-color:transparent; }

input, select, textarea {
  background:var(--bg);
  border:1px solid var(--border);
  color:var(--text);
  padding:14px;
  border-radius:0;
  font-size:14px;
  font-family:'Inter', sans-serif;
  width:100%;
  -webkit-appearance:none;
}
input:focus, select:focus, textarea:focus {
  outline:none;
  border-color:var(--border-focus);
}
textarea { resize:vertical; min-height:100px; }
select {
  background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%23fff'%3E%3Cpath d='M6 8L1 3h10z'/%3E%3C/svg%3E");
  background-repeat:no-repeat;
  background-position:right 14px center;
  padding-right:32px;
}

img { max-width:100%; display:block; }
a { color:var(--text); text-decoration:underline; text-underline-offset:4px; }
a:active { background:var(--text); color:var(--bg); text-decoration:none; }

/* Layout Screens */
.screen { display:none; min-height:100dvh; padding-bottom:90px; }
.screen.active { display:block; }

.topbar {
  position:sticky; top:0; z-index:50;
  background:var(--bg);
  border-bottom:1px solid var(--border);
  padding:12px 16px;
  display:flex; align-items:center; gap:16px;
}
.topbar h1 { font-size:14px; font-weight:700; flex:1; }

.badge {
  font-size:10px;
  padding:4px 8px;
  border:1px solid var(--border);
  color:var(--text-2);
  background:var(--bg);
}
.badge.pending { color:var(--text); border-color:var(--text); }
.badge.partial { border-style:dashed; }
.badge.done { background:var(--text); color:var(--bg); }

/* Lists & Groups */
.post-group { border-bottom:1px solid var(--border); margin:0; }
.post-header {
  display:flex; align-items:center; gap:12px;
  padding:16px; cursor:pointer; user-select:none;
}
.post-header:active { background:var(--surface-2); }
.post-thumb {
  width:48px; height:48px;
  background:var(--surface-2); flex-shrink:0; border:1px solid var(--border);
}
.post-thumb img { width:100%; height:100%; object-fit:cover; filter:grayscale(100%); transition:filter 0.2s; }
.post-group.open .post-thumb img { filter:grayscale(0%); }
.post-info { flex:1; min-width:0; }
.post-id { font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.post-meta { font-size:12px; color:var(--text-2); margin-top:2px; }
.post-chevron { width:20px; height:20px; color:var(--text); transition:transform 0.2s; }
.post-group.open .post-chevron { transform:rotate(180deg); }

.post-items { display:none; padding:0 16px 16px; border-top:1px dashed var(--border); }
.post-group.open .post-items { display:block; margin-top:0; padding-top:16px; background:var(--surface-2); }

.item-row {
  display:flex; align-items:center; gap:12px;
  padding:12px 0; border-bottom:1px solid var(--border); cursor:pointer;
}
.item-row:last-child { border-bottom:none; padding-bottom:0; }
.item-thumb { width:40px; height:56px; background:var(--bg); border:1px solid var(--border); flex-shrink:0; }
.item-thumb img { width:100%; height:100%; object-fit:cover; }
.item-info { flex:1; min-width:0; }
.item-type { font-size:12px; }
.item-status { font-size:10px; color:var(--text-2); margin-top:4px; text-transform:uppercase; font-family:'JetBrains Mono', monospace; }

/* Hero (Review Main Image) */
.hero { width:100%; border-bottom:1px solid var(--border); }
.hero img { width:100%; max-height:65vh; object-fit:contain; background:var(--surface-2); }
.hero-meta { padding:12px 16px; display:flex; gap:8px; flex-wrap:wrap; background:var(--bg); border-top:1px solid var(--border); }

/* Section & Cards */
.section { padding:0; padding-bottom:100px; }
.section h2 { font-size:14px; padding:16px; border-bottom:1px solid var(--border); margin:0; display:flex; justify-content:space-between; align-items:center; }

.p-card {
  padding:16px; display:flex; gap:16px; cursor:pointer;
  border-bottom:1px solid var(--border);
}
.p-card:active { background:var(--surface-2); }
.p-img { width:80px; height:106px; background:var(--surface-2); border:1px solid var(--border); flex-shrink:0; }
.p-img img { width:100%; height:100%; object-fit:cover; }
.p-img .no-img { width:100%; height:100%; display:flex; align-items:center; justify-content:center; color:var(--text-2); font-size:10px; text-transform:uppercase; font-family:'JetBrains Mono', monospace; }
.p-info { flex:1; min-width:0; display:flex; flex-direction:column; justify-content:center; }
.p-title { font-size:15px; font-weight:500; margin-bottom:4px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.p-brand { font-size:12px; color:var(--text-2); margin-bottom:8px; }
.p-status { display:flex; align-items:center; gap:8px; font-size:10px; text-transform:uppercase; font-family:'JetBrains Mono', monospace; }

/* Modal / Editor */
.modal { position:fixed; inset:0; z-index:100; background:var(--bg); display:none; flex-direction:column; }
.modal.active { display:flex; }
.modal-header { padding:12px 16px; border-bottom:1px solid var(--border); display:flex; align-items:center; gap:12px; background:var(--bg); }
.modal-header h2 { font-size:14px; flex:1; text-align:center; margin:0; }
.modal-body { flex:1; overflow-y:auto; padding:0; padding-bottom:100px; }

.card { padding:20px 16px; border-bottom:1px solid var(--border); }
.card h3 { font-size:12px; color:var(--text); margin-bottom:16px; border-bottom:1px dashed var(--border); padding-bottom:8px; display:block; }

/* Grid Images */
.img-grid { display:grid; grid-template-columns:repeat(3, 1fr); gap:1px; background:var(--border); border:1px solid var(--border); margin-bottom:16px; }
.img-cell { aspect-ratio:1; background:var(--bg); position:relative; cursor:pointer; }
.img-cell img { width:100%; height:100%; object-fit:cover; opacity:0.4; transition:opacity 0s; filter:grayscale(100%); }
.img-cell.on img { opacity:1; filter:grayscale(0%); }
.img-cell .check { position:absolute; top:4px; right:4px; background:var(--text); color:var(--bg); padding:4px 6px; font-size:10px; font-family:'JetBrains Mono', monospace; display:none; text-transform:uppercase; line-height:1; }
.img-cell.on .check { display:block; }

/* Form fields */
.field { margin-bottom:16px; }
.field label { display:block; font-size:10px; margin-bottom:8px; color:var(--text-2); font-family:'JetBrains Mono', monospace; text-transform:uppercase; letter-spacing:0.05em; }
.field-row { display:flex; gap:12px; }
.field-row .field { flex:1; }

/* Sources */
.src-row { border:1px solid var(--border); padding:12px; margin-bottom:8px; display:flex; align-items:center; gap:12px; }
.src-row .info { flex:1; min-width:0; }
.src-row .name { font-size:12px; margin-bottom:4px; font-weight:700; }
.src-row .url { font-size:10px; color:var(--text-2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-family:'JetBrains Mono', monospace; }
.src-row .actions { display:flex; gap:4px; }
.src-row a, .src-row button { padding:6px 10px; font-size:11px; min-height:0; border:1px solid var(--border); text-decoration:none; }

/* Actions Bar */
.actions-bar { position:fixed; bottom:0; left:0; right:0; padding:16px; background:var(--bg); border-top:1px solid var(--border); display:flex; gap:12px; z-index:50; }
.actions-bar button { flex:1; }

.empty { padding:40px 16px; text-align:center; color:var(--text-2); font-size:12px; }

/* Loading & Utils */
.loading{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100dvh;gap:24px;color:var(--text-2)}
.spinner{width:32px;height:32px;border:1px solid var(--border);border-top-color:var(--text);border-radius:0;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

.toast { position:fixed; top:16px; left:50%; transform:translate(-50%, -100px); background:var(--text); color:var(--bg); padding:12px 20px; font-size:12px; font-family:'JetBrains Mono', monospace; text-transform:uppercase; z-index:200; transition:transform 0.2s; border:1px solid var(--text); }
.toast.show { transform:translate(-50%, 0); }

.lazy-img { opacity:0; transition:opacity 0s; }
.lazy-img.loaded { opacity:1; }
.placeholder { background:var(--surface-2); }
</style>
</head>
<body>
<div id="app">
  <div id="loading" class="screen active">
    <div class="loading"><div class="spinner"></div><p class="empty">Loading queue...</p></div>
  </div>
  <div id="queue" class="screen">
    <div class="topbar"><h1>REVIEW QUEUE</h1><span class="badge" id="qCount">0</span></div>
    <div id="qList"></div>
  </div>
  <div id="review" class="screen">
    <div class="topbar">
      <button class="btn-ghost" onclick="showQueue()" style="padding:10px 12px; min-height:0; border:1px solid var(--border);">BACK</button>
      <h1 id="rTitle" style="text-align:center;">ITEM</h1>
      <div style="width:60px"></div>
    </div>
    <div class="hero">
      <img id="rImage" src="" alt="" loading="lazy">
      <div class="hero-meta" id="rMeta"></div>
    </div>
    <div class="section">
      <h2>PRODUCTS <span class="badge" id="pCount">0</span></h2>
      <div id="pList"></div>
    </div>
    <div class="actions-bar">
      <button class="btn-danger" onclick="deleteItem()">[ DELETE ITEM ]</button>
      <button class="btn-primary" onclick="commitItem()">COMMIT ITEM</button>
    </div>
  </div>
  <div id="editor" class="modal">
    <div class="modal-header">
      <button class="btn-ghost" onclick="closeEditor()" style="padding:10px 12px; min-height:0; border:1px solid var(--border);">CANCEL</button>
      <h2>EDIT PRODUCT</h2>
      <button class="btn-primary" onclick="saveProduct()" style="padding:10px 16px; min-height:0;">SAVE</button>
    </div>
    <div class="modal-body" id="eBody"></div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
const state = { queue: [], posts: {}, current: null, editingIdx: null, io: null };

function showScreen(id) {
  document.querySelectorAll(".screen, .modal").forEach(el => el.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2500);
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function getImageUrl(u) {
  if (!u) return "";
  if (typeof u === "object" && u !== null && u.url) return String(u.url);
  return String(u);
}

function formatPrice(p) {
  if (!p) return "TBD";
  if (typeof p === "string") return p;
  if (typeof p === "object" && p !== null) {
    if (p.current) return p.current + (p.currency ? " " + p.currency : "");
    return JSON.stringify(p);
  }
  return String(p);
}

function initLazyImages() {
  if (state.io) return;
  state.io = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const img = entry.target;
        const src = img.dataset.src;
        if (src) {
          img.src = src;
          img.classList.add("loaded");
          img.removeAttribute("data-src");
        }
        state.io.unobserve(img);
      }
    });
  }, { rootMargin: "200px" });
}

function observeImage(img) {
  if (state.io) state.io.observe(img);
}

async function loadQueue() {
  try {
    const r = await fetch("/api/queue");
    const data = await r.json();
    state.posts = data.posts || {};
    state.queue = data.items || [];
  } catch(e) {
    state.posts = {};
    state.queue = [];
    toast("Failed to load queue");
  }
  document.getElementById("loading").classList.remove("active");
  showScreen("queue");
  initLazyImages();
  renderQueue();
}

function renderQueue() {
  const list = document.getElementById("qList");
  const postIds = Object.keys(state.posts);
  
  if (!postIds.length) {
    list.innerHTML = '<div class="empty">Nothing to review</div>';
    document.getElementById("qCount").textContent = "0";
    return;
  }
  
  let totalItems = 0;
  
  list.innerHTML = postIds.map(pid => {
    const post = state.posts[pid];
    const items = post.items || [];
    totalItems += items.length;
    const pending = items.filter(it => it.status === "pending" || it.status === "partial").length;
    const thumb = items[0] ? items[0].thumb : "";
    
    return \`
      <div class="post-group" id="g_\${pid}" onclick="toggleGroup(event, '\${pid}')">
        <div class="post-header">
          <div class="post-thumb"><img data-src="\${escapeHtml(thumb)}" alt="" class="lazy-img placeholder" onload="this.classList.remove('placeholder')"></div>
          <div class="post-info">
            <div class="post-id">\${escapeHtml(pid)}</div>
            <div class="post-meta">\${items.length} ITEM(S) &middot; \${pending} PENDING</div>
          </div>
          <svg class="post-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
        </div>
        <div class="post-items" onclick="event.stopPropagation()">
          \${items.map(it => \`
            <div class="item-row" onclick="openItem('\${it._id}', \${it.fileIdx}, \${it.frameIdx !== null ? it.frameIdx : null})">
              <div class="item-thumb"><img data-src="\${escapeHtml(it.thumb)}" alt="" class="lazy-img placeholder" onload="this.classList.remove('placeholder')"></div>
              <div class="item-info">
                <div class="item-type">\${it.type === "frame" ? "FRAME" : "IMAGE"} #\${it.frameIdx !== null ? it.frameIdx : it.fileIdx}</div>
                <div class="item-status">\${escapeHtml(it.status)}</div>
              </div>
              <span class="badge \${it.status}">\${it.status}</span>
            </div>
          \`).join('')}
        </div>
      </div>
    \`;
  }).join('');
  
  document.getElementById("qCount").textContent = totalItems;
  document.querySelectorAll(".lazy-img[data-src]").forEach(observeImage);
}

function toggleGroup(ev, pid) {
  if (ev.target.closest(".item-row")) return;
  document.getElementById("g_" + pid).classList.toggle("open");
}

async function openItem(_id, fileIdx, frameIdx) {
  try {
    let url = \`/api/item/\${_id}/\${fileIdx}\`;
    if (frameIdx !== null) url += \`/\${frameIdx}\`;
    const r = await fetch(url);
    if (!r.ok) throw new Error("Fetch failed");
    state.current = await r.json();
  } catch(e) {
    toast("Failed to load item");
    return;
  }
  renderItem();
  showScreen("review");
}

function renderItem() {
  const item = state.current;
  document.getElementById("rTitle").textContent = item.postId;
  document.getElementById("rImage").src = item.url;
  
  const prods = item.response && item.response.products ? item.response.products : [];
  const pending = prods.filter(p => p.reviewStatus !== "completed" && p.reviewStatus !== "rejected").length;
  
  document.getElementById("rMeta").innerHTML = \`
    <span class="badge">\${item.type === "frame" ? "FRAME" : "IMAGE"}</span>
    <span class="badge">\${prods.length} PROD</span>
    \${pending ? \`<span class="badge pending">\${pending} PEND</span>\` : ""}
  \`;
  
  document.getElementById("pCount").textContent = prods.length;
  const list = document.getElementById("pList");
  
  if (!prods.length) {
    list.innerHTML = '<div class="empty">No products identified</div>';
    return;
  }
  
  list.innerHTML = prods.map((p, i) => {
    const color = p.reviewStatus === "completed" ? "var(--text)" : p.reviewStatus === "rejected" ? "var(--text-2)" : "var(--border)";
    const imgUrl = getImageUrl((p.selectedImages && p.selectedImages[0]) || (p.images && p.images[0]));
    const storeLabel = p.store ? \`\${escapeHtml(p.store)} &middot; \` : '';

    return \`
      <div class="p-card" onclick="openProduct(\${i})">
        <div class="p-img">\${imgUrl ? \`<img src="\${escapeHtml(imgUrl)}" alt="" loading="lazy">\` : \`<div class="no-img">N/A</div>\`}</div>
        <div class="p-info">
          <div class="p-title">\${escapeHtml(p.title || "UNTITLED")}</div>
          <div class="p-brand">\${storeLabel}\${escapeHtml(formatPrice(p.price))}</div>
          <div class="p-status"><span style="color:\${color}">\u25A0</span>\${p.reviewStatus || "pending"}</div>
        </div>
      </div>
    \`;
  }).join("");
}

function getAllImages(p) {
  const allUrls = new Set();
  
  if (state.current && state.current.url) {
    allUrls.add(state.current.url);
  }

  (p.images || []).forEach(u => {
    const url = getImageUrl(u);
    if (url) allUrls.add(url);
  });
  
  (p.customImages || []).forEach(u => { if (u) allUrls.add(String(u)); });
  (p.selectedImages || []).forEach(u => { if (u) allUrls.add(String(u)); });
  
  return { urls: Array.from(allUrls) };
}

function openProduct(idx) {
  state.editingIdx = idx;
  const p = state.current.response.products[idx];
  const allImages = getAllImages(p);
  const selectedSet = new Set((p.selectedImages || []).map(String));
  
  let html = \`
    <div class="card">
      <h3>AI VIABILITY: \${p.dropshipViability?.score || '?'} / 10</h3>
      <p style="font-size: 13px; color: var(--text-2); line-height: 1.5; font-family:'JetBrains Mono', monospace;">\${escapeHtml(p.dropshipViability?.reasoning || 'N/A')}</p>
    </div>
    <div class="card">
      <h3>BASIC INFO</h3>
      <div class="field"><label>Product Title</label><input id="eTitle" value="\${escapeHtml(p.title || "")}"></div>
      
      <div class="field-row">
        <div class="field"><label>Store / Supplier Name</label><input id="eStore" value="\${escapeHtml(p.store || "")}"></div>
        <div class="field"><label>Brand</label><input id="eBrand" value="\${escapeHtml(p.brand || "")}"></div>
      </div>

      <div class="field-row" style="align-items: flex-end;">
        <div class="field" style="flex: 1;"><label>Supplier URL</label><input id="eUrl" value="\${escapeHtml(p.url || "")}"></div>
        \${p.url ? \`<a href="\${escapeHtml(p.url)}" target="_blank" rel="noopener" class="btn-ghost" style="border:1px solid var(--border); padding:14px; margin-bottom:16px; font-family:'JetBrains Mono', monospace; font-size:12px; text-decoration:none;">VISIT</a>\` : ''}
      </div>

      <div class="field"><label>Category</label><input id="eCategory" value="\${escapeHtml(p.category || "")}"></div>
      <div class="field-row">
        <div class="field"><label>Price</label><input id="ePrice" value="\${escapeHtml((p.price && p.price.current) ? p.price.current : "")}"></div>
        <div class="field" style="width:100px">
          <label>Currency</label>
          <select id="eCurrency">
            <option \${p.price?.currency === "USD" ? "selected" : ""}>USD</option>
            <option \${p.price?.currency === "EUR" ? "selected" : ""}>EUR</option>
            <option \${p.price?.currency === "GBP" ? "selected" : ""}>GBP</option>
            <option \${p.price?.currency === "CAD" ? "selected" : ""}>CAD</option>
            <option \${p.price?.currency === "AUD" ? "selected" : ""}>AUD</option>
            <option \${p.price?.currency === "JPY" ? "selected" : ""}>JPY</option>
          </select>
        </div>
      </div>
      <div class="field"><label>Base Price</label><input id="eBasePrice" value="\${escapeHtml(p.basePrice || "")}"></div>
      <div class="field">
        <label>Availability</label>
        <select id="eAvail">
          <option \${p.availability === "In stock" ? "selected" : ""}>IN STOCK</option>
          <option \${p.availability === "Out of stock" ? "selected" : ""}>OUT OF STOCK</option>
          <option \${p.availability === "Pre-order" ? "selected" : ""}>PRE-ORDER</option>
        </select>
      </div>
      <div class="field-row">
        <div class="field">
          <label>Markup Type</label>
          <select id="eMarkupType">
            <option \${p.recommendedMarkup?.type === 'fixed' ? 'selected' : ''}>FIXED</option>
            <option \${p.recommendedMarkup?.type === 'percentage' || !p.recommendedMarkup?.type ? 'selected' : ''}>PERCENTAGE</option>
          </select>
        </div>
        <div class="field">
          <label>Markup Val</label>
          <input id="eMarkupVal" value="\${escapeHtml(p.recommendedMarkup?.value || '')}">
        </div>
      </div>
      <div class="field-row">
        <div class="field"><label>Shipping Cost</label><input id="eShippingCost" value="\${escapeHtml(p.recommendedShippingRate?.amount || '')}"></div>
        <div class="field"><label>Shipping Cov</label><input id="eShippingCov" value="\${escapeHtml(p.recommendedShippingRate?.coverage || '')}"></div>
      </div>
      <div class="field"><label>Sizes (CSV)</label><input id="eSizes" value="\${escapeHtml((p.sizing || []).join(", "))}"></div>
      <div class="field"><label>Description</label><textarea id="eDesc">\${escapeHtml(p.description || "")}</textarea></div>
      <div class="field"><label>Sizing Guide</label><textarea id="eSizingGuide">\${escapeHtml(p.sizingGuide || "")}</textarea></div>
      <div class="field"><label>Shipping & Returns</label><textarea id="eShipping">\${escapeHtml(p.shippingAndReturns || "")}</textarea></div>
    </div>
    <div class="card">
      <h3>IMAGES</h3>
      <div class="img-grid" id="eImgGrid"></div>
      <button class="btn-ghost" onclick="addImage()" style="width:100%; border:1px dashed var(--border);">+ ADD URL</button>
    </div>
    <div class="card" style="border-bottom:none;">
      <h3>ACTIONS</h3>
      <div style="display:flex;gap:12px">
        <button class="btn-danger" onclick="rejectProduct()" style="flex:1">[ REJECT ]</button>
        <button class="btn-primary" onclick="saveProduct()" style="flex:1">SAVE</button>
      </div>
    </div>
  \`;
  
  document.getElementById("eBody").innerHTML = html;
  renderImgGrid(allImages.urls, selectedSet);
  showScreen("editor");
}

function renderImgGrid(urls, selectedSet) {
  const grid = document.getElementById("eImgGrid");
  if (!urls.length) {
    grid.innerHTML = '<div class="empty" style="grid-column:1/-1">NO IMAGES</div>';
    return;
  }
  
  grid.innerHTML = urls.map(url => {
    const isOn = selectedSet.has(url);
    return \`
      <div class="img-cell \${isOn ? 'on' : ''}" onclick="this.classList.toggle('on')">
        <img src="\${escapeHtml(url)}" loading="lazy" alt="" onload="this.classList.add('loaded')">
        <div class="check">SEL</div>
      </div>
    \`;
  }).join("");
}

function addImage() {
  const url = prompt("IMAGE URL:"); 
  if (!url) return;
  const grid = document.getElementById("eImgGrid");
  const empty = grid.querySelector(".empty");
  if (empty) empty.remove();
  
  const div = document.createElement("div");
  div.className = "img-cell on";
  div.innerHTML = \`<img src="\${escapeHtml(url)}" loading="lazy" alt="" onload="this.classList.add('loaded')"><div class="check">SEL</div>\`;
  div.onclick = function() { this.classList.toggle("on"); };
  grid.appendChild(div);
}

async function saveProduct() {
  const idx = state.editingIdx;
  const p = state.current.response.products[idx];
  
  p.title = document.getElementById("eTitle").value;
  p.store = document.getElementById("eStore").value;
  p.url = document.getElementById("eUrl").value;
  p.brand = document.getElementById("eBrand").value;
  p.category = document.getElementById("eCategory").value;
  p.price = { current: document.getElementById("ePrice").value, currency: document.getElementById("eCurrency").value };
  p.basePrice = document.getElementById("eBasePrice").value;
  p.availability = document.getElementById("eAvail").value;
  
  p.recommendedMarkup = {
    type: document.getElementById("eMarkupType").value,
    value: document.getElementById("eMarkupVal").value,
    currency: document.getElementById("eCurrency").value
  };
  
  p.recommendedShippingRate = {
    amount: document.getElementById("eShippingCost").value,
    coverage: document.getElementById("eShippingCov").value,
    currency: document.getElementById("eCurrency").value
  };
  
  const sizesRaw = document.getElementById("eSizes").value;
  p.sizing = sizesRaw.split(",").map(s => s.trim()).filter(Boolean);
  p.sizes = p.sizing;
  
  p.description = document.getElementById("eDesc").value;
  p.sizingGuide = document.getElementById("eSizingGuide").value;
  p.shippingAndReturns = document.getElementById("eShipping").value;
  
  const cells = document.querySelectorAll("#eImgGrid .img-cell");
  p.selectedImages = [];
  p.customImages = [];
  
  cells.forEach(c => {
    const img = c.querySelector("img").src;
    if (c.classList.contains("on")) {
      p.selectedImages.push(img);
    }
    if (!p.images.includes(img)) {
       p.customImages.push(img);
    }
  });
  
  p.reviewStatus = "completed";
  p.reviewedAt = new Date().toISOString();
  
  try {
    const body = { docId: state.current._id, fileIdx: state.current.fileIdx, frameIdx: state.current.frameIdx, prodIdx: idx, product: p };
    const r = await fetch("/api/product", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error("Save failed");
    toast("SAVED");
    renderItem();
    closeEditor();
  } catch(e) {
    toast("ERROR: " + e.message);
  }
}

function rejectProduct() {
  const idx = state.editingIdx;
  const p = state.current.response.products[idx];
  p.reviewStatus = "rejected";
  p.selectedImages = [];
  p.customImages = [];
  saveProduct();
}

function closeEditor() { showScreen("review"); }

async function commitItem() {
  const prods = state.current.response && state.current.response.products ? state.current.response.products : [];
  const pending = prods.filter(p => p.reviewStatus !== "completed" && p.reviewStatus !== "rejected");
  if (pending.length) {
    if (!confirm(pending.length + " PENDING. COMMIT ANYWAY?")) return;
  }
  try {
    const body = { docId: state.current._id, fileIdx: state.current.fileIdx, frameIdx: state.current.frameIdx };
    const r = await fetch("/api/commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error("Commit failed");
    toast("COMMITTED");
    showQueue();
    await loadQueue();
  } catch(e) {
    toast("ERROR: " + e.message);
  }
}

async function deleteItem() {
  if (!confirm("DELETE ITEM?")) return;
  try {
    const body = { docId: state.current._id, fileIdx: state.current.fileIdx, frameIdx: state.current.frameIdx };
    const r = await fetch("/api/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error("Delete failed");
    toast("DELETED");
    showQueue();
    await loadQueue();
  } catch(e) {
    toast("ERROR: " + e.message);
  }
}

function showQueue() { showScreen("queue"); }
loadQueue();
</script>
</body>
</html>`;

/* -------------------------------------------------------------------------- */
/* MONGODB HELPERS & AUTO-MIGRATION (FLATTENING)                              */
/* -------------------------------------------------------------------------- */

function resolvePrice(basePriceObj, sourcePriceStr) {
    if (!sourcePriceStr) return basePriceObj;
    return {
        current: String(sourcePriceStr),
        original: basePriceObj?.original || null,
        currency: basePriceObj?.currency || 'USD'
    };
}

/**
 * Flattens the old AI schema (1 product -> many sources/alternatives)
 * into a 1-to-1 array (1 product = 1 source/url).
 */
function flattenProducts(products) {
    let modified = false;
    const flattened = [];

    for (const p of products) {
        if (p.isFlattened) {
            flattened.push(p);
            continue;
        }
        modified = true;

        const base = { ...p, isFlattened: true, reviewStatus: p.reviewStatus || 'pending' };
        delete base.sources;
        delete base.customSources;
        delete base.alternatives;

        let variantsAdded = 0;

        const allSources = [
            ...(Array.isArray(p.sources) ? p.sources : []),
            ...(Array.isArray(p.customSources) ? p.customSources : [])
        ];

        allSources.forEach(s => {
            flattened.push({
                ...base,
                store: s.store || '',
                url: s.url || '',
                price: resolvePrice(base.price, s.price),
                availability: s.availability || base.availability,
                images: s.images || []
            });
            variantsAdded++;
        });

        if (Array.isArray(p.alternatives)) {
            p.alternatives.forEach(a => {
                flattened.push({
                    ...base,
                    title: a.title || base.title,
                    brand: a.brand || base.brand,
                    store: a.store || 'Alternative',
                    url: a.url || '',
                    price: a.price ? { current: String(a.price), currency: base.price?.currency || 'USD' } : base.price,
                    images: []
                });
                variantsAdded++;
            });
        }

        if (variantsAdded === 0) {
            flattened.push({ ...base, store: '', url: '', images: [] });
        }
    }
    return { flattened, modified };
}

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
        images: p.images || [],
        price: p.price || { current: '', original: null, currency: 'USD' },
        sizing: Array.isArray(p.sizing) ? p.sizing : (p.sizes ? String(p.sizes).split(',').map(s => s.trim()).filter(Boolean) : []),
        sizes: p.sizes || p.sizing || [],
        recommendedMarkup: p.recommendedMarkup || null,
        recommendedShippingRate: p.recommendedShippingRate || null,
        dropshipViability: p.dropshipViability || null,
    }));

    return resp;
}

function getItemStatus(item) {
    const resp = normalizeResponse(item);
    
    // Auto-flatten purely in memory for status calculation so the queue reflects the correct state
    const { flattened } = flattenProducts(resp.products);
    
    if (!flattened.length) return 'pending';
    const allDone = flattened.every(p => p.reviewStatus === 'completed' || p.reviewStatus === 'rejected');
    const someDone = flattened.some(p => p.reviewStatus === 'completed' || p.reviewStatus === 'rejected');
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

    const grouped = {};
    for (const post of posts) {
        if (!Array.isArray(post.file_urls)) continue;
        const postItems = [];
        for (let i = 0; i < post.file_urls.length; i++) {
            const f = post.file_urls[i];
            if (!f || f.discarded) continue;

            if (f.type === 'image') {
                if (f.reviewed && !f.humanReviewed) {
                    postItems.push({
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
                        postItems.push({
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
        if (postItems.length > 0) {
            grouped[post.post_id] = {
                postId: post.post_id,
                _id: post._id.toString(),
                items: postItems
            };
        }
    }

    const items = Object.values(grouped).flatMap(g => g.items);
    return { posts: grouped, items };
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

async function maybeDiscardEmptyPost(collection, docId) {
    const post = await collection.findOne(
        { _id: new ObjectId(docId) },
        { projection: { file_urls: 1, post_id: 1 } }
    );
    if (!post || !post.file_urls) return;

    const hasRemaining = post.file_urls.some(f => {
        if (f.discarded) return false;
        if (f.type === 'image') return true;
        if (f.type === 'video' && Array.isArray(f.frames)) {
            return f.frames.some(fr => !fr.discarded);
        }
        return false;
    });

    if (!hasRemaining) {
        await collection.updateOne(
            { _id: new ObjectId(docId) },
            { $set: { discarded: true, discardedAt: new Date(), discardReason: 'all file_urls removed' } }
        );
        log('info', `Auto-discarded empty post ${post.post_id}`);
    }
}

/* -------------------------------------------------------------------------- */
/* NGROK                                                                      */
/* -------------------------------------------------------------------------- */
async function startNgrok(port) {
    try {
        const { spawn } = await import('child_process');
        
        // Relies on `ngrok config add-authtoken` being correctly executed by the GitHub Actions workflow environment.
        const ngrok = spawn('ngrok', ['http', String(port)], { stdio: 'pipe' });

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

        log('warn', 'ngrok started but no URL captured');
        ngrok.kill();
        return null;
    } catch (err) {
        log('error', 'ngrok failed:', err.message);
        return null;
    }
}

/* -------------------------------------------------------------------------- */
/* SERVER                                                                     */
/* -------------------------------------------------------------------------- */
async function main() {
    log('info', '===============================================================');
    log('info', '  REVIEW SERVER — Production Human Review');
    log('info', '===============================================================');

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

        if (parsed.pathname === '/' || parsed.pathname === '/index.html') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(REVIEW_UI_HTML);
            return;
        }

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
                
                // BACKWARD COMPATIBILITY: Auto-flatten if necessary and write immediately to DB so indices lock in place.
                const { flattened, modified } = flattenProducts(response.products);
                if (modified) {
                    log('info', `Auto-flattening legacy schema for doc ${docId}`);
                    response.products = flattened;
                    
                    const updatePath = frameIdx !== null 
                        ? `file_urls.${fileIdx}.frames.${frameIdx}.response.products` 
                        : `file_urls.${fileIdx}.response.products`;
                    
                    await collection.updateOne(
                        { _id: new ObjectId(docId) },
                        { $set: { [updatePath]: flattened } }
                    );
                }

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
                            [`${basePath}.store`]: product.store,
                            [`${basePath}.url`]: product.url,
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
                            [`${basePath}.recommendedMarkup`]: product.recommendedMarkup,
                            [`${basePath}.recommendedShippingRate`]: product.recommendedShippingRate,
                            [`${basePath}.images`]: product.images,
                            [`${basePath}.selectedImages`]: product.selectedImages,
                            [`${basePath}.customImages`]: product.customImages,
                            [`${basePath}.reviewStatus`]: product.reviewStatus,
                            [`${basePath}.isFlattened`]: product.isFlattened,
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

                    await maybeDiscardEmptyPost(collection, docId);

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

        res.writeHead(404);
        res.end('Not found');
    });

    server.listen(CONFIG.port, '0.0.0.0', async () => {
        log('info', '===============================================================');
        log('info', `  Server: http://0.0.0.0:${CONFIG.port}`);

        const ngrok = await startNgrok(CONFIG.port);
        if (ngrok) {
            log('info', '===============================================================');
            log('info', `  OPEN ON YOUR BROWSER: ${ngrok.url}`);
            log('info', '===============================================================');
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
