/**

  - review-server.js
  - 
  - Production human review server for the UGC dropship pipeline.
  - Grouped by post, virtualized rendering, lazy-loaded images, mobile-first.
  - 
  - Env: ORCH_MONGODB_URI, ORCH_MONGODB_DB, ORCH_MONGODB_COLLECTION
  -  REVIEW_PORT (default 3456)

*/

import http from 'http'; import { MongoClient, ObjectId } from 'mongodb';

//
═══════════════════════════════════════════════════════════════════════════════
// CONFIG //
═══════════════════════════════════════════════════════════════════════════════
const CONFIG = { mongodb: { uri: process.env.ORCH_MONGODB_URI || '', db:
process.env.ORCH_MONGODB_DB || 'ugc-dropship', collection:
process.env.ORCH_MONGODB_COLLECTION || 'scraped-posts', }, port:
parseInt(process.env.REVIEW_PORT || '3456', 10), };

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 }; const LOG_LEVEL =
LOG_LEVELS[process.env.ORCH_LOG_LEVEL || 'info'] || 1;

function log(level, ...args) { if ((LOG_LEVELS[level] ?? 1) < LOG_LEVEL) return;
const ts = new Date().toISOString().slice(11, 23); const prefix = [${ts}]
[${level.toUpperCase()}]; if (level === 'error') console.error(prefix, ...args);
else if (level === 'warn') console.warn(prefix, ...args); else
console.log(prefix, ...args); }

