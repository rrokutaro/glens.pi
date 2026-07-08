/**
 * review-server.js
 *
 * Production human review server for the UGC dropship pipeline.
 * Brutalist Native Apple Aesthetic, lazy loading, Python AI extraction.
 *
 * Env: ORCH_MONGODB_URI, ORCH_MONGODB_DB, ORCH_MONGODB_COLLECTION
 *      REVIEW_PORT (default 3456), ORCH_HF_TOKEN, ORCH_GEMINI_API_KEYS
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

const DATA_EXTRACTION_PROMPT = `You are a product data extraction expert. I will provide you with a messy JSON payload containing data from one or multiple e-commerce product pages. Each input object will have a "source_id". Your task is to extract all relevant product information and output a clean, structured JSON array where each element strictly follows the schema template provided below.

SYSTEM RULES AND OUTPUT FORMAT
1. OUTPUT JSON ONLY. Output nothing but raw, valid JSON. Do not wrap the JSON in markdown formatting. Do not include any conversational text before or after the JSON.
2. ALWAYS RETURN AN ARRAY. Your output must always be a JSON array. If the input is a single product, return an array containing one object.
3. NULL VERSUS EMPTY ARRAYS. For string or number fields that cannot be found, use null. For missing array fields ("images", "variants", "reviews", "product_tags", "coupon_codes", "breadcrumb", "features"), use an empty array [] NEVER use null for an array.
4. STRIP HTML. Remove all HTML tags from descriptions, reviews, and text fields. Return clean, readable plain text.

EXTRACTION RULES
1. DEEP EXTRACTION. Extract data from all available sources: schema_org, open_graph, meta_tags, dom_text, shopify_product, microdata, tables, lists, etc.
2. IGNORE RELATED PRODUCTS. Focus ONLY on the main product(s) the page is actually selling. Strictly ignore products found in "You might also like", "Related Products", or "Recently Viewed" sections to prevent data pollution.
3. 404 AND FAILED PAGES. If "success" is false or "status_code" is 400 or above, set all product details ("name", "price", "brand", etc.) to null or []. Provide a "dropship_advisory" explaining the page failed to load.
4. VARIANTS. Include all available options inside the "variants" array. Ensure you capture the specific "size", "color", and variant "image_url" if available. If a product has variants but no specific size, use "One Size" for the "size" field.
5. SIZE GUIDE. Only extract a size guide into the "size_guide" object if a sizing table explicitly exists on the page. Do not hallucinate or generate a fallback size guide. If none exists, set "size_guide" to null.
6. POLICIES AND FEATURES. Summarize relevant text for "shipping_info" and "return_policy". Extract bulleted highlights or technical details into the "features" array.
7. IMAGES. Deduplicate images. Include ALL distinct, high-resolution main product images found across all JSON nodes in the "images" array.
8. MISSING CURRENCY. If "currency" is missing, attempt to infer it from the domain extension (.co.uk = GBP, .com.au = AUD) or default to USD.

DROPSHIPPING AND MARKUP LOGIC You must reason and determine the optimal markup based on the product data. Do NOT use a fixed default percentage.
- "base_price_for_markup": Use "compare_at_price" if it exists and is greater than "price". Otherwise, use "price".
- "recommended_markup_percentage": Determine based on brand reputation (luxury equals higher, fast fashion equals lower), price point, category, sale status, and review scores.
- "calculated_markup_amount": "base_price_for_markup" multiplied by ("recommended_markup_percentage" divided by 100).
- "suggested_resell_price": "base_price_for_markup" plus "calculated_markup_amount".
- MATH CONSTRAINT: Round all calculated monetary values to EXACTLY 2 decimal places. All values are in the product native "currency".
- FAILURE CONSTRAINT: If "price" is null, set "base_price_for_markup", "recommended_markup_percentage", "calculated_markup_amount", and "suggested_resell_price" to null.
- "dropship_advisory": Write 1 to 2 sentences explaining your markup reasoning and overall suitability for dropshipping based on stock, margins, and brand.

OUTPUT SCHEMA TEMPLATE [ { "source_id": "string (MUST EXACTLY MATCH INPUT)", "url": "string", "canonical_url": "string or null", "success": boolean, "status_code": number, "extracted_at": "ISO 8601 timestamp", "name": "string or null", "brand": "string or null", "primary_category": "string or null", "product_type": "string or null", "color": "string or null", "material": "string or null", "description": "string or null", "features": ["string"], "price": number or null, "compare_at_price": number or null, "is_on_sale": boolean, "currency": "string (3-letter ISO code) or null", "availability": "InStock or OutOfStock or PreOrder or null", "sku": "string or null", "handle": "string or null", "product_id": number or null, "vendor": "string or null", "created_at": "ISO timestamp or null", "updated_at": "ISO timestamp or null", "images": ["string"], "rating": number or null, "review_count": number or null, "reviews": [ { "author": "string or null", "rating": number, "text": "string", "date": "ISO timestamp or null", "helpful_count": number or null } ], "variants": [ { "size": "string or null", "color": "string or null", "price": number or null, "availability": "InStock or OutOfStock or PreOrder or null", "sku": "string or null", "inventory_quantity": number or null, "weight": "string or null", "barcode": "string or null", "image_url": "string or null", "url": "string or null" } ], "size_guide": { "headers": ["string"], "rows": [["string"]] } or null, "shipping_info": "string or null", "return_policy": "string or null", "coupon_codes": ["string"], "product_tags": ["string"], "breadcrumb": ["string"], "base_price_for_markup": number or null, "recommended_markup_percentage": number or null, "calculated_markup_amount": number or null, "suggested_resell_price": number or null, "dropship_advisory": "string or null" } ]`;


/* -------------------------------------------------------------------------- */
/* HTML UI                                                                    */
/* -------------------------------------------------------------------------- */
const REVIEW_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#ffffff" id="metaThemeColor">
<title>DropShip Review • v1.2</title>
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
}

