/**
 * review-server.js
 *
 * Production human review server for the UGC dropship pipeline.
 * Brutalist Native Apple Aesthetic, lazy loading, Python AI extraction.
 *
 * Env: ORCH_MONGODB_URI, ORCH_MONGODB_DB, ORCH_MONGODB_COLLECTION
 *      REVIEW_PORT (default 3456), ORCH_HF_TOKEN
 *
 * FINAL PRODUCTION v1.1 - Polished UX, robust error handling, keyboard support,
 * selected image count + clear, refresh, ObjectId safety, Python script validation.
 */

import http from 'http';
import { MongoClient, ObjectId } from 'mongodb';
import { spawn } from 'child_process';
import { Readable } from 'stream';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

/* -------------------------------------------------------------------------- */
/* CONFIG                                                                     */
/* -------------------------------------------------------------------------- */
const CONFIG = {
    mongodb: {
        uri:        process.env.ORCH_MONGODB_URI        || '',
        db:         process.env.ORCH_MONGODB_DB         || 'ugc-dropship',
        collection: process.env.ORCH_MONGODB_COLLECTION || 'scraped-posts',
    },
    hfToken: process.env.ORCH_HF_TOKEN || process.env.HF_TOKEN || '',
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
/* HTML UI (Premium Native Aesthetic + Dark Mode + UX Polish)                 */
/* -------------------------------------------------------------------------- */
const REVIEW_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#ffffff" id="metaThemeColor">
<title>DropShip Review • v1.1</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
:root {
  --bg: #ffffff;
  --surface: #ffffff;
  --surface-2: #f5f5f5;
  --border: #e5e5e5;
  --text: #000000;
  --text-2: #737373;
  --focus: #000000;
  --danger: #dc2626;
  --success: #16a34a;
}
:root[data-theme="dark"] {
  --bg: #121212;
  --surface: #121212;
  --surface-2: #1e1e1e;
  --border: #333333;
  --text: #ffffff;
  --text-2: #a3a3a3;
  --focus: #ffffff;
  --danger: #ef4444;
  --success: #22c55e;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.4;
  min-height: 100dvh;
  overflow-x: hidden;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* Typography Overrides */
h1, h2, h3, label, .item-type, .p-brand, .post-id, .src-row .name, .empty {
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

/* Controls */
button {
  cursor: pointer;
  border: 1px solid var(--border);
  border-radius: 0;
  padding: 12px 16px;
  font-size: 13px;
  background: var(--bg);
  color: var(--text);
  min-height: 48px;
  font-family: inherit;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  transition: opacity 0.15s ease, transform 0.1s ease;
}
button:active { opacity: 0.7; transform: scale(0.98); }
button:disabled { opacity: 0.4 !important; cursor: not-allowed; border-color: var(--border); transform: none !important; }

.btn-primary { background: var(--text); color: var(--bg); border: 1px solid var(--text); }
.btn-danger { background: var(--bg); color: var(--danger); border: 1px solid var(--border); }
.btn-ghost { border-color: transparent; background: transparent; color: var(--text); padding: 0; min-height: 0; border: none; }
.btn-ghost:active { opacity: 0.5; transform: scale(0.96); }

input, select, textarea {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 14px;
  border-radius: 0;
  font-size: 14px;
  font-family: inherit;
  width: 100%;
  -webkit-appearance: none;
  transition: border-color 0.2s ease;
}
input::placeholder, textarea::placeholder { color: var(--text-2); opacity: 0.5; }
input:focus, select:focus, textarea:focus {
  outline: none;
  border-color: var(--text);
}
textarea { resize: vertical; min-height: 100px; }
select {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%23737373'%3E%3Cpath d='M6 8L1 3h10z'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 14px center;
  padding-right: 32px;
}

img { max-width: 100%; display: block; }
a { color: var(--text); text-decoration: underline; text-underline-offset: 4px; font-weight: 600; }
a:active { opacity: 0.7; }

/* Layout Screens */
.screen { display: none; min-height: 100dvh; padding-bottom: calc(90px + env(safe-area-inset-bottom)); }
.screen.active { display: block; }

.topbar {
  position: sticky; top: 0; z-index: 50;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  padding: 12px 16px;
  padding-top: max(12px, env(safe-area-inset-top));
  display: flex; align-items: center; gap: 12px;
}
.topbar h1 { font-size: 14px; flex: 1; margin: 0; text-align: left; }

.badge {
  font-size: 10px;
  padding: 0 8px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--text);
  color: var(--bg);
  background: var(--text);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}
.badge.pending { color: var(--text); background: var(--surface-2); border-color: var(--border); }
.badge.partial { background: var(--bg); color: var(--text); border: 1px dashed var(--border); }

.theme-toggle {
  font-size: 10px;
  padding: 0 8px;
  height: 24px;
  min-height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  color: var(--text);
  background: transparent;
}

/* Lists & Groups */
.post-group { border-bottom: 1px solid var(--border); margin: 0; background: var(--bg); }
.post-header {
  display: flex; align-items: center; gap: 12px;
  padding: 20px 16px; cursor: pointer; user-select: none;
}
.post-header:active { background: var(--surface-2); }
.post-thumb {
  width: 48px; height: 48px;
  background: var(--surface-2); flex-shrink: 0; border: 1px solid var(--border);
}
.post-thumb img { width: 100%; height: 100%; object-fit: cover; }
.post-info { flex: 1; min-width: 0; }
.post-id { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.post-meta { font-size: 12px; color: var(--text-2); margin-top: 2px; font-weight: 600; }
.post-chevron { width: 20px; height: 20px; color: var(--text); transition: transform 0.2s ease; }
.post-group.open .post-chevron { transform: rotate(180deg); }

.post-items { display: none; padding: 0 16px 16px; border-top: 1px dashed var(--border); }
.post-group.open .post-items { display: block; margin-top: 0; padding-top: 16px; background: var(--surface-2); }

.item-row {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 0; border-bottom: 1px solid var(--border); cursor: pointer;
  transition: transform 0.1s ease;
}
.item-row:active { transform: scale(0.98); }
.item-row:last-child { border-bottom: none; padding-bottom: 0; }
.item-thumb { width: 40px; height: 56px; background: var(--bg); border: 1px solid var(--border); flex-shrink: 0; }
.item-thumb img { width: 100%; height: 100%; object-fit: cover; }
.item-info { flex: 1; min-width: 0; }
.item-status { font-size: 10px; color: var(--text-2); margin-top: 4px; font-weight: 700; text-transform: uppercase; }

/* Hero (Review Main Image) */
.hero { width: 100%; border-bottom: 1px solid var(--border); background: var(--surface-2); position: relative; }
.hero img { width: 100%; height: 65vh; object-fit: cover; cursor: pointer; transition: object-fit 0.1s; }
.hero-meta { padding: 12px 16px; display: flex; gap: 8px; flex-wrap: wrap; background: var(--bg); border-top: 1px solid var(--border); }

/* Section & Cards */
.section { padding: 0; padding-bottom: calc(100px + env(safe-area-inset-bottom)); background: var(--bg); }
.section h2 { font-size: 14px; padding: 20px 16px; border-bottom: 1px solid var(--border); margin: 0; display: flex; justify-content: space-between; align-items: center; background: var(--bg); }

.p-card {
  padding: 16px; display: flex; gap: 16px; cursor: pointer;
  border-bottom: 1px solid var(--border); background: var(--bg);
  transition: transform 0.1s ease, opacity 0.2s, filter 0.2s;
}
.p-card:active { background: var(--surface-2); transform: scale(0.98); }
.p-card.rejected { opacity: 0.4; filter: grayscale(100%); }
.p-img { width: 80px; height: 106px; background: var(--surface-2); border: 1px solid var(--border); flex-shrink: 0; position: relative;}
.p-img img { width: 100%; height: 100%; object-fit: cover; }
.p-img .no-img { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; color: var(--text-2); font-size: 10px; font-weight: 700; text-transform: uppercase; }
.p-info { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; }
.p-title { font-size: 16px; font-weight: 600; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.p-brand { font-size: 13px; color: var(--text-2); margin-bottom: 8px; font-weight: 500; }
.p-status { display: flex; align-items: center; gap: 8px; font-size: 11px; font-weight: 700; text-transform: uppercase; }

/* Modal / Editor */
.modal { position: fixed; inset: 0; z-index: 100; background: var(--bg); display: none; flex-direction: column; }
.modal.active { display: flex; }
.modal-header { padding: 12px 16px; padding-top: max(12px, env(safe-area-inset-top)); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; background: var(--bg); }
.modal-header h2 { font-size: 14px; flex: 1; text-align: center; margin: 0; }
.modal-body { flex: 1; overflow-y: auto; padding: 0; padding-bottom: calc(100px + env(safe-area-inset-bottom)); -webkit-overflow-scrolling: touch;}

/* Video Modal */
#videoModal { background: #000; z-index: 200; cursor: pointer; }
#vPlayer { width: 100%; height: 100%; object-fit: contain; }

.card { padding: 24px 16px; border-bottom: 1px solid var(--border); background: var(--bg); }
.card h3 { font-size: 13px; color: var(--text); margin-bottom: 16px; padding-bottom: 12px; display: block; border-bottom: 1px dashed var(--border); }

/* 3:4 Carousel Images - Taller (75%) */
.carousel { 
  display: flex; overflow-x: auto; gap: 12px; padding-bottom: 0px; 
  scroll-snap-type: x mandatory; margin-bottom: 16px;
  -webkit-overflow-scrolling: touch;
  -ms-overflow-style: none;
  scrollbar-width: none;
  transform: translateZ(0); /* Hardware acceleration */
}
.carousel::-webkit-scrollbar { display: none; }

.img-cell { 
  flex: 0 0 75%; aspect-ratio: 3/4; scroll-snap-align: center; 
  position: relative; cursor: pointer; 
  border: 1px solid var(--border); background: var(--surface-2);
  transition: border-color 0.15s ease, transform 0.1s ease;
}
.img-cell:active { transform: scale(0.98); }
.img-cell img { width: 100%; height: 100%; object-fit: cover; opacity: 0.5; transition: opacity 0.2s ease; }
.img-cell.on { border-color: transparent; box-shadow: inset 0 0 0 2px var(--text); }
.img-cell.on img { opacity: 1; }

/* Order Number Box */
.img-cell .check { 
  position: absolute; top: 12px; right: 12px; 
  width: 24px; height: 24px; border: 1px solid var(--text); background: transparent;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700; color: transparent;
  transition: background 0.1s, color 0.1s;
}
.img-cell.on .check { background: var(--text); border-color: var(--text); color: var(--bg); }

/* Extraction Animation Feedback */
@keyframes pulse-extract {
  0% { opacity: 1; }
  50% { opacity: 0.3; filter: grayscale(100%); }
  100% { opacity: 1; }
}
.extracting {
  animation: pulse-extract 1.5s infinite ease-in-out;
  pointer-events: none;
}

/* Form fields */
.field { margin-bottom: 16px; }
.field label { display: block; font-size: 11px; margin-bottom: 8px; color: var(--text-2); font-weight: 600; }
.field-row { display: flex; gap: 12px; }
.field-row .field { flex: 1; }

/* Actions Bar */
.actions-bar { position: fixed; bottom: 0; left: 0; right: 0; padding: 16px; padding-bottom: max(16px, env(safe-area-inset-bottom)); background: var(--bg); border-top: 1px solid var(--border); display: flex; gap: 12px; z-index: 50; }
.actions-bar button { flex: 1; }

.empty { padding: 40px 16px; text-align: center; color: var(--text-2); font-size: 13px; font-weight: 600; }

/* Loading & Utils */
.loading{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100dvh;gap:24px;color:var(--text)}
.spinner{width:32px;height:32px;border:2px solid var(--border);border-top-color:var(--text);border-radius:50%;animation:spin .8s linear infinite;}
@keyframes spin{to{transform:rotate(360deg)}}

.toast { position: fixed; top: max(16px, env(safe-area-inset-top)); left: 50%; transform: translate(-50%, -150px); background: var(--text); color: var(--bg); padding: 14px 24px; font-size: 12px; text-transform: uppercase; z-index: 300; transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1); border: 1px solid var(--text); font-weight: 700; white-space: nowrap; box-shadow: 0 10px 30px rgba(0,0,0,0.15);}
.toast.show { transform: translate(-50%, 0); }

.lazy-img { opacity: 0; transition: opacity 0.3s ease; }
.lazy-img.loaded { opacity: 1; }
.placeholder { background: var(--surface-2); }
</style>
</head>
<body>
<div id="app">
  <div id="loading" class="screen active">
    <div class="loading"><div class="spinner"></div><p class="empty" style="color:var(--text);">LOADING QUEUE...</p></div>
  </div>
  <div id="queue" class="screen">
    <div class="topbar">
      <h1>REVIEW QUEUE</h1>
      <span class="badge" id="qCount">0</span>
      <button class="theme-toggle" onclick="toggleTheme()">THEME</button>
      <button class="btn-ghost" onclick="loadQueue()" style="border:1px solid var(--border); padding:0 10px; font-size:10px; min-height:24px; height:24px;">REFRESH</button>
    </div>
    <div id="qList"></div>
  </div>
  <div id="review" class="screen">
    <div class="topbar">
      <button class="btn-ghost" onclick="showQueue()" style="border:1px solid var(--border); padding:8px 12px; font-size:12px;">BACK</button>
      <h1 id="rTitle" style="text-align:center;">ITEM</h1>
      <div id="rTopRight" style="width:70px; text-align:right;"></div>
    </div>
    <div class="hero">
      <img id="rImage" src="" alt="" loading="lazy" onclick="this.style.objectFit = this.style.objectFit === 'contain' ? 'cover' : 'contain'">
      <div class="hero-meta" id="rMeta"></div>
    </div>
    <div class="section">
      <h2>PRODUCTS <span class="badge" id="pCount">0</span></h2>
      <div id="pList"></div>
    </div>
    <div class="actions-bar">
      <button class="btn-danger" onclick="deleteItem()">DELETE ITEM</button>
      <button class="btn-primary" onclick="commitItem()">COMMIT ITEM</button>
    </div>
  </div>
  <div id="editor" class="modal">
    <div class="modal-header">
      <button class="btn-ghost" onclick="closeEditor()" style="border:1px solid var(--border); padding:8px 14px; font-size:12px; min-height:36px;">CANCEL</button>
      <h2>EDIT PRODUCT</h2>
      <button class="btn-primary" onclick="saveProduct('completed')" style="padding:8px 14px; font-size:12px; min-height:36px;">SAVE</button>
    </div>
    <div class="modal-body" id="eBody"></div>
  </div>
  
  <!-- Fullscreen Video Modal -->
  <div id="videoModal" class="modal" style="background:#000;" onclick="if(event.target === this) closeVideo()">
    <div style="position:absolute; top:max(16px, env(safe-area-inset-top)); right:16px; z-index:210;">
      <button class="btn-ghost" onclick="closeVideo()" style="background:rgba(255,255,255,0.2); color:#fff; border:none; width:44px; height:44px; border-radius:50%; display:flex; align-items:center; justify-content:center; padding:0;">X</button>
    </div>
    <div style="flex:1; display:flex; align-items:center; justify-content:center; height:100dvh; pointer-events:none;">
      <video id="vPlayer" controls playsinline style="max-width:100%; max-height:100%; outline:none; pointer-events:auto;"></video>
    </div>
  </div>

</div>
<div class="toast" id="toast"></div>
<script>
const state = { 
  queue: [], 
  posts: {}, 
  current: null, 
  editingIdx: null, 
  currentSelected: [], 
  currentGridUrls: [], 
  io: null,
  justEditedProdIdx: null,           // for scrolling back to the card we were editing
  formPersistKey: null               // current editor localStorage key
};

// Theme Toggle
function toggleTheme() {
  const root = document.documentElement;
  const current = root.getAttribute('data-theme');
  const newTheme = current === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', newTheme);
  document.getElementById('metaThemeColor').setAttribute('content', newTheme === 'dark' ? '#121212' : '#ffffff');
  localStorage.setItem('theme', newTheme);
}
// Init theme
if (localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
  document.documentElement.setAttribute('data-theme', 'dark');
  document.getElementById('metaThemeColor')?.setAttribute('content', '#121212');
}

function showScreen(id) {
  document.querySelectorAll(".screen, .modal").forEach(el => el.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 3000);
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

function copyRaw() {
   navigator.clipboard.writeText(state.current.response.rawText || "");
   toast('COPIED TO CLIPBOARD');
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
    const resText = await r.text();
    let data;
    try { data = JSON.parse(resText); } catch(e) { throw new Error(resText.slice(0, 100)); }
    
    state.posts = data.posts || {};
    state.queue = data.items || [];
  } catch(e) {
    state.posts = {};
    state.queue = [];
    toast("ERR: " + e.message);
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
    list.innerHTML = '<div class="empty">EMPTY QUEUE</div>';
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
          <div class="post-thumb"><img data-src="\${escapeHtml(thumb)}" alt="" class="lazy-img placeholder" onload="this.classList.remove('placeholder')" onerror="this.style.display='none'"></div>
          <div class="post-info">
            <div class="post-id">\${escapeHtml(pid)}</div>
            <div class="post-meta">\${items.length} ITEM(S) &middot; \${pending} PENDING</div>
          </div>
          <svg class="post-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
        </div>
        <div class="post-items" onclick="event.stopPropagation()">
          \${items.map(it => \`
            <div class="item-row" onclick="openItem('\${it._id}', \${it.fileIdx}, \${it.frameIdx !== null ? it.frameIdx : null})">
              <div class="item-thumb"><img data-src="\${escapeHtml(it.thumb)}" alt="" class="lazy-img placeholder" onload="this.classList.remove('placeholder')" onerror="this.style.display='none'"></div>
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
    toast("ERR: " + e.message);
    return;
  }
  renderItem();
  showScreen("review");
}

function renderItem() {
  const item = state.current;
  
  // Format alias link
  let igLink = 'https://www.instagram.com/' + item.postId + '/';
  if (!item.postId.startsWith('p/') && !item.postId.startsWith('reel/')) {
    igLink = 'https://www.instagram.com/p/' + item.postId + '/';
  }
  document.getElementById("rTitle").innerHTML = \`<a href="\${escapeHtml(igLink)}" target="_blank">\${escapeHtml(item.postId)}</a>\`;
  
  // Proxy Video Button
  if (item.type === 'frame' && item.parentUrl) {
    const proxyUrl = "/api/video?url=" + encodeURIComponent(item.parentUrl);
    document.getElementById('rTopRight').innerHTML = \`<button class="btn-ghost" onclick="openVideo('\${proxyUrl}')" style="border:1px solid var(--border); padding:8px 12px; min-height:0; font-size:12px; color:var(--text);">WATCH</button>\`;
  } else {
    document.getElementById('rTopRight').innerHTML = '';
  }

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
    if (item.response && item.response.rawText) {
      list.innerHTML = \`
        <div class="card" style="margin:16px;">
          <h3 style="color:var(--danger); border-bottom:1px solid var(--danger);">RAW AI STRING (PARSE FAILED)</h3>
          <div style="background:var(--surface-2); padding:12px; font-family:monospace; font-size:12px; white-space:pre-wrap; overflow-x:auto; margin-bottom:12px; border:1px solid var(--border);">\${escapeHtml(item.response.rawText)}</div>
          <button class="btn-ghost" style="width:100%; border:1px solid var(--border);" onclick="copyRaw()">COPY RAW RESPONSE</button>
        </div>
      \`;
    } else {
      list.innerHTML = '<div class="empty">NO PRODUCTS IDENTIFIED</div>';
    }
    return;
  }
  
  list.innerHTML = prods.map((p, i) => {
    let statusLabel = p.reviewStatus || "pending";
    let statusColor = "var(--text)";
    let rejectedClass = "";
    
    if (p.reviewStatus === "rejected") {
      statusLabel = "REJECTED";
      statusColor = "var(--text-2)";
      rejectedClass = "rejected";
    }

    const imgUrl = getImageUrl((p.selectedImages && p.selectedImages[0]) || (p.images && p.images[0]));
    const storeLabel = p.store ? \`\${escapeHtml(p.store)} &middot; \` : '';

    return \`
      <div class="p-card \${rejectedClass}" data-prod-idx="\${i}" onclick="openProduct(\${i})">
        <div class="p-img">\${imgUrl ? \`<img src="\${escapeHtml(imgUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">\` : \`<div class="no-img">N/A</div>\`}</div>
        <div class="p-info">
          <div class="p-title">\${escapeHtml(p.title || "UNTITLED")}</div>
          <div class="p-brand">\${storeLabel}\${escapeHtml(formatPrice(p.price))}</div>
          <div class="p-status" style="color:\${statusColor}">\u25A0 \${statusLabel}</div>
        </div>
      </div>
    \`;
  }).join("");

  // After returning from product editor, scroll the card we were just editing into view
  if (state.justEditedProdIdx !== null && prods.length > state.justEditedProdIdx) {
    const targetCard = list.querySelector(\`.p-card[data-prod-idx="\${state.justEditedProdIdx}"]\`);
    if (targetCard) {
      // Use requestAnimationFrame so layout is ready
      requestAnimationFrame(() => {
        targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
    state.justEditedProdIdx = null;
  }
}

function openVideo(url) {
  const v = document.getElementById('vPlayer');
  v.src = url;
  document.getElementById('videoModal').classList.add('active');
  v.play().catch(e => console.error(e));
}
function closeVideo() {
  const v = document.getElementById('vPlayer');
  v.pause();
  v.src = '';
  document.getElementById('videoModal').classList.remove('active');
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

// Generate stable key for persisting unsaved editor form state
function getFormPersistKey() {
  if (!state.current || state.editingIdx === null) return null;
  const fid = state.current.frameIdx !== null && state.current.frameIdx !== undefined 
    ? `f${state.current.frameIdx}` 
    : `img${state.current.fileIdx}`;
  return `reviewForm_${state.current._id}_${fid}_${state.editingIdx}`;
}

function saveFormToLocalStorage() {
  const key = state.formPersistKey;
  if (!key) return;
  try {
    const data = {
      title: document.getElementById("eTitle")?.value || "",
      store: document.getElementById("eStore")?.value || "",
      url: document.getElementById("eUrl")?.value || "",
      brand: document.getElementById("eBrand")?.value || "",
      category: document.getElementById("eCategory")?.value || "",
      price: document.getElementById("ePrice")?.value || "",
      currency: document.getElementById("eCurrency")?.value || "",
      basePrice: document.getElementById("eBasePrice")?.value || "",
      availability: document.getElementById("eAvail")?.value || "",
      markupType: document.getElementById("eMarkupType")?.value || "",
      markupVal: document.getElementById("eMarkupVal")?.value || "",
      shippingCost: document.getElementById("eShippingCost")?.value || "",
      shippingCov: document.getElementById("eShippingCov")?.value || "",
      sizes: document.getElementById("eSizes")?.value || "",
      desc: document.getElementById("eDesc")?.value || "",
      sizingGuide: document.getElementById("eSizingGuide")?.value || "",
      shipping: document.getElementById("eShipping")?.value || "",
      // Note: selectedImages & currentGridUrls are already in state, persisted via normal flow
    };
    localStorage.setItem(key, JSON.stringify(data));
  } catch(e) { /* ignore quota errors */ }
}

function restoreFormFromLocalStorage() {
  const key = state.formPersistKey;
  if (!key) return;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const data = JSON.parse(raw);

    const setVal = (id, val) => { 
      const el = document.getElementById(id); 
      if (el && val != null) el.value = val; 
    };

    setVal("eTitle", data.title);
    setVal("eStore", data.store);
    setVal("eUrl", data.url);
    setVal("eBrand", data.brand);
    setVal("eCategory", data.category);
    setVal("ePrice", data.price);
    setVal("eCurrency", data.currency);
    setVal("eBasePrice", data.basePrice);
    setVal("eAvail", data.availability);
    setVal("eMarkupType", data.markupType);
    setVal("eMarkupVal", data.markupVal);
    setVal("eShippingCost", data.shippingCost);
    setVal("eShippingCov", data.shippingCov);
    setVal("eSizes", data.sizes);
    setVal("eDesc", data.desc);
    setVal("eSizingGuide", data.sizingGuide);
    setVal("eShipping", data.shipping);

    // Optional toast so user knows we restored unsaved work
    if (data.title || data.store) {
      // silent restore is usually better; only toast if significant
    }
  } catch(e) { /* corrupted data, ignore */ }
}

function clearFormPersist(key) {
  if (key) localStorage.removeItem(key);
}

function openProduct(idx) {
  state.editingIdx = idx;
  const p = state.current.response.products[idx];
  const allImages = getAllImages(p);
  
  state.currentSelected = [...(p.selectedImages || [])];
  
  // Reorder for the UI: selected images first in their chosen sequence, then unselected
  const sortedUrls = [...state.currentSelected];
  allImages.urls.forEach(u => {
    if (!sortedUrls.includes(u)) sortedUrls.push(u);
  });
  state.currentGridUrls = sortedUrls;

  // Setup persistence key for this specific product edit session
  state.formPersistKey = getFormPersistKey();
  
  let html = \`
    <div class="card" style="padding-bottom: 0;">
      <h3 style="display:flex; justify-content:space-between; align-items:center; border:none; margin-bottom:12px; gap:12px;">
        IMAGES 
        <span style="color:var(--text-2); font-weight:normal; text-transform:none; font-size:12px;">
          <span id="selCount">\${state.currentSelected.length}</span> SELECTED
        </span>
      </h3>
      <div class="carousel" id="eImgGrid"></div>
      <div style="display:flex; gap:8px; margin-bottom:16px;">
        <button class="btn-ghost" onclick="addImage()" style="flex:1; border:1px dashed var(--border); min-height:48px;">+ PASTE IMAGE URL</button>
        <button class="btn-ghost" onclick="clearSelection()" style="flex:1; border:1px dashed var(--border); min-height:48px; color:var(--danger);">CLEAR SELECTION</button>
      </div>
    </div>
    <div class="card">
      <h3>AI VIABILITY: \${p.dropshipViability?.score || '?'} / 10</h3>
      <p style="font-size: 13px; color: var(--text-2); line-height: 1.5;">\${escapeHtml(p.dropshipViability?.reasoning || 'N/A')}</p>
    </div>
    <div class="card">
      <h3>BASIC INFO</h3>
      <div class="field"><label>Product Title</label><input id="eTitle" value="\${escapeHtml(p.title || "")}"></div>
      
      <div class="field-row">
        <div class="field"><label>Store / Supplier Name</label><input id="eStore" value="\${escapeHtml(p.store || "")}"></div>
        <div class="field"><label>Brand</label><input id="eBrand" value="\${escapeHtml(p.brand || "")}"></div>
      </div>

      <div class="field" style="margin-bottom:24px;">
        <label>Supplier URL</label>
        <div style="display:flex; gap:8px;">
          <input id="eUrl" type="url" value="\${escapeHtml(p.url || "")}" style="flex:1;">
          \${p.url ? \`<a href="\${escapeHtml(p.url)}" target="_blank" rel="noopener" class="btn-ghost" style="border:1px solid var(--border); padding:0 16px; display:flex; align-items:center; justify-content:center; font-size:12px; text-decoration:none;">VISIT</a>\` : ''}
        </div>
        <div style="display:flex; gap:8px; margin-top:8px;">
          <button id="btnExtractLazy" class="btn-ghost" style="flex:1; font-size:11px; min-height:48px; padding:0; background:var(--surface-2); border:1px solid var(--border);" onclick="extractImages('lazy')">EXTRACT (LAZY)</button>
          <button id="btnExtractFull" class="btn-ghost" style="flex:1; font-size:11px; min-height:48px; padding:0; background:var(--surface-2); border:1px solid var(--border);" onclick="extractImages('full')">EXTRACT (FULL)</button>
        </div>
      </div>

      <div class="field"><label>Category</label><input id="eCategory" value="\${escapeHtml(p.category || "")}"></div>
      <div class="field-row">
        <div class="field"><label>Price</label><input id="ePrice" inputmode="decimal" value="\${escapeHtml((p.price && p.price.current) ? p.price.current : "")}"></div>
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
      <div class="field"><label>Base Price</label><input id="eBasePrice" inputmode="decimal" value="\${escapeHtml(p.basePrice || "")}"></div>
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
          <input id="eMarkupVal" inputmode="decimal" value="\${escapeHtml(p.recommendedMarkup?.value || '')}">
        </div>
      </div>
      <div class="field-row">
        <div class="field"><label>Shipping Cost</label><input id="eShippingCost" inputmode="decimal" value="\${escapeHtml(p.recommendedShippingRate?.amount || '')}"></div>
        <div class="field"><label>Shipping Cov</label><input id="eShippingCov" value="\${escapeHtml(p.recommendedShippingRate?.coverage || '')}"></div>
      </div>
      <div class="field"><label>Sizes (CSV)</label><input id="eSizes" value="\${escapeHtml((p.sizing || []).join(", "))}"></div>
      <div class="field"><label>Description</label><textarea id="eDesc">\${escapeHtml(p.description || "")}</textarea></div>
      <div class="field"><label>Sizing Guide</label><textarea id="eSizingGuide">\${escapeHtml(p.sizingGuide || "")}</textarea></div>
      <div class="field"><label>Shipping & Returns</label><textarea id="eShipping">\${escapeHtml(p.shippingAndReturns || "")}</textarea></div>
    </div>
    <div class="card" style="border-bottom:none;">
      <h3>ACTIONS</h3>
      <div style="display:flex;gap:12px">
        <button class="btn-danger" onclick="rejectProduct()" style="flex:1">REJECT</button>
        <button class="btn-primary" onclick="saveProduct('completed')" style="flex:1">SAVE</button>
      </div>
    </div>
  \`;
  
  document.getElementById("eBody").innerHTML = html;
  renderImgGrid(state.currentGridUrls);
  updateSelCount();
  showScreen("editor");
  document.getElementById("eBody").scrollTop = 0;

  // Restore any unsaved work from previous session (crash / accidental back)
  restoreFormFromLocalStorage();

  // Auto-save form state to localStorage on any change (robust against refresh/crash)
  const editorBody = document.getElementById("eBody");
  if (editorBody) {
    editorBody.addEventListener('input', () => saveFormToLocalStorage(), { passive: true });
    editorBody.addEventListener('change', () => saveFormToLocalStorage(), { passive: true });
  }
}

function updateSelCount() {
  const el = document.getElementById('selCount');
  if (el) el.textContent = state.currentSelected.length;
}

function toggleImageSelection(url) {
  const idx = state.currentSelected.indexOf(url);
  if (idx > -1) {
    state.currentSelected.splice(idx, 1);
  } else {
    state.currentSelected.push(url);
  }
  renderImgGrid(state.currentGridUrls);
  updateSelCount();
}

function clearSelection() {
  if (!confirm('CLEAR ALL SELECTED IMAGES?')) return;
  state.currentSelected = [];
  renderImgGrid(state.currentGridUrls);
  updateSelCount();
  toast('SELECTION CLEARED — TAP IMAGES IN DESIRED ORDER');
}

function renderImgGrid(urls) {
  const grid = document.getElementById("eImgGrid");
  if (!urls.length) {
    grid.innerHTML = '<div class="empty" style="flex:1;">NO IMAGES</div>';
    return;
  }
  
  grid.innerHTML = urls.map(url => {
    const selIdx = state.currentSelected.indexOf(url);
    const isOn = selIdx > -1;
    const num = isOn ? (selIdx + 1) : '';

    return \`
      <div class="img-cell \${isOn ? 'on' : ''}" onclick="toggleImageSelection('\${escapeHtml(url)}')">
        <img src="\${escapeHtml(url)}" loading="lazy" alt="" onload="this.classList.add('loaded')" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%25%22 height=%22100%25%22><rect width=%22100%25%22 height=%22100%25%22 fill=%22%23f5f5f5%22/><text x=%2250%25%22 y=%2250%25%22 fill=%22%23999%22 font-family=%22sans-serif%22 font-size=%2212%22 text-anchor=%22middle%22 dy=%22.3em%22>BROKEN URL</text></svg>'">
        <div class="check">\${num}</div>
      </div>
    \`;
  }).join("");
}

async function addImage() {
  let url = "";
  try {
    const text = await navigator.clipboard.readText();
    if (text && /^https?:\\/\\//i.test(text.trim())) {
      url = text.trim();
    }
  } catch (err) {
    console.warn("Clipboard read skipped/failed:", err);
  }
  
  if (!url) {
    url = prompt("NO URL FOUND IN CLIPBOARD.\\n\\nPASTE IMAGE URL MANUALLY:");
  }
  
  if (!url) return;
  url = url.trim();
  
  if (!/^https?:\\/\\//i.test(url)) {
    return toast("INVALID URL");
  }
  
  const p = state.current.response.products[state.editingIdx];
  p.customImages = p.customImages || [];
  if (!p.customImages.includes(url)) p.customImages.push(url);
  
  const wasSelected = state.currentSelected.includes(url);
  if (!wasSelected) state.currentSelected.push(url);
  if (!state.currentGridUrls.includes(url)) state.currentGridUrls.unshift(url);
  
  renderImgGrid(state.currentGridUrls);
  updateSelCount();
  toast(wasSelected ? "IMAGE ALREADY IN LIST" : "IMAGE ADDED + SELECTED");
}

async function extractImages(mode) {
  const url = document.getElementById("eUrl").value;
  if (!url) return toast("NO URL PROVIDED");
  
  const carousel = document.getElementById("eImgGrid");
  const btnLazy = document.getElementById("btnExtractLazy");
  const btnFull = document.getElementById("btnExtractFull");

  if (carousel) carousel.classList.add("extracting");
  if (btnLazy) { btnLazy.disabled = true; btnLazy.innerText = mode==='lazy' ? "EXTRACTING..." : "EXTRACT (LAZY)"; }
  if (btnFull) { btnFull.disabled = true; btnFull.innerText = mode==='full' ? "EXTRACTING..." : "EXTRACT (FULL)"; }
  
  try {
    const r = await fetch("/api/extract", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, mode })
    });
    
    const resText = await r.text();
    let d;
    try { d = JSON.parse(resText); } catch(err) { throw new Error(resText.slice(0, 100)); }

    if (d.error) throw new Error(d.error);
    
    if (d.images && d.images.length > 0) {
      const p = state.current.response.products[state.editingIdx];
      
      // Deduplicate against existing images and limit payload to 20
      const newUnique = d.images.filter(imgUrl => !state.currentGridUrls.includes(imgUrl)).slice(0, 20);
      
      if (newUnique.length > 0) {
        p.customImages = p.customImages || [];
        p.customImages = [...newUnique, ...p.customImages];
        state.currentGridUrls = [...newUnique, ...state.currentGridUrls];
        
        // Auto-select newly extracted images (they appear first)
        newUnique.forEach(u => {
          if (!state.currentSelected.includes(u)) state.currentSelected.push(u);
        });
        
        renderImgGrid(state.currentGridUrls);
        updateSelCount();
        toast(\`EXTRACTED \${newUnique.length} NEW IMAGES (AUTO-SELECTED)\`);
      } else {
        toast("NO NEW IMAGES FOUND (ALL DUPES)");
      }
    } else {
      toast("NO IMAGES EXTRACTED");
    }
  } catch(e) {
    toast("ERROR: " + e.message);
  } finally {
    if (carousel) carousel.classList.remove("extracting");
    if (btnLazy) { btnLazy.disabled = false; btnLazy.innerText = "EXTRACT (LAZY)"; }
    if (btnFull) { btnFull.disabled = false; btnFull.innerText = "EXTRACT (FULL)"; }
  }
}

async function saveProduct(status = "completed") {
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
  
  // Save custom images array
  p.customImages = p.customImages || [];
  
  // Set ordered selection directly from state array
  p.selectedImages = [...state.currentSelected];
  
  p.reviewStatus = status;
  p.reviewedAt = new Date().toISOString();
  
  try {
    const body = { docId: state.current._id, fileIdx: state.current.fileIdx, frameIdx: state.current.frameIdx, prodIdx: idx, product: p };
    const r = await fetch("/api/product", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error("Save failed");
    
    // Clear persisted draft + remember which card to scroll back to
    clearFormPersist(state.formPersistKey);
    state.justEditedProdIdx = idx;
    
    toast(status === "rejected" ? "REJECTED" : "SAVED");
    renderItem();
    closeEditor();
  } catch(e) {
    toast("ERROR: " + e.message);
  }
}

function rejectProduct() {
  const idx = state.editingIdx;
  const p = state.current.response.products[idx];
  state.currentSelected = [];
  saveProduct("rejected");
}

function closeEditor() { 
  clearFormPersist(state.formPersistKey);
  state.formPersistKey = null;
  showScreen("review"); 
}

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

// Keyboard shortcuts (Escape closes modals, power user friendly)
function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const videoModal = document.getElementById('videoModal');
      const editorModal = document.getElementById('editor');
      if (videoModal.classList.contains('active')) {
        closeVideo();
      } else if (editorModal.classList.contains('active')) {
        closeEditor();
      } else if (document.getElementById('review').classList.contains('active')) {
        showQueue();
      }
    }
    // Future: could add 's' for save when in editor, etc.
  });
}

loadQueue();
initKeyboard();
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
    let rawText = null;
    
    if (typeof resp === 'string') {
        try { 
            resp = JSON.parse(resp); 
        } catch { 
            rawText = resp;
            resp = { products: [] }; 
        }
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

    if (rawText) resp.rawText = rawText;
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

/**
 * When a product is reviewed, propagate the human review decisions (status, selected images,
 * overrides) to any *other* items/frames in the SAME post that have a product with the exact
 * same supplier URL. This prevents the reviewer from having to do duplicate work.
 */
async function propagateReviewToSameSources(collection, docId, sourceUrl, updatedProduct, currentFileIdx, currentFrameIdx) {
  if (!sourceUrl) return 0; // nothing to propagate without a URL to match on

  try {
    const post = await collection.findOne(
      { _id: new ObjectId(docId) },
      { projection: { file_urls: 1 } }
    );
    if (!post || !Array.isArray(post.file_urls)) return 0;

    let updatedCount = 0;

    for (let fi = 0; fi < post.file_urls.length; fi++) {
      const f = post.file_urls[fi];
      if (!f || f.discarded) continue;

      // Check main image item
      if (f.type === 'image' && f.response && Array.isArray(f.response.products)) {
        for (let pi = 0; pi < f.response.products.length; pi++) {
          const prod = f.response.products[pi];
          if (prod.url === sourceUrl) {
            // Found a match in another (or same) item — apply review fields
            const setObj = {};
            const base = `file_urls.${fi}.response.products.${pi}`;

            // Propagate key human decisions
            setObj[`${base}.reviewStatus`] = updatedProduct.reviewStatus;
            setObj[`${base}.selectedImages`] = updatedProduct.selectedImages || [];
            setObj[`${base}.reviewedAt`] = new Date();
            setObj[`${base}.price`] = updatedProduct.price;
            setObj[`${base}.recommendedMarkup`] = updatedProduct.recommendedMarkup;
            setObj[`${base}.recommendedShippingRate`] = updatedProduct.recommendedShippingRate;
            setObj[`${base}.availability`] = updatedProduct.availability;

            await collection.updateOne({ _id: new ObjectId(docId) }, { $set: setObj });
            updatedCount++;
          }
        }
      }

      // Check frames inside video
      if (f.type === 'video' && Array.isArray(f.frames)) {
        for (let fr = 0; fr < f.frames.length; fr++) {
          const frame = f.frames[fr];
          if (!frame || frame.discarded || !frame.response || !Array.isArray(frame.response.products)) continue;

          for (let pi = 0; pi < frame.response.products.length; pi++) {
            const prod = frame.response.products[pi];
            if (prod.url === sourceUrl) {
              const setObj = {};
              const base = `file_urls.${fi}.frames.${fr}.response.products.${pi}`;

              setObj[`${base}.reviewStatus`] = updatedProduct.reviewStatus;
              setObj[`${base}.selectedImages`] = updatedProduct.selectedImages || [];
              setObj[`${base}.reviewedAt`] = new Date();
              setObj[`${base}.price`] = updatedProduct.price;
              setObj[`${base}.recommendedMarkup`] = updatedProduct.recommendedMarkup;
              setObj[`${base}.recommendedShippingRate`] = updatedProduct.recommendedShippingRate;
              setObj[`${base}.availability`] = updatedProduct.availability;

              await collection.updateOne({ _id: new ObjectId(docId) }, { $set: setObj });
              updatedCount++;
            }
          }
        }
      }
    }

    if (updatedCount > 0) {
      log('info', `Propagated review to ${updatedCount} duplicate source(s) in same post (url: ${sourceUrl})`);
    }
    return updatedCount;
  } catch (err) {
    log('warn', 'Propagation failed:', err.message);
    return 0;
  }
}

/* -------------------------------------------------------------------------- */
/* EXTERNAL API HELPERS (Catbox Upload & Python Extract)                      */
/* -------------------------------------------------------------------------- */

async function uploadToCatbox(base64Data, filename) {
    const base64Content = base64Data.split(',')[1];
    const buffer = Buffer.from(base64Content, 'base64');
    const blob = new Blob([buffer]);
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('fileToUpload', blob, filename || 'paste.jpg');
    
    const res = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: form });
    const url = (await res.text()).trim();
    if (!url.startsWith('http')) throw new Error('Upload failed: ' + url);
    return url;
}

async function runPythonExtractor(targetUrl, mode) {
    return new Promise((resolve, reject) => {
        const runId = crypto.randomBytes(4).toString('hex');
        const inFile = path.join(os.tmpdir(), `in_${runId}.json`);
        const outFile = path.join(os.tmpdir(), `out_${runId}.json`);
        
        fs.writeFileSync(inFile, JSON.stringify([targetUrl]));

        // Ensure we point precisely to the script in the workspace root
        const scriptPath = path.resolve(process.cwd(), 'ecom-image-extractor.py');
        
        if (!fs.existsSync(scriptPath)) {
            try { fs.unlinkSync(inFile); } catch(e){}
            return reject(new Error('ecom-image-extractor.py NOT FOUND in current working directory. Please place the Python extractor script next to review-server.js'));
        }

        const args = [scriptPath, '-u', inFile, '-o', outFile];
        
        if (mode === 'lazy') {
            args.push('--lazy-extraction');
        } else {
            args.push('--no-lazy-extraction');
            args.push('--adaptive-cutoff');
        }

        log('info', `Running extractor (${mode}): python3 ${args.join(' ')}`);
        const proc = spawn('python3', args);
        
        let stderr = '';
        proc.stdout.on('data', d => log('debug', `[PYTHON] ${d.toString().trim()}`));
        proc.stderr.on('data', d => {
            const out = d.toString();
            stderr += out;
            log('warn', `[PYTHON ERR] ${out.trim()}`);
        });

        proc.on('close', code => {
            if (code !== 0) {
                try { fs.unlinkSync(inFile); fs.unlinkSync(outFile); } catch(e){}
                return reject(new Error(`Extractor crashed (code ${code}). Check logs. Stderr: ${stderr.slice(0,200)}`));
            }
            try {
                if (!fs.existsSync(outFile)) throw new Error("No output generated by python script.");
                const resultData = JSON.parse(fs.readFileSync(outFile, 'utf8'));
                fs.unlinkSync(inFile); fs.unlinkSync(outFile);
                
                const images = resultData[targetUrl] || [];
                if (images.error) throw new Error(images.error);
                
                log('info', `Extraction success: ${images.length} images found.`);
                resolve(images.map(i => i.url));
            } catch (err) {
                reject(err);
            }
        });
    });
}

/* -------------------------------------------------------------------------- */
/* NGROK                                                                      */
/* -------------------------------------------------------------------------- */
async function startNgrok(port) {
    try {
        const { spawn } = await import('child_process');
        
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
    log('info', '  REVIEW SERVER — Production Human Review v1.1');
    log('info', '===============================================================');

    if (!CONFIG.mongodb.uri) {
        log('error', 'ORCH_MONGODB_URI is required');
        process.exit(1);
    }

    log('info', 'Connecting to MongoDB...');
    const client = new MongoClient(CONFIG.mongodb.uri, { 
        serverSelectionTimeoutMS: 15000,
        maxPoolSize: 10 
    });
    await client.connect();
    const db = client.db(CONFIG.mongodb.db);
    const collection = db.collection(CONFIG.mongodb.collection);
    log('info', `Connected: ${CONFIG.mongodb.db}.${CONFIG.mongodb.collection}`);
    log('info', `HF Token for video proxy: ${CONFIG.hfToken ? 'PRESENT' : 'MISSING (private videos may fail)'}`);

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
        
        if (parsed.pathname === '/api/video' && req.method === 'GET') {
            try {
                const vidUrl = parsed.searchParams.get('url');
                if (!vidUrl) { res.writeHead(400); res.end('No video url specified'); return; }
                
                const fetchHeaders = {};
                if (req.headers.range) fetchHeaders.range = req.headers.range;
                if (CONFIG.hfToken) fetchHeaders['Authorization'] = `Bearer ${CONFIG.hfToken}`;
                
                const fRes = await fetch(vidUrl, { headers: fetchHeaders });
                const resHeaders = {};
                fRes.headers.forEach((v, k) => {
                    // Filter out content-encoding because we are streaming the raw bytes
                    if (k.toLowerCase() !== 'content-encoding') resHeaders[k] = v;
                });
                
                res.writeHead(fRes.status, resHeaders);
                if (fRes.body) {
                    Readable.fromWeb(fRes.body).pipe(res);
                } else {
                    res.end();
                }
            } catch (e) {
                res.writeHead(500); res.end(e.message);
            }
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

                let objectId;
                try {
                    objectId = new ObjectId(docId);
                } catch {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Invalid document ID' }));
                    return;
                }

                const post = await collection.findOne(
                    { _id: objectId },
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
                        { _id: objectId },
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
                    parentUrl: item.parentUrl || null,
                    type: item.type,
                    response
                }));
            } catch (e) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: e.message }));
            }
            return;
        }

        if (parsed.pathname === '/api/upload' && req.method === 'POST') {
            let body = '';
            req.on('data', d => body += d);
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body);
                    if (!data.image) throw new Error("No image data");
                    const url = await uploadToCatbox(data.image, data.filename || 'paste.jpg');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ url }));
                } catch (e) {
                    res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }

        if (parsed.pathname === '/api/extract' && req.method === 'POST') {
            let body = '';
            req.on('data', d => body += d);
            req.on('end', async () => {
                try {
                    const { url, mode } = JSON.parse(body);
                    if (!url) throw new Error("No URL provided");
                    const images = await runPythonExtractor(url, mode);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ images }));
                } catch (e) {
                    res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
                }
            });
            return;
        }

        if (parsed.pathname === '/api/product' && req.method === 'POST') {
            let body = '';
            req.on('data', d => body += d);
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body);
                    const { docId, fileIdx, frameIdx, prodIdx, product } = data;

                    let objectId;
                    try {
                        objectId = new ObjectId(docId);
                    } catch {
                        res.writeHead(400);
                        res.end(JSON.stringify({ error: 'Invalid document ID' }));
                        return;
                    }

                    const basePath = frameIdx !== null && frameIdx !== undefined
                        ? `file_urls.${fileIdx}.frames.${frameIdx}.response.products.${prodIdx}`
                        : `file_urls.${fileIdx}.response.products.${prodIdx}`;

                    await collection.updateOne(
                        { _id: objectId },
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

                    // === SMART DUPLICATE PROPAGATION ===
                    // If this product has a supplier URL, apply the same review decisions to any other
                    // items/frames in this same post that reference the exact same source URL.
                    // This dramatically reduces duplicate review work across frames of a reel/post.
                    if (product.url) {
                      propagateReviewToSameSources(
                        collection,
                        docId,
                        product.url,
                        product,
                        fileIdx,
                        frameIdx
                      ).catch(e => log('warn', 'Propagation error (non-fatal):', e.message));
                    }

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

                    let objectId;
                    try {
                        objectId = new ObjectId(docId);
                    } catch {
                        res.writeHead(400);
                        res.end(JSON.stringify({ error: 'Invalid document ID' }));
                        return;
                    }

                    const path = frameIdx !== null && frameIdx !== undefined
                        ? `file_urls.${fileIdx}.frames.${frameIdx}`
                        : `file_urls.${fileIdx}`;

                    await collection.updateOne(
                        { _id: objectId },
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

                    let objectId;
                    try {
                        objectId = new ObjectId(docId);
                    } catch {
                        res.writeHead(400);
                        res.end(JSON.stringify({ error: 'Invalid document ID' }));
                        return;
                    }

                    const path = frameIdx !== null && frameIdx !== undefined
                        ? `file_urls.${fileIdx}.frames.${frameIdx}`
                        : `file_urls.${fileIdx}`;

                    await collection.updateOne(
                        { _id: objectId },
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
