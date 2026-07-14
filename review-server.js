/**
 * review-server.js
 *
 * Production human review server for the UGC dropship pipeline.
 * lazy loading, Python AI extraction.
 *
 * Env: ORCH_MONGODB_URI, ORCH_MONGODB_DB, ORCH_MONGODB_COLLECTION
 *      REVIEW_PORT (default 3456), ORCH_HF_TOKEN
 *
 * FINAL PRODUCTION v2.3.0 - Mobile Table overflow, Collapsible sections,
 * Direct Clipboard URL pasting, Scoped rejections, Robust state mapping.
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
<meta name="theme-color" content="#f8f8f7" id="metaThemeColor">
<title>DropShip Review • v2.3</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}

/* ─── TOKENS ─────────────────────────────────────────────────────────────── */
:root {
  --bg:        #f8f8f7;
  --surface:   #ffffff;
  --surface-2: #efefed;
  --border:    #e0dedd;
  --text:      #111110;
  --text-2:    #8a8a86;
  --text-3:    #b8b8b4;
  --danger:    #c0392b;
  --success:   #2e7d32;
  --warning:   #a07800;
}
:root[data-theme="dark"] {
  --bg:        #0f0f0e;
  --surface:   #161615;
  --surface-2: #1e1e1c;
  --border:    #2a2a28;
  --text:      #e8e8e5;
  --text-2:    #6a6a66;
  --text-3:    #3a3a38;
  --danger:    #e05c52;
  --success:   #4caf50;
  --warning:   #d4a017;
}

/* ─── BASE ───────────────────────────────────────────────────────────────── */
body {
  font-family: "Helvetica Neue", Helvetica, Arial, -apple-system, BlinkMacSystemFont, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.45;
  min-height: 100dvh;
  overflow-x: hidden;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  font-size: 14px;
  letter-spacing: -0.01em;
}

img { max-width: 100%; display: block; }
a { color: var(--text); text-decoration: none; border-bottom: 1px solid var(--border); }
a:active { opacity: 0.6; }

/* ─── TYPOGRAPHY ─────────────────────────────────────────────────────────── */
h1, h2, h3 {
  font-weight: 500;
  letter-spacing: 0;
  text-transform: none;
}
label {
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-2);
}
.mono {
  font-family: "SF Mono", "Fira Code", "Cascadia Code", monospace;
  font-size: 12px;
}

/* ─── CONTROLS ───────────────────────────────────────────────────────────── */
button {
  cursor: pointer;
  border: 1px solid var(--border);
  border-radius: 0;
  padding: 10px 14px;
  font-size: 11px;
  font-weight: 500;
  background: var(--bg);
  color: var(--text);
  min-height: 40px;
  font-family: inherit;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  transition: opacity 0.12s, background 0.12s;
  white-space: nowrap;
}
button:active { opacity: 0.55; }
button:disabled { opacity: 0.28 !important; cursor: not-allowed; transform: none !important; }

.btn-primary {
  background: var(--text);
  color: var(--bg);
  border-color: var(--text);
  font-weight: 600;
}
.btn-primary:active { opacity: 0.75; }
.btn-danger {
  background: transparent;
  color: var(--danger);
  border-color: var(--border);
}
.btn-ghost {
  border: none;
  background: transparent;
  color: var(--text-2);
  padding: 0;
  min-height: 0;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  font-size: 11px;
}
.btn-ghost:active { opacity: 0.45; }

input, select, textarea {
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text);
  padding: 10px 12px;
  border-radius: 0;
  font-size: 13px;
  font-family: inherit;
  width: 100%;
  -webkit-appearance: none;
  letter-spacing: -0.01em;
}
input::placeholder, textarea::placeholder { color: var(--text-3); }
input:focus, select:focus, textarea:focus {
  outline: none;
  border-color: var(--text-2);
  background: var(--surface);
}
textarea { resize: vertical; min-height: 88px; line-height: 1.5; }
select {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' fill='none'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%236a6a66' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
  padding-right: 28px;
}

/* ─── TABLES ─────────────────────────────────────────────────────────────── */
.simple-table-wrapper { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; padding-bottom: 4px; margin-top: 8px; }
.simple-table { min-width: 480px; width: 100%; border-collapse: collapse; font-size: 12px; }
.simple-table th {
  background: var(--surface-2);
  padding: 8px 8px;
  font-size: 10px;
  color: var(--text-2);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-weight: 500;
  text-align: left;
  border-bottom: 1px solid var(--border);
}
.simple-table td { border-bottom: 1px solid var(--border); padding: 0; }
.simple-table tr:last-child td { border-bottom: none; }
.simple-table input, .simple-table select {
  border: none;
  min-height: 40px;
  padding: 8px 8px;
  font-size: 12px;
  width: 100%;
  background: transparent;
}
.simple-table input:focus, .simple-table select:focus { box-shadow: inset 0 0 0 1px var(--text-2); }
.table-btn { width: 40px; min-height: 40px; padding: 0; display: flex; align-items: center; justify-content: center; color: var(--text-3); border: none; background: transparent; font-size: 16px; transition: color 0.12s; }
.table-btn:hover { color: var(--danger); }

/* ─── SCREEN LAYOUT ──────────────────────────────────────────────────────── */
.screen { display: none; min-height: 100dvh; padding-bottom: calc(80px + env(safe-area-inset-bottom)); }
.screen.active { display: block; }

/* ─── TOPBAR ─────────────────────────────────────────────────────────────── */
.topbar {
  position: sticky; top: 0; z-index: 50;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  padding: 0 14px;
  padding-top: env(safe-area-inset-top);
  height: calc(48px + env(safe-area-inset-top));
  display: flex;
  align-items: center;
  gap: 10px;
}
.topbar h1 {
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text);
  flex: 1;
}

/* ─── BADGE ──────────────────────────────────────────────────────────────── */
.badge {
  font-size: 10px;
  padding: 0 7px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  color: var(--text-2);
  background: var(--surface-2);
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  white-space: nowrap;
}
.badge.pending { color: var(--warning); border-color: var(--warning); background: transparent; }
.badge.src-status { color: var(--text-2); background: transparent; border-color: var(--border); }
.badge.partial { color: var(--text-2); background: transparent; border-color: var(--border); }

/* ─── THEME TOGGLE ───────────────────────────────────────────────────────── */
.theme-toggle {
  font-size: 10px;
  letter-spacing: 0.05em;
  padding: 0 8px;
  height: 24px;
  min-height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  color: var(--text-2);
  background: transparent;
  text-transform: uppercase;
}

/* ─── QUEUE LIST ─────────────────────────────────────────────────────────── */
.post-group { border-bottom: 1px solid var(--border); background: var(--bg); }
.post-header {
  display: flex; align-items: center; gap: 12px;
  padding: 14px 14px; cursor: pointer; user-select: none;
}
.post-header:active { background: var(--surface-2); }
.post-thumb {
  width: 40px; height: 40px;
  background: var(--surface-2); flex-shrink: 0;
  overflow: hidden;
}
.post-thumb img { width: 100%; height: 100%; object-fit: cover; }
.post-info { flex: 1; min-width: 0; }
.post-id {
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
  text-transform: none;
  letter-spacing: 0;
}
.post-meta {
  font-size: 10px;
  color: var(--text-2);
  margin-top: 2px;
  font-weight: 400;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.post-chevron { width: 16px; height: 16px; color: var(--text-3); transition: transform 0.18s ease; flex-shrink: 0; }
.post-group.open .post-chevron { transform: rotate(180deg); }

.post-items { display: none; border-top: 1px solid var(--border); background: var(--surface-2); }
.post-group.open .post-items { display: block; }

.item-row {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 14px; border-bottom: 1px solid var(--border); cursor: pointer;
}
.item-row:active { background: var(--surface); }
.item-row:last-child { border-bottom: none; }
.item-thumb { width: 32px; height: 44px; background: var(--surface); flex-shrink: 0; overflow: hidden; }
.item-thumb img { width: 100%; height: 100%; object-fit: cover; }
.item-info { flex: 1; min-width: 0; }
.item-type {
  font-size: 11px;
  font-weight: 500;
  color: var(--text);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.item-status { font-size: 10px; color: var(--text-2); margin-top: 2px; text-transform: uppercase; letter-spacing: 0.04em; }

/* ─── HERO ───────────────────────────────────────────────────────────────── */
.hero { width: 100%; background: var(--surface-2); position: relative; border-bottom: 1px solid var(--border); }
.hero img { width: 100%; height: 60vh; object-fit: cover; cursor: pointer; background: var(--surface-2); }
.hero-meta {
  padding: 10px 14px;
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  background: var(--bg);
  border-top: 1px solid var(--border);
}

/* ─── SECTION & CARDS ────────────────────────────────────────────────────── */
.section { padding: 0; padding-bottom: calc(90px + env(safe-area-inset-bottom)); background: var(--bg); }
.section h2 {
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-2);
  padding: 14px 14px;
  border-bottom: 1px solid var(--border);
  margin: 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--bg);
}

