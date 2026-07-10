/**
 * review-server.js
 *
 * Production human review server for the UGC dropship pipeline.
 * Brutalist Native Apple Aesthetic, lazy loading, Python AI extraction.
 *
 * Env: ORCH_MONGODB_URI, ORCH_MONGODB_DB, ORCH_MONGODB_COLLECTION
 *      REVIEW_PORT (default 3456), ORCH_HF_TOKEN
 *
 * FINAL PRODUCTION v2.2.1 - Table horizontal scrolling, Clipboard URL pasting,
 * Auto-scroll on Cancel, Scoped rejections, In-memory URL deduplication & DB Sync.
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
<title>DropShip Review • v2.2</title>
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
  --warning: #ca8a04;
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
  --warning: #eab308;
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
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--text); }
textarea { resize: vertical; min-height: 100px; }
select {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%23737373'%3E%3Cpath d='M6 8L1 3h10z'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 14px center;
  padding-right: 32px;
}

/* Tables */
.simple-table-wrapper { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; padding-bottom: 8px; margin-top: 8px; }
.simple-table { min-width: 500px; width: 100%; border-collapse: collapse; font-size: 14px; }
.simple-table th { background: var(--surface-2); padding: 12px 8px; font-size: 12px; color: var(--text-2); text-transform: uppercase; font-weight: 600; text-align: left; }
.simple-table td { border: 1px solid var(--border); padding: 0; }
.simple-table input, .simple-table select { border: none; min-height: 48px; padding: 12px 8px; font-size: 14px; width: 100%; }
.simple-table input:focus, .simple-table select:focus { box-shadow: inset 0 0 0 1px var(--text); }
.table-btn { width: 48px; min-height: 48px; padding: 0; display: flex; align-items: center; justify-content: center; color: var(--danger); font-weight: bold; border: none; background: transparent; font-size: 18px; }

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
.badge.src-status { color: var(--text); background: var(--surface-2); border-color: var(--border); }
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

.product-group-title { font-size: 11px; padding: 16px 16px 8px; color: var(--text-2); background: var(--surface-2); border-bottom: 1px solid var(--border); text-transform: uppercase; letter-spacing: 0.05em; font-weight: 700; }

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
.p-status { display: flex; align-items: center; gap: 8px; font-size: 11px; font-weight: 700; text-transform: uppercase; margin-top: 4px; }

