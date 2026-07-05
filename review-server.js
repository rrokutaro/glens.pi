/**
 * review-server.final.js
 *
 * FINAL PRODUCTION-READY Human Review Server for UGC Dropship Pipeline
 *
 * Purpose:
 *   After GLENS (Google Lens) + Gemini review stages have run, this server lets a human
 *   curator validate, enrich and approve every file_url (image or video) before it is
 *   used to generate dropshipping product pages / bridge pages.
 *
 * Key Features (addressing previous shortcomings):
 *   - Per-file_url review (each becomes its own postable item)
 *   - Full support for videos + extracted frames (show frames as reviewable media)
 *   - "Pull Images from Source" — one-click extraction of high-quality product images
 *     from any source URL using the ecom-image-extractor.py (lazy mode)
 *   - Image curation: choose exactly which images (from GLENS + extracted from sources + manual)
 *     will be used for the final dropship creative
 *   - Source validation & management: visit, remove bad sources, add your own
 *   - Full metadata editing (title, brand, price, sizes, description, availability)
 *   - Reject / approve individual products inside a file_url
 *   - Mark file_url as humanReviewed + readyForDropship when done
 *   - Mobile-first, fast, works great over ngrok on phone
 *   - Auto-exits when queue is empty (perfect for CI / manual gate step)
 *
 * Usage:
 *   node review-server.final.js
 *   (or via GitHub Actions review.yml with REVIEW_PORT and NGROK_AUTHTOKEN)
 *
 * Environment:
 *   ORCH_MONGODB_URI (required)
 *   REVIEW_PORT=3456
 *   NGROK_AUTHTOKEN (optional but recommended)
 *   Path to ecom-image-extractor.py must be correct (see CONFIG)
 */

import http from 'http';
import { MongoClient, ObjectId } from 'mongodb';
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    // Path to the excellent ecom image extractor (used for "Pull from Source")
    pythonPath: process.env.REVIEW_PYTHON || 'python3',
    extractorScript: process.env.REVIEW_EXTRACTOR_SCRIPT || path.join(__dirname, '..', 'attachments', 'ecom-image-extractor.py'),
    // Where to put temp files for extraction
    tmpDir: path.join(process.cwd(), 'review-tmp'),
};