h1, h2, h3, label, .item-type, .p-brand, .post-id, .src-row .name, .empty {
  font-weight: 700; text-transform: uppercase; letter-spacing: 0.03em;
}

button {
  cursor: pointer; border: 1px solid var(--border); border-radius: 0;
  padding: 12px 16px; font-size: 13px; background: var(--bg); color: var(--text);
  min-height: 48px; font-weight: 700; text-transform: uppercase;
  transition: opacity 0.15s ease, transform 0.1s ease;
}
button:active { opacity: 0.7; transform: scale(0.98); }
button:disabled { opacity: 0.4 !important; cursor: not-allowed; border-color: var(--border); }

.btn-primary { background: var(--text); color: var(--bg); border: 1px solid var(--text); }
.btn-danger { background: var(--bg); color: var(--danger); border: 1px solid var(--border); }
.btn-ghost { border-color: transparent; background: transparent; color: var(--text); padding: 0; min-height: 0; border: none; }

input, select, textarea {
  background: var(--bg); border: 1px solid var(--border); color: var(--text);
  padding: 14px; font-size: 14px; font-family: inherit; width: 100%;
  -webkit-appearance: none; transition: border-color 0.2s ease;
}
input::placeholder, textarea::placeholder { color: var(--text-2); opacity: 0.5; }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--text); }
textarea { resize: vertical; min-height: 100px; }
select {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%23737373'%3E%3Cpath d='M6 8L1 3h10z'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 14px center; padding-right: 32px;
}
.readonly-field { background: var(--surface-2); font-family: monospace; font-size: 12px; }

img { max-width: 100%; display: block; }
a { color: var(--text); text-decoration: underline; text-underline-offset: 4px; font-weight: 600; }

.screen { display: none; min-height: 100dvh; padding-bottom: calc(90px + env(safe-area-inset-bottom)); }
.screen.active { display: block; }

.topbar {
  position: sticky; top: 0; z-index: 50; background: var(--bg); border-bottom: 1px solid var(--border);
  padding: 12px 16px; padding-top: max(12px, env(safe-area-inset-top)); display: flex; align-items: center; gap: 12px;
}
.topbar h1 { font-size: 14px; flex: 1; margin: 0; text-align: left; }

.badge {
  font-size: 10px; padding: 0 8px; height: 24px; display: inline-flex; align-items: center; justify-content: center;
  border: 1px solid var(--text); color: var(--bg); background: var(--text); font-weight: 700; text-transform: uppercase;
}
.badge.pending { color: var(--text); background: var(--surface-2); border-color: var(--border); }
.theme-toggle {
  font-size: 10px; padding: 0 8px; height: 24px; min-height: 24px; border: 1px solid var(--border); color: var(--text); background: transparent;
}

.post-group { border-bottom: 1px solid var(--border); margin: 0; background: var(--bg); }
.post-header { display: flex; align-items: center; gap: 12px; padding: 20px 16px; cursor: pointer; user-select: none; }
.post-thumb { width: 48px; height: 48px; background: var(--surface-2); flex-shrink: 0; border: 1px solid var(--border); }
.post-thumb img { width: 100%; height: 100%; object-fit: cover; }
.post-info { flex: 1; min-width: 0; }
.post-id { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.post-meta { font-size: 12px; color: var(--text-2); margin-top: 2px; font-weight: 600; }
.post-chevron { width: 20px; height: 20px; transition: transform 0.2s ease; }
.post-group.open .post-chevron { transform: rotate(180deg); }
.post-items { display: none; padding: 0 16px 16px; border-top: 1px dashed var(--border); }
.post-group.open .post-items { display: block; margin-top: 0; padding-top: 16px; background: var(--surface-2); }
.item-row { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--border); cursor: pointer; }
.item-thumb { width: 40px; height: 56px; background: var(--bg); border: 1px solid var(--border); flex-shrink: 0; }
.item-thumb img { width: 100%; height: 100%; object-fit: cover; }
.item-info { flex: 1; min-width: 0; }
.item-status { font-size: 10px; color: var(--text-2); margin-top: 4px; font-weight: 700; text-transform: uppercase; }

.hero { width: 100%; border-bottom: 1px solid var(--border); background: var(--surface-2); position: relative; }
.hero img { width: 100%; height: 65vh; object-fit: cover; cursor: pointer; transition: object-fit 0.1s; }
.hero-meta { padding: 12px 16px; display: flex; gap: 8px; flex-wrap: wrap; background: var(--bg); border-top: 1px solid var(--border); }

.section { padding: 0; padding-bottom: calc(100px + env(safe-area-inset-bottom)); background: var(--bg); }
.section h2 { font-size: 14px; padding: 20px 16px; border-bottom: 1px solid var(--border); margin: 0; display: flex; justify-content: space-between; align-items: center; background: var(--bg); }