.product-group-title {
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-2);
  padding: 10px 14px 8px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--border);
}

/* ─── PRODUCT CARDS ──────────────────────────────────────────────────────── */
.p-card {
  padding: 14px;
  display: flex;
  gap: 14px;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  transition: background 0.1s;
}
.p-card:active { background: var(--surface-2); }
.p-card.rejected { opacity: 0.32; filter: grayscale(100%); }
.p-img {
  width: 64px; height: 86px;
  background: var(--surface-2);
  flex-shrink: 0;
  position: relative;
  overflow: hidden;
}
.p-img img { width: 100%; height: 100%; object-fit: cover; }
.p-img .no-img {
  width: 100%; height: 100%;
  display: flex; align-items: center; justify-content: center;
  color: var(--text-3);
  font-size: 9px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.p-info { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 4px; }
.p-title {
  font-size: 13px;
  font-weight: 400;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text);
  letter-spacing: -0.01em;
}
.p-brand {
  font-size: 11px;
  color: var(--text-2);
  font-weight: 400;
  text-transform: none;
  letter-spacing: 0;
}
.p-status { display: flex; align-items: center; gap: 6px; margin-top: 2px; }

/* ─── MODAL / EDITOR ─────────────────────────────────────────────────────── */
.modal { position: fixed; inset: 0; z-index: 100; background: var(--bg); display: none; flex-direction: column; }
.modal.active { display: flex; }
.modal-header {
  padding: 0 14px;
  padding-top: env(safe-area-inset-top);
  height: calc(48px + env(safe-area-inset-top));
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 10px;
  background: var(--bg);
  flex-shrink: 0;
}
.modal-header h2 {
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  flex: 1;
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--text-2);
}
.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 0;
  padding-bottom: calc(80px + env(safe-area-inset-bottom));
  -webkit-overflow-scrolling: touch;
}

/* Video Modal */
#videoModal { background: #000; z-index: 200; cursor: pointer; }
#vPlayer { width: 100%; height: 100%; object-fit: contain; }

/* ─── EDITOR CARDS ───────────────────────────────────────────────────────── */
.card {
  padding: 18px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}
.card h3 {
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--text-2);
  margin-bottom: 14px;
  padding-bottom: 10px;
  display: block;
  border-bottom: 1px solid var(--border);
}

details.card { padding: 0; }
details.card > summary {
  padding: 16px 14px;
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--text-2);
  cursor: pointer;
  list-style: none;
  display: flex;
  justify-content: space-between;
  align-items: center;
}
details.card > summary::after { content: '+'; font-size: 14px; font-weight: 300; color: var(--text-3); }
details[open].card > summary { border-bottom: 1px solid var(--border); color: var(--text); }
details[open].card > summary::after { content: '−'; }
details.card > .details-content { padding: 14px; }

/* ─── IMAGE CAROUSEL ─────────────────────────────────────────────────────── */
.carousel {
  display: flex;
  overflow-x: auto;
  gap: 8px;
  padding-bottom: 0;
  scroll-snap-type: x mandatory;
  margin-bottom: 14px;
  -webkit-overflow-scrolling: touch;
  -ms-overflow-style: none;
  scrollbar-width: none;
  transform: translateZ(0);
}
.carousel::-webkit-scrollbar { display: none; }

.img-cell {
  flex: 0 0 72%;
  aspect-ratio: 3/4;
  scroll-snap-align: center;
  position: relative;
  cursor: pointer;
  background: var(--surface-2);
  overflow: hidden;
  transition: opacity 0.15s;
}
.img-cell:active { opacity: 0.75; }
.img-cell img {
  width: 100%; height: 100%;
  object-fit: cover;
  opacity: 0.45;
  transition: opacity 0.18s;
}
.img-cell.on img { opacity: 1; }
.img-cell.on { outline: 2px solid var(--text); outline-offset: -2px; }

.img-cell .check {
  position: absolute; top: 8px; right: 8px;
  width: 20px; height: 20px;
  background: transparent;
  border: 1px solid rgba(255,255,255,0.5);
  display: flex; align-items: center; justify-content: center;
  font-size: 10px; font-weight: 600; color: transparent;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.img-cell.on .check { background: var(--text); border-color: var(--text); color: var(--bg); }

/* ─── EXTRACT ANIMATION ──────────────────────────────────────────────────── */
@keyframes pulse-extract {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.2; filter: grayscale(100%); }
}
.extracting { animation: pulse-extract 1.4s infinite ease-in-out; pointer-events: none; }

/* ─── FORM FIELDS ────────────────────────────────────────────────────────── */
.field { margin-bottom: 14px; }
.field label { display: block; margin-bottom: 6px; }
.field-row { display: flex; gap: 10px; }
.field-row .field { flex: 1; }

/* ─── ACTIONS BAR ────────────────────────────────────────────────────────── */
.actions-bar {
  position: fixed; bottom: 0; left: 0; right: 0;
  padding: 12px 14px;
  padding-bottom: max(12px, env(safe-area-inset-bottom));
  background: var(--bg);
  border-top: 1px solid var(--border);
  display: flex; gap: 8px;
  z-index: 50;
}
.actions-bar button { flex: 1; }