if (!fs.existsSync(CONFIG.tmpDir)) fs.mkdirSync(CONFIG.tmpDir, { recursive: true });

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
//  MOBILE REVIEW UI (highly polished, self-contained)
// ═══════════════════════════════════════════════════════════════════════════════
const REVIEW_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta name="theme-color" content="#0a0a0a">
<title>Review • Dropship</title>
<style>
:root { --accent:#4ade80; --danger:#ef4444; --card:#141414; }
*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;-webkit-tap-highlight-color:transparent}
body{background:#0a0a0a;color:#e5e5e5;min-height:100dvh;overflow-x:hidden}
button{cursor:pointer;padding:12px 18px;border:none;border-radius:12px;background:#262626;color:#e5e5e5;font-size:15px;font-weight:600;min-height:44px;transition:all .1s}
button:active{transform:scale(0.97)}
button.primary{background:var(--accent);color:#000}
button.danger{background:var(--danger);color:#fff}
button.ghost{background:transparent;border:1px solid #404040}
button.small{padding:8px 14px;font-size:13px;min-height:36px}
input,select,textarea{background:#1a1a1a;border:1px solid #333;color:#e5e5e5;padding:12px 14px;border-radius:12px;font-size:15px;width:100%}
input:focus,select:focus,textarea:focus{outline:none;border-color:var(--accent)}
img,video{max-width:100%;border-radius:12px;display:block}
.topbar{position:sticky;top:0;z-index:100;background:#0a0a0a;border-bottom:1px solid #222;padding:14px 16px;display:flex;align-items:center;gap:12px}
.topbar h1{font-size:18px;font-weight:700;flex:1}
.topbar .count{background:var(--accent);color:#000;font-size:12px;font-weight:800;padding:4px 12px;border-radius:999px}
.queue{padding:16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:10px}
.qitem{position:relative;aspect-ratio:3/4;border-radius:16px;overflow:hidden;background:#1a1a1a;border:2px solid transparent}
.qitem.on{border-color:var(--accent)}
.qitem img{width:100%;height:100%;object-fit:cover}
.qitem .badge{position:absolute;top:8px;left:8px;padding:3px 9px;border-radius:8px;font-size:10px;font-weight:700;background:rgba(0,0,0,.75);backdrop-filter:blur(6px)}
.qitem .badge.pending{background:#f59e0b;color:#000}
.qitem .badge.partial{background:#eab308;color:#000}
.qitem .badge.done{background:var(--accent);color:#000}
.qitem .play{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:42px;height:42px;background:rgba(0,0,0,.6);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px}
.qitem .id{position:absolute;bottom:0;left:0;right:0;padding:22px 10px 8px;background:linear-gradient(transparent,#000);font-size:11px;color:#aaa;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.reviewview{padding-bottom:120px}
.media-scroll{display:flex;gap:12px;padding:14px 16px;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch}
.media-scroll::-webkit-scrollbar{display:none}
.media-item{flex:0 0 82%;scroll-snap-align:center;border-radius:18px;overflow:hidden;border:3px solid transparent;background:#1a1a1a;position:relative}
.media-item.on{border-color:var(--accent)}
.media-item video,.media-item img{width:100%;aspect-ratio:3/4;object-fit:cover}
.media-item .label{position:absolute;bottom:0;left:0;right:0;padding:8px 12px;background:linear-gradient(transparent,#000);font-size:12px;color:#ccc;text-align:center}
.chips{padding:0 16px 12px;display:flex;gap:8px;overflow-x:auto;white-space:nowrap}
.chips::-webkit-scrollbar{display:none}
.chip{display:inline-flex;align-items:center;gap:8px;padding:10px 18px;background:#1a1a1a;border:2px solid #333;border-radius:999px;font-size:14px;font-weight:600;flex-shrink:0}
.chip.on{border-color:var(--accent);background:#0f2a1f}
.chip .dot{width:9px;height:9px;border-radius:50%}
.editor{padding:16px 16px 140px}
.editor h2{font-size:22px;font-weight:800;margin-bottom:2px}
.editor .subtitle{color:#888;font-size:14px;margin-bottom:18px}
.card{background:var(--card);border:1px solid #222;border-radius:18px;padding:18px;margin-bottom:14px}
.card h3{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#777;margin-bottom:14px;font-weight:700}
.img-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px}
.img-cell{aspect-ratio:1;border-radius:14px;overflow:hidden;position:relative;border:3px solid transparent;background:#1a1a1a}
.img-cell.on{border-color:var(--accent)}
.img-cell img{width:100%;height:100%;object-fit:cover}
.img-cell .check{position:absolute;top:8px;right:8px;width:26px;height:26px;background:var(--accent);border-radius:50%;display:none;align-items:center;justify-content:center;font-size:15px;color:#000;font-weight:900}
.img-cell.on .check{display:flex}
.source-row{display:flex;align-items:center;gap:14px;padding:14px 16px;background:#1a1a1a;border-radius:14px;margin-bottom:8px}
.source-row .info{flex:1;min-width:0}
.source-row .name{font-size:15px;font-weight:600;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.source-row .price{font-size:13px;color:#888}
.source-row .actions{display:flex;gap:6px}
.source-row button{padding:8px 12px;font-size:12px;min-height:36px;border-radius:10px}
.field{margin-bottom:16px}
.field label{display:block;font-size:12px;color:#888;margin-bottom:6px;font-weight:600}
.field input,.field select,.field textarea{font-size:15px}
.actions-row{display:flex;gap:12px}
.actions-row button{flex:1;padding:16px;font-size:16px;font-weight:700;border-radius:14px}
#commitBar{position:fixed;bottom:0;left:0;right:0;padding:16px;background:linear-gradient(transparent,#0a0a0a 25%);display:flex;gap:12px;z-index:60}
.sheet{position:fixed;bottom:0;left:0;right:0;background:#0a0a0a;border-top:1px solid #333;border-radius:24px 24px 0 0;padding:24px 18px 40px;z-index:200;transform:translateY(100%);transition:transform .25s cubic-bezier(.32,1,.23,1)}
.sheet.open{transform:translateY(0)}
.sheet .handle{width:44px;height:5px;background:#444;border-radius:3px;margin:0 auto 20px}
.sheet h3{font-size:19px;font-weight:800;margin-bottom:18px}
.sheet .option{padding:16px 18px;border-radius:14px;font-size:16px;margin-bottom:8px;background:#1a1a1a}
.sheet .option:active{background:#262626}
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.65);z-index:150;opacity:0;pointer-events:none;transition:opacity .2s}
.overlay.on{opacity:1;pointer-events:auto}
.loading{display:flex;align-items:center;justify-content:center;height:100dvh;color:#888}
.spinner{width:30px;height:30px;border:3px solid #333;border-top-color:var(--accent);border-radius:50%;animation:spin .8s linear infinite;margin-right:14px}
@keyframes spin{to{transform:rotate(360deg)}}
.hide{display:none}
.picker-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;max-height:420px;overflow-y:auto;padding:4px}
.picker-cell{position:relative;aspect-ratio:1;border-radius:12px;overflow:hidden;border:3px solid transparent}
.picker-cell.on{border-color:var(--accent)}
.picker-cell img{width:100%;height:100%;object-fit:cover}
.picker-cell .check{position:absolute;top:8px;right:8px;width:24px;height:24px;background:var(--accent);border-radius:50%;display:none;align-items:center;justify-content:center;color:#000;font-weight:900;font-size:14px}
.picker-cell.on .check{display:flex}
.raw-json{background:#111;border:1px solid #333;border-radius:12px;padding:12px;max-height:280px;overflow:auto;font-family:monospace;font-size:12px;color:#aaa;white-space:pre-wrap}
.status-bar{padding:8px 16px;font-size:13px;color:#666;text-align:center}
</style>
</head>
<body>
<div id="app">
  <div class="loading" id="loadScreen"><div class="spinner"></div>Loading review queue...</div>

  <!-- QUEUE VIEW -->
  <div id="queueView" class="hide">
    <div class="topbar">
      <h1>Review Queue</h1>
      <span class="count" id="qCount">0</span>
    </div>
    <div class="queue" id="queue"></div>
    <div class="status-bar" id="statusBar"></div>
  </div>

  <!-- REVIEW VIEW -->
  <div id="reviewView" class="reviewview hide">
    <div class="topbar">
      <button class="ghost" onclick="back()">← Back</button>
      <h1 id="rTitle">Post</h1>
      <div style="width:70px"></div>
    </div>

    <!-- Media horizontal scroller -->
    <div class="media-scroll" id="mediaScroll"></div>

    <!-- Product chips -->
    <div class="chips" id="chips"></div>

    <!-- Editor -->
    <div class="editor" id="editor">
      <h2 id="eTitle">Product Title</h2>
      <div class="subtitle" id="eSub"></div>

      <!-- Images -->
      <div class="card">
        <h3>Selected Images for Dropship Page <span id="imgCount" style="font-weight:400;color:#666"></span></h3>
        <div class="img-grid" id="imgGrid"></div>
        <div style="display:flex;gap:8px;margin-top:4px">
          <button class="ghost small" onclick="addImageUrl()" style="flex:1">+ Paste Image URL</button>
          <button class="ghost small" onclick="showRawResponse()" style="flex:1">View Raw Lens Data</button>
        </div>
      </div>

      <!-- Sources -->
      <div class="card">
        <h3>Product Sources <span style="font-weight:400;color:#666">(validate these!)</span></h3>
        <div id="srcList"></div>
        <button class="ghost small" onclick="addSourceUrl()" style="width:100%;margin-top:10px">+ Add Your Own Source URL</button>
      </div>

      <!-- Metadata -->
      <div class="card">
        <h3>Metadata</h3>
        <div class="field"><label>Brand / Store</label><input id="fBrand" placeholder="e.g. Nike"></div>
        <div class="field" style="display:flex;gap:10px">
          <div style="flex:1"><label>Price</label><input id="fPrice" type="text" inputmode="decimal" placeholder="29.99"></div>
          <div style="width:110px"><label>Currency</label><select id="fCurr"><option>USD</option><option>EUR</option><option>GBP</option><option>CAD</option><option>AUD</option><option>ZAR</option></select></div>
        </div>
        <div class="field"><label>Availability</label><select id="fStock"><option>In stock</option><option>Out of stock</option><option>Pre-order</option></select></div>
        <div class="field"><label>Sizes (comma separated)</label><input id="fSizes" placeholder="S, M, L or 36-42"></div>
        <div class="field"><label>Description / Selling Points</label><textarea id="fDesc" rows="4" placeholder="Premium quality, breathable fabric, perfect for summer..."></textarea></div>
      </div>

      <div class="actions-row">
        <button class="danger" onclick="rejectProduct()">Reject Product</button>
        <button class="primary" onclick="saveProduct()">Save &amp; Next</button>
      </div>
    </div>

    <!-- Bottom bar -->
    <div id="commitBar">
      <button class="danger" onclick="deleteFileUrl()" style="flex:1">Delete File</button>
      <button class="primary" onclick="commitFileUrl()" style="flex:2">Mark as Approved &amp; Continue</button>
    </div>
  </div>
</div>

<!-- Overlay + Bottom Sheet -->
<div class="overlay" id="overlay" onclick="closeSheet()"></div>
<div class="sheet" id="sheet">
  <div class="handle"></div>
  <h3 id="sheetTitle"></h3>
  <div id="sheetContent"></div>
</div>

<!-- Image Picker Modal (for source extraction) -->
<div class="overlay" id="pickerOverlay" onclick="closePicker()"></div>
<div class="sheet" id="pickerSheet" style="max-height:85dvh">
  <div class="handle"></div>
  <h3 id="pickerTitle">Select images from source</h3>
  <div class="picker-grid" id="pickerGrid"></div>
  <div style="display:flex;gap:10px;margin-top:16px">
    <button class="ghost" onclick="closePicker()" style="flex:1">Cancel</button>
    <button class="primary" onclick="addSelectedFromPicker()" style="flex:1">Add Selected</button>
  </div>
</div>

<script>
let queue = [], post = null, fileIdx = 0, prodIdx = 0, selected = new Set();
let currentPickerImages = [];

async function loadQueue() {
  try {
    const r = await fetch('/api/queue');
    queue = await r.json();
  } catch(e) { queue = []; }
  document.getElementById('loadScreen').classList.add('hide');
  document.getElementById('queueView').classList.remove('hide');
  document.getElementById('qCount').textContent = queue.length;
  document.getElementById('statusBar').textContent = queue.length ? 'Tap any item to start reviewing' : 'Queue is empty — all done!';
  renderQueue();
}

function renderQueue() {
  const container = document.getElementById('queue');
  if (!queue.length) {
    container.innerHTML = '<div style="padding:40px 20px;text-align:center;color:#666">Nothing left to review.<br>Great job!</div>';
    return;
  }
  container.innerHTML = queue.map((q, i) => {
    const isVideo = q.thumb && (q.thumb.includes('.mp4') || q.status === 'video');
    const badge = q.status === 'done' ? 'done' : q.status === 'partial' ? 'partial' : 'pending';
    return \`<div class="qitem" onclick="openPost(\${i})">
      <img src="\${q.thumb}" loading="lazy" onerror="this.style.background='#222'">
      \${isVideo ? '<div class="play">▶</div>' : ''}
      <span class="badge \${badge}">\${q.status}</span>
      <div class="id">\${q.postId}</div>
    </div>\`;
  }).join('');
}

function openPost(i) {
  post = queue[i];
  fileIdx = 0;
  prodIdx = 0;
  document.getElementById('queueView').classList.add('hide');
  document.getElementById('reviewView').classList.remove('hide');
  document.getElementById('rTitle').textContent = post.postId;
  renderMedia();
  renderChips();
  closeEditor();
}

function back() {
  document.getElementById('reviewView').classList.add('hide');
  document.getElementById('queueView').classList.remove('hide');
  loadQueue(); // refresh in case we approved items
}

function renderMedia() {
  const files = post.fileUrl.fileUrls || [];
  const html = files.map((f, i) => {
    const isVideo = f.type === 'video';
    const hasFrames = f.frames && f.frames.length > 0;
    let content = '';

    if (hasFrames) {
      // Show first frame as representative (user can tap to see more if needed)
      content = \`<img src="\${f.frames[0].url}" style="aspect-ratio:3/4;object-fit:cover"> 
                 <div class="label">VIDEO • \${f.frames.length} frames</div>\`;
    } else if (isVideo) {
      content = \`<video src="\${f.url}" controls style="aspect-ratio:3/4;object-fit:cover"></video>
                 <div class="label">VIDEO</div>\`;
    } else {
      content = \`<img src="\${f.url}" onerror="this.style.background='#222'"> 
                 <div class="label">IMAGE</div>\`;
    }
    return \`<div class="media-item \${i===fileIdx?'on':''}" onclick="selFile(\${i})">\${content}</div>\`;
  }).join('');
  document.getElementById('mediaScroll').innerHTML = html;
}

function selFile(i) {
  fileIdx = i;
  prodIdx = 0;
  renderMedia();
  renderChips();
  closeEditor();
}

function renderChips() {
  const f = post.fileUrl.fileUrls[fileIdx];
  const prods = (f.response && f.response.products) || [];
  const html = prods.map((p, i) => {
    const color = p.reviewStatus === 'completed' ? '#4ade80' : p.reviewStatus === 'rejected' ? '#ef4444' : '#eab308';
    return \`<div class="chip \${i===prodIdx?'on':''}" onclick="openProduct(\${i})">
      <span class="dot" style="background:\${color}"></span>
      \${p.title || 'Untitled Product'}
    </div>\`;
  }).join('');
  document.getElementById('chips').innerHTML = html || '<div style="color:#666;padding:8px 16px">No products detected in this file</div>';
}

function openProduct(i) {
  prodIdx = i;
  const f = post.fileUrl.fileUrls[fileIdx];
  const p = (f.response && f.response.products && f.response.products[i]) || {};
  selected = new Set(p.selectedImages?.map((_, idx) => idx) || (p.images?.length ? [0] : []));

  document.getElementById('editor').classList.remove('hide');
  document.getElementById('eTitle').textContent = p.title || 'Untitled Product';
  document.getElementById('eSub').textContent = (p.brand || '') + (p.category ? ' · ' + p.category : '');
  document.getElementById('fBrand').value = p.brand || '';
  document.getElementById('fPrice').value = p.price || '';
  document.getElementById('fCurr').value = p.currency || 'USD';
  document.getElementById('fStock').value = p.availability || 'In stock';
  document.getElementById('fSizes').value = (p.sizing || []).join(', ') || p.sizes || '';
  document.getElementById('fDesc').value = p.description || '';

  renderImages(p);
  renderSources(p);
  renderChips();
  document.getElementById('editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function closeEditor() {
  document.getElementById('editor').classList.add('hide');
}

function renderImages(p) {
  const imgs = p.images || [];
  document.getElementById('imgCount').textContent = selected.size ? \`(\${selected.size} selected)\` : '';
  let html = '';
  if (imgs.length === 0) {
    html = '<div style="color:#666;padding:30px 10px;text-align:center;font-size:13px">No images yet.<br>Use "Extract from Source" or paste URLs.</div>';
  } else {
    html = imgs.map((u, i) => \`
      <div class="img-cell \${selected.has(i)?'on':''}" onclick="toggleImage(\${i})">
        <img src="\${u}" loading="lazy" onerror="this.style.background='#222'">
        <div class="check">✓</div>
      </div>\`).join('');
  }
  document.getElementById('imgGrid').innerHTML = html;
}

function toggleImage(i) {
  const p = post.fileUrl.fileUrls[fileIdx].response.products[prodIdx];
  if (selected.has(i)) selected.delete(i);
  else selected.add(i);
  renderImages(p);
}

function addImageUrl() {
  const url = prompt('Paste direct image URL (jpg/png/webp):');
  if (!url) return;
  const f = post.fileUrl.fileUrls[fileIdx];
  const p = f.response.products[prodIdx];
  if (!p.images) p.images = [];
  p.images.push(url);
  selected.add(p.images.length - 1);
  renderImages(p);
}

async function showRawResponse() {
  const f = post.fileUrl.fileUrls[fileIdx];
  const raw = f.response || {};
  const html = \`<div style="padding:10px 4px">
    <div style="margin-bottom:8px;font-weight:600;color:#888">Raw data returned by GLENS / Lens</div>
    <pre class="raw-json">\${JSON.stringify(raw, null, 2)}</pre>
  </div>\`;
  showSheet('Raw Lens Response', html, true);
}

function renderSources(p) {
  const srcs = p.sources || [];
  let html = '';
  if (srcs.length === 0) {
    html = '<div style="color:#666;font-size:13px;padding:8px 4px">No sources linked yet. Add the official product page URL.</div>';
  } else {
    html = srcs.map((s, i) => \`
      <div class="source-row">
        <div class="info">
          <div class="name">\${s.store || 'Unknown Store'}</div>
          <div class="price">\${s.price || ''}</div>
        </div>
        <div class="actions">
          <button class="ghost small" onclick="window.open('\${s.url}', '_blank')">Visit</button>
          <button class="ghost small" onclick="extractImagesFromSource(\${i})">✨ Extract</button>
          <button class="danger small" onclick="removeSource(\${i})">×</button>
        </div>
      </div>\`).join('');
  }
  document.getElementById('srcList').innerHTML = html;
}

function removeSource(i) {
  const p = post.fileUrl.fileUrls[fileIdx].response.products[prodIdx];
  p.sources.splice(i, 1);
  renderSources(p);
}

function addSourceUrl() {
  const url = prompt('Paste official product page URL:');
  if (!url) return;
  const p = post.fileUrl.fileUrls[fileIdx].response.products[prodIdx];
  if (!p.sources) p.sources = [];
  p.sources.push({ store: 'Manual', price: 'TBD', url });
  renderSources(p);
}

// === SOURCE IMAGE EXTRACTION (calls backend) ===
async function extractImagesFromSource(sourceIndex) {
  const p = post.fileUrl.fileUrls[fileIdx].response.products[prodIdx];
  const source = p.sources[sourceIndex];
  if (!source || !source.url) return alert('No URL on this source');

  showSheet('Extracting images...', '<div style="padding:20px;text-align:center">Running image extractor on source page...<br>This may take 10-30 seconds.</div>', true);

  try {
    const res = await fetch('/api/extract-images-from-source', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: source.url })
    });
    const data = await res.json();
    closeSheet();

    if (!data.images || data.images.length === 0) {
      alert('No good images found on that page. Try another source or paste manually.');
      return;
    }

    currentPickerImages = data.images;
    showImagePicker(source.store || 'Source');
  } catch (e) {
    closeSheet();
    alert('Extraction failed: ' + e.message);
  }
}

function showImagePicker(storeName) {
  document.getElementById('pickerTitle').textContent = 'Select images from ' + storeName;
  const grid = document.getElementById('pickerGrid');
  grid.innerHTML = currentPickerImages.map((img, idx) => \`
    <div class="picker-cell" data-idx="\${idx}" onclick="togglePickerSelection(this, \${idx})">
      <img src="\${img.url || img}" loading="lazy">
      <div class="check">✓</div>
    </div>\`).join('');
  document.getElementById('pickerOverlay').classList.add('on');
  document.getElementById('pickerSheet').classList.add('open');
}

function togglePickerSelection(el, idx) {
  el.classList.toggle('on');
}

async function addSelectedFromPicker() {
  const grid = document.getElementById('pickerGrid');
  const selectedCells = grid.querySelectorAll('.picker-cell.on');
  if (selectedCells.length === 0) { closePicker(); return; }

  const p = post.fileUrl.fileUrls[fileIdx].response.products[prodIdx];
  if (!p.images) p.images = [];

  const indices = Array.from(selectedCells).map(c => parseInt(c.dataset.idx));
  indices.forEach(i => {
    const url = currentPickerImages[i].url || currentPickerImages[i];
    if (!p.images.includes(url)) {
      p.images.push(url);
      selected.add(p.images.length - 1);
    }
  });

  closePicker();
  renderImages(p);
}

function closePicker() {
  document.getElementById('pickerOverlay').classList.remove('on');
  document.getElementById('pickerSheet').classList.remove('open');
}

async function saveProduct() {
  const f = post.fileUrl.fileUrls[fileIdx];
  const p = f.response.products[prodIdx];

  p.title = document.getElementById('eTitle').textContent.trim();
  p.brand = document.getElementById('fBrand').value.trim();
  p.price = document.getElementById('fPrice').value.trim();
  p.currency = document.getElementById('fCurr').value;
  p.availability = document.getElementById('fStock').value;
  p.sizes = document.getElementById('fSizes').value.trim();
  p.description = document.getElementById('fDesc').value.trim();
  p.selectedImages = Array.from(selected).map(i => p.images[i]).filter(Boolean);
  p.reviewStatus = 'completed';

  try {
    await fetch('/api/product/' + post._id + '/' + fileIdx + '/' + prodIdx, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p)
    });
  } catch(e) { console.warn(e); }

  renderChips();

  // Auto advance to next unreviewed product in this file
  const prods = f.response.products;
  let next = prods.findIndex((pr, idx) => idx > prodIdx && pr.reviewStatus !== 'completed' && pr.reviewStatus !== 'rejected');
  if (next === -1) next = prods.findIndex(pr => pr.reviewStatus !== 'completed' && pr.reviewStatus !== 'rejected');
  if (next !== -1) {
    openProduct(next);
  } else {
    closeEditor();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

async function rejectProduct() {
  const p = post.fileUrl.fileUrls[fileIdx].response.products[prodIdx];
  p.reviewStatus = 'rejected';
  p.selectedImages = [];
  try {
    await fetch('/api/product/' + post._id + '/' + fileIdx + '/' + prodIdx, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(p)
    });
  } catch(e){}
  renderChips();
  closeEditor();
}

async function deleteFileUrl() {
  if (!confirm('Delete this entire file_url? It will be marked discarded.')) return;
  try {
    await fetch('/api/delete/' + post._id + '/' + fileIdx, { method: 'POST' });
  } catch(e){}
  back();
}

async function commitFileUrl() {
  const f = post.fileUrl.fileUrls[fileIdx];
  const pending = (f.response?.products || []).filter(p => p.reviewStatus !== 'completed' && p.reviewStatus !== 'rejected');
  if (pending.length > 0) {
    showSheet('Pending Products', pending.map(p => ({
      text: p.title || 'Untitled',
      action: () => { closeSheet(); openProduct(f.response.products.indexOf(p)); }
    })));
    return;
  }

  try {
    await fetch('/api/commit/' + post._id + '/' + fileIdx, { method: 'POST' });
  } catch(e){}

  // Move to next file in same post or back
  if (fileIdx < post.fileUrl.fileUrls.length - 1) {
    fileIdx++;
    prodIdx = 0;
    renderMedia();
    renderChips();
    closeEditor();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else {
    back();
  }
}

function showSheet(title, contentHtml, noCloseOnClick = false) {
  document.getElementById('sheetTitle').textContent = title;
  document.getElementById('sheetContent').innerHTML = contentHtml;
  document.getElementById('overlay').classList.add('on');
  document.getElementById('sheet').classList.add('open');
  if (!noCloseOnClick) {
    document.getElementById('overlay').onclick = () => closeSheet();
  }
}

function closeSheet() {
  document.getElementById('overlay').classList.remove('on');
  document.getElementById('sheet').classList.remove('open');
  document.getElementById('overlay').onclick = () => closeSheet();
}

loadQueue();
</script>
</body>
</html>`;

// ═══════════════════════════════════════════════════════════════════════════════
//  HELPER: Extract images from a source URL using ecom-image-extractor.py
// ═══════════════════════════════════════════════════════════════════════════════
async function extractImagesFromSourceUrl(sourceUrl) {
  return new Promise((resolve) => {
    const urlsFile = path.join(CONFIG.tmpDir, `urls_${Date.now()}.json`);
    const outFile = path.join(CONFIG.tmpDir, `out_${Date.now()}.json`);

    fs.writeFileSync(urlsFile, JSON.stringify([sourceUrl]));

    const args = [
      CONFIG.extractorScript,
      '-u', urlsFile,
      '-o', outFile,
      '--lazy-extraction',
      '--min-score', '4',
      '--hash-threshold', '8'
    ];

    const proc = spawn(CONFIG.pythonPath, args, { stdio: 'pipe' });

    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', (code) => {
      try {
        if (fs.existsSync(outFile)) {
          const result = JSON.parse(fs.readFileSync(outFile, 'utf8'));
          const images = result[sourceUrl] || [];
          // Return top 9 best images
          resolve({ images: images.slice(0, 9) });
        } else {
          log('warn', 'Extractor produced no output file');
          resolve({ images: [] });
        }
      } catch (e) {
        log('warn', 'Failed to parse extractor output:', e.message);
        resolve({ images: [] });
      }
      // cleanup
      try { fs.unlinkSync(urlsFile); } catch (_) {}
      try { fs.unlinkSync(outFile); } catch (_) {}
    });

    proc.on('error', (err) => {
      log('error', 'Extractor spawn failed:', err.message);
      resolve({ images: [] });
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  QUEUE + MONGO LOGIC (improved robustness)
// ═══════════════════════════════════════════════════════════════════════════════
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
  }).project({ post_id: 1, file_urls: 1 }).limit(80).toArray();

  const queue = [];
  for (const post of posts) {
    for (let i = 0; i < post.file_urls.length; i++) {
      const f = post.file_urls[i];
      if (!f.reviewed || f.humanReviewed) continue;

      // Auto-bootstrap a minimal product structure if GLENS response exists but products array is missing
      if (f.response && !f.response.products && typeof f.response === 'object') {
        const lensTitle = f.response.bestGuessLabels?.[0]?.label || f.response.title || 'Product from Lens';
        const lensImages = [];
        // Try to harvest any image urls that Lens might have returned
        if (f.response.visualMatches) {
          for (const m of f.response.visualMatches) {
            if (m.imageUrl) lensImages.push(m.imageUrl);
            if (m.thumbnailUrl) lensImages.push(m.thumbnailUrl);
          }
        }
        f.response.products = [{
          title: lensTitle,
          brand: '',
          price: '',
          currency: 'USD',
          availability: 'In stock',
          sizes: '',
          description: '',
          images: lensImages.length ? lensImages.slice(0, 6) : (f.url ? [f.url] : []),
          selectedImages: [],
          sources: f.response.knowledgeGraph?.sourceUrl ? [{ store: 'Lens Source', price: '', url: f.response.knowledgeGraph.sourceUrl }] : [],
          reviewStatus: 'pending'
        }];
        // Persist the bootstrapped structure so next load is clean
        await collection.updateOne(
          { _id: post._id },
          { $set: { [`file_urls.${i}.response`]: f.response } }
        );
      }

      const hasPending = !f.response?.products || f.response.products.some(p => p.reviewStatus !== 'completed' && p.reviewStatus !== 'rejected');
      if (!hasPending) continue;

      queue.push({
        _id: post._id.toString(),
        postId: post.post_id,
        fileIndex: i,
        thumb: (f.frames && f.frames[0]?.url) || f.url,
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
  log('info', `Queue: ${remaining} item(s) remaining to review`);
  return remaining;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN SERVER
// ═══════════════════════════════════════════════════════════════════════════════
async function startNgrok(port) {
  if (!CONFIG.ngrokToken) {
    log('warn', 'No NGROK_AUTHTOKEN — server only accessible locally.');
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
      if (match) {
        url = match[0];
        resolved = true;
      }
    };

    ngrok.stdout.on('data', onData);
    ngrok.stderr.on('data', onData);

    await new Promise(r => setTimeout(r, 11000));

    if (url) {
      log('info', `ngrok tunnel ready: ${url}`);
      return { url, process: ngrok };
    }

    // API fallback
    try {
      const apiRes = await fetch('http://127.0.0.1:4040/api/tunnels');
      const apiData = await apiRes.json();
      const tunnel = apiData.tunnels?.find(t => t.public_url?.startsWith('https'));
      if (tunnel) {
        url = tunnel.public_url;
        log('info', `ngrok (API): ${url}`);
        return { url, process: ngrok };
      }
    } catch (_) {}

    log('warn', 'ngrok started but URL not captured. Check token.');
    ngrok.kill();
    return null;
  } catch (err) {
    log('error', 'ngrok failed to start:', err.message);
    return null;
  }
}

async function main() {
  log('info', '═══════════════════════════════════════════════════════════════');
  log('info', '  REVIEW SERVER — FINAL PRODUCTION VERSION');
  log('info', '═══════════════════════════════════════════════════════════════');

  if (!CONFIG.mongodb.uri) {
    log('error', 'ORCH_MONGODB_URI is required');
    process.exit(1);
  }

  const client = new MongoClient(CONFIG.mongodb.uri, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  const db = client.db(CONFIG.mongodb.db);
  const collection = db.collection(CONFIG.mongodb.collection);
  log('info', `MongoDB connected: ${CONFIG.mongodb.db}.${CONFIG.mongodb.collection}`);

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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
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
          const pathBase = `file_urls.${fileIdx}.response.products.${prodIdx}`;
          await collection.updateOne(
            { _id: new ObjectId(docId) },
            { $set: {
              [`${pathBase}.title`]: data.title,
              [`${pathBase}.brand`]: data.brand,
              [`${pathBase}.price`]: data.price,
              [`${pathBase}.currency`]: data.currency,
              [`${pathBase}.availability`]: data.availability,
              [`${pathBase}.sizes`]: data.sizes,
              [`${pathBase}.description`]: data.description,
              [`${pathBase}.selectedImages`]: data.selectedImages || [],
              [`${pathBase}.sources`]: data.sources || [],
              [`${pathBase}.reviewStatus`]: data.reviewStatus || 'completed',
              [`${pathBase}.reviewedAt`]: new Date()
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

    // POST /api/commit/:docId/:fileIdx  → mark humanReviewed + readyForDropship
    const commitMatch = parsed.pathname.match(/^\/api\/commit\/([^\/]+)\/(\d+)$/);
    if (commitMatch && req.method === 'POST') {
      const docId = commitMatch[1];
      const fileIdx = parseInt(commitMatch[2], 10);
      await collection.updateOne(
        { _id: new ObjectId(docId) },
        { $set: {
          [`file_urls.${fileIdx}.humanReviewed`]: true,
          [`file_urls.${fileIdx}.humanReviewedAt`]: new Date(),
          [`file_urls.${fileIdx}.readyForDropship`]: true,
          [`file_urls.${fileIdx}.approved`]: true
        }}
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
        { $set: { [`file_urls.${fileIdx}.discarded`]: true, [`file_urls.${fileIdx}.discardedAt`]: new Date() } }
      );
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      const remaining = await checkDone(collection);
      if (remaining === 0) serverResolve();
      return;
    }

    // POST /api/extract-images-from-source   { url: "https://..." }
    if (parsed.pathname === '/api/extract-images-from-source' && req.method === 'POST') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        try {
          const { url } = JSON.parse(body);
          if (!url) throw new Error('Missing url');
          const result = await extractImagesFromSourceUrl(url);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (e) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(CONFIG.port, '0.0.0.0', async () => {
    log('info', `Server listening on http://0.0.0.0:${CONFIG.port}`);

    const ngrok = await startNgrok(CONFIG.port);
    if (ngrok) {
      log('info', '═══════════════════════════════════════════════════════════════');
      log('info', `  OPEN THIS ON YOUR PHONE: ${ngrok.url}`);
      log('info', '═══════════════════════════════════════════════════════════════');
      ngrokProc = ngrok.process;
    }

    const initial = await checkDone(collection);
    if (initial === 0) {
      log('info', 'Queue is already empty. Exiting immediately.');
      serverResolve();
    }
  });

  await donePromise;

  log('info', 'All items reviewed. Shutting down cleanly...');
  server.close(() => {});
  if (ngrokProc) ngrokProc.kill('SIGTERM');
  await client.close();
  log('info', 'Review server finished.');
}

main().catch(err => {
  log('error', 'Fatal error:', err.message);
  process.exit(1);
});