.p-card {
  padding: 16px; display: flex; gap: 16px; cursor: pointer; border-bottom: 1px solid var(--border); background: var(--bg);
}
.p-card.rejected { opacity: 0.4; filter: grayscale(100%); }
.p-img { width: 80px; height: 106px; background: var(--surface-2); border: 1px solid var(--border); flex-shrink: 0;}
.p-img img { width: 100%; height: 100%; object-fit: cover; }
.p-info { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; }
.p-title { font-size: 16px; font-weight: 600; margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.p-brand { font-size: 13px; color: var(--text-2); margin-bottom: 8px; font-weight: 500; }
.p-status { display: flex; align-items: center; gap: 8px; font-size: 11px; font-weight: 700; text-transform: uppercase; }

.modal { position: fixed; inset: 0; z-index: 100; background: var(--bg); display: none; flex-direction: column; }
.modal.active { display: flex; }
.modal-header { padding: 12px 16px; padding-top: max(12px, env(safe-area-inset-top)); border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 12px; background: var(--bg); }
.modal-header h2 { font-size: 14px; flex: 1; text-align: center; margin: 0; }
.modal-body { flex: 1; overflow-y: auto; padding: 0; padding-bottom: calc(100px + env(safe-area-inset-bottom)); -webkit-overflow-scrolling: touch;}

.card { padding: 24px 16px; border-bottom: 1px solid var(--border); background: var(--bg); }
.card h3 { font-size: 13px; color: var(--text); margin-bottom: 16px; padding-bottom: 12px; display: block; border-bottom: 1px dashed var(--border); }

.carousel { display: flex; overflow-x: auto; gap: 12px; scroll-snap-type: x mandatory; margin-bottom: 16px; scrollbar-width: none; }
.carousel::-webkit-scrollbar { display: none; }
.img-cell { flex: 0 0 75%; aspect-ratio: 3/4; scroll-snap-align: center; position: relative; cursor: pointer; border: 1px solid var(--border); background: var(--surface-2); }
.img-cell img { width: 100%; height: 100%; object-fit: cover; opacity: 0.5; transition: opacity 0.2s ease; }
.img-cell.on { border-color: transparent; box-shadow: inset 0 0 0 2px var(--text); }
.img-cell.on img { opacity: 1; }
.img-cell .check { position: absolute; top: 12px; right: 12px; width: 24px; height: 24px; border: 1px solid var(--text); background: transparent; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; color: transparent;}
.img-cell.on .check { background: var(--text); border-color: var(--text); color: var(--bg); }

.field { margin-bottom: 16px; }
.field label { display: block; font-size: 11px; margin-bottom: 8px; color: var(--text-2); font-weight: 600; }
.field-row { display: flex; gap: 12px; }
.field-row .field { flex: 1; }

.actions-bar { position: fixed; bottom: 0; left: 0; right: 0; padding: 16px; padding-bottom: max(16px, env(safe-area-inset-bottom)); background: var(--bg); border-top: 1px solid var(--border); display: flex; gap: 12px; z-index: 50; }
.actions-bar button { flex: 1; }

.toast { position: fixed; top: max(16px, env(safe-area-inset-top)); left: 50%; transform: translate(-50%, -150px); background: var(--text); color: var(--bg); padding: 14px 24px; font-size: 12px; font-weight: 700; z-index: 300; transition: transform 0.3s ease; box-shadow: 0 10px 30px rgba(0,0,0,0.15);}
.toast.show { transform: translate(-50%, 0); }
</style>
</head>
<body>
<div id="app">
  <div id="loading" class="screen active">
    <div style="display:flex;justify-content:center;align-items:center;height:100dvh;">LOADING...</div>
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
    </div>
    <div class="hero">
      <img id="rImage" src="" alt="">
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
      <h2>EDIT DATA</h2>
      <button class="btn-primary" onclick="saveProduct('completed')" style="padding:8px 14px; font-size:12px; min-height:36px;">SAVE</button>
    </div>
    <div class="modal-body" id="eBody"></div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
const state = { 
  queue: [], posts: {}, current: null, editingIdx: null, 
  currentSelected: [], currentGridUrls: [], justEditedProdIdx: null
};

function toggleTheme() {
  const root = document.documentElement;
  const newTheme = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', newTheme);
  document.getElementById('metaThemeColor').setAttribute('content', newTheme === 'dark' ? '#121212' : '#ffffff');
  localStorage.setItem('theme', newTheme);
}
if (localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) toggleTheme();

function showScreen(id) {
  document.querySelectorAll(".screen, .modal").forEach(el => el.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function toast(msg) {
  const t = document.getElementById("toast"); t.textContent = msg; t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 3000);
}

function escapeHtml(str) {
  if (str == null) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatPrice(p) {
  if (!p) return "TBD";
  if (typeof p === "object" && p.current) return p.current + (p.currency ? " " + p.currency : "");
  return String(p);
}

async function loadQueue() {
  try {
    const r = await fetch("/api/queue");
    const data = await r.json();
    state.posts = data.posts || {};
    state.queue = data.items || [];
  } catch(e) { toast("ERR: " + e.message); }
  showScreen("queue");
  renderQueue();
}

function renderQueue() {
  const list = document.getElementById("qList");
  const postIds = Object.keys(state.posts);
  if (!postIds.length) { list.innerHTML = '<div class="empty">EMPTY QUEUE</div>'; return; }
  
  list.innerHTML = postIds.map(pid => {
    const items = state.posts[pid].items || [];
    const pending = items.filter(it => it.status === "pending" || it.status === "partial").length;
    return \`
      <div class="post-group" id="g_\${pid}" onclick="this.classList.toggle('open')">
        <div class="post-header">
          <div class="post-thumb"><img src="\${escapeHtml(items[0]?.thumb)}"></div>
          <div class="post-info"><div class="post-id">\${escapeHtml(pid)}</div><div class="post-meta">\${items.length} ITEM(S) &middot; \${pending} PENDING</div></div>
        </div>
        <div class="post-items" onclick="event.stopPropagation()">
          \${items.map(it => \`
            <div class="item-row" onclick="openItem('\${it._id}', \${it.fileIdx}, \${it.frameIdx !== null ? it.frameIdx : null})">
              <div class="item-thumb"><img src="\${escapeHtml(it.thumb)}"></div>
              <div class="item-info"><div class="item-type">\${it.type} #\${it.frameIdx !== null ? it.frameIdx : it.fileIdx}</div><div class="item-status">\${it.status}</div></div>
            </div>
          \`).join('')}
        </div>
      </div>
    \`;
  }).join('');
  document.getElementById("qCount").textContent = state.queue.length;
}

async function openItem(_id, fileIdx, frameIdx) {
  try {
    let url = \`/api/item/\${_id}/\${fileIdx}\` + (frameIdx !== null ? \`/\${frameIdx}\` : "");
    const r = await fetch(url);
    state.current = await r.json();
  } catch(e) { return toast("ERR: " + e.message); }
  renderItem();
  showScreen("review");
}

function renderItem() {
  const item = state.current;
  document.getElementById("rTitle").innerHTML = \`<a href="https://instagram.com/p/\${item.postId}" target="_blank">\${item.postId}</a>\`;
  document.getElementById("rImage").src = item.url;
  
  const prods = item.response?.products || [];
  document.getElementById("pCount").textContent = prods.length;
  document.getElementById("rMeta").innerHTML = \`<span class="badge">\${prods.length} PROD</span>\`;
  
  document.getElementById("pList").innerHTML = prods.map((p, i) => {
    const imgUrl = (p.selectedImages?.[0] || p.images?.[0] || "");
    return \`
      <div class="p-card \${p.reviewStatus === 'rejected' ? 'rejected' : ''}" onclick="openProduct(\${i})">
        <div class="p-img">\${imgUrl ? \`<img src="\${escapeHtml(imgUrl)}">\` : \`<div class="no-img">N/A</div>\`}</div>
        <div class="p-info">
          <div class="p-title">\${escapeHtml(p.title || p.name || "UNTITLED")}</div>
          <div class="p-brand">\${escapeHtml(p.store || p.brand || "Unknown")} &middot; \${escapeHtml(formatPrice(p.price))}</div>
          <div class="p-status">\u25A0 \${p.reviewStatus || 'pending'}</div>
        </div>
      </div>
    \`;
  }).join("");
}

function openProduct(idx) {
  state.editingIdx = idx;
  const p = state.current.response.products[idx];
  
  state.currentSelected = [...(p.selectedImages || [])];
  const allImages = new Set([state.current.url, ...(p.images || []), ...(p.customImages || [])]);
  state.currentGridUrls = [...new Set([...state.currentSelected, ...Array.from(allImages)])].filter(Boolean);

  let html = \`
    <div class="card" style="padding-bottom: 0;">
      <h3>IMAGES <span id="selCount" style="float:right; font-weight:normal;">\${state.currentSelected.length} SELECTED</span></h3>
      <div class="carousel" id="eImgGrid"></div>
      <div style="display:flex; gap:8px; margin-bottom:16px;">
        <button class="btn-ghost" onclick="addImage()" style="flex:1; border:1px dashed var(--border);">+ URL</button>
        <button class="btn-ghost" onclick="state.currentSelected=[]; renderImgGrid();" style="flex:1; border:1px dashed var(--danger); color:var(--danger);">CLEAR</button>
      </div>
    </div>

    <div class="card">
      <h3>BASIC INFO</h3>
      <div class="field"><label>Title</label><input id="eTitle" value="\${escapeHtml(p.title || p.name || "")}"></div>
      <div class="field-row">
        <div class="field"><label>Brand</label><input id="eBrand" value="\${escapeHtml(p.brand || "")}"></div>
        <div class="field"><label>Vendor/Store</label><input id="eVendor" value="\${escapeHtml(p.vendor || p.store || "")}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Category</label><input id="eCategory" value="\${escapeHtml(p.category || p.primary_category || "")}"></div>
        <div class="field"><label>Product Type</label><input id="eProdType" value="\${escapeHtml(p.product_type || "")}"></div>
      </div>
      
      <div class="field" style="margin-bottom:24px;">
        <label>Supplier URL</label>
        <div style="display:flex; gap:8px;">
          <input id="eUrl" type="url" value="\${escapeHtml(p.url || "")}">
          <button id="btnSyncData" class="btn-primary" style="padding:0 16px;" onclick="syncDataLlm()">SYNC DATA</button>
          \${p.url ? \`<a href="\${escapeHtml(p.url)}" target="_blank" class="btn-ghost" style="border:1px solid var(--border); padding:14px; text-decoration:none;">VISIT</a>\` : ''}
        </div>
      </div>
    </div>

    <div class="card">
      <h3>PRICING & MARGINS</h3>
      <div class="field-row">
        <div class="field"><label>Current Price</label><input id="ePrice" type="number" step="0.01" value="\${escapeHtml(p.price?.current || p.price || "")}"></div>
        <div class="field"><label>Compare At</label><input id="eCompare" type="number" step="0.01" value="\${escapeHtml(p.price?.original || p.compare_at_price || "")}"></div>
        <div class="field"><label>Currency</label><input id="eCurrency" value="\${escapeHtml(p.price?.currency || p.currency || "USD")}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Base Price (For Markup)</label><input id="eBasePrice" type="number" step="0.01" value="\${escapeHtml(p.basePrice || p.base_price_for_markup || "")}"></div>
        <div class="field"><label>Markup %</label><input id="eMarkupPct" type="number" step="1" value="\${escapeHtml(p.recommendedMarkup?.value || p.recommended_markup_percentage || "")}"></div>
      </div>
      <div class="field-row">
        <div class="field"><label>Calc Margin Amount</label><input id="eCalcAmount" class="readonly-field" readonly value="\${escapeHtml(p.calculated_markup_amount || "")}"></div>
        <div class="field"><label>Suggested Resell Price</label><input id="eResellPrice" class="readonly-field" readonly value="\${escapeHtml(p.suggested_resell_price || "")}"></div>
      </div>
    </div>

    <div class="card">
      <h3>DETAILS & CONTENT</h3>
      <div class="field-row">
        <div class="field"><label>Color</label><input id="eColor" value="\${escapeHtml(p.color || "")}"></div>
        <div class="field"><label>Material</label><input id="eMaterial" value="\${escapeHtml(p.material || "")}"></div>
        <div class="field"><label>SKU</label><input id="eSku" value="\${escapeHtml(p.sku || "")}"></div>
      </div>
      <div class="field"><label>Description</label><textarea id="eDesc">\${escapeHtml(p.description || "")}</textarea></div>
      <div class="field"><label>Features (JSON Array or Text)</label><textarea id="eFeatures">\${escapeHtml(Array.isArray(p.features) ? JSON.stringify(p.features, null, 2) : (p.features || ""))}</textarea></div>
      <div class="field"><label>Dropship Advisory (LLM Reasoning)</label><textarea id="eAdvisory" class="readonly-field" readonly>\${escapeHtml(p.dropship_advisory || "")}</textarea></div>
    </div>

    <div class="card">
      <h3>POLICIES & LOGISTICS</h3>
      <div class="field-row">
        <div class="field">
          <label>Availability</label>
          <select id="eAvail">
            <option \${p.availability === 'InStock' || p.availability === 'In stock' ? 'selected' : ''}>InStock</option>
            <option \${p.availability === 'OutOfStock' || p.availability === 'Out of stock' ? 'selected' : ''}>OutOfStock</option>
            <option \${p.availability === 'PreOrder' || p.availability === 'Pre-order' ? 'selected' : ''}>PreOrder</option>
            <option \${!p.availability || p.availability === 'Unknown' ? 'selected' : ''}>Unknown</option>
          </select>
        </div>
      </div>
      <div class="field"><label>Shipping Info</label><textarea id="eShipping">\${escapeHtml(p.shipping_info || p.shippingAndReturns || "")}</textarea></div>
      <div class="field"><label>Return Policy</label><textarea id="eReturns">\${escapeHtml(p.return_policy || "")}</textarea></div>
    </div>

    <div class="card">
      <h3>RAW DATA (READ-ONLY)</h3>
      <div class="field"><label>Variants JSON</label><textarea class="readonly-field" readonly>\${escapeHtml(JSON.stringify(p.variants || [], null, 2))}</textarea></div>
      <div class="field"><label>Reviews JSON</label><textarea class="readonly-field" readonly>\${escapeHtml(JSON.stringify(p.reviews || [], null, 2))}</textarea></div>
      <div class="field"><label>Size Guide JSON</label><textarea class="readonly-field" readonly>\${escapeHtml(JSON.stringify(p.size_guide || p.sizingGuide || {}, null, 2))}</textarea></div>
    </div>

    <div class="card" style="border:none;">
      <div style="display:flex;gap:12px">
        <button class="btn-danger" onclick="rejectProduct()" style="flex:1">REJECT</button>
        <button class="btn-primary" onclick="saveProduct('completed')" style="flex:1">SAVE</button>
      </div>
    </div>
  \`;
  
  document.getElementById("eBody").innerHTML = html;
  renderImgGrid();
  showScreen("editor");
}

function renderImgGrid() {
  const grid = document.getElementById("eImgGrid");
  document.getElementById("selCount").textContent = state.currentSelected.length + " SELECTED";
  
  grid.innerHTML = state.currentGridUrls.map(url => {
    const selIdx = state.currentSelected.indexOf(url);
    const isOn = selIdx > -1;
    return \`
      <div class="img-cell \${isOn ? 'on' : ''}" onclick="toggleImageSelection('\${escapeHtml(url)}')">
        <img src="\${escapeHtml(url)}" loading="lazy" onerror="this.style.opacity=0.1">
        <div class="check">\${isOn ? selIdx + 1 : ''}</div>
      </div>
    \`;
  }).join("");
}

function toggleImageSelection(url) {
  const idx = state.currentSelected.indexOf(url);
  if (idx > -1) state.currentSelected.splice(idx, 1);
  else state.currentSelected.push(url);
  renderImgGrid();
}

async function syncDataLlm() {
  const url = document.getElementById("eUrl").value;
  if (!url) return toast("NO URL PROVIDED");
  
  const btn = document.getElementById("btnSyncData");
  btn.disabled = true; btn.innerText = "SYNCING...";
  
  try {
    const r = await fetch("/api/extract-data", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    const cleanJson = d.data;

    // Map new fields to UI
    const setVal = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.value = val; };
    
    setVal("eTitle", cleanJson.name);
    setVal("eBrand", cleanJson.brand);
    setVal("eVendor", cleanJson.vendor);
    setVal("eCategory", cleanJson.primary_category);
    setVal("eProdType", cleanJson.product_type);
    setVal("eColor", cleanJson.color);
    setVal("eMaterial", cleanJson.material);
    setVal("ePrice", cleanJson.price);
    setVal("eComparePrice", cleanJson.compare_at_price);
    setVal("eCurrency", cleanJson.currency);
    setVal("eAvail", cleanJson.availability || "Unknown");
    setVal("eSku", cleanJson.sku);
    setVal("eBasePrice", cleanJson.base_price_for_markup);
    setVal("eMarkupPct", cleanJson.recommended_markup_percentage);
    setVal("eCalcAmount", cleanJson.calculated_markup_amount);
    setVal("eResellPrice", cleanJson.suggested_resell_price);
    setVal("eDesc", cleanJson.description);
    setVal("eFeatures", JSON.stringify(cleanJson.features || [], null, 2));
    setVal("eAdvisory", cleanJson.dropship_advisory);
    setVal("eShipping", cleanJson.shipping_info);
    setVal("eReturns", cleanJson.return_policy);

    if (cleanJson.images?.length) {
        cleanJson.images.forEach(u => {
            if (!state.currentGridUrls.includes(u)) state.currentGridUrls.unshift(u);
            if (!state.currentSelected.includes(u)) state.currentSelected.push(u);
        });
        renderImgGrid();
    }

    toast("DATA SYNCED WITH LLM!");
  } catch(e) {
    toast("ERROR: " + e.message);
  } finally {
    btn.disabled = false; btn.innerText = "SYNC DATA";
  }
}

async function saveProduct(status = "completed") {
  const p = state.current.response.products[state.editingIdx];
  const getVal = (id) => document.getElementById(id).value;
  
  p.title = getVal("eTitle");
  p.name = getVal("eTitle");
  p.brand = getVal("eBrand");
  p.vendor = getVal("eVendor");
  p.store = getVal("eVendor");
  p.category = getVal("eCategory");
  p.primary_category = getVal("eCategory");
  p.product_type = getVal("eProdType");
  p.url = getVal("eUrl");
  
  p.price = { current: getVal("ePrice"), currency: getVal("eCurrency") }; // Legacy support
  p.compare_at_price = getVal("eComparePrice");
  p.currency = getVal("eCurrency");
  
  p.base_price_for_markup = getVal("eBasePrice");
  p.recommended_markup_percentage = getVal("eMarkupPct");
  p.calculated_markup_amount = getVal("eCalcAmount");
  p.suggested_resell_price = getVal("eResellPrice");
  
  p.color = getVal("eColor");
  p.material = getVal("eMaterial");
  p.sku = getVal("eSku");
  p.availability = getVal("eAvail");
  
  p.description = getVal("eDesc");
  try { p.features = JSON.parse(getVal("eFeatures")); } catch(e) { p.features = getVal("eFeatures").split('\\n'); }
  p.dropship_advisory = getVal("eAdvisory");
  
  p.shipping_info = getVal("eShipping");
  p.return_policy = getVal("eReturns");
  p.shippingAndReturns = getVal("eShipping") + "\\n" + getVal("eReturns"); // Legacy support
  
  p.selectedImages = [...state.currentSelected];
  p.reviewStatus = status;
  
  try {
    const body = { docId: state.current._id, fileIdx: state.current.fileIdx, frameIdx: state.current.frameIdx, prodIdx: state.editingIdx, product: p };
    await fetch("/api/product", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    toast("SAVED & PROPAGATED");
    closeEditor();
    openItem(state.current._id, state.current.fileIdx, state.current.frameIdx); // Reload
  } catch(e) { toast("ERR: " + e.message); }
}

function rejectProduct() { state.currentSelected = []; saveProduct("rejected"); }
function closeEditor() { showScreen("review"); }

async function commitItem() {
  await fetch("/api/commit", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ docId: state.current._id, fileIdx: state.current.fileIdx, frameIdx: state.current.frameIdx }) });
  toast("COMMITTED"); loadQueue();
}
async function deleteItem() {
  await fetch("/api/delete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ docId: state.current._id, fileIdx: state.current.fileIdx, frameIdx: state.current.frameIdx }) });
  toast("DELETED"); loadQueue();
}

loadQueue();
</script>
</body>
</html>`;

/* -------------------------------------------------------------------------- */
/* MONGODB HELPERS & AUTO-MIGRATION (FLATTENING)                              */
/* -------------------------------------------------------------------------- */

function flattenProducts(products) {
    let modified = false;
    const flattened = [];
    const seenUrls = new Map();

    const mergeArrays = (existingItem, newItem, field, isObjectArray = false) => {
        if (!newItem[field] || !Array.isArray(newItem[field]) || newItem[field].length === 0) return;
        const existingArr = Array.isArray(existingItem[field]) ? existingItem[field] : [];
        const seen = new Set(existingArr.map(i => isObjectArray ? (typeof i === 'object' && i !== null ? i.url : i) : i));
        let changed = false;

        newItem[field].forEach(item => {
            const checkVal = isObjectArray ? (typeof item === 'object' && item !== null ? item.url : item) : item;
            if (checkVal && !seen.has(checkVal)) {
                seen.add(checkVal); existingArr.push(item); changed = true;
            }
        });
        if (changed || (!existingItem[field] && existingArr.length > 0)) existingItem[field] = existingArr;
    };

    for (const p of products) {
        if (p.isFlattened) {
            if (p.url) {
                if (seenUrls.has(p.url)) {
                    const existing = seenUrls.get(p.url);
                    mergeArrays(existing, p, 'images', true);
                    mergeArrays(existing, p, 'customImages', false);
                    mergeArrays(existing, p, 'selectedImages', false);
                    modified = true; continue; 
                }
                seenUrls.set(p.url, p);
            }
            flattened.push(p);
            continue;
        }
        modified = true;

        const base = { ...p, isFlattened: true, reviewStatus: p.reviewStatus || 'pending' };
        delete base.sources; delete base.customSources; delete base.alternatives;

        const allSources = [...(Array.isArray(p.sources) ? p.sources : []), ...(Array.isArray(p.customSources) ? p.customSources : [])];
        const totalOriginalVariants = allSources.length + (Array.isArray(p.alternatives) ? p.alternatives.length : 0);

        const addVariant = (variant) => {
            if (variant.url) {
                if (seenUrls.has(variant.url)) {
                    const existing = seenUrls.get(variant.url);
                    mergeArrays(existing, variant, 'images', true);
                    mergeArrays(existing, variant, 'customImages', false);
                    mergeArrays(existing, variant, 'selectedImages', false);
                    return; 
                }
                seenUrls.set(variant.url, variant);
            }
            flattened.push(variant);
        };

        // NEW: Safely spread all source properties so UI gets the full LLM schema
        allSources.forEach(s => {
            addVariant({
                ...base,
                ...s,
                url: s.url || '',
                images: s.images || []
            });
        });

        if (Array.isArray(p.alternatives)) {
            p.alternatives.forEach(a => {
                addVariant({ ...base, ...a, url: a.url || '', images: [] });
            });
        }

        if (totalOriginalVariants === 0) addVariant({ ...base, store: '', url: '', images: [] });
    }
    return { flattened, modified };
}

function normalizeResponse(item) {
    let resp = item.response;
    if (typeof resp === 'string') { try { resp = JSON.parse(resp); } catch { resp = { products: [], rawText: resp }; } }
    if (!resp || typeof resp !== 'object') resp = { products: [] };
    if (!Array.isArray(resp.products)) resp.products = [];

    resp.products = resp.products.map(p => ({
        ...p,
        reviewStatus: p.reviewStatus || 'pending',
        selectedImages: p.selectedImages || [],
        images: p.images || [],
    }));
    return resp;
}

function getItemStatus(item) {
    const resp = normalizeResponse(item);
    const { flattened } = flattenProducts(resp.products);
    if (!flattened.length) return 'pending';
    const allDone = flattened.every(p => p.reviewStatus === 'completed' || p.reviewStatus === 'rejected');
    const someDone = flattened.some(p => p.reviewStatus === 'completed' || p.reviewStatus === 'rejected');
    return allDone ? 'done' : (someDone ? 'partial' : 'pending');
}

async function buildQueue(collection) {
    const posts = await collection.find({
        discarded: { $ne: true },
        $or: [
            { file_urls: { $elemMatch: { type: 'image', reviewed: true, auditStatus: 'audited', humanReviewed: { $ne: true }, discarded: { $ne: true } } } },
            { 'file_urls.frames': { $elemMatch: { type: 'image', reviewed: true, auditStatus: 'audited', humanReviewed: { $ne: true }, discarded: { $ne: true } } } }
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
                postItems.push({ _id: post._id.toString(), postId: post.post_id, fileIdx: i, frameIdx: null, thumb: f.url, status: getItemStatus(f), type: 'image' });
            } else if (f.type === 'video' && Array.isArray(f.frames)) {
                for (let j = 0; j < f.frames.length; j++) {
                    const frame = f.frames[j];
                    if (frame && frame.reviewed && !frame.humanReviewed && !frame.discarded) {
                        postItems.push({ _id: post._id.toString(), postId: post.post_id, fileIdx: i, frameIdx: j, thumb: frame.url, status: getItemStatus(frame), type: 'frame' });
                    }
                }
            }
        }
        if (postItems.length > 0) grouped[post.post_id] = { postId: post.post_id, _id: post._id.toString(), items: postItems };
    }
    return { posts: grouped, items: Object.values(grouped).flatMap(g => g.items) };
}

async function checkDone(collection) {
    return await collection.countDocuments({
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

async function propagateReviewToSameSources(collection, docId, sourceUrl, updatedProduct, currentFileIdx, currentFrameIdx) {
  if (!sourceUrl) return 0;
  try {
    const post = await collection.findOne({ _id: new ObjectId(docId) }, { projection: { file_urls: 1 } });
    if (!post || !Array.isArray(post.file_urls)) return 0;

    let updatedCount = 0;
    const applyUpdate = async (base) => {
        const setObj = {};
        for (const [k, v] of Object.entries(updatedProduct)) {
            if (v !== undefined) setObj[`${base}.${k}`] = v;
        }
        setObj[`${base}.reviewedAt`] = new Date();
        await collection.updateOne({ _id: new ObjectId(docId) }, { $set: setObj });
        updatedCount++;
    };

    for (let fi = 0; fi < post.file_urls.length; fi++) {
      const f = post.file_urls[fi];
      if (!f || f.discarded) continue;

      if (f.type === 'image' && f.response && Array.isArray(f.response.products)) {
        for (let pi = 0; pi < f.response.products.length; pi++) {
          if (f.response.products[pi].url === sourceUrl && !(fi === currentFileIdx && currentFrameIdx === -1)) {
            await applyUpdate(`file_urls.${fi}.response.products.${pi}`);
          }
        }
      }

      if (f.type === 'video' && Array.isArray(f.frames)) {
        for (let fr = 0; fr < f.frames.length; fr++) {
          const frame = f.frames[fr];
          if (!frame || frame.discarded || !frame.response || !Array.isArray(frame.response.products)) continue;
          for (let pi = 0; pi < frame.response.products.length; pi++) {
            if (frame.response.products[pi].url === sourceUrl && !(fi === currentFileIdx && fr === currentFrameIdx)) {
              await applyUpdate(`file_urls.${fi}.frames.${fr}.response.products.${pi}`);
            }
          }
        }
      }
    }
    if (updatedCount > 0) log('info', `Propagated review to ${updatedCount} duplicate source(s) (url: ${sourceUrl})`);
    return updatedCount;
  } catch (err) { log('warn', 'Propagation failed:', err.message); return 0; }
}

/* -------------------------------------------------------------------------- */
/* EXTERNAL API HELPERS (Catbox Upload, Python Extract, LLM Sync)             */
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

        const scriptPath = path.resolve(process.cwd(), mode === 'text' ? 'ecom-text-extractor.py' : 'ecom-image-extractor.py');
        if (!fs.existsSync(scriptPath)) {
            try { fs.unlinkSync(inFile); } catch(e){}
            return reject(new Error(`${mode === 'text' ? 'ecom-text-extractor.py' : 'ecom-image-extractor.py'} NOT FOUND.`));
        }

        const args = ['-u', scriptPath, '-u', inFile, '-o', outFile, '--lazy-extraction'];
        log('info', `Running extractor (${mode}): python3 ${args.join(' ')}`);
        const proc = spawn('python3', args);
        
        let stderr = '';
        proc.stdout.on('data', d => process.stdout.write(`[EXTRACTOR] ${d}`));
        proc.stderr.on('data', d => { stderr += d; process.stderr.write(`[EXTRACTOR] ${d}`); });

        proc.on('close', code => {
            if (code !== 0) {
                try { fs.unlinkSync(inFile); fs.unlinkSync(outFile); } catch(e){}
                return reject(new Error(`Extractor crashed (code ${code}). Stderr: ${stderr.slice(0,200)}`));
            }
            try {
                if (!fs.existsSync(outFile)) throw new Error("No output generated by python script.");
                const resultData = JSON.parse(fs.readFileSync(outFile, 'utf8'));
                fs.unlinkSync(inFile); fs.unlinkSync(outFile);
                
                const data = resultData[targetUrl] || [];
                if (data.error) throw new Error(data.error);
                resolve(data);
            } catch (err) { reject(err); }
        });
    });
}

async function callGeminiForExtraction(rawJson) {
    const keys = (process.env.ORCH_GEMINI_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
    if (!keys.length) throw new Error('No Gemini API keys configured on Review Server. Manual LLM sync disabled.');
    
    const apiKey = keys[Math.floor(Math.random() * keys.length)];
    const model = process.env.ORCH_GEMINI_MODEL || 'gemini-3.5-flash-lite';
    const payload = JSON.stringify([{ source_id: 'sync_test', raw_data: rawJson }]);

    const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: DATA_EXTRACTION_PROMPT }, { text: payload }] }],
                generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
            }),
        }
    );

    if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`Gemini API error (${resp.status}): ${body.slice(0, 300)}`);
    }

    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('Gemini response missing text content');

    const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('Gemini response invalid or empty');
    return parsed[0]; 
}