/* Modal / Editor */
.modal { position: fixed; inset: 0; z-index: 100; background: var(--bg); display: none; flex-direction: column; }
.modal.active { display: flex; }
.modal-header { padding: 12px 16px; padding-top: max(12px, env(safe-area-inset-top)); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; background: var(--bg); }
.modal-header h2 { font-size: 14px; flex: 1; text-align: center; margin: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.modal-body { flex: 1; overflow-y: auto; padding: 0; padding-bottom: calc(100px + env(safe-area-inset-bottom)); -webkit-overflow-scrolling: touch;}

/* Video Modal */
#videoModal { background: #000; z-index: 200; cursor: pointer; }
#vPlayer { width: 100%; height: 100%; object-fit: contain; }

.card { padding: 24px 16px; border-bottom: 1px solid var(--border); background: var(--bg); }
.card h3 { font-size: 13px; color: var(--text); margin-bottom: 16px; padding-bottom: 12px; display: block; border-bottom: 1px dashed var(--border); text-transform: uppercase; letter-spacing: 0.02em; font-weight: 700; }

details.card { padding: 0; }
details.card > summary { padding: 24px 16px; font-size: 13px; color: var(--text); font-weight: 700; text-transform: uppercase; letter-spacing: 0.02em; cursor: pointer; list-style: none; display: flex; justify-content: space-between; align-items: center; }
details.card > summary::after { content: '+'; font-size: 16px; font-weight: 400; }
details[open].card > summary { border-bottom: 1px dashed var(--border); }
details[open].card > summary::after { content: '−'; }
details.card > .details-content { padding: 16px; border-top: 1px solid var(--border); }

/* 3:4 Carousel Images - Taller (75%) */
.carousel { 
  display: flex; overflow-x: auto; gap: 12px; padding-bottom: 0px; 
  scroll-snap-type: x mandatory; margin-bottom: 16px;
  -webkit-overflow-scrolling: touch;
  -ms-overflow-style: none;
  scrollbar-width: none;
  transform: translateZ(0);
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

.img-cell .check { 
  position: absolute; top: 12px; right: 12px; 
  width: 24px; height: 24px; border: 1px solid var(--text); background: transparent;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px; font-weight: 700; color: transparent;
  transition: background 0.1s, color 0.1s;
}
.img-cell.on .check { background: var(--text); border-color: var(--text); color: var(--bg); }

@keyframes pulse-extract {
  0% { opacity: 1; }
  50% { opacity: 0.3; filter: grayscale(100%); }
  100% { opacity: 1; }
}
.extracting { animation: pulse-extract 1.5s infinite ease-in-out; pointer-events: none; }

/* Form fields */
.field { margin-bottom: 16px; }
.field label { display: block; font-size: 11px; margin-bottom: 8px; color: var(--text-2); font-weight: 600; text-transform: uppercase; }
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
  
  <!-- QUEUE SCREEN -->
  <div id="queue" class="screen">
    <div class="topbar">
      <h1>REVIEW QUEUE</h1>
      <span class="badge" id="qCount">0</span>
      <button class="theme-toggle" onclick="toggleTheme()">THEME</button>
      <button class="btn-ghost" onclick="loadQueue()" style="border:1px solid var(--border); padding:0 10px; font-size:10px; min-height:24px; height:24px;">REFRESH</button>
    </div>
    <div id="qList"></div>
  </div>

  <!-- REVIEW SCREEN (Item Level) -->
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
      <h2>SOURCES <span class="badge" id="pCount">0</span></h2>
      <div id="pList"></div>
    </div>
    <div class="actions-bar">
      <button class="btn-danger" onclick="deleteItem()">DISCARD ITEM</button>
      <button class="btn-primary" id="btnCommitItem" onclick="commitItem()">COMMIT ITEM</button>
    </div>
  </div>

  <!-- EDITOR MODAL (Source Level) -->
  <div id="editor" class="modal">
    <div class="modal-header">
      <button class="btn-ghost" onclick="closeEditor()" style="border:1px solid var(--border); padding:8px 14px; font-size:12px; min-height:36px;">CANCEL</button>
      <h2 id="eModalTitle">EDIT SOURCE</h2>
      <button class="btn-primary" onclick="saveSource('completed')" style="padding:8px 14px; font-size:12px; min-height:36px;">SAVE</button>
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
  editingPIdx: null,
  editingSIdx: null, 
  currentSelected: [], 
  currentGridUrls: [], 
  currentVariants: [],
  currentSizeGuide: { headers: [], rows: [] },
  io: null,
  justEditedSId: null,
  formPersistKey: null
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

// Safely parse messy string numbers (e.g. "$120.00" -> 120.00)
function getSafeNumber(val) {
  if (val == null || val === '') return '';
  const str = String(val).replace(/[^0-9.-]/g, '');
  const num = parseFloat(str);
  return isNaN(num) ? '' : num.toFixed(2);
}

function formatPrice(p, fallbackCurrency = "USD") {
  if (p == null || p === "") return "TBD";
  let num = '';
  let curr = fallbackCurrency || '';
  
  if (typeof p === "number" || typeof p === "string") {
    num = getSafeNumber(p);
  } else if (typeof p === "object" && p !== null) {
    num = getSafeNumber(p.current);
    if (p.currency) curr = p.currency;
  }
  
  return num !== '' ? num + (curr ? " " + curr : "") : "TBD";
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

/* --- Local Storage Draft Saving --- */
function getFormPersistKey() {
  if (!state.current || state.editingPIdx === null || state.editingSIdx === null) return null;
  const fid = state.current.frameIdx !== null ? \`f\${state.current.frameIdx}\` : \`img\${state.current.fileIdx}\`;
  return \`reviewV2_\${state.current._id}_\${fid}_p\${state.editingPIdx}_s\${state.editingSIdx}\`;
}

function saveFormToLocalStorage() {
  const key = state.formPersistKey;
  if (!key) return;
  
  syncVariantsFromDOM();
  syncSizeGuideFromDOM();

  try {
    const data = {
      name: document.getElementById("eTitle")?.value || "",
      brand: document.getElementById("eBrand")?.value || "",
      vendor: document.getElementById("eVendor")?.value || "",
      url: document.getElementById("eUrl")?.value || "",
      category: document.getElementById("eCategory")?.value || "",
      price: document.getElementById("ePrice")?.value || "",
      comparePrice: document.getElementById("eComparePrice")?.value || "",
      currency: document.getElementById("eCurrency")?.value || "",
      availability: document.getElementById("eAvail")?.value || "",
      desc: document.getElementById("eDesc")?.value || "",
      features: document.getElementById("eFeatures")?.value || "",
      shipping: document.getElementById("eShippingInfo")?.value || "",
      returns: document.getElementById("eReturnPolicy")?.value || "",
      variants: state.currentVariants,
      sizeGuide: state.currentSizeGuide,
      selectedImages: state.currentSelected
    };
    localStorage.setItem(key, JSON.stringify(data));
  } catch(e) {}
}

function restoreFormFromLocalStorage() {
  const key = state.formPersistKey;
  if (!key) return false;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return false;
    const data = JSON.parse(raw);

    const setVal = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.value = val; };

    setVal("eTitle", data.name);
    setVal("eBrand", data.brand);
    setVal("eVendor", data.vendor);
    setVal("eUrl", data.url);
    setVal("eCategory", data.category);
    setVal("ePrice", data.price);
    setVal("eComparePrice", data.comparePrice);
    setVal("eCurrency", data.currency);
    setVal("eAvail", data.availability);
    setVal("eDesc", data.desc);
    setVal("eFeatures", data.features);
    setVal("eShippingInfo", data.shipping);
    setVal("eReturnPolicy", data.returns);

    if (data.variants && Array.isArray(data.variants)) {
      state.currentVariants = data.variants;
      renderVariantsTable();
    }
    if (data.sizeGuide && data.sizeGuide.headers) {
      state.currentSizeGuide = data.sizeGuide;
      renderSizeGuideTable();
    }
    if (data.selectedImages && Array.isArray(data.selectedImages)) {
      state.currentSelected = data.selectedImages;
      renderImgGrid(state.currentGridUrls);
      updateSelCount();
    }
    return true;
  } catch(e) { return false; }
}

function clearFormPersist(key) {
  if (key) localStorage.removeItem(key);
}

/* --- Core Loading & Display --- */
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
  
  let igLink = 'https://www.instagram.com/' + item.postId + '/';
  if (!item.postId.startsWith('p/') && !item.postId.startsWith('reel/')) {
    igLink = 'https://www.instagram.com/p/' + item.postId + '/';
  }
  document.getElementById("rTitle").innerHTML = \`<a href="\${escapeHtml(igLink)}" target="_blank">\${escapeHtml(item.postId)}</a>\`;
  
  if (item.type === 'frame' && item.parentUrl) {
    const proxyUrl = "/api/video?url=" + encodeURIComponent(item.parentUrl);
    document.getElementById('rTopRight').innerHTML = \`<button class="btn-ghost" onclick="openVideo('\${proxyUrl}')" style="border:1px solid var(--border); padding:8px 12px; min-height:0; font-size:12px; color:var(--text);">WATCH</button>\`;
  } else {
    document.getElementById('rTopRight').innerHTML = '';
  }

  document.getElementById("rImage").src = item.url;
  
  const prods = item.response && item.response.products ? item.response.products : [];
  
  let totalSources = 0;
  let pendingSources = 0;
  let listHtml = "";

  if (!prods.length) {
    listHtml = '<div class="empty">NO PRODUCTS IDENTIFIED</div>';
  } else {
    prods.forEach((p, pIdx) => {
      const sources = p.sources || [];
      if (sources.length === 0) return; // Skip products with 0 sources to keep the page completely clean

      listHtml += \`<div class="product-group-title">\${escapeHtml(p.title || 'UNKNOWN PRODUCT')}</div>\`;
      totalSources += sources.length;
      
      sources.forEach((s, sIdx) => {
        if (s.reviewStatus !== "completed" && s.reviewStatus !== "rejected") pendingSources++;
        
        let statusColor = "var(--text)";
        let rejectedClass = "";
        let statusBadge = "";

        // All status badges on listing page remain uniform grey color to eliminate visual clutter
        if (s.reviewStatus === "rejected") {
          statusColor = "var(--text-2)";
          rejectedClass = "rejected";
          statusBadge = '<span class="badge src-status">REJECTED</span>';
        } else if (s.reviewStatus === "completed") {
          statusBadge = '<span class="badge src-status">REVIEWED</span>';
        } else {
          const extStatus = s.textExtraction?.status;
          if (extStatus === 'completed') statusBadge = '<span class="badge src-status">EXTRACTED</span>';
          else if (extStatus === 'failed') statusBadge = '<span class="badge src-status">FAILED</span>';
          else statusBadge = '<span class="badge src-status">PENDING EXTRACT</span>';
        }

        const imgUrl = getImageUrl((s.selectedImages && s.selectedImages[0]) || (s.images && s.images[0]));
        const nameLabel = s.name || p.title || "UNTITLED";
        const storeLabel = s.brand || s.vendor || s.store || "Unknown Store";

        listHtml += \`
          <div class="p-card \${rejectedClass}" data-source-id="\${pIdx}-\${sIdx}" onclick="openSource(\${pIdx}, \${sIdx})">
            <div class="p-img">\${imgUrl ? \`<img src="\${escapeHtml(imgUrl)}" alt="" loading="lazy" onerror="this.style.display='none'">\` : \`<div class="no-img">N/A</div>\`}</div>
            <div class="p-info">
              <div class="p-title">\${escapeHtml(nameLabel)}</div>
              <div class="p-brand">\${escapeHtml(storeLabel)} &middot; \${escapeHtml(formatPrice(s.price, s.currency))}</div>
              <div class="p-status" style="color:\${statusColor}">\${statusBadge}</div>
            </div>
          </div>
        \`;
      });
    });
  }

  document.getElementById("pList").innerHTML = listHtml;
  document.getElementById("pCount").textContent = totalSources;

  document.getElementById("rMeta").innerHTML = \`
    <span class="badge">\${item.type === "frame" ? "FRAME" : "IMAGE"}</span>
    <span class="badge">\${totalSources} SRC</span>
    \${pendingSources ? \`<span class="badge pending">\${pendingSources} PEND</span>\` : ""}
  \`;

  const btnCommit = document.getElementById("btnCommitItem");
  if (pendingSources > 0) {
    btnCommit.disabled = true;
    btnCommit.title = "Review all sources first";
  } else {
    btnCommit.disabled = false;
    btnCommit.title = "";
  }

  if (state.justEditedSId !== null) {
    const targetCard = document.querySelector('.p-card[data-source-id="' + state.justEditedSId + '"]');
    if (targetCard) {
      requestAnimationFrame(() => {
        targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
    state.justEditedSId = null;
  }
}

// Global openSource helper to wrap errors safely
function openSource(pIdx, sIdx) {
  try {
    openSourceUnsafe(pIdx, sIdx);
  } catch (err) {
    toast("ERROR OPENING SOURCE: " + err.message.toUpperCase());
  }
}

function openSourceUnsafe(pIdx, sIdx) {
  state.editingPIdx = pIdx;
  state.editingSIdx = sIdx;
  
  const product = state.current.response.products[pIdx];
  const s = product.sources[sIdx];
  if (!s) return toast('Source data missing');
  
  document.getElementById("eModalTitle").textContent = "EDIT SOURCE";

  const allImages = getAllImages(s);
  state.currentSelected = [...(s.selectedImages || [])];
  
  const sortedUrls = [...state.currentSelected];
  allImages.urls.forEach(u => { if (!sortedUrls.includes(u)) sortedUrls.push(u); });
  state.currentGridUrls = sortedUrls;

  // Extremely safe type checking on arrays to avoid .forEach of null issues
  state.currentVariants = Array.isArray(s.variants) ? JSON.parse(JSON.stringify(s.variants)) : [];
  state.currentVariants = state.currentVariants.filter(v => v && typeof v === 'object');
  
  let rawSg = s.size_guide;
  state.currentSizeGuide = {
    headers: (rawSg && Array.isArray(rawSg.headers)) ? [...rawSg.headers] : ["US", "EU", "UK"],
    rows: (rawSg && Array.isArray(rawSg.rows)) ? JSON.parse(JSON.stringify(rawSg.rows)) : []
  };

  const safePriceVal = s.price?.current != null ? getSafeNumber(s.price.current) : "";
  const safeCompareVal = getSafeNumber(s.compare_at_price || s.price?.original);
  
  // Robust availability normalization matching out-of-stock variations
  let rawAvail = String(s.availability || "").toLowerCase().replace(/[^a-z]/g, '');
  let mappedAvail = (rawAvail.includes('out') || rawAvail.includes('sold')) ? "OutOfStock" : (rawAvail.includes('pre') ? "PreOrder" : "InStock");
  
  // Safe parsing for string vs array features
  const featuresRaw = Array.isArray(s.features) ? s.features.join("\\n") : (typeof s.features === "string" ? s.features : "");

  let html = \`
    <div class="card" style="padding-bottom: 0; margin-top:0; border-top:none;">
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
      <h3>BASIC INFO</h3>
      <div class="field"><label>Product Name</label><input id="eTitle" value="\${escapeHtml(s.name || product.title || "")}"></div>
      
      <div class="field-row">
        <div class="field"><label>Brand</label><input id="eBrand" value="\${escapeHtml(s.brand || "")}"></div>
        <div class="field"><label>Vendor</label><input id="eVendor" value="\${escapeHtml(s.vendor || s.store || "")}"></div>
      </div>
      
      <div class="field"><label>Category</label><input id="eCategory" value="\${escapeHtml(s.primary_category || product.category || "")}"></div>

      <div class="field" style="margin-bottom:24px;">
        <label>Supplier URL</label>
        <div style="display:flex; gap:8px;">
          <input id="eUrl" type="url" value="\${escapeHtml(s.url || "")}" style="flex:1;">
          \${s.url ? \`<a href="\${escapeHtml(s.url)}" target="_blank" rel="noopener" class="btn-ghost" style="border:1px solid var(--border); padding:0 16px; display:flex; align-items:center; justify-content:center; font-size:12px; text-decoration:none;">VISIT</a>\` : ''}
        </div>
        <div style="display:flex; gap:8px; margin-top:8px;">
          <button id="btnExtractLazy" class="btn-ghost" style="flex:1; font-size:11px; min-height:48px; padding:0; background:var(--surface-2); border:1px solid var(--border);" onclick="extractImages('lazy')">EXTRACT IMAGES</button>
        </div>
      </div>

      <div class="field-row">
        <div class="field"><label>Price</label><input id="ePrice" type="number" step="0.01" inputmode="decimal" value="\${escapeHtml(safePriceVal)}"></div>
        <div class="field"><label>Compare At</label><input id="eComparePrice" type="number" step="0.01" inputmode="decimal" value="\${escapeHtml(safeCompareVal)}"></div>
        <div class="field" style="width:100px">
          <label>Currency</label>
          <select id="eCurrency">
            <option \${s.price?.currency === "USD" ? "selected" : ""}>USD</option>
            <option \${s.price?.currency === "EUR" ? "selected" : ""}>EUR</option>
            <option \${s.price?.currency === "GBP" ? "selected" : ""}>GBP</option>
            <option \${s.price?.currency === "CAD" ? "selected" : ""}>CAD</option>
            <option \${s.price?.currency === "AUD" ? "selected" : ""}>AUD</option>
          </select>
        </div>
      </div>
      <div class="field">
        <label>Availability</label>
        <select id="eAvail">
          <option \${mappedAvail === "InStock" ? "selected" : ""}>InStock</option>
          <option \${mappedAvail === "OutOfStock" ? "selected" : ""}>OutOfStock</option>
          <option \${mappedAvail === "PreOrder" ? "selected" : ""}>PreOrder</option>
        </select>
      </div>
    </div>
    
    <div class="card" style="background:var(--surface-2);">
      <h3>DROPSHIP CONTEXT (READ-ONLY)</h3>
      <div style="font-size:13px; margin-bottom:8px;"><strong>Advisory:</strong> \${escapeHtml(s.dropship_advisory || "None")}</div>
      <div style="display:flex; gap:16px; font-size:13px; flex-wrap:wrap;">
        <div><strong>Base:</strong> \${s.base_price_for_markup || "N/A"}</div>
        <div><strong>Markup:</strong> \${s.recommended_markup_percentage ? s.recommended_markup_percentage + "%" : "N/A"}</div>
        <div><strong>Resell:</strong> \${s.suggested_resell_price || "N/A"}</div>
        <div><strong>Rating:</strong> \${s.rating || "?"}★ (\${s.review_count || 0})</div>
      </div>
    </div>
    
    <details class="card">
      <summary>VARIANTS (SIZE & STOCK)</summary>
      <div class="details-content">
        <div id="variantsContainer" class="simple-table-wrapper"></div>
        <button class="btn-ghost" onclick="addVariantRow()" style="width:100%; border:1px dashed var(--border); margin-top:8px; min-height:48px;">+ ADD SIZE</button>
      </div>
    </details>

    <details class="card">
      <summary>SIZE GUIDE</summary>
      <div class="details-content">
        <div id="sizeGuideContainer" class="simple-table-wrapper"></div>
        <div style="display:flex; gap:8px; margin-top:8px;">
          <button class="btn-ghost" onclick="addSizeGuideRow()" style="flex:1; border:1px dashed var(--border); min-height:48px;">+ ADD ROW</button>
          <button class="btn-ghost" onclick="addSizeGuideCol()" style="flex:1; border:1px dashed var(--border); min-height:48px;">+ ADD COL</button>
        </div>
      </div>
    </details>

    <details class="card">
      <summary>DETAILS & POLICIES</summary>
      <div class="details-content">
        <div class="field"><label>Description</label><textarea id="eDesc">\${escapeHtml(s.description || product.description || "")}</textarea></div>
        <div class="field"><label>Features (One per line)</label><textarea id="eFeatures">\${escapeHtml(featuresRaw)}</textarea></div>
        <div class="field"><label>Shipping Info</label><textarea id="eShippingInfo">\${escapeHtml(s.shipping_info || "")}</textarea></div>
        <div class="field"><label>Return Policy</label><textarea id="eReturnPolicy">\${escapeHtml(s.return_policy || "")}</textarea></div>
      </div>
    </details>

    <div class="card" style="border-bottom:none;">
      <h3>ACTIONS</h3>
      <div style="display:flex; gap:12px; margin-bottom:12px;">
        <button class="btn-ghost" onclick="deleteSource()" style="flex:1; color:var(--danger); border:1px solid var(--border); min-height:48px;">DELETE SOURCE</button>
      </div>
      <div style="display:flex; gap:12px">
        <button class="btn-danger" onclick="rejectSource()" style="flex:1">REJECT</button>
        <button class="btn-primary" onclick="saveSource('completed')" style="flex:1">SAVE</button>
      </div>
    </div>
  \`;
  
  document.getElementById("eBody").innerHTML = html;
  
  renderImgGrid(state.currentGridUrls);
  updateSelCount();
  renderVariantsTable();
  renderSizeGuideTable();
  
  state.formPersistKey = getFormPersistKey();
  restoreFormFromLocalStorage();

  const eBody = document.getElementById("eBody");
  if (eBody) {
    eBody.removeEventListener('input', saveFormToLocalStorage);
    eBody.removeEventListener('change', saveFormToLocalStorage);
    eBody.addEventListener('input', () => saveFormToLocalStorage(), { passive: true });
    eBody.addEventListener('change', () => saveFormToLocalStorage(), { passive: true });
  }

  showScreen("editor");
  document.getElementById("eBody").scrollTop = 0;
}

function updateSelCount() {
  const el = document.getElementById('selCount');
  if (el) el.textContent = state.currentSelected.length;
}

function toggleImageSelection(url) {
  const idx = state.currentSelected.indexOf(url);
  if (idx > -1) state.currentSelected.splice(idx, 1);
  else state.currentSelected.push(url);
  renderImgGrid(state.currentGridUrls);
  updateSelCount();
  saveFormToLocalStorage();
}

function clearSelection() {
  if (!confirm('CLEAR ALL SELECTED IMAGES?')) return;
  state.currentSelected = [];
  renderImgGrid(state.currentGridUrls);
  updateSelCount();
  saveFormToLocalStorage();
  toast('SELECTION CLEARED');
}

function renderImgGrid(urls) {
  const grid = document.getElementById("eImgGrid");
  if (!urls.length) { grid.innerHTML = '<div class="empty" style="flex:1;">NO IMAGES</div>'; return; }
  
  grid.innerHTML = urls.map(url => {
    const selIdx = state.currentSelected.indexOf(url);
    const isOn = selIdx > -1;
    return \`
      <div class="img-cell \${isOn ? 'on' : ''}" onclick="toggleImageSelection('\${escapeHtml(url)}')">
        <img src="\${escapeHtml(url)}" loading="lazy" alt="" onload="this.classList.add('loaded')" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%22100%25%22 height=%22100%25%22><rect width=%22100%25%22 height=%22100%25%22 fill=%22%23f5f5f5%22/><text x=%2250%25%22 y=%2250%25%22 fill=%22%23999%22 font-family=%22sans-serif%22 font-size=%2212%22 text-anchor=%22middle%22 dy=%22.3em%22>BROKEN URL</text></svg>'">
        <div class="check">\${isOn ? (selIdx + 1) : ''}</div>
      </div>\`;
  }).join("");
}

async function addImage() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) { toast("CLIPBOARD EMPTY"); return; }
    let url = text.trim();
    if (!/^https?:\\/\\//i.test(url)) { toast("NO VALID URL IN CLIPBOARD"); return; }
    
    const product = state.current.response.products[state.editingPIdx];
    const s = product.sources[state.editingSIdx];
    
    s.customImages = s.customImages || [];
    if (!s.customImages.includes(url)) s.customImages.push(url);
    
    if (!state.currentSelected.includes(url)) state.currentSelected.push(url);
    if (!state.currentGridUrls.includes(url)) state.currentGridUrls.unshift(url);
    
    renderImgGrid(state.currentGridUrls);
    updateSelCount();
    saveFormToLocalStorage();
    toast("IMAGE PASTED FROM CLIPBOARD");
  } catch (err) {
    toast("CLIPBOARD PERMISSION DENIED");
  }
}

async function extractImages(mode) {
  const url = document.getElementById("eUrl").value;
  if (!url) return toast("NO URL PROVIDED");
  
  const carousel = document.getElementById("eImgGrid");
  const btn = document.getElementById("btnExtractLazy");
  if (carousel) carousel.classList.add("extracting");
  if (btn) { btn.disabled = true; btn.innerText = "EXTRACTING..."; }
  
  try {
    const r = await fetch("/api/extract", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, mode })
    });
    
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    
    if (d.images && d.images.length > 0) {
      const s = state.current.response.products[state.editingPIdx].sources[state.editingSIdx];
      const newUnique = d.images.filter(imgUrl => !state.currentGridUrls.includes(imgUrl)).slice(0, 20);
      
      if (newUnique.length > 0) {
        s.customImages = s.customImages || [];
        s.customImages = [...newUnique, ...s.customImages];
        state.currentGridUrls = [...newUnique, ...state.currentGridUrls];
        newUnique.forEach(u => { if (!state.currentSelected.includes(u)) state.currentSelected.push(u); });
        
        renderImgGrid(state.currentGridUrls);
        updateSelCount();
        saveFormToLocalStorage();
        toast(\`EXTRACTED \${newUnique.length} IMAGES\`);
      } else {
        toast("NO NEW IMAGES (ALL DUPES)");
      }
    } else {
      toast("NO IMAGES EXTRACTED");
    }
  } catch(e) {
    toast("ERROR: " + e.message);
  } finally {
    if (carousel) carousel.classList.remove("extracting");
    if (btn) { btn.disabled = false; btn.innerText = "EXTRACT IMAGES"; }
  }
}

/* --- Variants Table Logic --- */
function renderVariantsTable() {
  const container = document.getElementById("variantsContainer");
  if (!state.currentVariants.length) { container.innerHTML = ''; return; }
  
  let html = '<table class="simple-table"><thead><tr><th>SIZE</th><th>STOCK</th><th style="width:48px;"></th></tr></thead><tbody>';
  state.currentVariants.forEach((v, i) => {
    let rawAvail = String(v.availability || "").toLowerCase().replace(/[^a-z]/g, '');
    let mappedAvail = (rawAvail.includes('out') || rawAvail.includes('sold')) ? "OutOfStock" : (rawAvail.includes('pre') ? "PreOrder" : "InStock");
    
    html += \`
      <tr class="v-row" data-idx="\${i}">
        <td><input type="text" class="v-size" value="\${escapeHtml(v.size || '')}"></td>
        <td>
          <select class="v-avail">
            <option \${mappedAvail === "InStock" ? "selected" : ""}>InStock</option>
            <option \${mappedAvail === "OutOfStock" ? "selected" : ""}>OutOfStock</option>
            <option \${mappedAvail === "PreOrder" ? "selected" : ""}>PreOrder</option>
          </select>
        </td>
        <td><button class="table-btn" onclick="delVariantRow(\${i})">&times;</button></td>
      </tr>
    \`;
  });
  html += '</tbody></table>';
  container.innerHTML = html;
}

function syncVariantsFromDOM() {
  const rows = document.querySelectorAll(".v-row");
  state.currentVariants = Array.from(rows).map(row => ({
    size: row.querySelector(".v-size").value,
    availability: row.querySelector(".v-avail").value
  }));
}

function addVariantRow() {
  syncVariantsFromDOM();
  state.currentVariants.push({ size: "", availability: "InStock" });
  renderVariantsTable();
  saveFormToLocalStorage();
}

function delVariantRow(idx) {
  syncVariantsFromDOM();
  state.currentVariants.splice(idx, 1);
  renderVariantsTable();
  saveFormToLocalStorage();
}

/* --- Size Guide Table Logic --- */
function renderSizeGuideTable() {
  const container = document.getElementById("sizeGuideContainer");
  const sg = state.currentSizeGuide;
  if (!sg || !Array.isArray(sg.headers) || !sg.headers.length) { container.innerHTML = ''; return; }
  
  let html = '<table class="simple-table"><thead><tr>';
  sg.headers.forEach((h, cIdx) => {
    html += \`<th>
      <div style="display:flex; align-items:center;">
        <input type="text" class="sg-header" data-cidx="\${cIdx}" value="\${escapeHtml(h)}" style="flex:1; font-size:11px; font-weight:bold; background:transparent; border:none; padding:4px;">
        <button class="table-btn" onclick="delSizeGuideCol(\${cIdx})" style="width:20px; font-size:18px; min-height:0;">&times;</button>
      </div>
    </th>\`;
  });
  html += '<th style="width:48px;"></th></tr></thead><tbody>';
  
  const rows = Array.isArray(sg.rows) ? sg.rows : [];
  rows.forEach((row, rIdx) => {
    html += \`<tr class="sg-row" data-ridx="\${rIdx}">\`;
    sg.headers.forEach((_, cIdx) => {
      const val = (Array.isArray(row) && row[cIdx] != null) ? row[cIdx] : "";
      html += \`<td><input type="text" class="sg-cell" data-ridx="\${rIdx}" data-cidx="\${cIdx}" value="\${escapeHtml(val)}"></td>\`;
    });
    html += \`<td><button class="table-btn" onclick="delSizeGuideRow(\${rIdx})">&times;</button></td></tr>\`;
  });
  html += '</tbody></table>';
  container.innerHTML = html;
}

function syncSizeGuideFromDOM() {
  const sg = state.currentSizeGuide;
  if (!sg || !Array.isArray(sg.headers)) return;
  
  document.querySelectorAll(".sg-header").forEach(inp => {
    sg.headers[inp.dataset.cidx] = inp.value;
  });
  
  if (!Array.isArray(sg.rows)) sg.rows = [];
  document.querySelectorAll(".sg-cell").forEach(inp => {
    const r = parseInt(inp.dataset.ridx, 10);
    const c = parseInt(inp.dataset.cidx, 10);
    if (!sg.rows[r]) sg.rows[r] = [];
    sg.rows[r][c] = inp.value;
  });
}

function addSizeGuideRow() {
  syncSizeGuideFromDOM();
  if (!state.currentSizeGuide.headers.length) state.currentSizeGuide.headers = ["US", "EU", "UK"];
  state.currentSizeGuide.rows.push(new Array(state.currentSizeGuide.headers.length).fill(""));
  renderSizeGuideTable();
  saveFormToLocalStorage();
}

function addSizeGuideCol() {
  syncSizeGuideFromDOM();
  state.currentSizeGuide.headers.push("NEW");
  if (Array.isArray(state.currentSizeGuide.rows)) {
    state.currentSizeGuide.rows.forEach(r => { if (Array.isArray(r)) r.push(""); });
  }
  renderSizeGuideTable();
  saveFormToLocalStorage();
}

function delSizeGuideRow(rIdx) {
  syncSizeGuideFromDOM();
  state.currentSizeGuide.rows.splice(rIdx, 1);
  renderSizeGuideTable();
  saveFormToLocalStorage();
}

function delSizeGuideCol(cIdx) {
  syncSizeGuideFromDOM();
  state.currentSizeGuide.headers.splice(cIdx, 1);
  if (Array.isArray(state.currentSizeGuide.rows)) {
    state.currentSizeGuide.rows.forEach(r => { if (Array.isArray(r)) r.splice(cIdx, 1); });
  }
  renderSizeGuideTable();
  saveFormToLocalStorage();
}

/* --- Saving --- */
async function saveSource(status = "completed") {
  syncVariantsFromDOM();
  syncSizeGuideFromDOM();
  
  const pIdx = state.editingPIdx;
  const sIdx = state.editingSIdx;
  const source = state.current.response.products[pIdx].sources[sIdx];
  
  source.name = document.getElementById("eTitle").value;
  source.brand = document.getElementById("eBrand").value;
  source.vendor = document.getElementById("eVendor").value;
  source.url = document.getElementById("eUrl").value;
  source.primary_category = document.getElementById("eCategory").value;
  
  const priceVal = parseFloat(document.getElementById("ePrice").value);
  const compareVal = parseFloat(document.getElementById("eComparePrice").value);
  const oldPrice = source.price || {};
  
  source.price = { 
    ...oldPrice,
    current: isNaN(priceVal) ? null : priceVal, 
    original: isNaN(compareVal) ? null : compareVal,
    currency: document.getElementById("eCurrency").value 
  };
  
  source.compare_at_price = source.price.original;
  source.is_on_sale = (source.compare_at_price != null && source.price.current != null && source.compare_at_price > source.price.current);
  source.currency = source.price.currency;
  
  source.availability = document.getElementById("eAvail").value;
  source.description = document.getElementById("eDesc").value;
  source.features = document.getElementById("eFeatures").value.split("\\n").map(s => s.trim()).filter(Boolean);
  source.shipping_info = document.getElementById("eShippingInfo").value;
  source.return_policy = document.getElementById("eReturnPolicy").value;
  
  const oldVariants = source.variants || [];
  source.variants = state.currentVariants.map(v => {
    const existing = oldVariants.find(ov => ov.size === v.size) || {};
    return { ...existing, size: v.size, availability: v.availability };
  });
  
  source.size_guide = state.currentSizeGuide;
  source.selectedImages = [...state.currentSelected];
  source.reviewStatus = status;
  
  try {
    const body = { 
      docId: state.current._id, 
      fileIdx: state.current.fileIdx, 
      frameIdx: state.current.frameIdx, 
      prodIdx: pIdx, 
      sourceIdx: sIdx, 
      source 
    };
    
    const r = await fetch("/api/product", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error("Save failed");
    
    clearFormPersist(state.formPersistKey);
    state.justEditedSId = \`\${pIdx}-\${sIdx}\`;
    toast(status === "rejected" ? "REJECTED" : "SAVED");
    renderItem();
    closeEditor();
  } catch(e) {
    toast("ERROR: " + e.message);
  }
}

function rejectSource() { saveSource("rejected"); }

async function deleteSource() {
  if (!confirm("DELETE THIS SOURCE ENTIRELY?")) return;
  try {
    const body = { 
      docId: state.current._id, 
      fileIdx: state.current.fileIdx, 
      frameIdx: state.current.frameIdx, 
      prodIdx: state.editingPIdx, 
      sourceIdx: state.editingSIdx 
    };
    const r = await fetch("/api/delete-source", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error("Delete failed");
    
    clearFormPersist(state.formPersistKey);
    state.current.response.products[state.editingPIdx].sources.splice(state.editingSIdx, 1);
    
    toast("SOURCE DELETED");
    renderItem();
    closeEditor();
  } catch(e) {
    toast("ERROR: " + e.message);
  }
}

function closeEditor() { 
  clearFormPersist(state.formPersistKey);
  showScreen("review");
  
  // Re-scroll back to source card context instantly upon pressing cancel (vetted and completely safe)
  if (state.editingPIdx !== null && state.editingSIdx !== null) {
    const targetCard = document.querySelector('.p-card[data-source-id="' + state.editingPIdx + '-' + state.editingSIdx + '"]');
    if (targetCard) {
      requestAnimationFrame(() => {
        targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    }
  }
}

async function commitItem() {
  try {
    const body = { docId: state.current._id, fileIdx: state.current.fileIdx, frameIdx: state.current.frameIdx };
    const r = await fetch("/api/commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    
    if (r.status === 409) {
      toast("NOT ALL SOURCES REVIEWED");
      return;
    }
    if (!r.ok) throw new Error("Commit failed");
    
    toast("COMMITTED");
    showQueue();
    await loadQueue();
  } catch(e) {
    toast("ERROR: " + e.message);
  }
}

async function deleteItem() {
  if (!confirm("DISCARD ENTIRE ITEM?")) return;
  try {
    const body = { docId: state.current._id, fileIdx: state.current.fileIdx, frameIdx: state.current.frameIdx };
    const r = await fetch("/api/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error("Discard failed");
    toast("ITEM DISCARDED");
    showQueue();
    await loadQueue();
  } catch(e) {
    toast("ERROR: " + e.message);
  }
}

function showQueue() { showScreen("queue"); }

function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const videoModal = document.getElementById('videoModal');
      const editorModal = document.getElementById('editor');
      if (videoModal.classList.contains('active')) closeVideo();
      else if (editorModal.classList.contains('active')) closeEditor();
      else if (document.getElementById('review').classList.contains('active')) showQueue();
    }
  });
}

loadQueue();
initKeyboard();
</script>
</body>
</html>`;

/* -------------------------------------------------------------------------- */
/* MONGODB HELPERS                                                            */
/* -------------------------------------------------------------------------- */

function normalizeResponse(item) {
    let resp = item.response;
    let rawText = null;
    let modified = false;
    
    if (typeof resp === 'string') {
        try { resp = JSON.parse(resp); modified = true; } catch { rawText = resp; resp = { products: [] }; }
    }
    if (!resp || typeof resp !== 'object') resp = { products: [] };
    if (!Array.isArray(resp.products)) resp.products = [];

    resp.products.forEach(p => {
        if (!Array.isArray(p.sources)) {
            p.sources = [];
            modified = true;
        }
        
        // Strict in-memory URL-based deduplicator protecting sibling indices in DB
        const seenUrls = new Set();
        const uniqueSources = [];
        
        p.sources.forEach(s => {
            s.reviewStatus = s.reviewStatus || 'pending';
            s.selectedImages = s.selectedImages || [];
            s.customImages = s.customImages || [];
            s.variants = s.variants || [];
            s.images = s.images || [];

            // Robust price normalization to handle raw python extractor numbers
            if (typeof s.price === 'number' || typeof s.price === 'string') {
                s.price = {
                    current: s.price,
                    original: s.compare_at_price || null,
                    currency: s.currency || 'USD'
                };
                modified = true;
            } else if (!s.price || typeof s.price !== 'object') {
                s.price = { current: '', original: s.compare_at_price || null, currency: s.currency || 'USD' };
                modified = true;
            }
            if (s.price.original != null && s.compare_at_price == null) {
                s.compare_at_price = s.price.original;
                modified = true;
            }

            if (!s.url) {
                uniqueSources.push(s);
                return;
            }

            let normUrl = s.url.trim().toLowerCase().replace(/\/$/, '');
            try {
                const u = new URL(normUrl);
                u.searchParams.delete('utm_source');
                u.searchParams.delete('utm_medium');
                u.searchParams.delete('utm_campaign');
                u.searchParams.delete('fbclid');
                u.searchParams.delete('gclid');
                normUrl = u.toString().replace(/\/$/, '');
            } catch(e) {}

            if (!seenUrls.has(normUrl)) {
                seenUrls.add(normUrl);
                uniqueSources.push(s);
            } else {
                modified = true; // Duplicates purged immediately on load
            }
        });

        if (p.sources.length !== uniqueSources.length) {
            p.sources = uniqueSources;
            modified = true;
        }
    });

    if (rawText) resp.rawText = rawText;
    if (modified) resp._wasDbModified = true;
    return resp;
}

function getItemStatus(item) {
    const resp = normalizeResponse(item);
    let totalSources = 0;
    let reviewedSources = 0;

    resp.products.forEach(p => {
        p.sources.forEach(s => {
            totalSources++;
            if (s.reviewStatus === 'completed' || s.reviewStatus === 'rejected') reviewedSources++;
        });
    });

    if (totalSources === 0) return 'done'; // Empty arrays can be committed safely to clear from queue
    if (reviewedSources === totalSources) return 'done';
    if (reviewedSources > 0) return 'partial';
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
                        auditStatus: 'audited',
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
                        auditStatus: 'audited',
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

            if (f.type === 'image' && f.reviewed && !f.humanReviewed) {
                postItems.push({
                    _id: post._id.toString(),
                    postId: post.post_id,
                    fileIdx: i,
                    frameIdx: null,
                    thumb: f.url,
                    status: getItemStatus(f),
                    type: 'image'
                });
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
            grouped[post.post_id] = { postId: post.post_id, _id: post._id.toString(), items: postItems };
        }
    }

    const items = Object.values(grouped).flatMap(g => g.items);
    return { posts: grouped, items };
}

async function checkDone(collection) {
    return collection.countDocuments({
        discarded: { $ne: true },
        $or: [
            { file_urls: { $elemMatch: { type: 'image', reviewed: true, auditStatus: 'audited', humanReviewed: { $ne: true }, discarded: { $ne: true } } } },
            { 'file_urls.frames': { $elemMatch: { type: 'image', reviewed: true, auditStatus: 'audited', humanReviewed: { $ne: true }, discarded: { $ne: true } } } }
        ]
    });
}

async function maybeDiscardEmptyPost(collection, docId) {
    const post = await collection.findOne({ _id: new ObjectId(docId) }, { projection: { file_urls: 1, post_id: 1 } });
    if (!post || !post.file_urls) return;

    const hasRemaining = post.file_urls.some(f => {
        if (f.discarded) return false;
        if (f.type === 'image') return true;
        if (f.type === 'video' && Array.isArray(f.frames)) return f.frames.some(fr => !fr.discarded);
        return false;
    });

    if (!hasRemaining) {
        await collection.updateOne({ _id: new ObjectId(docId) }, { $set: { discarded: true, discardedAt: new Date(), discardReason: 'all file_urls removed' } });
        log('info', `Auto-discarded empty post ${post.post_id}`);
    }
}

async function propagateReviewToSameSources(collection, docId, url, updatedSource) {
    if (!url) return 0;
    try {
        const post = await collection.findOne({ _id: new ObjectId(docId) }, { projection: { file_urls: 1 } });
        if (!post || !Array.isArray(post.file_urls)) return 0;

        let updatedCount = 0;

        for (let fi = 0; fi < post.file_urls.length; fi++) {
            const f = post.file_urls[fi];
            if (!f || f.discarded) continue;

            const updateItem = async (item, basePath) => {
                if (!item.response || !Array.isArray(item.response.products)) return;
                for (let pi = 0; pi < item.response.products.length; pi++) {
                    const prod = item.response.products[pi];
                    if (!Array.isArray(prod.sources)) continue;
                    for (let si = 0; si < prod.sources.length; si++) {
                        const src = prod.sources[si];
                        if (src.url === url) {
                            const setObj = {};
                            const pth = `${basePath}.products.${pi}.sources.${si}`;
                            setObj[`${pth}.reviewStatus`] = updatedSource.reviewStatus;
                            setObj[`${pth}.reviewedAt`] = new Date();
                            setObj[`${pth}.selectedImages`] = updatedSource.selectedImages;
                            setObj[`${pth}.price`] = updatedSource.price;
                            setObj[`${pth}.compare_at_price`] = updatedSource.compare_at_price;
                            setObj[`${pth}.is_on_sale`] = updatedSource.is_on_sale;
                            setObj[`${pth}.currency`] = updatedSource.currency;
                            setObj[`${pth}.availability`] = updatedSource.availability;
                            setObj[`${pth}.vendor`] = updatedSource.vendor;
                            await collection.updateOne({ _id: new ObjectId(docId) }, { $set: setObj });
                            updatedCount++;
                        }
                    }
                }
            };

            if (f.type === 'image') await updateItem(f, `file_urls.${fi}.response`);
            if (f.type === 'video' && Array.isArray(f.frames)) {
                for (let fr = 0; fr < f.frames.length; fr++) {
                    if (!f.frames[fr].discarded) await updateItem(f.frames[fr], `file_urls.${fi}.frames.${fr}.response`);
                }
            }
        }
        if (updatedCount > 0) log('info', `Propagated review to ${updatedCount} matching source(s) in post`);
        return updatedCount;
    } catch (err) {
        log('warn', 'Propagation failed:', err.message);
        return 0;
    }
}

/* -------------------------------------------------------------------------- */
/* EXTERNAL API HELPERS                                                       */
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
        const scriptPath = path.resolve(process.cwd(), 'ecom-image-extractor.py');
        
        if (!fs.existsSync(scriptPath)) {
            try { fs.unlinkSync(inFile); } catch(e){}
            return reject(new Error('ecom-image-extractor.py NOT FOUND.'));
        }

        const args = [scriptPath, '-u', inFile, '-o', outFile];
        if (mode === 'lazy') args.push('--lazy-extraction');
        else { args.push('--no-lazy-extraction'); args.push('--adaptive-cutoff'); }

        const proc = spawn('python3', args);
        let stderr = '';
        proc.stderr.on('data', d => stderr += d.toString());

        proc.on('close', code => {
            if (code !== 0) {
                try { fs.unlinkSync(inFile); fs.unlinkSync(outFile); } catch(e){}
                return reject(new Error(`Extractor crashed (code ${code}). Stderr: ${stderr.slice(0,200)}`));
            }
            try {
                if (!fs.existsSync(outFile)) throw new Error("No output generated.");
                const resultData = JSON.parse(fs.readFileSync(outFile, 'utf8'));
                fs.unlinkSync(inFile); fs.unlinkSync(outFile);
                
                const images = resultData[targetUrl] || [];
                if (images.error) throw new Error(images.error);
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

        if (url) return { url, process: ngrok };

        try {
            const apiRes = await fetch('http://127.0.0.1:4040/api/tunnels');
            const apiData = await apiRes.json();
            const tunnel = apiData.tunnels?.find(t => t.public_url?.startsWith('https'));
            if (tunnel) return { url: tunnel.public_url, process: ngrok };
        } catch (e) {}

        ngrok.kill();
        return null;
    } catch (err) {
        return null;
    }
}

/* -------------------------------------------------------------------------- */
/* SERVER                                                                     */
/* -------------------------------------------------------------------------- */
async function main() {
    log('info', '===============================================================');
    log('info', '  REVIEW SERVER — Production Human Review v2.2.1 (New Schema)');
    log('info', '===============================================================');

    if (!CONFIG.mongodb.uri) { log('error', 'ORCH_MONGODB_URI is required'); process.exit(1); }

    const client = new MongoClient(CONFIG.mongodb.uri, { serverSelectionTimeoutMS: 15000, maxPoolSize: 10 });
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
        
        if (parsed.pathname === '/api/video' && req.method === 'GET') {
            try {
                const vidUrl = parsed.searchParams.get('url');
                if (!vidUrl) return res.writeHead(400), res.end('No video url');
                const fetchHeaders = {};
                if (req.headers.range) fetchHeaders.range = req.headers.range;
                if (CONFIG.hfToken) fetchHeaders['Authorization'] = `Bearer ${CONFIG.hfToken}`;
                const fRes = await fetch(vidUrl, { headers: fetchHeaders });
                const resHeaders = {};
                fRes.headers.forEach((v, k) => { if (k.toLowerCase() !== 'content-encoding') resHeaders[k] = v; });
                res.writeHead(fRes.status, resHeaders);
                if (fRes.body) Readable.fromWeb(fRes.body).pipe(res); else res.end();
            } catch (e) { res.writeHead(500); res.end(e.message); }
            return;
        }

        if (parsed.pathname === '/api/queue' && req.method === 'GET') {
            try {
                const q = await buildQueue(collection);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(q));
            } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
            return;
        }

        const itemMatch = parsed.pathname.match(/^\/api\/item\/([^\/]+)\/(\d+)(?:\/(\d+))?$/);
        if (itemMatch && req.method === 'GET') {
            try {
                const docId = itemMatch[1];
                const fileIdx = parseInt(itemMatch[2], 10);
                const frameIdx = itemMatch[3] !== undefined ? parseInt(itemMatch[3], 10) : null;
                const objectId = new ObjectId(docId);

                const post = await collection.findOne({ _id: objectId }, { projection: { post_id: 1, file_urls: 1 } });
                if (!post || !post.file_urls || !post.file_urls[fileIdx]) return res.writeHead(404), res.end('Not found');

                const file = post.file_urls[fileIdx];
                let item;
                if (frameIdx !== null) {
                    if (!file.frames || !file.frames[frameIdx]) return res.writeHead(404), res.end('Frame not found');
                    item = file.frames[frameIdx];
                    item.type = 'frame'; item.parentUrl = file.url;
                } else {
                    item = file; item.type = 'image';
                }

                // Normalization ensures sources arrays and reviewStatus exist. Deduplicates duplicate entries synchronously.
                const response = normalizeResponse(item);
                
                if (response._wasDbModified) {
                    const updatePath = frameIdx !== null 
                        ? `file_urls.${fileIdx}.frames.${frameIdx}.response` 
                        : `file_urls.${fileIdx}.response`;
                    
                    await collection.updateOne(
                        { _id: objectId },
                        { $set: { [updatePath]: response } }
                    );
                    delete response._wasDbModified;
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ _id: docId, postId: post.post_id, fileIdx, frameIdx, url: item.url, parentUrl: item.parentUrl || null, type: item.type, response }));
            } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
            return;
        }

        if (parsed.pathname === '/api/upload' && req.method === 'POST') {
            let body = ''; req.on('data', d => body += d);
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body);
                    const url = await uploadToCatbox(data.image, data.filename);
                    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ url }));
                } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
            });
            return;
        }

        if (parsed.pathname === '/api/extract' && req.method === 'POST') {
            let body = ''; req.on('data', d => body += d);
            req.on('end', async () => {
                try {
                    const { url, mode } = JSON.parse(body);
                    const images = await runPythonExtractor(url, mode);
                    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ images }));
                } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
            });
            return;
        }

        if (parsed.pathname === '/api/product' && req.method === 'POST') {
            let body = ''; req.on('data', d => body += d);
            req.on('end', async () => {
                try {
                    const { docId, fileIdx, frameIdx, prodIdx, sourceIdx, source } = JSON.parse(body);
                    const basePath = frameIdx !== null
                        ? `file_urls.${fileIdx}.frames.${frameIdx}.response.products.${prodIdx}.sources.${sourceIdx}`
                        : `file_urls.${fileIdx}.response.products.${prodIdx}.sources.${sourceIdx}`;

                    await collection.updateOne(
                        { _id: new ObjectId(docId) },
                        { $set: {
                            [`${basePath}.name`]: source.name,
                            [`${basePath}.brand`]: source.brand,
                            [`${basePath}.vendor`]: source.vendor,
                            [`${basePath}.url`]: source.url,
                            [`${basePath}.primary_category`]: source.primary_category,
                            [`${basePath}.price`]: source.price,
                            [`${basePath}.compare_at_price`]: source.compare_at_price,
                            [`${basePath}.is_on_sale`]: source.is_on_sale,
                            [`${basePath}.currency`]: source.currency,
                            [`${basePath}.availability`]: source.availability,
                            [`${basePath}.description`]: source.description,
                            [`${basePath}.features`]: source.features,
                            [`${basePath}.variants`]: source.variants,
                            [`${basePath}.size_guide`]: source.size_guide,
                            [`${basePath}.shipping_info`]: source.shipping_info,
                            [`${basePath}.return_policy`]: source.return_policy,
                            [`${basePath}.images`]: source.images,
                            [`${basePath}.selectedImages`]: source.selectedImages,
                            [`${basePath}.customImages`]: source.customImages,
                            [`${basePath}.reviewStatus`]: source.reviewStatus,
                            [`${basePath}.reviewedAt`]: new Date()
                        }}
                    );

                    // Rejections strictly scoped to this item only. ONLY propagate successful approvals.
                    if (source.url && source.reviewStatus !== 'rejected') {
                        propagateReviewToSameSources(collection, docId, source.url, source)
                            .catch(e => log('warn', 'Propagation err:', e.message));
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
                } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
            });
            return;
        }

        if (parsed.pathname === '/api/delete-source' && req.method === 'POST') {
            let body = ''; req.on('data', d => body += d);
            req.on('end', async () => {
                try {
                    const { docId, fileIdx, frameIdx, prodIdx, sourceIdx } = JSON.parse(body);
                    const parentPath = frameIdx !== null
                        ? `file_urls.${fileIdx}.frames.${frameIdx}.response.products.${prodIdx}`
                        : `file_urls.${fileIdx}.response.products.${prodIdx}`;

                    const post = await collection.findOne({ _id: new ObjectId(docId) });
                    const targetProduct = frameIdx !== null
                        ? post.file_urls[fileIdx].frames[frameIdx].response.products[prodIdx]
                        : post.file_urls[fileIdx].response.products[prodIdx];

                    if (targetProduct && targetProduct.sources && targetProduct.sources.length > sourceIdx) {
                        targetProduct.sources.splice(sourceIdx, 1);
                        await collection.updateOne(
                            { _id: new ObjectId(docId) },
                            { $set: { [`${parentPath}.sources`]: targetProduct.sources } }
                        );
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
                } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
            });
            return;
        }

        if (parsed.pathname === '/api/commit' && req.method === 'POST') {
            let body = ''; req.on('data', d => body += d);
            req.on('end', async () => {
                try {
                    const { docId, fileIdx, frameIdx } = JSON.parse(body);
                    const objectId = new ObjectId(docId);
                    
                    const post = await collection.findOne({ _id: objectId });
                    const item = frameIdx !== null ? post.file_urls[fileIdx].frames[frameIdx] : post.file_urls[fileIdx];
                    
                    const allSourcesReviewed = item.response.products.every(p => 
                        !p.sources || p.sources.length === 0 || p.sources.every(s => s.reviewStatus === 'completed' || s.reviewStatus === 'rejected')
                    );

                    if (!allSourcesReviewed) {
                        return res.writeHead(409), res.end(JSON.stringify({ error: 'Not all sources reviewed' }));
                    }

                    const path = frameIdx !== null ? `file_urls.${fileIdx}.frames.${frameIdx}` : `file_urls.${fileIdx}`;
                    await collection.updateOne({ _id: objectId }, { $set: { [`${path}.humanReviewed`]: true, [`${path}.humanReviewedAt`]: new Date() } });

                    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
                    if (await checkDone(collection) === 0) serverResolve();
                } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
            });
            return;
        }

        if (parsed.pathname === '/api/delete' && req.method === 'POST') {
            let body = ''; req.on('data', d => body += d);
            req.on('end', async () => {
                try {
                    const { docId, fileIdx, frameIdx } = JSON.parse(body);
                    const path = frameIdx !== null ? `file_urls.${fileIdx}.frames.${frameIdx}` : `file_urls.${fileIdx}`;
                    await collection.updateOne({ _id: new ObjectId(docId) }, { $set: { [`${path}.discarded`]: true } });
                    await maybeDiscardEmptyPost(collection, docId);
                    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));
                    if (await checkDone(collection) === 0) serverResolve();
                } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
            });
            return;
        }

        res.writeHead(404); res.end('Not found');
    });

    server.listen(CONFIG.port, '0.0.0.0', async () => {
        log('info', '===============================================================');
        log('info', `  Server: http://0.0.0.0:${CONFIG.port}`);
        const ngrok = await startNgrok(CONFIG.port);
        if (ngrok) {
            log('info', `  OPEN BROWSER: ${ngrok.url}`);
            ngrokProc = ngrok.process;
        }
        if (await checkDone(collection) === 0) {
            log('info', 'Nothing to review. Exiting.');
            serverResolve();
        }
    });

    await donePromise;
    log('info', 'Shutting down...');
    server.close();
    if (ngrokProc) ngrokProc.kill();
    await client.close();
    log('info', 'Done.');
}

main().catch(err => { log('error', 'Fatal:', err.message); process.exit(1); });