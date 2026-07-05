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
/* HTML UI (Premium Glassmorphism Aesthetic)                                  */
/* -------------------------------------------------------------------------- */
const REVIEW_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="theme-color" content="#000000">
<title>DropShip Review</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root{
  --bg:#000000;
  --surface:rgba(255, 255, 255, 0.04);
  --surface-2:rgba(255, 255, 255, 0.08);
  --border:rgba(255, 255, 255, 0.1);
  --text:#ffffff;
  --text-2:#9ca3af;
  --accent:#ff5e00; /* Warm Gallery Glow */
  --accent-glow:rgba(255, 94, 0, 0.25);
  --accent-2:#ff2a00;
  --danger:#ef4444;
  --danger-2:#dc2626;
  --warn:#f59e0b;
  --success:#10b981;
}
body {
  font-family:'Inter',sans-serif;
  background-color:var(--bg);
  background-image:radial-gradient(rgba(255,255,255,0.06) 1px, transparent 1px);
  background-size:20px 20px;
  color:var(--text);
  line-height:1.5;
  min-height:100dvh;
  overflow-x:hidden;
}
body::before {
  content:'';
  position:fixed;
  top:0;left:0;right:0;bottom:0;
  background:radial-gradient(circle at 15% 30%, rgba(255, 94, 0, 0.05), transparent 30%),
             radial-gradient(circle at 85% 70%, rgba(0, 140, 255, 0.05), transparent 30%);
  z-index:-1;
  pointer-events:none;
}
button {
  cursor:pointer;
  border:none;
  border-radius:20px;
  padding:14px 20px;
  font-size:15px;
  font-weight:600;
  touch-action:manipulation;
  min-height:48px;
  transition:all .2s cubic-bezier(0.16,1,0.3,1);
  background:var(--surface-2);
  color:var(--text);
  border:1px solid var(--border);
  letter-spacing:-0.01em;
}
button:active{transform:scale(.95)}
button:disabled{opacity:.4;cursor:not-allowed}
.btn-primary {
  background:linear-gradient(135deg, var(--accent), var(--accent-2));
  color:#fff;
  border:none;
  box-shadow:0 8px 24px var(--accent-glow);
}
.btn-danger {
  background:rgba(220, 38, 38, 0.15);
  color:#f87171;
  border:1px solid rgba(220, 38, 38, 0.3);
}
.btn-ghost{background:transparent;color:var(--text-2);border:1px solid var(--border)}

input,select,textarea {
  background:var(--surface);
  border:1px solid var(--border);
  color:var(--text);
  padding:16px;
  border-radius:18px;
  font-size:15px;
  font-family:'Inter',sans-serif;
  width:100%;
  -webkit-appearance:none;
  transition:all .3s ease;
}
input:focus,select:focus,textarea:focus {
  outline:none;
  background:var(--surface-2);
  border-color:var(--accent);
  box-shadow:0 0 0 4px var(--accent-glow);
}
select{background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%23999'%3E%3Cpath d='M6 8L1 3h10z'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 16px center;padding-right:40px}
textarea{resize:vertical;min-height:100px}
img{max-width:100%;display:block}
a{color:var(--accent);text-decoration:none;transition:opacity .2s}
a:active{opacity:.6}

.screen{display:none;min-height:100dvh;padding-bottom:120px}
.screen.active{display:block;animation:fadeIn 0.4s ease forwards}
@keyframes fadeIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}

.topbar {
  position:sticky;
  top:0;
  z-index:50;
  background:rgba(5, 5, 5, 0.6);
  backdrop-filter:blur(24px);
  -webkit-backdrop-filter:blur(24px);
  border-bottom:1px solid var(--border);
  padding:16px 20px;
  display:flex;
  align-items:center;
  gap:16px;
}
.topbar h1{font-size:18px;font-weight:700;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;letter-spacing:-0.02em}