/* -------------------------------------------------------------------------- */
/* NGROK                                                                      */
/* -------------------------------------------------------------------------- */
async function startNgrok(port) {
    try {
        const { spawn } = await import('child_process');
        const ngrok = spawn('ngrok', ['http', String(port)], { stdio: 'pipe' });

        let url = null, buffer = '', resolved = false;
        const onData = (chunk) => {
            if (resolved) return;
            buffer += chunk.toString();
            const match = buffer.match(/https:\/\/[a-zA-Z0-9-]+\.ngrok(?:-free)?\.(?:app|io)/);
            if (match) { url = match[0]; resolved = true; }
        };

        ngrok.stdout.on('data', onData);
        ngrok.stderr.on('data', onData);
        await new Promise(r => setTimeout(r, 12000));

        if (url) { log('info', `ngrok tunnel: ${url}`); return { url, process: ngrok }; }

        try {
            const apiRes = await fetch('http://127.0.0.1:4040/api/tunnels');
            const apiData = await apiRes.json();
            const tunnel = apiData.tunnels?.find(t => t.public_url?.startsWith('https'));
            if (tunnel) {
                url = tunnel.public_url;
                log('info', `ngrok tunnel (via API): ${url}`);
                return { url, process: ngrok };
            }
        } catch (e) { log('warn', 'ngrok API fallback failed:', e.message); }

        ngrok.kill(); return null;
    } catch (err) { log('error', 'ngrok failed:', err.message); return null; }
}