//
═══════════════════════════════════════════════════════════════════════════════
// HTML UI //
═══════════════════════════════════════════════════════════════════════════════
const REVIEW_UI_HTML = `

function showScreen(id) { document.querySelectorAll(".screen,
.modal").forEach(el => el.classList.remove("active"));
document.getElementById(id).classList.add("active"); }

function toast(msg) { const t = document.getElementById("toast"); t.textContent
= msg; t.classList.add("show"); setTimeout(() =>
t.classList.remove("show"), 2500); }

function escapeHtml(str) { if (str == null) return ""; return
String(str).replace(/&/g, "&").replace(/</g, "<").replace(/>/g,
">").replace(/"/g, """); }

function getImageUrl(u) { if (!u) return ""; if (typeof u === "object" && u !==
null && u.url) return String(u.url); return String(u); }

function formatPrice(p) { if (!p) return "TBD"; if (typeof p === "string")
return p; if (typeof p === "object" && p !== null) { if (p.current) return
p.current + (p.currency ? " " + p.currency : ""); return JSON.stringify(p); }
return String(p); }

function initLazyImages() { if (state.io) return; state.io = new
IntersectionObserver(entries => { entries.forEach(entry => { if
(entry.isIntersecting) { const img = entry.target; const src = img.dataset.src;
if (src) { img.src = src; img.classList.add("loaded");
img.removeAttribute("data-src"); } state.io.unobserve(img); } }); }, {
rootMargin: "200px" }); }

function observeImage(img) { if (state.io) state.io.observe(img); }

async function loadQueue() { try { const r = await fetch("/api/queue"); const
data = await r.json(); state.posts = data.posts || {}; state.queue = data.items
|| []; } catch(e) { state.posts = {}; state.queue = []; toast("Failed to load
queue"); } document.getElementById("loading").classList.remove("active");
showScreen("queue"); initLazyImages(); renderQueue(); }

function renderQueue() { const list = document.getElementById("qList"); const
postIds = Object.keys(state.posts);

if (!postIds.length) { list.innerHTML = 'Nothing to review';
document.getElementById("qCount").textContent = "0"; return; }

let totalItems = 0;

list.innerHTML = postIds.map(pid => { const post = state.posts[pid]; const items
= post.items || []; totalItems += items.length; const pending = items.filter(it
=> it.status === "pending" || it.status === "partial").length; const thumb =
items[0] ? items[0].thumb : "";

// We escape variables evaluated by Node by using \\\${...} so they make it to the browser intact.
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
document.querySelectorAll(".lazy-img[data-src]").forEach(observeImage); }

function toggleGroup(ev, pid) { if (ev.target.closest(".item-row")) return;
document.getElementById("g_" + pid).classList.toggle("open"); }

async function openItem(_id, fileIdx, frameIdx) { try { let url =
`/api/item/${_id}/${fileIdx}`; if (frameIdx !== null) url += `/${frameIdx}`;
const r = await fetch(url); if (!r.ok) throw new Error("Fetch failed");
state.current = await r.json(); } catch(e) { toast("Failed to load item");
return; } renderItem(); showScreen("review"); }

function renderItem() { const item = state.current;
document.getElementById("rTitle").textContent = item.postId;
document.getElementById("rImage").src = item.url;

const prods = item.response && item.response.products ? item.response.products :
[]; const pending = prods.filter(p => p.reviewStatus !== "completed" &&
p.reviewStatus !== "rejected").length;

document.getElementById("rMeta").innerHTML = ` ${item.type === "frame" ? "Frame"
: "Image"} ${prods.length} products ${pending ? `${pending} pending` : ""} `;

document.getElementById("pCount").textContent = prods.length; const list =
document.getElementById("pList");

if (!prods.length) { list.innerHTML = 'No products identified'; return; }

list.innerHTML = prods.map((p, i) => { const color = p.reviewStatus ===
"completed" ? "var(--success)" : p.reviewStatus === "rejected" ? "var(--danger)"
: "var(--warn)"; const imgUrl = getImageUrl((p.selectedImages &&
p.selectedImages[0]) || (p.sources && p.sources[0] && p.sources[0].images &&
p.sources[0].images[0]));

return \`
  <div class="p-card" onclick="openProduct(\${i})">
    <div class="p-img">\${imgUrl ? \`<img src="\${escapeHtml(imgUrl)}" alt="" loading="lazy">\` : \`<div class="no-img">No img</div>\`}</div>
    <div class="p-info">
      <div class="p-title">\${escapeHtml(p.title || "Untitled")}</div>
      <div class="p-brand">\${escapeHtml(p.brand || "Unknown")} &middot; \${escapeHtml(formatPrice(p.price))}</div>
      <div class="p-status"><span class="dot" style="background:\${color}"></span>\${p.reviewStatus || "pending"}</div>
    </div>
  </div>
\`;

}).join(""); }

function getAllImages(p) { const sourceUrls = new Set(); const allUrls = new
Set();

// Make the scraped post image/frame available by default if (state.current &&
state.current.url) { allUrls.add(state.current.url); }

(p.sources || []).forEach(s => { (s.images || []).forEach(u => { const url =
getImageUrl(u); if (url) { sourceUrls.add(url); allUrls.add(url); } }); });

(p.customImages || []).forEach(u => { if (u) allUrls.add(String(u)); });
(p.selectedImages || []).forEach(u => { if (u) allUrls.add(String(u)); });

return { urls: Array.from(allUrls), sourceUrls }; }

function openProduct(idx) { state.editingIdx = idx; const p =
state.current.response.products[idx]; const allImages = getAllImages(p); const
selectedSet = new Set((p.selectedImages || []).map(String));

let html = `  AI Viability Score: ${p.dropshipViability?.score || '?'} / 10
${escapeHtml(p.dropshipViability?.reasoning || 'No reasoning provided')}   Basic
Info Title<input id="eTitle" value="${escapeHtml(p.title || "")}"> Brand<input
id="eBrand" value="${escapeHtml(p.brand || "")}"> Category<input id="eCategory"
value="${escapeHtml(p.category || "")}">  Price<input id="ePrice"
value="${escapeHtml((p.price && p.price.current) ? p.price.current : "")}"> 
Currency  <option ${p.price?.currency === "USD" ? "selected" : ""}>USD <option
${p.price?.currency === "EUR" ? "selected" : ""}>EUR <option ${p.price?.currency
=== "GBP" ? "selected" : ""}>GBP <option ${p.price?.currency === "CAD" ?
"selected" : ""}>CAD <option ${p.price?.currency === "AUD" ? "selected" :
""}>AUD <option ${p.price?.currency === "JPY" ? "selected" : ""}>JPY    Base
Price<input id="eBasePrice" value="${escapeHtml(p.basePrice || "")}"> 
Availability  <option ${p.availability === "In stock" ? "selected" : ""}>In
stock <option ${p.availability === "Out of stock" ? "selected" : ""}>Out of
stock <option ${p.availability === "Pre-order" ? "selected" : ""}>Pre-order    
Markup Type  <option ${p.recommendedMarkup?.type === 'fixed' ? 'selected' :
''}>fixed <option ${p.recommendedMarkup?.type === 'percentage' ||
!p.recommendedMarkup?.type ? 'selected' : ''}>percentage    Markup Val    
Shipping Cost Shipping Cov  Sizes (comma separated)<input id="eSizes"
value="${escapeHtml((p.sizing || []).join(", "))}">
Description${escapeHtml(p.description || "")} Sizing
Guide${escapeHtml(p.sizingGuide || "")} Shipping &
Returns${escapeHtml(p.shippingAndReturns || "")}   Images — Tap to select  + Add
Image URL   Sources  + Add Source   Actions  Reject Product Save Product   `;

document.getElementById("eBody").innerHTML = html; renderImgGrid(allImages.urls,
selectedSet, allImages.sourceUrls); renderSrcList(p); showScreen("editor"); }

function renderImgGrid(urls, selectedSet, sourceUrls) { const grid =
document.getElementById("eImgGrid"); if (!urls.length) { grid.innerHTML = 'No
images available'; return; }

grid.innerHTML = urls.map(url => { const isOn = selectedSet.has(url); const
isFromSource = sourceUrls.has(url); return `   ✓  `; }).join(""); }

function addImage() { const url = prompt("Paste image URL:"); if (!url) return;
const grid = document.getElementById("eImgGrid"); const empty =
grid.querySelector(".empty"); if (empty) empty.remove();

const div = document.createElement("div"); div.className = "img-cell on";
div.dataset.source = "false"; div.innerHTML = `✓`; div.onclick = function() {
this.classList.toggle("on"); }; grid.appendChild(div); }

function renderSrcList(p) { const list = document.getElementById("eSrcList");
const all = [];

(p.sources || []).forEach((s, i) => { all.push({ store: s.store, url: s.url,
price: s.price, availability: s.availability, idx: i, type: "ai", images:
s.images }); }); (p.customSources || []).forEach((s, i) => { all.push({ store:
s.store, url: s.url, price: s.price, availability: s.availability, idx: i, type:
"custom", images: s.images }); });

if (!all.length) { list.innerHTML = 'No sources'; return; }

list.innerHTML = all.map(s => { const imagesAttr = s.images && s.images.length ?
encodeURIComponent(JSON.stringify(s.images)) : ""; return `  
${escapeHtml(s.store || "Unknown")}${s.type === "ai" ? ' AI' : ' Custom'}
${escapeHtml(s.url)}   Visit Remove   `; }).join(""); }

function removeSource(btn) { btn.closest(".src-row").remove(); }

function addSource() { const url = prompt("Paste product source URL:"); if
(!url) return; const store = prompt("Store name (optional):") || "Custom"; const
list = document.getElementById("eSrcList"); const empty =
list.querySelector(".empty"); if (empty) empty.remove();

const div = document.createElement("div"); div.className = "src-row";
div.dataset.type = "custom"; div.dataset.idx = "new"; div.dataset.images = "";
div.innerHTML = `  ${escapeHtml(store)} Custom ${escapeHtml(url)}   Visit Remove
 `; list.appendChild(div); }

async function saveProduct() { const idx = state.editingIdx; const p =
state.current.response.products[idx];

p.title = document.getElementById("eTitle").value; p.brand =
document.getElementById("eBrand").value; p.category =
document.getElementById("eCategory").value; p.price = { current:
document.getElementById("ePrice").value, currency:
document.getElementById("eCurrency").value }; p.basePrice =
document.getElementById("eBasePrice").value; p.availability =
document.getElementById("eAvail").value;

p.recommendedMarkup = { type: document.getElementById("eMarkupType").value,
value: document.getElementById("eMarkupVal").value, currency:
document.getElementById("eCurrency").value };

p.recommendedShippingRate = { amount:
document.getElementById("eShippingCost").value, coverage:
document.getElementById("eShippingCov").value, currency:
document.getElementById("eCurrency").value };

const sizesRaw = document.getElementById("eSizes").value; p.sizing =
sizesRaw.split(",").map(s => s.trim()).filter(Boolean); p.sizes = p.sizing;

p.description = document.getElementById("eDesc").value; p.sizingGuide =
document.getElementById("eSizingGuide").value; p.shippingAndReturns =
document.getElementById("eShipping").value;

const cells = document.querySelectorAll("#eImgGrid .img-cell"); p.selectedImages
= []; p.customImages = [];

cells.forEach(c => { const img = c.querySelector("img").src; if
(c.classList.contains("on")) { p.selectedImages.push(img); if (c.dataset.source
!== "true") p.customImages.push(img); } });

const srcRows = document.querySelectorAll("#eSrcList .src-row"); p.sources = [];
p.customSources = [];

srcRows.forEach(row => { const url = row.querySelector(".url").textContent;
const name = row.querySelector(".name").childNodes[0].textContent.trim(); const
imagesAttr = row.getAttribute("data-images"); const images = imagesAttr ?
JSON.parse(decodeURIComponent(imagesAttr)) : [{ url: url, width: 0, height: 0,
alt: "", score: 0, similarity: 0, weighted_score: 0 }]; const obj = { store:
name, url: url, price: null, availability: null, images: images };

if (row.dataset.type === "ai") p.sources.push(obj); 
else p.customSources.push(obj);

});

p.reviewStatus = "completed"; p.reviewedAt = new Date().toISOString();

try { const body = { docId: state.current._id, fileIdx: state.current.fileIdx,
frameIdx: state.current.frameIdx, prodIdx: idx, product: p }; const r = await
fetch("/api/product", { method: "POST", headers: { "Content-Type":
"application/json" }, body: JSON.stringify(body) }); if (!r.ok) throw new
Error("Save failed"); toast("Saved"); renderItem(); closeEditor(); } catch(e) {
toast("Save failed: " + e.message); } }

function rejectProduct() { const idx = state.editingIdx; const p =
state.current.response.products[idx]; p.reviewStatus = "rejected";
p.selectedImages = []; p.customImages = []; p.customSources = []; saveProduct();
}

function closeEditor() { showScreen("review"); }

async function commitItem() { const prods = state.current.response &&
state.current.response.products ? state.current.response.products : []; const
pending = prods.filter(p => p.reviewStatus !== "completed" && p.reviewStatus !==
"rejected"); if (pending.length) { if (!confirm(pending.length + " product(s)
still pending. Commit anyway?")) return; } try { const body = { docId:
state.current._id, fileIdx: state.current.fileIdx, frameIdx:
state.current.frameIdx }; const r = await fetch("/api/commit", { method: "POST",
headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
if (!r.ok) throw new Error("Commit failed"); toast("Committed"); showQueue();
await loadQueue(); } catch(e) { toast("Commit failed: " + e.message); } }

async function deleteItem() { if (!confirm("Delete this item? It will be marked
as discarded.")) return; try { const body = { docId: state.current._id, fileIdx:
state.current.fileIdx, frameIdx: state.current.frameIdx }; const r = await
fetch("/api/delete", { method: "POST", headers: { "Content-Type":
"application/json" }, body: JSON.stringify(body) }); if (!r.ok) throw new
Error("Delete failed"); toast("Deleted"); showQueue(); await loadQueue(); }
catch(e) { toast("Delete failed: " + e.message); } }

function showQueue() { showScreen("queue"); } loadQueue(); 

//
═══════════════════════════════════════════════════════════════════════════════
// MONGODB HELPERS //
═══════════════════════════════════════════════════════════════════════════════

function normalizeResponse(item) { let resp = item.response; if (typeof resp ===
'string') { try { resp = JSON.parse(resp); } catch { resp = null; } } if (!resp
|| typeof resp !== 'object') resp = { products: [] }; if
(!Array.isArray(resp.products)) resp.products = [];

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
    sizes: p.sizes || p.sizing || [],
    recommendedMarkup: p.recommendedMarkup || null,
    recommendedShippingRate: p.recommendedShippingRate || null,
    dropshipViability: p.dropshipViability || null,
}));

return resp;

}

function getItemStatus(item) { const resp = normalizeResponse(item); const
products = resp.products; if (!products.length) return 'pending'; const allDone
= products.every(p => p.reviewStatus === 'completed' || p.reviewStatus ===
'rejected'); const someDone = products.some(p => p.reviewStatus === 'completed'
|| p.reviewStatus === 'rejected'); if (allDone) return 'done'; if (someDone)
return 'partial'; return 'pending'; }

async function buildQueue(collection) { const posts = await collection.find({
discarded: { $ne: true }, $or: [ { file_urls: { $elemMatch: { type: 'image',
reviewed: true, humanReviewed: { $ne: true }, discarded: { $ne: true } } } }, {
'file_urls.frames': { $elemMatch: { type: 'image', reviewed: true,
humanReviewed: { $ne: true }, discarded: { $ne: true } } } } ] }).project({
post_id: 1, file_urls: 1 }).limit(100).toArray();

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

async function checkDone(collection) { const remaining = await
collection.countDocuments({ discarded: { $ne: true }, $or: [ { file_urls: {
$elemMatch: { type: 'image', reviewed: true, humanReviewed: { $ne: true },
discarded: { $ne: true } } } }, { 'file_urls.frames': { $elemMatch: { type:
'image', reviewed: true, humanReviewed: { $ne: true }, discarded: { $ne: true }
} } } ] }); log('info', Queue: ${remaining} item(s) remaining); return
remaining; }

async function maybeDiscardEmptyPost(collection, docId) { const post = await
collection.findOne( { _id: new ObjectId(docId) }, { projection: { file_urls: 1,
post_id: 1 } } ); if (!post || !post.file_urls) return;

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

//
═══════════════════════════════════════════════════════════════════════════════
// NGROK //
═══════════════════════════════════════════════════════════════════════════════
async function startNgrok(port) { try { const { spawn } = await
import('child_process');

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

//
═══════════════════════════════════════════════════════════════════════════════
// SERVER //
═══════════════════════════════════════════════════════════════════════════════
async function main() { log('info',
'═══════════════════════════════════════════════════════════════'); log('info',
' REVIEW SERVER — Production Human Review'); log('info',
'═══════════════════════════════════════════════════════════════');

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
    log('info', `Server: http://0.0.0.0:${CONFIG.port}`);

    const ngrok = await startNgrok(CONFIG.port);
    if (ngrok) {
        log('info', '═══════════════════════════════════════════════════════════════');
        log('info', `  OPEN ON YOUR BROWSER: ${ngrok.url}`);
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

main().catch(err => { log('error', 'Fatal:', err.message); process.exit(1); });