.badge {
  font-size:12px;
  font-weight:600;
  padding:4px 12px;
  border-radius:24px;
  background:var(--surface-2);
  color:var(--text);
  border:1px solid var(--border);
  backdrop-filter:blur(10px);
}
.badge.pending{background:rgba(245,158,11,0.15);color:#fbbf24;border-color:rgba(245,158,11,0.3)}
.badge.partial{background:rgba(96,165,250,0.15);color:#60a5fa;border-color:rgba(96,165,250,0.3)}
.badge.done{background:rgba(16,185,129,0.15);color:#34d399;border-color:rgba(16,185,129,0.3)}

.loading{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100dvh;gap:16px;color:var(--text-2)}
.spinner{width:36px;height:36px;border:3px solid var(--surface-2);border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

.post-group {
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:28px;
  margin:16px;
  overflow:hidden;
  backdrop-filter:blur(16px);
  -webkit-backdrop-filter:blur(16px);
}
.post-header {
  display:flex;
  align-items:center;
  gap:16px;
  padding:16px;
  cursor:pointer;
  user-select:none;
  transition:background .2s;
}
.post-header:active{background:var(--surface-2)}
.post-thumb {
  width:64px;height:64px;
  border-radius:18px;
  overflow:hidden;
  background:var(--bg);
  flex-shrink:0;
  border:1px solid var(--border);
}
.post-thumb img{width:100%;height:100%;object-fit:cover}
.post-info{flex:1;min-width:0}
.post-id{font-size:16px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.post-meta{font-size:13px;color:var(--text-2);margin-top:4px}
.post-chevron{width:24px;height:24px;transition:transform .3s cubic-bezier(0.16,1,0.3,1);color:var(--text-2)}
.post-group.open .post-chevron{transform:rotate(180deg)}
.post-items{display:none;padding:0 16px 16px}
.post-group.open .post-items{display:block;animation:fadeIn .3s ease}

.item-row {
  display:flex;
  align-items:center;
  gap:14px;
  padding:12px;
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:20px;
  margin-bottom:10px;
  cursor:pointer;
  transition:all .2s;
}
.item-row:last-child{margin-bottom:0}
.item-row:active{transform:scale(0.97);background:var(--surface-2)}
.item-thumb {
  width:52px;height:68px;
  border-radius:14px;
  overflow:hidden;
  background:var(--bg);
  flex-shrink:0;
}
.item-thumb img{width:100%;height:100%;object-fit:cover}
.item-info{flex:1;min-width:0}
.item-type{font-size:14px;font-weight:600}
.item-status{font-size:13px;color:var(--text-2);margin-top:2px}

.hero {
  position:relative;
  margin:16px;
  border-radius:36px;
  background:var(--surface);
  padding:8px;
  border:1px solid var(--border);
  box-shadow:0 30px 60px rgba(0,0,0,0.6);
}
.hero::before {
  content:'';
  position:absolute;
  inset:20px;
  background:var(--accent);
  filter:blur(60px);
  opacity:0.15;
  z-index:-1;
}
.hero img {
  width:100%;
  aspect-ratio:4/5;
  object-fit:cover;
  border-radius:28px;
  background:var(--bg);
}
.hero-meta {
  position:absolute;
  bottom:8px;left:8px;right:8px;
  padding:40px 20px 20px;
  background:linear-gradient(transparent, rgba(0,0,0,0.9));
  border-bottom-left-radius:28px;
  border-bottom-right-radius:28px;
  display:flex;
  gap:8px;
  flex-wrap:wrap;
}

.section{padding:16px;padding-bottom:20px}
.section h2{font-size:20px;font-weight:700;margin-bottom:16px;display:flex;align-items:center;gap:10px;letter-spacing:-0.02em}

.p-card {
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:24px;
  padding:16px;
  display:flex;
  gap:16px;
  cursor:pointer;
  margin-bottom:12px;
  backdrop-filter:blur(16px);
  transition:all .2s cubic-bezier(0.16,1,0.3,1);
}
.p-card:active{transform:scale(0.97);background:var(--surface-2)}
.p-img {
  width:88px;height:88px;
  border-radius:18px;
  overflow:hidden;
  background:var(--bg);
  flex-shrink:0;
  border:1px solid var(--border);
}
.p-img img{width:100%;height:100%;object-fit:cover}
.p-img .no-img{width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--text-2);font-size:12px}
.p-info{flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center}
.p-title{font-size:16px;font-weight:600;margin-bottom:4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.p-brand{font-size:14px;color:var(--accent);font-weight:500;margin-bottom:8px}
.p-status{display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500;color:var(--text-2)}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;box-shadow:0 0 8px currentColor}

.actions-bar {
  position:fixed;
  bottom:32px;
  left:50%;
  transform:translateX(-50%);
  width:calc(100% - 32px);
  max-width:400px;
  background:rgba(20, 20, 20, 0.7);
  backdrop-filter:blur(30px);
  -webkit-backdrop-filter:blur(30px);
  border:1px solid rgba(255, 255, 255, 0.12);
  border-radius:100px;
  padding:8px;
  display:flex;
  gap:8px;
  z-index:100;
  box-shadow:0 24px 48px rgba(0,0,0,0.6);
}
.actions-bar button {
  flex:1;
  border-radius:100px;
  padding:16px;
  font-size:16px;
}

.modal {
  position:fixed;
  inset:0;
  z-index:200;
  background:rgba(0,0,0,0.8);
  backdrop-filter:blur(10px);
  -webkit-backdrop-filter:blur(10px);
  display:none;
  flex-direction:column;
}
.modal.active {
  display:flex;
  animation:slideUp .4s cubic-bezier(0.16,1,0.3,1) forwards;
}
@keyframes slideUp {
  from { opacity:0; transform:translateY(40px) scale(0.98); }
  to { opacity:1; transform:translateY(0) scale(1); }
}

.modal-header {
  position:sticky;
  top:0;
  z-index:10;
  background:rgba(10,10,10,0.8);
  backdrop-filter:blur(24px);
  border-bottom:1px solid var(--border);
  padding:16px 20px;
  display:flex;
  align-items:center;
  gap:16px;
}
.modal-header h2{font-size:18px;font-weight:700;flex:1;text-align:center}
.modal-body{flex:1;overflow-y:auto;padding:16px;padding-bottom:140px}

.card {
  background:var(--surface);
  border:1px solid var(--border);
  border-radius:28px;
  padding:20px;
  margin-bottom:16px;
}
.card h3 {
  font-size:13px;
  text-transform:uppercase;
  letter-spacing:0.06em;
  color:var(--text-2);
  margin-bottom:16px;
  font-weight:700;
}

.img-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px}
.img-cell {
  aspect-ratio:1;
  border-radius:18px;
  overflow:hidden;
  position:relative;
  border:2px solid transparent;
  background:var(--bg);
  cursor:pointer;
  transition:all .3s cubic-bezier(0.16,1,0.3,1);
}
.img-cell.on {
  border-color:var(--accent);
  transform:scale(0.94);
  box-shadow:0 0 20px var(--accent-glow);
}
.img-cell img{width:100%;height:100%;object-fit:cover}
.img-cell .check {
  position:absolute;
  top:8px;right:8px;
  width:26px;height:26px;
  background:var(--accent);
  border-radius:50%;
  display:none;
  align-items:center;
  justify-content:center;
  font-size:14px;
  color:#fff;
  font-weight:700;
  box-shadow:0 4px 10px rgba(0,0,0,0.3);
}
.img-cell.on .check{display:flex}

.src-row {
  display:flex;
  align-items:center;
  gap:12px;
  padding:14px;
  background:rgba(0,0,0,0.4);
  border:1px solid var(--border);
  border-radius:18px;
  margin-bottom:10px;
}
.src-row .info{flex:1;min-width:0}
.src-row .name{font-size:15px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.src-row .url{font-size:13px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px}
.src-row .actions{display:flex;gap:8px;flex-shrink:0}
.src-row a, .src-row button {
  padding:10px 14px;
  font-size:13px;
  min-height:40px;
  border-radius:14px;
  display:inline-flex;
  align-items:center;
  justify-content:center;
}
.src-row a{background:var(--surface-2);color:var(--text);border:1px solid var(--border)}

.field{margin-bottom:16px}
.field label{display:block;font-size:12px;font-weight:700;color:var(--text-2);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.04em}
.field-row{display:flex;gap:12px}
.field-row .field{flex:1}

.empty{color:var(--text-2);text-align:center;padding:32px;font-size:15px}

.toast {
  position:fixed;
  top:24px;
  left:50%;
  transform:translateX(-50%) translateY(-120px);
  background:rgba(20,20,20,0.9);
  backdrop-filter:blur(16px);
  color:var(--text);
  padding:14px 24px;
  border-radius:100px;
  font-size:15px;
  font-weight:600;
  z-index:300;
  transition:transform .4s cubic-bezier(0.16,1,0.3,1);
  border:1px solid rgba(255,255,255,0.15);
  box-shadow:0 20px 40px rgba(0,0,0,0.5);
}
.toast.show{transform:translateX(-50%) translateY(0)}

.lazy-img{opacity:0;transition:opacity .4s ease}
.lazy-img.loaded{opacity:1}
.placeholder{background:var(--surface-2);animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
</style>
</head>
<body>
<div id="app">
  <div id="loading" class="screen active">
    <div class="loading"><div class="spinner"></div><p>Loading queue...</p></div>
  </div>
  <div id="queue" class="screen">
    <div class="topbar"><h1>Review Queue</h1><span class="badge" id="qCount">0</span></div>
    <div id="qList"></div>
  </div>
  <div id="review" class="screen">
    <div class="topbar">
      <button class="btn-ghost" onclick="showQueue()" style="padding:10px 16px; min-height:40px;">Back</button>
      <h1 id="rTitle">Item</h1>
      <div style="width:60px"></div>
    </div>
    <div class="hero">
      <img id="rImage" src="" alt="" loading="lazy">
      <div class="hero-meta" id="rMeta"></div>
    </div>
    <div class="section">
      <h2>Products <span class="badge" id="pCount">0</span></h2>
      <div id="pList"></div>
    </div>
    <div class="actions-bar">
      <button class="btn-danger" onclick="deleteItem()">Delete Item</button>
      <button class="btn-primary" onclick="commitItem()">Commit Item</button>
    </div>
  </div>
  <div id="editor" class="modal">
    <div class="modal-header">
      <button class="btn-ghost" onclick="closeEditor()" style="padding:10px 16px; min-height:40px;">Cancel</button>
      <h2>Edit Product</h2>
      <button class="btn-primary" onclick="saveProduct()" style="padding:10px 20px; min-height:40px;">Save</button>
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
            <div class="post-meta">\${items.length} item(s) &middot; \${pending} pending</div>
          </div>
          <svg class="post-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
        </div>
        <div class="post-items" onclick="event.stopPropagation()">
          \${items.map(it => \`
            <div class="item-row" onclick="openItem('\${it._id}', \${it.fileIdx}, \${it.frameIdx !== null ? it.frameIdx : null})">
              <div class="item-thumb"><img data-src="\${escapeHtml(it.thumb)}" alt="" class="lazy-img placeholder" onload="this.classList.remove('placeholder')"></div>
              <div class="item-info">
                <div class="item-type">\${it.type === "frame" ? "Frame" : "Image"} #\${it.frameIdx !== null ? it.frameIdx : it.fileIdx}</div>
                <div class="item-status">\${escapeHtml(it.status)}</div>
              </div>
              <span class="item-badge \${it.status}">\${it.status}</span>
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
    <span class="badge">\${item.type === "frame" ? "Frame" : "Image"}</span>
    <span class="badge">\${prods.length} products</span>
    \${pending ? \`<span class="badge pending">\${pending} pending</span>\` : ""}
  \`;
  
  document.getElementById("pCount").textContent = prods.length;
  const list = document.getElementById("pList");
  
  if (!prods.length) {
    list.innerHTML = '<div class="empty">No products identified</div>';
    return;
  }
  
  list.innerHTML = prods.map((p, i) => {
    const color = p.reviewStatus === "completed" ? "var(--success)" : p.reviewStatus === "rejected" ? "var(--danger)" : "var(--warn)";
    const imgUrl = getImageUrl((p.selectedImages && p.selectedImages[0]) || (p.images && p.images[0]));
    const storeLabel = p.store ? \`\${escapeHtml(p.store)} &middot; \` : '';

    return \`
      <div class="p-card" onclick="openProduct(\${i})">
        <div class="p-img">\${imgUrl ? \`<img src="\${escapeHtml(imgUrl)}" alt="" loading="lazy">\` : \`<div class="no-img">No img</div>\`}</div>
        <div class="p-info">
          <div class="p-title">\${escapeHtml(p.title || "Untitled")}</div>
          <div class="p-brand">\${storeLabel}\${escapeHtml(formatPrice(p.price))}</div>
          <div class="p-status"><span class="dot" style="background:\${color}"></span>\${p.reviewStatus || "pending"}</div>
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
      <h3>AI Viability Score: \${p.dropshipViability?.score || '?'} / 10</h3>
      <p style="font-size: 14px; color: var(--text-2); margin-bottom: 4px; line-height: 1.6;">\${escapeHtml(p.dropshipViability?.reasoning || 'No reasoning provided')}</p>
    </div>
    <div class="card">
      <h3>Basic Info</h3>
      <div class="field"><label>Product Title</label><input id="eTitle" value="\${escapeHtml(p.title || "")}"></div>
      
      <div class="field-row">
        <div class="field"><label>Store / Supplier Name</label><input id="eStore" value="\${escapeHtml(p.store || "")}"></div>
        <div class="field"><label>Brand (Optional)</label><input id="eBrand" value="\${escapeHtml(p.brand || "")}"></div>
      </div>

      <div class="field-row" style="align-items: flex-end;">
        <div class="field" style="flex: 1;"><label>Supplier URL</label><input id="eUrl" value="\${escapeHtml(p.url || "")}"></div>
        \${p.url ? \`<a href="\${escapeHtml(p.url)}" target="_blank" rel="noopener" class="btn-ghost" style="height:48px; display:flex; align-items:center; margin-bottom:16px; border-radius:18px;">Visit</a>\` : ''}
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
          <option \${p.availability === "In stock" ? "selected" : ""}>In stock</option>
          <option \${p.availability === "Out of stock" ? "selected" : ""}>Out of stock</option>
          <option \${p.availability === "Pre-order" ? "selected" : ""}>Pre-order</option>
        </select>
      </div>
      <div class="field-row">
        <div class="field">
          <label>Markup Type</label>
          <select id="eMarkupType">
            <option \${p.recommendedMarkup?.type === 'fixed' ? 'selected' : ''}>fixed</option>
            <option \${p.recommendedMarkup?.type === 'percentage' || !p.recommendedMarkup?.type ? 'selected' : ''}>percentage</option>
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
      <div class="field"><label>Sizes (comma separated)</label><input id="eSizes" value="\${escapeHtml((p.sizing || []).join(", "))}"></div>
      <div class="field"><label>Description</label><textarea id="eDesc">\${escapeHtml(p.description || "")}</textarea></div>
      <div class="field"><label>Sizing Guide</label><textarea id="eSizingGuide">\${escapeHtml(p.sizingGuide || "")}</textarea></div>
      <div class="field"><label>Shipping & Returns</label><textarea id="eShipping">\${escapeHtml(p.shippingAndReturns || "")}</textarea></div>
    </div>
    <div class="card">
      <h3>Images &mdash; Tap to select</h3>
      <div class="img-grid" id="eImgGrid"></div>
      <button class="btn-ghost" onclick="addImage()" style="width:100%;margin-top:8px">+ Add Image URL</button>
    </div>
    <div class="card" style="margin-bottom:0">
      <h3>Actions</h3>
      <div style="display:flex;gap:12px">
        <button class="btn-danger" onclick="rejectProduct()" style="flex:1">Reject Product</button>
        <button class="btn-primary" onclick="saveProduct()" style="flex:1">Save Product</button>
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
    grid.innerHTML = '<div class="empty" style="grid-column:1/-1">No images available</div>';
    return;
  }
  
  grid.innerHTML = urls.map(url => {
    const isOn = selectedSet.has(url);
    return \`
      <div class="img-cell \${isOn ? 'on' : ''}" onclick="this.classList.toggle('on')">
        <img src="\${escapeHtml(url)}" loading="lazy" alt="" onload="this.classList.add('loaded')">
        <div class="check">&#10003;</div>
      </div>
    \`;
  }).join("");
}

function addImage() {
  const url = prompt("Paste image URL:"); 
  if (!url) return;
  const grid = document.getElementById("eImgGrid");
  const empty = grid.querySelector(".empty");
  if (empty) empty.remove();
  
  const div = document.createElement("div");
  div.className = "img-cell on";
  div.innerHTML = \`<img src="\${escapeHtml(url)}" loading="lazy" alt="" onload="this.classList.add('loaded')"><div class="check">&#10003;</div>\`;
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
    toast("Saved");
    renderItem();
    closeEditor();
  } catch(e) {
    toast("Save failed: " + e.message);
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
    if (!confirm(pending.length + " product(s) still pending. Commit anyway?")) return;
  }
  try {
    const body = { docId: state.current._id, fileIdx: state.current.fileIdx, frameIdx: state.current.frameIdx };
    const r = await fetch("/api/commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error("Commit failed");
    toast("Committed");
    showQueue();
    await loadQueue();
  } catch(e) {
    toast("Commit failed: " + e.message);
  }
}

async function deleteItem() {
  if (!confirm("Delete this item? It will be marked as discarded.")) return;
  try {
    const body = { docId: state.current._id, fileIdx: state.current.fileIdx, frameIdx: state.current.frameIdx };
    const r = await fetch("/api/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error("Delete failed");
    toast("Deleted");
    showQueue();
    await loadQueue();
  } catch(e) {
    toast("Delete failed: " + e.message);
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