/* -------------------------------------------------------------------------- */
/* SERVER                                                                     */
/* -------------------------------------------------------------------------- */
async function main() {
    log('info', '===============================================================');
    log('info', '  REVIEW SERVER — Production Human Review v1.2');
    log('info', '===============================================================');

    if (!CONFIG.mongodb.uri) { log('error', 'ORCH_MONGODB_URI is required'); process.exit(1); }

    log('info', 'Connecting to MongoDB...');
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
                if (!vidUrl) { res.writeHead(400); res.end('No video url specified'); return; }
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

                let objectId;
                try { objectId = new ObjectId(docId); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid document ID' })); return; }

                const post = await collection.findOne({ _id: objectId }, { projection: { post_id: 1, file_urls: 1 } });
                if (!post || !post.file_urls || !post.file_urls[fileIdx]) { res.writeHead(404); res.end(JSON.stringify({ error: 'Not found' })); return; }

                const file = post.file_urls[fileIdx];
                let item;
                if (frameIdx !== null) {
                    if (!file.frames || !file.frames[frameIdx]) { res.writeHead(404); res.end(JSON.stringify({ error: 'Frame not found' })); return; }
                    item = file.frames[frameIdx]; item.type = 'frame'; item.parentUrl = file.url;
                } else {
                    item = file; item.type = 'image';
                }

                const response = normalizeResponse(item);
                const { flattened, modified } = flattenProducts(response.products);
                if (modified) {
                    response.products = flattened;
                    const updatePath = frameIdx !== null ? `file_urls.${fileIdx}.frames.${frameIdx}.response.products` : `file_urls.${fileIdx}.response.products`;
                    await collection.updateOne({ _id: objectId }, { $set: { [updatePath]: flattened } });
                }

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ _id: post._id.toString(), postId: post.post_id, fileIdx, frameIdx, url: item.url, parentUrl: item.parentUrl || null, type: item.type, response }));
            } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
            return;
        }

        if (parsed.pathname === '/api/extract-data' && req.method === 'POST') {
            let body = '';
            req.on('data', d => body += d);
            req.on('end', async () => {
                try {
                    const { url } = JSON.parse(body);
                    if (!url) throw new Error("No URL provided");
                    
                    const rawData = await runPythonExtractor(url, 'text');
                    const cleanData = await callGeminiForExtraction(rawData);

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ data: cleanData }));
                } catch (e) {
                    log('error', `Sync API error: ${e.message}`);
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
                    try { objectId = new ObjectId(docId); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid document ID' })); return; }

                    const basePath = frameIdx !== null && frameIdx !== undefined
                        ? `file_urls.${fileIdx}.frames.${frameIdx}.response.products.${prodIdx}`
                        : `file_urls.${fileIdx}.response.products.${prodIdx}`;

                    // Completely overwrite the product object with the frontend's full state
                    await collection.updateOne({ _id: objectId }, { $set: { [basePath]: product } });

                    if (product.url) {
                      propagateReviewToSameSources(collection, docId, product.url, product, fileIdx, frameIdx)
                        .catch(e => log('warn', 'Propagation error (non-fatal):', e.message));
                    }

                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
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
                    const objectId = new ObjectId(docId);
                    const path = frameIdx !== null && frameIdx !== undefined ? `file_urls.${fileIdx}.frames.${frameIdx}` : `file_urls.${fileIdx}`;

                    await collection.updateOne({ _id: objectId }, { $set: { [`${path}.humanReviewed`]: true, [`${path}.humanReviewedAt`]: new Date() } });
                    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));

                    const remaining = await checkDone(collection);
                    if (remaining === 0) serverResolve();
                } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
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
                    const objectId = new ObjectId(docId);
                    const path = frameIdx !== null && frameIdx !== undefined ? `file_urls.${fileIdx}.frames.${frameIdx}` : `file_urls.${fileIdx}`;

                    await collection.updateOne({ _id: objectId }, { $set: { [`${path}.discarded`]: true } });
                    await maybeDiscardEmptyPost(collection, docId);
                    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }));

                    const remaining = await checkDone(collection);
                    if (remaining === 0) serverResolve();
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
            log('info', '===============================================================');
            log('info', `  OPEN ON YOUR BROWSER: ${ngrok.url}`);
            log('info', '===============================================================');
            ngrokProc = ngrok.process;
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