/* ─── EMPTY STATE ────────────────────────────────────────────────────────── */
.empty {
  padding: 48px 14px;
  text-align: center;
  color: var(--text-3);
  font-size: 11px;
  font-weight: 400;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

/* ─── LOADING ────────────────────────────────────────────────────────────── */
.loading { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100dvh; gap: 20px; color: var(--text-2); }
.spinner { width: 24px; height: 24px; border: 1.5px solid var(--border); border-top-color: var(--text-2); border-radius: 50%; animation: spin .7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ─── TOAST ──────────────────────────────────────────────────────────────── */
.toast {
  position: fixed;
  top: max(14px, env(safe-area-inset-top));
  left: 50%;
  transform: translate(-50%, -120px);
  background: var(--text);
  color: var(--bg);
  padding: 10px 20px;
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  z-index: 300;
  transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  white-space: nowrap;
}
.toast.show { transform: translate(-50%, 0); }

/* ─── LAZY IMAGES ────────────────────────────────────────────────────────── */
.lazy-img { opacity: 0; transition: opacity 0.25s; }
.lazy-img.loaded { opacity: 1; }
.placeholder { background: var(--surface-2); }

/* ─── PERFORMANCE ────────────────────────────────────────────────────────── */
.post-group, .p-card { content-visibility: auto; contain-intrinsic-size: auto 120px; }

</style>
</head>
<body>
<div id="app">
  <div id="loading" class="screen active">
    <div class="loading"><div class="spinner"></div><p style="font-size:10px; text-transform:uppercase; letter-spacing:0.07em; color:var(--text-2);">Loading</p></div>
  </div>
  
  <!-- QUEUE SCREEN -->
  <div id="queue" class="screen">
    <div class="topbar">
      <h1>Queue</h1>
      <span class="badge" id="qCount">0</span>
      <button class="theme-toggle" onclick="toggleTheme()">Theme</button>
      <button class="theme-toggle" onclick="loadQueue()">Refresh</button>
    </div>
    <div id="qList"></div>
  </div>

  <!-- REVIEW SCREEN (Item Level) -->
  <div id="review" class="screen">
    <div class="topbar">
      <button class="theme-toggle" onclick="showQueue()">← Back</button>
      <h1 id="rTitle" style="text-align:center; color:var(--text-2);"></h1>
      <div id="rTopRight" style="min-width:60px; text-align:right;"></div>
    </div>
    <div class="hero">
      <img id="rImage" src="" alt="" loading="lazy" onclick="this.style.objectFit = this.style.objectFit === 'contain' ? 'cover' : 'contain'">
      <div class="hero-meta" id="rMeta"></div>
    </div>
    <div class="section">
      <h2>Sources <span class="badge" id="pCount">0</span></h2>
      <div id="pList"></div>
    </div>
    <div class="actions-bar">
      <button class="btn-danger" onclick="deleteItem()">Discard</button>
      <button class="btn-primary" id="btnCommitItem" onclick="commitItem()">Commit Item</button>
    </div>
  </div>

  <!-- EDITOR MODAL (Source Level) -->
  <div id="editor" class="modal">
    <div class="modal-header">
      <button class="theme-toggle" onclick="closeEditor()">Cancel</button>
      <h2 id="eModalTitle">Edit Source</h2>
      <button class="btn-primary" onclick="saveSource('completed')" style="padding:0 14px; font-size:10px; min-height:28px; height:28px;">Save</button>
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
  lastViewedItemId: null,
  formPersistKey: null
};

// Theme Toggle
function toggleTheme() {
  const root = document.documentElement;
  const current = root.getAttribute('data-theme');
  const newTheme = current === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', newTheme);
  document.getElementById('metaThemeColor').setAttribute('content', newTheme === 'dark' ? '#0f0f0e' : '#f8f8f7');
  localStorage.setItem('theme', newTheme);
}
if (localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
  document.documentElement.setAttribute('data-theme', 'dark');
  document.getElementById('metaThemeColor')?.setAttribute('content', '#0f0f0e');
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

function getHighestSourcePrice(src) {
  const candidates = [];
  if (src.price?.current != null) { const n = parseFloat(getSafeNumber(src.price.current)); if (!isNaN(n)) candidates.push(n); }
  if (src.price?.original != null) { const n = parseFloat(getSafeNumber(src.price.original)); if (!isNaN(n)) candidates.push(n); }
  if (src.compare_at_price != null) { const n = parseFloat(getSafeNumber(src.compare_at_price)); if (!isNaN(n)) candidates.push(n); }
  if (Array.isArray(src.variants)) {
    src.variants.forEach(v => {
      if (v.price != null) { const n = parseFloat(getSafeNumber(v.price)); if (!isNaN(n)) candidates.push(n); }
    });
  }
  return candidates.length ? Math.max(...candidates) : null;
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

function computeFinalPriceDisplay(source) {
    const base = getHighestSourcePrice(source);
    if (base == null || isNaN(base)) return "N/A";
    
    const type = source.markup_type || "percentage";
    let final = base;
    
    if (type === "fixed" && source.markup_fixed != null) {
        const fixed = parseFloat(source.markup_fixed);
        if (!isNaN(fixed)) final = base + fixed;
    } else if (type === "percentage" && source.markup_percentage != null) {
        const pct = parseFloat(source.markup_percentage);
        if (!isNaN(pct)) final = base * (1 + pct / 100);
    }
    
    const curr = source.price?.currency || source.currency || "";
    return final.toFixed(2) + (curr ? " " + curr : "");
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
      color: document.getElementById("eColor")?.value || "",
      variant: document.getElementById("eVariant")?.value || "",
      material: document.getElementById("eMaterial")?.value || "",
      condition: document.getElementById("eCondition")?.value || "",
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
      markupType: document.getElementById("eMarkupType")?.value || "percentage",
      markupFixed: document.getElementById("eMarkupFixed")?.value || "",
      markupPct: document.getElementById("eMarkupPct")?.value || "",
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
    setVal("eColor", data.color);
    setVal("eVariant", data.variant);
    setVal("eMaterial", data.material);
    setVal("eCondition", data.condition);
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
    setVal("eMarkupType", data.markupType);
    setVal("eMarkupFixed", data.markupFixed);
    setVal("eMarkupPct", data.markupPct);

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
    list.innerHTML = '<div class="empty">Queue complete<br><span style="font-size:10px; opacity:0.5; display:block; margin-top:6px;">All items reviewed</span></div>';
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
          <div class="post-thumb"><img data-src="\${escapeHtml(thumb)}" alt="" class="lazy-img placeholder" loading="lazy" onload="this.classList.remove('placeholder')" onerror="this.style.display='none'"></div>
          <div class="post-info">
            <div class="post-id">\${escapeHtml(pid)}</div>
            <div class="post-meta">\${items.length} ITEM(S) &middot; \${pending} PENDING</div>
          </div>
          <svg class="post-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
        </div>
        <div class="post-items" onclick="event.stopPropagation()">
          \${items.map(it => \`
            <div class="item-row" data-item-id="\${it._id}-\${it.fileIdx}-\${it.frameIdx !== null ? it.frameIdx : 'img'}" onclick="openItem('\${it._id}', \${it.fileIdx}, \${it.frameIdx !== null ? it.frameIdx : null})">
              <div class="item-thumb"><img data-src="\${escapeHtml(it.thumb)}" alt="" class="lazy-img placeholder" loading="lazy" onload="this.classList.remove('placeholder')" onerror="this.style.display='none'"></div>
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
  
  if (state.lastViewedItemId) {
    const scrollToItem = () => {
      const targetRow = document.querySelector(\`.item-row[data-item-id="\${state.lastViewedItemId}"]\`);
      if (targetRow) {
        targetRow.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      state.lastViewedItemId = null;
    };
      
    // Double rAF ensures layout is fully settled regardless of prior scroll position
    requestAnimationFrame(() => requestAnimationFrame(scrollToItem));
  }
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
    state.lastViewedItemId = \`\${_id}-\${fileIdx}-\${frameIdx !== null ? frameIdx : 'img'}\`;
  } catch(e) {
    toast("ERR: " + e.message);
    return;
  }
  renderItem();
  showScreen("review");
  window.scrollTo(0,0);
}

function renderItem() {
  const item = state.current;
  const rTitle = document.getElementById("rTitle");
  const rTopRight = document.getElementById("rTopRight");
  const rImage = document.getElementById("rImage");
  const rMeta = document.getElementById("rMeta");
  const pList = document.getElementById("pList");
  const pCount = document.getElementById("pCount");
  const btnCommit = document.getElementById("btnCommitItem");
  
  let igLink = 'https://www.instagram.com/' + item.postId + '/';
  if (!item.postId.startsWith('p/') && !item.postId.startsWith('reel/')) {
    igLink = 'https://www.instagram.com/p/' + item.postId + '/';
  }
  
  rTitle.innerHTML = \`<a href="\${escapeHtml(igLink)}" target="_blank">\${escapeHtml(item.postId)}</a>\`;
  
  if (item.type === 'frame' && item.parentUrl) {
    const proxyUrl = "/api/video?url=" + encodeURIComponent(item.parentUrl);
    const watchBtn = document.createElement('button');
    watchBtn.className = 'btn-ghost';
    watchBtn.setAttribute('style', 'font-size:10px; letter-spacing:0.05em; text-transform:uppercase; color:var(--text-2); border:1px solid var(--border); padding:0 10px; height:24px; min-height:24px; background:transparent;');
    watchBtn.textContent = 'WATCH';
    watchBtn.onclick = () => openVideo(proxyUrl);
    rTopRight.innerHTML = '';
    rTopRight.appendChild(watchBtn);
  } else {
    rTopRight.innerHTML  = '';
  }

  rImage.src = item.url;
  
  const prods = item.response && item.response.products ? item.response.products : [];
  
  let totalSources = 0;
  let pendingSources = 0;
  let listHtml = "";

  if (!prods.length) {
    listHtml = '<div class="empty">No products identified</div>';
  } else {
    prods.forEach((p, pIdx) => {
      listHtml += \`<div class="product-group-title">\${escapeHtml(p.title || 'UNKNOWN PRODUCT')}</div>\`;
      
      const sources = p.sources || [];
      totalSources += sources.length;
      
      if (!sources.length) {
        listHtml += '<div class="empty" style="padding:16px;">No sources found</div>';
      } else {
        sources.forEach((s, sIdx) => {
          if (s.reviewStatus !== "completed" && s.reviewStatus !== "rejected") pendingSources++;
          
          let statusColor = "var(--text)";
          let rejectedClass = "";
          let statusBadge = "";

          // All indicator badges on the listing page remain a uniform grey color for a clean UI
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
      }
    });
  }

  pList.innerHTML = listHtml;
  pCount.textContent = totalSources;

  rMeta.innerHTML = \`
    <span class="badge">\${item.type === "frame" ? "FRAME" : "IMAGE"}</span>
    <span class="badge">\${totalSources} SRC</span>
    \${pendingSources ? \`<span class="badge pending">\${pendingSources} PEND</span>\` : ""}
  \`;
  
  if (pendingSources > 0) {
    btnCommit.disabled = true;
    btnCommit.title = "Review all sources first";
  } else {
    btnCommit.disabled = false;
    btnCommit.title = "";
  }

  if (state.justEditedSId !== null) {
    const scrollToCard = () => {
      const targetCard = document.querySelector(\`.p-card[data-source-id="\${state.justEditedSId}"]\`);
      if (targetCard) {
        targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      state.justEditedSId = null;
    };
    requestAnimationFrame(() => requestAnimationFrame(scrollToCard));
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

function updateFinalPrice() {
    const type = document.getElementById("eMarkupType").value;
    const fixedWrap = document.getElementById("fieldMarkupFixed");
    const pctWrap = document.getElementById("fieldMarkupPct");
    
    if (fixedWrap) fixedWrap.style.display = type === "fixed" ? "block" : "none";
    if (pctWrap) pctWrap.style.display = type === "percentage" ? "block" : "none";
    
    const baseEl = document.getElementById("ePrice");
    const finalEl = document.getElementById("eFinalPrice");
    if (!baseEl || !finalEl) return;
    
    const base = parseFloat(baseEl.value);
    if (isNaN(base)) { finalEl.value = "N/A"; return; }
    
    const curr = document.getElementById("eCurrency")?.value || "";
    let final = base;
    
    if (type === "fixed") {
        const fixed = parseFloat(document.getElementById("eMarkupFixed")?.value);
        if (!isNaN(fixed)) final = base + fixed;
    } else {
        const pct = parseFloat(document.getElementById("eMarkupPct")?.value);
        if (!isNaN(pct)) final = base * (1 + pct / 100);
    }
    
    finalEl.value = final.toFixed(2) + (curr ? " " + curr : "");
    saveFormToLocalStorage();
}

function getAllImages(source) {
  const allUrls = new Set();
  if (state.current && state.current.url) allUrls.add(state.current.url);

  (source.images || []).forEach(u => {
    const url = getImageUrl(u);
    if (url) allUrls.add(url);
  });
  
  (source.customImages || []).forEach(u => { if (u) allUrls.add(String(u)); });
  (source.selectedImages || []).forEach(u => { if (u) allUrls.add(String(u)); });
  
  return { urls: Array.from(allUrls) };
}

function openSource(pIdx, sIdx) {
  try {
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

    state.currentVariants = Array.isArray(s.variants) ? JSON.parse(JSON.stringify(s.variants)) : [];
    const rawSg = s.size_guide;
    const hasHeaders = rawSg && Array.isArray(rawSg.headers);
    const hasRows    = rawSg && Array.isArray(rawSg.rows);
    state.currentSizeGuide = (hasHeaders && hasRows)
      ? JSON.parse(JSON.stringify(rawSg))
      : { headers: ["US", "EU", "UK"], rows: [] };

    const highestPrice = getHighestSourcePrice(s);
    const safePriceVal = highestPrice != null ? highestPrice.toFixed(2) : "";
    const safeCompareVal = s.price?.original != null ? getSafeNumber(s.price.original) : (s.compare_at_price != null ? getSafeNumber(s.compare_at_price) : "");
    
    // Robust availability parser — scoped to selected variant color if set
    function parseAvailStr(str) {
      const raw = String(str || "").toLowerCase().replace(/[^a-z]/g, '');
      return (raw.includes('out') || raw.includes('sold')) ? "OutOfStock" : (raw.includes('pre') ? "PreOrder" : "InStock");
    }
    const selectedVariantColor = (s.variant || '').trim();
    let mappedAvail;
    if (selectedVariantColor && Array.isArray(s.variants) && s.variants.length) {
      const filteredVars = s.variants.filter(v => (v.color || '').trim() === selectedVariantColor);
      if (filteredVars.length) {
        // If any are InStock → InStock; else if any PreOrder → PreOrder; else OutOfStock
        const avails = filteredVars.map(v => parseAvailStr(v.availability));
        mappedAvail = avails.includes('InStock') ? 'InStock' : (avails.includes('PreOrder') ? 'PreOrder' : 'OutOfStock');
      } else {
        mappedAvail = parseAvailStr(s.availability);
      }
    } else {
      mappedAvail = parseAvailStr(s.availability);
    }
    
    // Robust features string parser to prevent crash
    const featuresRaw = Array.isArray(s.features) ? s.features.join("\\n") : (typeof s.features === "string" ? s.features : "");

    let html = \`
      <div class="card" style="padding-bottom: 0; margin-top:0; border-top:none;">
        <h3 style="display:flex; justify-content:space-between; align-items:center; border:none; margin-bottom:12px; gap:12px;">
          Images
          <span style="color:var(--text-3); font-weight:400; text-transform:none; font-size:10px; letter-spacing:0.04em; text-transform:uppercase;">
            <span id="selCount">\${state.currentSelected.length}</span> selected
          </span>
        </h3>
        <div class="carousel" id="eImgGrid"></div>
        <div style="display:flex; gap:8px; margin-bottom:14px;">
          <button class="btn-ghost" onclick="addImage()" style="flex:1; border:1px solid var(--border); min-height:36px; font-size:10px; color:var(--text-2);">+ Paste URL</button>
          <button class="btn-ghost" onclick="clearSelection()" style="flex:1; border:1px solid var(--border); min-height:36px; font-size:10px; color:var(--danger);">Clear</button>
        </div>
      </div>
      
      <div class="card">
        <h3>Basic Info</h3>
        <div class="field"><label>Product Name</label><input id="eTitle" value="\${escapeHtml(s.name || product.title || "")}"></div>
        
        <div class="field-row">
          <div class="field"><label>Brand</label><input id="eBrand" value="\${escapeHtml(s.brand || "")}"></div>
          <div class="field"><label>Vendor</label><input id="eVendor" value="\${escapeHtml(s.vendor || s.store || "")}"></div>
        </div>
        
        <div class="field-row">
          <div class="field"><label>Color</label><input id="eColor" value="\${escapeHtml(s.color || "")}"></div>
          <div class="field"><label>Material</label><input id="eMaterial" value="\${escapeHtml(s.material || "")}"></div>
        </div>
        
        <div class="field">
          <label>Variant</label>
          <select id="eVariant">
            <option value="">All Variants</option>
            \${(() => {
              const variants = s.variants || [];
              if (!variants.length) return '';
              
              // Collect unique non-empty colors, preserving first-seen order
              const seen = new Set();
              const uniqueColors = [];
              variants.forEach(v => {
                const c = (v.color || '').trim();
                if (c && !seen.has(c)) { seen.add(c); uniqueColors.push(c); }
              });
              
              // Auto-select: use saved s.variant if it matches a known color,
              // else if all variants share the same color, auto-select it,
              // else select the first unique color found.
              const allColors = variants.map(v => (v.color || '').trim());
              const allSame = allColors.every(c => c === allColors[0]) && allColors[0] !== '';
              const savedVariant = (s.variant || '').trim();
              const defaultVal = (savedVariant && uniqueColors.includes(savedVariant))
                ? savedVariant
                : (allSame ? allColors[0] : (uniqueColors[0] || ''));
                
              return uniqueColors.map(c => 
                \`<option value="\${escapeHtml(c)}" \${defaultVal === c ? 'selected' : ''}>\${escapeHtml(c)}</option>\`
              ).join('');
            })()}
          </select>
        </div>

        <div class="field">
          <label>Condition</label>
          <select id="eCondition">
            <option value="" \${escapeHtml(s.condition || "") === "" ? "selected" : ""}>Unknown</option>
            <option value="New" \${escapeHtml(s.condition || "") === "New" ? "selected" : ""}>New</option>
            <option value="Used" \${escapeHtml(s.condition || "") === "Used" ? "selected" : ""}>Used</option>
          </select>
        </div>
        
        <div class="field"><label>Category</label><input id="eCategory" value="\${escapeHtml(s.primary_category || product.category || "")}"></div>

        <div class="field" style="margin-bottom:24px;">
          <label>Supplier URL</label>
          <div style="display:flex; gap:8px;">
            <input id="eUrl" type="url" value="\${escapeHtml(s.url || "")}" style="flex:1;">
            \${s.url ? \`<a href="\${escapeHtml(s.url)}" target="_blank" rel="noopener" class="btn-ghost" style="border:1px solid var(--border); padding:0 12px; display:flex; align-items:center; justify-content:center; font-size:10px; text-decoration:none; color:var(--text-2); white-space:nowrap; min-height:40px; flex-shrink:0; letter-spacing:0.05em; text-transform:uppercase;">Visit</a>\` : ''}
          </div>
          <div style="display:flex; gap:8px; margin-top:8px;">
            <button id="btnExtractLazy" class="btn-ghost" style="flex:1; font-size:10px; min-height:36px; padding:0; background:var(--surface-2); border:1px solid var(--border); color:var(--text-2);" onclick="extractImages('lazy')">Extract (Quick)</button>
            <button id="btnExtractFull" class="btn-ghost" style="flex:1; font-size:10px; min-height:36px; padding:0; background:var(--surface-2); border:1px solid var(--border); color:var(--text-2);" onclick="extractImages('full')">Extract (Full)</button>
          </div>
        </div>

        <div class="field-row">
          <div class="field"><label>Price</label><input id="ePrice" type="number" step="0.01" inputmode="decimal" value="\${escapeHtml(safePriceVal)}" oninput="updateFinalPrice()"></div>
          <div class="field"><label>Compare At</label><input id="eComparePrice" type="number" step="0.01" inputmode="decimal" value="\${escapeHtml(safeCompareVal)}"></div>
          
          <div class="field" style="width:120px">
            <label>Currency</label>
            <div style="display:flex; gap:0;">
              <input id="eCurrency" list="currencyList" value="\${escapeHtml(s.price?.currency || s.currency || 'USD')}" style="text-transform:uppercase; flex:1;" oninput="this.value=this.value.toUpperCase(); updateFinalPrice()">
              <select onchange="document.getElementById('eCurrency').value=this.value; updateFinalPrice(); this.value='';" style="width:36px; padding:0 4px; flex-shrink:0; font-size:11px; border-left:none;">
                <option value="">▾</option>
                <option>USD</option><option>EUR</option><option>GBP</option>
                <option>CAD</option><option>AUD</option><option>CHF</option>
                <option>JPY</option><option>CNY</option><option>SEK</option>
                <option>NOK</option><option>DKK</option><option>PLN</option>
                <option>SGD</option><option>HKD</option><option>NZD</option>
                <option>MXN</option><option>KRW</option><option>INR</option>
                <option>AED</option><option>SAR</option><option>ZAR</option>
              </select>
            </div>
            <datalist id="currencyList">
              <option value="USD"><option value="EUR"><option value="GBP">
              <option value="CAD"><option value="AUD"><option value="CHF">
              <option value="JPY"><option value="CNY"><option value="SEK">
              <option value="NOK"><option value="DKK"><option value="PLN">
              <option value="SGD"><option value="HKD"><option value="NZD">
              <option value="MXN"><option value="KRW"><option value="INR">
              <option value="AED"><option value="SAR"><option value="ZAR">
            </datalist>
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
      
      <details class="card">
        <summary>Variants</summary>
        <div class="details-content">
          <div id="variantsContainer" class="simple-table-wrapper"></div>
          <button class="btn-ghost" onclick="addVariantRow()" style="width:100%; border:1px solid var(--border); margin-top:8px; min-height:36px; font-size:10px; color:var(--text-2);">+ Add Size</button>
        </div>
      </details>

      <details class="card">
        <summary>Size Guide</summary>
        <div class="details-content">
          <div id="sizeGuideContainer" class="simple-table-wrapper"></div>
          <div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap;">
            <button class="btn-ghost" onclick="addSizeGuideRow()" style="flex:1; border:1px solid var(--border); min-height:36px; font-size:10px; color:var(--text-2);">+ Row</button>
            <button class="btn-ghost" onclick="addSizeGuideCol()" style="flex:1; border:1px solid var(--border); min-height:36px; font-size:10px; color:var(--text-2);">+ Col</button>
          </div>
          <div style="display:flex; gap:8px; margin-top:8px;">
            <button class="btn-ghost" onclick="copySizeGuidePrompt()" style="flex:1; border:1px solid var(--border); min-height:36px; font-size:10px; color:var(--text-2);">AI Prompt</button>
            <button class="btn-ghost" onclick="pasteSizeGuideJson()" style="flex:1; border:1px solid var(--border); min-height:36px; font-size:10px; color:var(--success);">Paste JSON</button>
          </div>
          <div style="font-size:10px; color:var(--text-3); margin-top:10px; line-height:1.6; text-transform:uppercase; letter-spacing:0.04em;">
            Copy AI prompt → run in any AI with web search → paste JSON result here
          </div>
        </div>
      </details>

      <details class="card">
        <summary>Details & Policies</summary>
        <div class="details-content">
          <div class="field"><label>Description</label><textarea id="eDesc">\${escapeHtml(s.description || product.description || "")}</textarea></div>
          <div class="field"><label>Features (One per line)</label><textarea id="eFeatures">\${escapeHtml(featuresRaw)}</textarea></div>
          <div class="field"><label>Shipping Info</label><textarea id="eShippingInfo">\${escapeHtml(s.shipping_info || "")}</textarea></div>
          <div class="field"><label>Return Policy</label><textarea id="eReturnPolicy">\${escapeHtml(s.return_policy || "")}</textarea></div>
        </div>
      </details>

      <details class="card">
        <summary>Dropship Pricing</summary>
        <div class="details-content">
          <div style="background:var(--surface-2); padding:12px; margin-bottom:14px; border:1px solid var(--border);">
            <div style="font-size:10px; font-weight:500; text-transform:uppercase; letter-spacing:0.06em; color:var(--text-2); margin-bottom:8px;">Context</div>
            <div style="font-size:13px; margin-bottom:6px;"><strong>Advisory:</strong> \${escapeHtml(s.dropship_advisory || "None")}</div>
            <div style="display:flex; gap:16px; font-size:13px; flex-wrap:wrap;">
              <div><strong>Base:</strong> \${s.base_price_for_markup || "N/A"}</div>
              <div><strong>Markup:</strong> \${s.recommended_markup_percentage ? s.recommended_markup_percentage + "%" : "N/A"}</div>
              <div><strong>Resell:</strong> \${s.suggested_resell_price || "N/A"}</div>
              <div><strong>Rating:</strong> \${s.rating || "?"}★ (\${s.review_count || 0})</div>
            </div>
            <div style="font-size:11px; color:var(--text-2); margin-top:8px;">Context fields: <code>dropship_advisory</code>, <code>base_price_for_markup</code>, <code>recommended_markup_percentage</code>, <code>suggested_resell_price</code>, <code>rating</code>, <code>review_count</code></div>
          </div>
          <div class="field">
            <label>Markup Type</label>
            <select id="eMarkupType" onchange="updateFinalPrice()">
              <option value="percentage" \${(s.markup_type || "percentage") === "percentage" ? "selected" : ""}>Percentage</option>
              <option value="fixed" \${(s.markup_type || "") === "fixed" ? "selected" : ""}>Fixed Amount</option>
            </select>
          </div>
          <div class="field-row">
            <div class="field" id="fieldMarkupFixed" style="display:\${(s.markup_type || "percentage") === "fixed" ? "block" : "none"}">
              <label>Fixed Markup</label>
              <input id="eMarkupFixed" type="number" step="0.01" inputmode="decimal" 
                value="\${s.markup_fixed != null ? escapeHtml(getSafeNumber(s.markup_fixed)) : ""}" 
                oninput="updateFinalPrice()">
            </div>
            <div class="field" id="fieldMarkupPct" style="display:\${(s.markup_type || "percentage") === "percentage" ? "block" : "none"}">
              <label>Markup %</label>
              <input id="eMarkupPct" type="number" step="0.1" inputmode="decimal" 
                value="\${s.markup_percentage != null ? escapeHtml(String(s.markup_percentage)) : (s.recommended_markup_percentage != null ? escapeHtml(String(s.recommended_markup_percentage)) : '30')}"
                oninput="updateFinalPrice()">
            </div>
          </div>
          <div class="field">
            <label>Final Price (Auto)</label>
            <input id="eFinalPrice" type="text" readonly 
              value="\${escapeHtml(computeFinalPriceDisplay(s))}" 
              style="background:var(--surface-2); color:var(--text-2);">
          </div>
        </div>
      </details>

      <div class="card" style="border-bottom:none;">
        <h3>Actions</h3>
        <div style="display:flex; gap:8px; margin-bottom:10px;">
          <button class="btn-ghost" onclick="deleteSource()" style="flex:1; color:var(--danger); border:1px solid var(--border); min-height:40px; font-size:10px;">Delete Source</button>
        </div>
        <div style="display:flex; gap:8px;">
          <button class="btn-danger" onclick="rejectSource()" style="flex:1; min-height:44px;">Reject</button>
          <button class="btn-primary" onclick="saveSource('completed')" style="flex:1; min-height:44px;">Save</button>
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
    window.scrollTo(0,0);
  } catch (err) {
    toast("ERROR OPENING SOURCE: " + err.message);
  }
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
  const btnLazy = document.getElementById("btnExtractLazy");
  const btnFull = document.getElementById("btnExtractFull");

  if (carousel) carousel.classList.add("extracting");
  if (btnLazy) { btnLazy.disabled = true; btnLazy.innerText = "Extracting..."; }
  if (btnFull) { btnFull.disabled = true; btnFull.innerText = "Extracting..."; }
  
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
    if (btnLazy) { btnLazy.disabled = false; btnLazy.innerText = "Extract (Quick)"; }
    if (btnFull) { btnFull.disabled = false; btnFull.innerText = "Extract (Full)"; }
  }
}

/* --- Variants Table Logic --- */
function renderVariantsTable() {
  const container = document.getElementById("variantsContainer");
  if (!state.currentVariants.length) { container.innerHTML = ''; return; }
  
  let html = '<table class="simple-table"><thead><tr><th>SIZE</th><th>COLOR</th><th>STOCK</th><th>QTY</th><th>PRICE</th><th style="width:48px;"></th></tr></thead><tbody>';
  state.currentVariants.forEach((v, i) => {
    let rawAvail = String(v.availability || "").toLowerCase().replace(/[^a-z]/g, '');
    let mappedAvail = (rawAvail.includes('out') || rawAvail.includes('sold')) ? "OutOfStock" : (rawAvail.includes('pre') ? "PreOrder" : "InStock");
    
    html += \`
      <tr class="v-row" data-idx="\${i}">
        <td><input type="text" class="v-size" value="\${escapeHtml(v.size || '')}"></td>
        <td><input type="text" class="v-color" value="\${escapeHtml(v.color || '')}"></td>
        <td>
          <select class="v-avail">
            <option \${mappedAvail === "InStock" ? "selected" : ""}>InStock</option>
            <option \${mappedAvail === "OutOfStock" ? "selected" : ""}>OutOfStock</option>
            <option \${mappedAvail === "PreOrder" ? "selected" : ""}>PreOrder</option>
          </select>
        </td>
        <td><input type="number" class="v-qty" inputmode="numeric" value="\${escapeHtml(v.inventory_quantity != null ? String(v.inventory_quantity) : '')}"></td>
        <td><input type="number" class="v-price" step="0.01" inputmode="decimal" value="\${escapeHtml(v.price != null ? getSafeNumber(v.price) : '')}"></td>
        <td><button class="table-btn" onclick="delVariantRow(\${i})">&times;</button></td>
      </tr>
    \`;
  });
  html += '</tbody></table>';
  container.innerHTML = html;
}

function syncVariantsFromDOM() {
  const rows = document.querySelectorAll(".v-row");
  state.currentVariants = Array.from(rows).map(row => {
    const qtyVal = row.querySelector(".v-qty").value;
    const priceVal = row.querySelector(".v-price").value;
    return {
      size: row.querySelector(".v-size").value,
      color: row.querySelector(".v-color").value,
      availability: row.querySelector(".v-avail").value,
      inventory_quantity: qtyVal !== '' ? parseInt(qtyVal, 10) : null,
      price: priceVal !== '' ? parseFloat(priceVal) : null
    };
  });
}

function addVariantRow() {
  syncVariantsFromDOM();
  state.currentVariants.push({ size: "", color: "", availability: "InStock", inventory_quantity: null, price: null });
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
  const sg = state.currentSizeGuide || { headers: [], rows: [] };
  
  // Ensure rows always exists
  if (!sg.rows) sg.rows = [];
  
  if (!sg.headers || !sg.headers.length) { 
    container.innerHTML = ''; 
    return; 
  }
  
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
  
  sg.rows.forEach((row, rIdx) => {
    html += \`<tr class="sg-row" data-ridx="\${rIdx}">\`;
    sg.headers.forEach((_, cIdx) => {
      const val = row[cIdx] || "";
      html += \`<td><input type="text" class="sg-cell" data-ridx="\${rIdx}" data-cidx="\${cIdx}" value="\${escapeHtml(val)}"></td>\`;
    });
    html += \`<td><button class="table-btn" onclick="delSizeGuideRow(\${rIdx})">&times;</button></td></tr>\`;
  });
  html += '</tbody></table>';
  container.innerHTML = html;
}

function syncSizeGuideFromDOM() {
  const sg = state.currentSizeGuide;
  document.querySelectorAll(".sg-header").forEach(inp => {
    sg.headers[parseInt(inp.dataset.cidx, 10)] = inp.value;
  });
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
  state.currentSizeGuide.rows.forEach(r => r.push(""));
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
  state.currentSizeGuide.rows.forEach(r => r.splice(cIdx, 1));
  renderSizeGuideTable();
  saveFormToLocalStorage();
}

function copySizeGuidePrompt() {
  const pIdx = state.editingPIdx;
  const sIdx = state.editingSIdx;
  const s = state.current?.response?.products?.[pIdx]?.sources?.[sIdx];
  if (!s) return toast("NO SOURCE LOADED");

  const sourceData = {
    name: s.name,
    brand: s.brand,
    vendor: s.vendor || s.store,
    category: s.primary_category,
    url: s.url,
    description: s.description,
    size_guide: s.size_guide || null,
    features: s.features,
    variants: (s.variants || []).map(v => ({ size: v.size, color: v.color }))
  };

  const currency = (s.price?.currency || s.currency || '').toUpperCase();

  const systemPrompt = \`You are a senior e-commerce sizing analyst. Generate live, customer-facing size guides that reduce returns through clarity and accuracy.

Rules:
1. Only include data you have verified through web search.
2. Label the source basis: "Official Brand Data" or "Synthesized Industry Consensus".
3. Detect gender and product sub-type from the data to choose correct body measurements and proportions.
4. Match the exact JSON schema. No markdown. No text outside the JSON object.
5. This output will be displayed directly to shoppers. Be concise, scannable, and actionable.

Example output for Women's Tops:
{"headers":["Alpha","US","UK","EU","AU","Bust (cm)","Waist (cm)"],"rows":[["XS","0-2","4-6","32-34","6-8","78-82","60-64"],["S","4-6","8-10","36-38","8-10","84-88","66-70"],["M","8-10","12-14","40-42","10-12","90-94","72-76"]],"gender":"Women","product_type":"Women's Tops","research_summary":"Official Zara size chart","confidence":"high (official brand data)","fit_notes":"True to size. Slight taper at waist. Size up for oversized fit.","measurement_note":"Bust: measure around fullest part. Waist: measure around natural waistline. Allow 2-3cm ease.","how_to_measure":"Use a soft tape measure. Keep it level and snug but not tight. Measure over undergarments.","disclaimer":"Size guidance based on research. Fit may vary slightly by style and batch."}\`;

  const userPrompt = \`Generate a live, customer-facing size guide for this product.

PRODUCT DATA:
\${JSON.stringify(sourceData, null, 2)}

CURRENCY: \${currency}

RESEARCH PROTOCOL:
1. **Scraped Size Guide Check**: If size_guide is present in the product data above, evaluate it first. It may be raw HTML, plain text, or structured data. Extract what you can — but do NOT blindly trust it. It may be incomplete, poorly formatted, or for a different product variant. Use it as a starting point and cross-check against web research.
2. **Web Verification**: Search for the brand's official size/fit chart for this exact product category and gender. If the scraped data conflicts with official brand data, prioritize the official source. If the scraped data is missing, garbled, or clearly wrong, ignore it and rely on web research.
3. Infer the primary target market(s) from the currency, URL TLD, and brand origin country. Produce conversions relevant to those markets.
4. Use the variant sizes as the primary column naming convention. Include all variant sizes plus logically adjacent standard sizes if typical for this category.
5. If the product is "One Size" or has only a single variant, output a single row with available measurements and note it in fit_notes.
6. Add body measurement columns (in cm) appropriate to the gender and product type:
   - Tops/Dresses: Bust/Chest, Waist
   - Bottoms: Waist, Hips, Inseam (and Rise if available)
   - Footwear: Foot Length (cm), plus US/UK/EU/AU conversions
   - Outerwear: Same as tops, possibly with Length
7. If you cannot find reliable data for a conversion column, use an empty string "" in that cell — do NOT remove the column from headers. All rows must have the exact same number of cells as headers.
8. If no official brand data exists, synthesize from 3+ high-authority sources for this category/gender and note the source count.

LIVE DISPLAY REQUIREMENTS:
- Use clean, scannable ranges (e.g., "78-82" not "78.5-82.3").
- fit_notes must be specific to this product type (not generic). Mention if it runs small/large, has stretch, or is cropped/oversized.
- how_to_measure must be 1-2 sentences telling the shopper exactly how to take the key measurement for this product.
- measurement_note should clarify if numbers are body measurements or garment measurements.

OUTPUT SCHEMA:
{
  "headers": ["<primary size system from variants>", "US", "UK", "EU", "AU", "<body measurements in cm>"],
  "rows": [["<val>", "<val>", ...], ...],
  "gender": "Women" | "Men" | "Kids" | "Unisex",
  "product_type": "e.g. Women's Tops / Men's Footwear - Sneakers",
  "research_summary": "Used official [Brand] chart" OR "No official data. Synthesized from [N] [category] sources.",
  "confidence": "high (official brand data)" | "medium (synthesized consensus)" | "low (limited direct mapping)",
  "fit_notes": "Specific to this product. E.g. Runs small in shoulders. Size up if between sizes. Stretch fabric allows some give.",
  "measurement_note": "E.g. Body measurements in cm. Allow 2-3cm ease. These are garment measurements, not body measurements.",
  "how_to_measure": "1-2 sentences instructing the shopper how to measure for this specific product.",
  "disclaimer": "Brief, honest disclaimer."
}

Return ONLY valid JSON. No markdown. No backticks. No text before or after the JSON object.\`;

  const fullPrompt = \`<system>
\${systemPrompt}
</system>

<user>
\${userPrompt}
</user>\`;

  navigator.clipboard.writeText(fullPrompt).then(() => {
    toast("PROMPT COPIED — Live customer-facing size guide ready");
  }).catch(() => toast("CLIPBOARD PERMISSION DENIED"));
}

async function pasteSizeGuideJson() {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return toast("CLIPBOARD EMPTY");

    let parsed;
    try {
      const clean = text.trim().replace(/^\`\`\`[a-z]*\\n?/i, '').replace(/\\n?\`\`\`$/,'').trim();
      parsed = JSON.parse(clean);
    } catch(e) {
      return toast("INVALID JSON — COULD NOT PARSE");
    }

    if (!Array.isArray(parsed.headers) || !Array.isArray(parsed.rows)) {
      return toast("INVALID FORMAT — NEED {headers:[...], rows:[[...]]}");
    }
    if (!parsed.headers.length) return toast("HEADERS ARRAY IS EMPTY");
    const colCount = parsed.headers.length;
    const validRows = parsed.rows.filter(r => Array.isArray(r) && r.length === colCount);
    if (validRows.length !== parsed.rows.length) {
      toast(\`WARNING: \${parsed.rows.length - validRows.length} ROW(S) HAD WRONG COLUMN COUNT AND WERE SKIPPED\`);
    }
    if (!validRows.length) return toast("NO VALID ROWS FOUND");

    // FIX: Preserve all AI-returned metadata, not just headers/rows
    state.currentSizeGuide = {
      headers: parsed.headers.map(h => String(h)),
      rows: validRows.map(r => r.map(c => String(c))),
      gender: parsed.gender || "",
      product_type: parsed.product_type || "",
      research_summary: parsed.research_summary || "",
      confidence: parsed.confidence || "",
      fit_notes: parsed.fit_notes || "",
      measurement_note: parsed.measurement_note || "",
      how_to_measure: parsed.how_to_measure || "",
      disclaimer: parsed.disclaimer || ""
    };

    renderSizeGuideTable();
    saveFormToLocalStorage();
    toast(\`SIZE GUIDE LOADED: \${parsed.headers.length} COLS, \${validRows.length} ROWS\`);
  } catch(err) {
    toast("CLIPBOARD PERMISSION DENIED");
  }
}


/* --- Saving --- */
async function saveSource(status = "completed") {
  syncVariantsFromDOM();
  syncSizeGuideFromDOM();

  const pIdx = state.editingPIdx;
  const sIdx = state.editingSIdx;
  const existing = state.current.response.products[pIdx].sources[sIdx];

  const priceVal = parseFloat(document.getElementById("ePrice").value);
  const compareVal = parseFloat(document.getElementById("eComparePrice").value);
  const oldPrice = existing.price || {};
  const newPrice = {
    ...oldPrice,
    current: isNaN(priceVal) ? null : priceVal,
    original: isNaN(compareVal) ? null : compareVal,
    currency: document.getElementById("eCurrency").value
  };

  const markupType = document.getElementById("eMarkupType").value;
  const markupFixed = parseFloat(document.getElementById("eMarkupFixed").value);
  const markupPct = parseFloat(document.getElementById("eMarkupPct").value);

  const oldVariants = existing.variants || [];
  const newVariants = state.currentVariants.map(v => {
    const found = oldVariants.find(ov => ov.size === v.size && ov.color === v.color) || {};
    return { ...found, size: v.size, color: v.color, availability: v.availability, inventory_quantity: v.inventory_quantity, price: v.price };
  });

  const payload = {
    ...existing,
    name: document.getElementById("eTitle").value,
    brand: document.getElementById("eBrand").value,
    vendor: document.getElementById("eVendor").value,
    color: document.getElementById("eColor").value,
    variant: document.getElementById("eVariant").value,
    material: document.getElementById("eMaterial").value,
    condition: document.getElementById("eCondition").value,
    url: document.getElementById("eUrl").value,
    primary_category: document.getElementById("eCategory").value,
    price: newPrice,
    compare_at_price: newPrice.original,
    is_on_sale: (newPrice.original != null && newPrice.current != null && newPrice.original > newPrice.current),
    currency: newPrice.currency,
    availability: document.getElementById("eAvail").value,
    description: document.getElementById("eDesc").value,
    features: document.getElementById("eFeatures").value.split("\\n").map(s => s.trim()).filter(Boolean),
    shipping_info: document.getElementById("eShippingInfo").value,
    return_policy: document.getElementById("eReturnPolicy").value,
    markup_type: markupType,
    markup_fixed: markupType === "fixed" ? (isNaN(markupFixed) ? null : markupFixed) : null,
    markup_percentage: markupType === "percentage" ? (isNaN(markupPct) ? null : markupPct) : null,
    variants: newVariants,
    size_guide: state.currentSizeGuide,
    selectedImages: [...state.currentSelected],
    reviewStatus: status
  };

  const saveBtn = document.querySelector('.modal-header .btn-primary');
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving...'; }
  try {
    const body = {
      docId: state.current._id,
      fileIdx: state.current.fileIdx,
      frameIdx: state.current.frameIdx,
      prodIdx: pIdx,
      sourceIdx: sIdx,
      source: payload
    };

    const r = await fetch("/api/product", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error("Save failed");

    // Only mutate in-memory state after confirmed server success
    state.current.response.products[pIdx].sources[sIdx] = payload;

    clearFormPersist(state.formPersistKey);
    state.justEditedSId = \`\${pIdx}-\${sIdx}\`;
    toast(status === "rejected" ? "REJECTED" : "SAVED");
    renderItem();
    closeEditor();
  } catch(e) {
    toast("ERROR: " + e.message);
  } finally {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
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
  // clearFormPersist(state.formPersistKey);
  showScreen("review");
  
  // Re-scroll back to source card context instantly upon pressing cancel
  if (state.editingPIdx !== null && state.editingSIdx !== null) {
    const scrollBack = () => {
      const targetCard = document.querySelector(\`.p-card[data-source-id="\${state.editingPIdx}-\${state.editingSIdx}"]\`);
      if (targetCard) {
        targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(scrollBack));
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
    const curId = state.current?._id, curFileIdx = state.current?.fileIdx, curFrameIdx = state.current?.frameIdx ?? null;
    const itemMatch = it => it._id === curId && it.fileIdx === curFileIdx && it.frameIdx === curFrameIdx;
    state.queue = state.queue.filter(it => !itemMatch(it));
    for (const pid in state.posts) {
      const post = state.posts[pid];
      post.items = post.items.filter(it => !itemMatch(it));
      if (post.items.length === 0) delete state.posts[pid];
    }
    state.current = null;
    showQueue();
    renderQueue();
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
    const curId = state.current?._id, curFileIdx = state.current?.fileIdx, curFrameIdx = state.current?.frameIdx ?? null;
    const itemMatch = it => it._id === curId && it.fileIdx === curFileIdx && it.frameIdx === curFrameIdx;
    state.queue = state.queue.filter(it => !itemMatch(it));
    for (const pid in state.posts) {
      const post = state.posts[pid];
      post.items = post.items.filter(it => !itemMatch(it));
      if (post.items.length === 0) delete state.posts[pid];
    }
    state.current = null;
    showQueue();
    renderQueue();
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
      else if (document.getElementById('review').classList.contains('active')) {
        // Preserve lastViewedItemId so renderQueue scrolls to it
        showQueue();
      }
    }
  });
}

/* --- Swipe Navigation on Hero --- */
function initSwipeNavigation() {
  const hero = document.querySelector('.hero');
  if (!hero) return;

  let startX = 0, startY = 0, startTime = 0;
  let didSwipe = false;
  const SWIPE_TIME = 500; // ms

  const getThreshold = () => Math.min(window.innerWidth * 0.3, 150); // 30vw, capped at 150px

  const onStart = (x, y) => { startX = x; startY = y; startTime = Date.now(); didSwipe = false; };
  const onEnd = (x, y) => {
    if (!startTime) return;
    const dx = x - startX, dy = y - startY, dt = Date.now() - startTime;
    startTime = 0;
    if (dt > SWIPE_TIME || Math.abs(dy) > Math.abs(dx) || Math.abs(dx) < getThreshold()) return;
    didSwipe = true;

    const idx = state.queue.findIndex(it =>
      it._id === state.current?._id &&
      it.fileIdx === state.current?.fileIdx &&
      (it.frameIdx === state.current?.frameIdx || (it.frameIdx === null && state.current?.frameIdx === null))
    );
    if (idx === -1) return;

    if (dx < 0 && idx + 1 < state.queue.length) {
      const n = state.queue[idx + 1];
      openItem(n._id, n.fileIdx, n.frameIdx);
    } else if (dx > 0 && idx > 0) {
      const p = state.queue[idx - 1];
      openItem(p._id, p.fileIdx, p.frameIdx);
    } else {
      toast(dx < 0 ? 'LAST ITEM IN QUEUE' : 'FIRST ITEM IN QUEUE');
    }
  };

  hero.addEventListener('touchstart', e => { if (e.touches.length === 1) onStart(e.touches[0].clientX, e.touches[0].clientY); }, { passive: true });
  hero.addEventListener('touchend', e => { onEnd(e.changedTouches[0].clientX, e.changedTouches[0].clientY); }, { passive: true });
  hero.addEventListener('mousedown', e => onStart(e.clientX, e.clientY));
  hero.addEventListener('mouseup', e => onEnd(e.clientX, e.clientY));
  hero.addEventListener('click', e => { if (didSwipe) { e.preventDefault(); e.stopPropagation(); didSwipe = false; } }, true);
}

loadQueue();
initKeyboard();
initSwipeNavigation();
</script>
</body>
</html>`;

/* -------------------------------------------------------------------------- */
/* MONGODB HELPERS                                                            */
/* -------------------------------------------------------------------------- */

function normalizeResponse(item) {
    let resp = item.response;
    let rawText = null;
    
    if (typeof resp === 'string') {
        try { resp = JSON.parse(resp); } catch { rawText = resp; resp = { products: [] }; }
    }
    if (!resp || typeof resp !== 'object') resp = { products: [] };
    if (!Array.isArray(resp.products)) resp.products = [];

    resp.products.forEach(p => {
        if (!Array.isArray(p.sources)) p.sources = [];
        p.sources.forEach(s => {
            s.reviewStatus = s.reviewStatus || 'pending';
            s.selectedImages = s.selectedImages || [];
            s.customImages = s.customImages || [];
            s.variants = s.variants || [];
            s.images = s.images || [];
            s.color = s.color || "";
            s.variant = s.variant || "";
            s.material = s.material || "";
            s.condition = s.condition || "";
            s.markup_type = s.markup_type || "percentage";
            s.markup_fixed = s.markup_fixed != null ? s.markup_fixed : null;
            s.markup_percentage = s.markup_percentage != null ? s.markup_percentage : null;

            // Robust price normalization to handle raw python extractor numbers
            if (typeof s.price === 'number' || typeof s.price === 'string') {
                s.price = {
                    current: s.price,
                    original: s.compare_at_price || null,
                    currency: s.currency || 'USD'
                };
            } else if (!s.price || typeof s.price !== 'object') {
                s.price = { current: '', original: s.compare_at_price || null, currency: s.currency || 'USD' };
            }
            if (s.price.original != null && s.compare_at_price == null) {
                s.compare_at_price = s.price.original;
            }
        });
    });

    if (rawText) resp.rawText = rawText;
    return resp;
}

function dedupeSourcesAcrossProducts(resp) {
    if (!resp || !Array.isArray(resp.products)) return resp;
    const seen = new Map();
    resp.products.forEach(p => {
        if (!Array.isArray(p.sources)) return;
        const keep = [];
        p.sources.forEach(s => {
            const url = String(s.url || '').toLowerCase().trim();
            if (!url || url === 'null') { keep.push(s); return; }
            if (seen.has(url)) {
                const { score: bScore, idx } = seen.get(url);
                const sScore = s.reviewStatus === 'completed' ? 3 : s.reviewStatus === 'rejected' ? 2 : 1;
                if (sScore > bScore) {
                    keep[idx] = s;
                    seen.set(url, { score: sScore, idx });
                }
            } else {
                seen.set(url, { score: s.reviewStatus === 'completed' ? 3 : s.reviewStatus === 'rejected' ? 2 : 1, idx: keep.length });
                keep.push(s);
            }
        });
        p.sources = keep;
    });
    return resp;
}

function getItemStatus(item) {
    const resp = dedupeSourcesAcrossProducts(normalizeResponse(item));
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
        if (f.type === 'image') return !f.humanReviewed;
        if (f.type === 'video' && Array.isArray(f.frames)) return f.frames.some(fr => !fr.discarded && !fr.humanReviewed);
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
                            setObj[`${pth}.color`] = updatedSource.color;
                            setObj[`${pth}.variant`] = updatedSource.variant;
                            setObj[`${pth}.material`] = updatedSource.material;
                            setObj[`${pth}.condition`] = updatedSource.condition;
                            setObj[`${pth}.markup_type`] = updatedSource.markup_type;
                            setObj[`${pth}.markup_fixed`] = updatedSource.markup_fixed;
                            setObj[`${pth}.markup_percentage`] = updatedSource.markup_percentage;

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
    log('info', '  REVIEW SERVER — Production Human Review v2.2.0 (New Schema)');
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
                const resHeaders = { 'Cache-Control': 'public, max-age=86400' };
                fRes.headers.forEach((v, k) => { 
                  const lk = k.toLowerCase();
                  if (lk !== 'content-encoding' && lk !== 'cache-control') resHeaders[k] = v; 
                });
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

                const response = dedupeSourcesAcrossProducts(normalizeResponse(item));
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
                            [`${basePath}.color`]: source.color,
                            [`${basePath}.variant`]: source.variant,
                            [`${basePath}.material`]: source.material,
                            [`${basePath}.condition`]: source.condition,
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
                            [`${basePath}.markup_type`]: source.markup_type,
                            [`${basePath}.markup_fixed`]: source.markup_fixed,
                            [`${basePath}.markup_percentage`]: source.markup_percentage,
                            [`${basePath}.images`]: source.images,
                            [`${basePath}.selectedImages`]: source.selectedImages,
                            [`${basePath}.customImages`]: source.customImages,
                            [`${basePath}.reviewStatus`]: source.reviewStatus,
                            [`${basePath}.reviewedAt`]: new Date()
                        }}
                    );

                    // Deduplicate sources by URL within the same product in DB
                    const post = await collection.findOne({ _id: new ObjectId(docId) });
                    const targetPath = frameIdx !== null
                        ? `file_urls.${fileIdx}.frames.${frameIdx}.response.products.${prodIdx}`
                        : `file_urls.${fileIdx}.response.products.${prodIdx}`;
                    const product = frameIdx !== null
                        ? post.file_urls[fileIdx].frames[frameIdx].response.products[prodIdx]
                        : post.file_urls[fileIdx].response.products[prodIdx];
                    
                    if (product && Array.isArray(product.sources)) {
                        const seen = new Map();
                        const deduped = [];
                        product.sources.forEach(s => {
                            const url = String(s.url || '').toLowerCase().trim();
                            if (!url || url === 'null') { deduped.push(s); return; }
                            if (seen.has(url)) {
                                const { score: bScore, idx } = seen.get(url);
                                const sScore = s.reviewStatus === 'completed' ? 3 : s.reviewStatus === 'rejected' ? 2 : 1;
                                if (sScore > bScore) {
                                    deduped[idx] = s;
                                    seen.set(url, { score: sScore, idx });
                                }
                            } else {
                                seen.set(url, { score: s.reviewStatus === 'completed' ? 3 : s.reviewStatus === 'rejected' ? 2 : 1, idx: deduped.length });
                                deduped.push(s);
                            }
                        });
                        await collection.updateOne(
                            { _id: new ObjectId(docId) },
                            { $set: { [`${targetPath}.sources`]: deduped } }
                        );
                    }

                    // Propagate ALL review statuses to matching URLs across items
                    if (source.url) {
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
