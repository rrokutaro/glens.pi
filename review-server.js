/**
 * review-server.js
 *
 * Production human review server for the UGC dropship pipeline.
 * UI Refactored for High-Fashion, Brutalist Native Apple Aesthetic.
 * Editorial typography contrast, edge-to-edge alignment, absolute minimal Chrome.
 *
 * Env: ORCH_MONGODB_URI, ORCH_MONGODB_DB, ORCH_MONGODB_COLLECTION
 *      REVIEW_PORT (default 3456), ORCH_HF_TOKEN
 *
 * FINAL PRODUCTION v2.4.0 (Design Edit) - Mobile Table overflow, Collapsible sections,
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
/* HTML UI (Editorial Minimalist / Apple Brutalist Polish)                    */
/* -------------------------------------------------------------------------- */
const REVIEW_UI_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#ffffff" id="metaThemeColor">
<title>DropShip Review • v2.4</title>
<style>
/* Brutalist / Apple Native Foundations */
*,*::before,*::after {box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;}

:root {
  --bg: #FFFFFF;
  --surface: #FFFFFF;
  --surface-2: #F2F2F2;
  --border: #E0E0E0;
  --text: #050505;
  --text-2: #858585;
  --focus: #050505;
  --danger: #E3342F;
  --success: #000000;
  --warning: #000000;
  
  --font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Helvetica, Arial, sans-serif;
  --font-serif: "Apple Garamond", "Baskerville", "Times New Roman", "Playfair Display", "Georgia", serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, Monaco, Consolas, "Courier New", monospace;
}

:root[data-theme="dark"] {
  --bg: #000000;
  --surface: #000000;
  --surface-2: #161616;
  --border: #2A2A2A;
  --text: #F0F0F0;
  --text-2: #7A7A7A;
  --focus: #FFFFFF;
  --danger: #FF443A;
  --success: #FFFFFF;
  --warning: #FFFFFF;
}

body {
  font-family: var(--font-sans);
  background: var(--bg);
  color: var(--text);
  line-height: 1.4;
  min-height: 100dvh;
  overflow-x: hidden;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

/* Typography Editorial Contrast */
.serif-headline {
  font-family: var(--font-serif);
  font-weight: normal;
  letter-spacing: -0.015em;
}
.mono-util {
  font-family: var(--font-mono);
  text-transform: uppercase;
  font-size: 10px;
  letter-spacing: 0.05em;
  font-weight: 500;
}
h1 { font-size: 28px; line-height: 1; }
h2 { font-size: 20px; line-height: 1; padding: 24px 20px 16px; margin: 0; background: var(--bg); border-bottom: 1px solid var(--border);}
.p-title, .modal-header h2 { font-size: 24px; line-height: 1.1; margin-bottom: 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* Structural Navigation */
.topbar {
  position: sticky; top: 0; z-index: 50;
  background: var(--bg);
  border-bottom: 1px solid var(--border);
  padding: 16px 20px;
  padding-top: max(16px, env(safe-area-inset-top));
  display: flex; align-items: baseline; gap: 16px;
  backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); background: rgba(var(--bg-rgb), 0.85); /* fallback */
}
/* For frosted effect fix if --bg holds variables, falling back to opaqueness handled neatly by UI */
@supports (-webkit-backdrop-filter: blur(20px)) {
    :root { --bg-rgb: 255,255,255; }
    :root[data-theme="dark"] { --bg-rgb: 0,0,0; }
    .topbar, .modal-header { background: rgba(var(--bg-rgb), 0.85) !important; backdrop-filter: saturate(180%) blur(20px); }
}

.topbar h1 { flex: 1; margin: 0; text-align: left; }
.top-action { border: none; font-family: var(--font-mono); font-size: 11px; padding: 0; min-height: 0; text-transform: uppercase; background: none; letter-spacing: 0.02em; }

/* Interactive Badges & Indicators */
.badge {
  display: inline-flex; align-items: center; justify-content: center;
  font-family: var(--font-mono); font-size: 9px; text-transform: uppercase; font-weight: bold; letter-spacing: 0.05em;
  padding: 3px 8px; border-radius: 4px;
  border: 1px solid var(--text); color: var(--bg); background: var(--text);
  line-height: 1.2; vertical-align: middle;
}
.badge.pending, .badge.src-status { color: var(--text); background: var(--bg); border-color: var(--text-2); opacity: 0.75; }
.badge.partial { background: var(--bg); color: var(--text); border: 1px dashed var(--text); }
.badge.warning { background: var(--warning); color: var(--bg); border: none; }
.p-status .badge { margin-top: 6px; }

/* Standard Forms & Buttons Edge-to-Edge Vibe */
button {
  cursor: pointer; border: 1px solid var(--text); border-radius: 4px;
  padding: 12px 20px; font-size: 11px; font-family: var(--font-sans);
  background: var(--bg); color: var(--text); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em;
  transition: opacity 0.1s, transform 0.1s, background-color 0.15s; min-height: 48px;
}
button:active { opacity: 0.6; }
button:disabled { opacity: 0.2 !important; cursor: not-allowed; border-color: var(--text-2); }

.btn-primary { background: var(--text); color: var(--bg); border-color: var(--text); }
.btn-danger { color: var(--danger); border-color: transparent; background: transparent;} /* minimal native danger look */
.btn-ghost { border: none; background: transparent; padding: 0; min-height: 0; display: inline; text-transform: uppercase; letter-spacing: 0.05em;}

input, select, textarea {
  background: transparent; color: var(--text); font-family: var(--font-sans); font-size: 16px;
  padding: 12px 0px; margin-bottom: 0px; width: 100%; border: none;
  border-bottom: 1px solid var(--border); border-radius: 0;
  -webkit-appearance: none; outline: none;
  transition: border-color 0.2s;
}
input::placeholder, textarea::placeholder { color: var(--text-2); font-weight: 300;}
input:focus, select:focus, textarea:focus { border-color: var(--text); border-bottom-width: 2px; margin-bottom: -1px; }
textarea { resize: vertical; min-height: 80px; padding: 12px 0; }
select {
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%237A7A7A' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right 0px center; padding-right: 28px;
}

/* Fields & Labels Editorial Approach */
.field { margin-bottom: 24px; position: relative;}
.field label { 
  display: block; font-family: var(--font-mono); font-size: 9px; letter-spacing: 0.05em; 
  text-transform: uppercase; font-weight: bold; color: var(--text-2); margin-bottom: 2px;
}
.field-row { display: flex; gap: 20px; }
.field-row .field { flex: 1; }
.info-plate { 
  font-family: var(--font-mono); font-size: 10px; border-left: 2px solid var(--border); padding-left: 12px; margin: 8px 0 24px;
  color: var(--text-2); letter-spacing: -0.01em; line-height: 1.4; text-transform: none;
}

/* Brutalist Clean Tables */
.simple-table-wrapper { width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch; padding-bottom: 8px; margin-top: 16px; border-top: 1px solid var(--text); }
.simple-table { min-width: 600px; width: 100%; border-collapse: collapse; font-family: var(--font-sans); }
.simple-table th { font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.05em; font-size: 9px; color: var(--text-2); padding: 12px 0px; text-align: left; border-bottom: 1px solid var(--border); }
.simple-table td { padding: 8px 12px 8px 0; border-bottom: 1px solid var(--border); vertical-align: top;}
.simple-table input, .simple-table select { font-size: 14px; padding: 8px 0; border-bottom: none; height: 100%; background: transparent; }
.simple-table input:focus { border:none; margin: 0; box-shadow: inset 0 -2px 0 var(--text); }
.table-btn { width: 36px; height: 36px; padding: 0; display: inline-flex; align-items: center; justify-content: center; font-size: 16px; min-height:0; color: var(--text-2); border: 1px solid var(--border); border-radius:4px; }
.table-btn:active { background: var(--text); color: var(--bg); border-color: var(--text);}

/* Index Queues / List View Edge to Edge Layout */
.screen { display: none; min-height: 100dvh; padding-bottom: calc(90px + env(safe-area-inset-bottom)); }
.screen.active { display: block; }
.empty { padding: 40px 20px; text-align: center; color: var(--text-2); font-size: 12px; letter-spacing: 0.02em; text-transform: uppercase; font-family: var(--font-mono); }

.post-group { margin: 0; background: var(--bg); border-bottom: 1px solid var(--border); transition: background-color 0.15s ease; }
.post-header {
  display: flex; align-items: center; gap: 16px; padding: 24px 20px; cursor: pointer; user-select: none;
}
.post-header:active { background: var(--surface-2); }
.post-thumb { width: 64px; height: 80px; background: var(--surface-2); border-radius: 4px; border: 1px solid rgba(127,127,127,0.1); overflow: hidden; flex-shrink: 0; }
.post-thumb img { width: 100%; height: 100%; object-fit: cover; opacity: 1; transition: opacity 0.3s; background: #E8E8E8; }
.post-info { flex: 1; min-width: 0; }
.post-id { line-height: 1.1; margin-bottom: 6px; }
.post-meta { display: flex; flex-direction: column; gap: 2px; font-family: var(--font-mono); font-size: 10px; color: var(--text-2); text-transform: uppercase;}
.post-chevron { width: 24px; height: 24px; color: var(--text-2); transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1); }
.post-group.open .post-chevron { transform: rotate(180deg); }

.post-items { display: none; border-top: 1px dashed var(--border); background: var(--surface-2); padding-bottom: 8px;}
.post-group.open .post-items { display: block; }

.item-row {
  display: flex; align-items: center; gap: 16px;
  padding: 16px 20px; border-bottom: 1px solid var(--border); cursor: pointer;
  background: transparent;
}
.item-row:last-child { border-bottom: none; }
.item-row:active { opacity: 0.6; }
.item-thumb { width: 44px; height: 56px; border-radius: 2px; overflow: hidden; border: 1px solid rgba(127,127,127,0.2); flex-shrink: 0; background: var(--bg);}
.item-thumb img { width: 100%; height: 100%; object-fit: cover; background: #fff;}
.item-info { flex: 1; min-width: 0; }
.item-type { font-family: var(--font-sans); font-weight: bold; font-size: 14px; margin-bottom: 2px;}

/* Source / Detail Pages */
.hero { width: 100%; background: var(--surface-2); position: relative; border-bottom: 1px solid var(--text); }
.hero img { width: 100%; height: 60vh; object-fit: cover; cursor: crosshair; transition: object-fit 0.2s; background: transparent; display: block; }
.hero-meta { padding: 12px 20px; display: flex; gap: 12px; background: var(--bg); justify-content: flex-start; align-items: center;}

.section { padding: 0; padding-bottom: calc(100px + env(safe-area-inset-bottom)); background: var(--bg); }
.product-group-title {
  font-family: var(--font-serif); font-size: 20px; padding: 40px 20px 8px; margin:0; border-bottom: 1px solid var(--text); line-height: 1.1; font-weight: normal; 
}
.p-card {
  padding: 24px 20px; display: flex; gap: 24px; cursor: pointer; align-items: flex-start;
  border-bottom: 1px solid var(--border); background: var(--bg);
  transition: background-color 0.15s, opacity 0.2s;
}
.p-card:active { background: var(--surface-2); }
.p-card.rejected { opacity: 0.35; filter: grayscale(100%); }
.p-img { width: 88px; height: 118px; border-radius: 4px; border: 1px solid rgba(127,127,127,0.15); overflow: hidden; background: var(--surface-2); flex-shrink: 0; position: relative;}
.p-img img { width: 100%; height: 100%; object-fit: cover; }
.p-img .no-img { display: flex; align-items: center; justify-content: center; height: 100%; width: 100%; font-family: var(--font-mono); font-size: 9px; text-transform: uppercase; color: var(--text-2); letter-spacing: 0.05em; }
.p-info { flex: 1; min-width: 0; padding-top: 4px;}
.p-brand { font-family: var(--font-mono); font-size: 10px; color: var(--text-2); text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 12px; display:block; line-height: 1.5; }

/* Sticky Modal (Bottom Up/Full Page native vibe) */
.modal { position: fixed; inset: 0; z-index: 100; background: var(--bg); display: none; flex-direction: column; animation: slideUp 0.3s cubic-bezier(0.16, 1, 0.3, 1) forwards; }
@keyframes slideUp { from{ transform:translateY(20%); opacity: 0; } to{ transform:translateY(0); opacity:1;} }
.modal.active { display: flex; }
.modal-header { padding: 16px 20px; padding-top: max(16px, env(safe-area-inset-top)); border-bottom: 1px solid var(--text); display: flex; align-items: center; gap: 16px; background: var(--bg); justify-content: space-between; flex-shrink: 0; }
.modal-header h2 { font-size: 20px; margin: 0; flex: 1; text-align: center; border: none; padding: 0;}
.modal-body { flex: 1; overflow-y: auto; padding: 0; padding-bottom: calc(140px + env(safe-area-inset-bottom)); -webkit-overflow-scrolling: touch; }

/* Minimalist Editorial Detail Content Containers */
.card { padding: 32px 20px; border-bottom: 1px solid var(--border); background: var(--bg); }
.card > h3 { font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; color: var(--text); letter-spacing: 0.08em; border-bottom: 1px solid var(--border); padding-bottom: 16px; margin-bottom: 24px; font-weight: normal; }

details.card { padding: 0; }
details.card > summary { padding: 32px 20px; font-family: var(--font-mono); font-size: 11px; color: var(--text); text-transform: uppercase; letter-spacing: 0.08em; font-weight: normal; cursor: pointer; list-style: none; display: flex; justify-content: space-between; align-items: center; }
details.card > summary::after { content: '+'; font-size: 18px; font-family: var(--font-sans); }
details[open].card > summary { border-bottom: 1px dashed var(--border); }
details[open].card > summary::after { content: '−'; }
details.card > .details-content { padding: 24px 20px; }

/* iOS/Mac fluid snapping horizontal image scroll */
.carousel { 
  display: flex; overflow-x: auto; gap: 12px; padding-bottom: 8px; margin-bottom: 20px;
  scroll-snap-type: x mandatory; -webkit-overflow-scrolling: touch; scrollbar-width: none;
}
.carousel::-webkit-scrollbar { display: none; }
.img-cell { 
  flex: 0 0 75%; aspect-ratio: 3/4; scroll-snap-align: center; position: relative; cursor: pointer; 
  border-radius: 4px; overflow: hidden; background: var(--surface-2); 
  border: 1px solid rgba(127,127,127,0.15); transition: opacity 0.15s, transform 0.15s; 
}
.img-cell img { width: 100%; height: 100%; object-fit: cover; opacity: 0.6; filter: grayscale(50%); transition: opacity 0.2s, filter 0.2s; display: block;}
.img-cell.on { border-color: var(--text); opacity: 1; }
.img-cell.on img { opacity: 1; filter: none; }
.img-cell .check { position: absolute; top: 12px; right: 12px; font-family: var(--font-mono); font-size: 11px; color: var(--bg); background: var(--text); padding: 4px 8px; border-radius: 4px; font-weight:bold; opacity: 0; transform: scale(0.9); transition: all 0.2s; }
.img-cell.on .check { opacity: 1; transform: scale(1); }
@keyframes pulse { 0% { opacity: 1;} 50% {opacity:0.3; filter: grayscale(100%);} 100% {opacity:1;} }
.extracting { animation: pulse 1.5s infinite; pointer-events: none; }

/* Brutalist Absolute Flush Actions Bars */
.actions-bar {
  position: fixed; bottom: 0; left: 0; right: 0; display: flex; z-index: 150;
  border-top: 1px solid var(--text); background: var(--bg);
  padding-bottom: env(safe-area-inset-bottom); align-items: stretch; height: calc(64px + env(safe-area-inset-bottom));
}
.actions-bar button { flex: 1; border: none !important; border-radius: 0; border-right: 1px solid var(--text) !important; background: transparent; height: 100%; color: var(--text); min-height:0; }
.actions-bar button:last-child { border-right: none !important; background: var(--text); color: var(--bg); }
.actions-bar .btn-danger { color: var(--danger); font-weight: normal; font-family: var(--font-mono); text-transform: uppercase; font-size: 12px;}

/* Video Player Extreme Minimal Overlay */
#videoModal { background: #000; cursor: pointer; transition: opacity 0.3s ease; display:none; }
#videoModal.active { display:block; opacity:1;}
#vPlayer { width: 100%; height: 100%; object-fit: contain; }

/* High-contrast Toasts */
.toast {
  position: fixed; top: calc(24px + env(safe-area-inset-top)); left: 50%; transform: translate(-50%, -150px);
  background: var(--text); color: var(--bg); padding: 12px 24px; border-radius: 100px;
  font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; font-weight: bold; letter-spacing: 0.05em;
  z-index: 300; transition: transform 0.4s cubic-bezier(0.16, 1, 0.3, 1); box-shadow: 0 20px 40px rgba(0,0,0,0.15); white-space: nowrap; border: 1px solid rgba(127,127,127,0.3);
}
.toast.show { transform: translate(-50%, 0); }
[data-theme="dark"] .toast { box-shadow: 0 10px 40px rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.1); }

/* Loader aesthetic spin */
.loading {display:flex; flex-direction:column; align-items:center; justify-content:center; height:100dvh;}
.spinner {width:24px; height:24px; border:2px solid var(--border); border-top-color:var(--text); border-radius:50%; animation: spin 0.6s cubic-bezier(.5, .1, .4, .9) infinite; }
@keyframes spin {to{transform:rotate(360deg)}}
</style>
</head>
<body>
<div id="app">
  <div id="loading" class="screen active">
    <div class="loading">
      <div class="spinner" style="margin-bottom:16px;"></div>
      <p class="mono-util" style="color:var(--text); margin:0;">Preparing Architecture</p>
    </div>
  </div>
  
  <!-- QUEUE SCREEN -->
  <div id="queue" class="screen">
    <div class="topbar">
      <h1 class="serif-headline">Index</h1>
      <span class="mono-util" style="color:var(--text-2);">Queue <span id="qCount">0</span></span>
      <button class="top-action" style="margin-left:8px;" onclick="toggleTheme()">Invert</button>
      <button class="top-action" onclick="loadQueue()" style="color:var(--text); text-decoration:underline; text-underline-offset:4px;">Sync</button>
    </div>
    <div id="qList"></div>
  </div>

  <!-- REVIEW SCREEN -->
  <div id="review" class="screen">
    <div class="topbar">
      <button class="top-action" onclick="showQueue()" style="color:var(--text); text-decoration:underline; text-underline-offset:4px;">← Back</button>
      <h1 id="rTitle" class="serif-headline" style="text-align:center; font-size:20px; font-weight:normal; margin-bottom: 2px;">Asset</h1>
      <div id="rTopRight" style="min-width:60px; text-align:right;"></div>
    </div>
    <div class="hero">
      <img id="rImage" src="" alt="" loading="lazy" onclick="this.style.objectFit = this.style.objectFit === 'contain' ? 'cover' : 'contain'">
    </div>
    <div class="hero-meta" id="rMeta"></div>
    <div class="section">
      <div id="pList"></div>
    </div>
    <div class="actions-bar">
      <button class="btn-danger mono-util" onclick="deleteItem()" style="background:var(--bg); border-right:1px solid var(--border)!important;">Discard</button>
      <button class="btn-primary mono-util" id="btnCommitItem" onclick="commitItem()" style="letter-spacing:0.1em; background:var(--text); color:var(--bg);">Commit Review</button>
    </div>
  </div>

  <!-- SOURCE MODAL (Editor) -->
  <div id="editor" class="modal">
    <div class="modal-header">
      <button class="top-action" onclick="closeEditor()" style="width: 50px; text-align:left; border: none!important; min-height:auto!important; margin-left: 0;">Cancel</button>
      <h2 id="eModalTitle" class="serif-headline">Parameters</h2>
      <button class="top-action" onclick="saveSource('completed')" style="width: 50px; text-align:right; font-weight:bold; border:none!important; min-height:auto!important; margin-right: 0;">Done</button>
    </div>
    <div class="modal-body" id="eBody"></div>
  </div>
  
  <!-- Media Fullscreen Vibe Player -->
  <div id="videoModal" class="modal" style="background:#000;" onclick="if(event.target === this) closeVideo()">
    <div style="position:absolute; top:max(16px, env(safe-area-inset-top)); right:16px; z-index:210;">
      <button class="mono-util" onclick="closeVideo()" style="background:none; color:#fff; border:1px solid rgba(255,255,255,0.2); height:auto; display:flex; align-items:center; justify-content:center; padding: 6px 12px; border-radius:100px; min-height: 0;">Close</button>
    </div>
    <div style="flex:1; display:flex; align-items:center; justify-content:center; height:100dvh; pointer-events:none;">
      <video id="vPlayer" controls playsinline style="max-width:100%; max-height:100%; outline:none; pointer-events:auto; border-radius:6px; background:#050505;"></video>
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

// Vibe Invert
function toggleTheme() {
  const root = document.documentElement;
  const current = root.getAttribute('data-theme');
  const newTheme = current === 'dark' ? 'light' : 'dark';
  root.setAttribute('data-theme', newTheme);
  document.getElementById('metaThemeColor').setAttribute('content', newTheme === 'dark' ? '#000000' : '#FFFFFF');
  localStorage.setItem('theme', newTheme);
}
if (localStorage.getItem('theme') === 'dark' || (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
  document.documentElement.setAttribute('data-theme', 'dark');
  document.getElementById('metaThemeColor')?.setAttribute('content', '#000000');
}

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
  let num = ''; let curr = fallbackCurrency || '';
  if (typeof p === "number" || typeof p === "string") { num = getSafeNumber(p); } 
  else if (typeof p === "object" && p !== null) { num = getSafeNumber(p.current); if (p.currency) curr = p.currency; }
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
        const img = entry.target; const src = img.dataset.src;
        if (src) { img.src = src; img.removeAttribute("data-src"); }
        state.io.unobserve(img);
      }
    });
  }, { rootMargin: "300px" });
}
function observeImage(img) { if (state.io) state.io.observe(img); }

/* Loc Store Sync */
function getFormPersistKey() {
  if (!state.current || state.editingPIdx === null || state.editingSIdx === null) return null;
  const fid = state.current.frameIdx !== null ? \`f\${state.current.frameIdx}\` : \`img\${state.current.fileIdx}\`;
  return \`rv_2.4_\${state.current._id}_\${fid}_p\${state.editingPIdx}_s\${state.editingSIdx}\`;
}
function saveFormToLocalStorage() {
  const key = state.formPersistKey; if (!key) return;
  syncVariantsFromDOM(); syncSizeGuideFromDOM();
  try {
    const data = {
      name: document.getElementById("eTitle")?.value || "", brand: document.getElementById("eBrand")?.value || "", vendor: document.getElementById("eVendor")?.value || "", color: document.getElementById("eColor")?.value || "",
      variant: document.getElementById("eVariant")?.value || "", material: document.getElementById("eMaterial")?.value || "", condition: document.getElementById("eCondition")?.value || "", url: document.getElementById("eUrl")?.value || "",
      category: document.getElementById("eCategory")?.value || "", price: document.getElementById("ePrice")?.value || "", comparePrice: document.getElementById("eComparePrice")?.value || "", currency: document.getElementById("eCurrency")?.value || "",
      availability: document.getElementById("eAvail")?.value || "", desc: document.getElementById("eDesc")?.value || "", features: document.getElementById("eFeatures")?.value || "", shipping: document.getElementById("eShippingInfo")?.value || "",
      returns: document.getElementById("eReturnPolicy")?.value || "", markupType: document.getElementById("eMarkupType")?.value || "percentage", markupFixed: document.getElementById("eMarkupFixed")?.value || "", markupPct: document.getElementById("eMarkupPct")?.value || "",
      variants: state.currentVariants, sizeGuide: state.currentSizeGuide, selectedImages: state.currentSelected
    };
    localStorage.setItem(key, JSON.stringify(data));
  } catch(e) {}
}
function restoreFormFromLocalStorage() {
  const key = state.formPersistKey; if (!key) return false;
  try {
    const raw = localStorage.getItem(key); if (!raw) return false;
    const d = JSON.parse(raw); const sv = (id, v) => { const e = document.getElementById(id); if(e && v != null) e.value = v; };
    sv("eTitle", d.name); sv("eBrand", d.brand); sv("eVendor", d.vendor); sv("eColor", d.color); sv("eVariant", d.variant); sv("eMaterial", d.material); sv("eCondition", d.condition);
    sv("eUrl", d.url); sv("eCategory", d.category); sv("ePrice", d.price); sv("eComparePrice", d.comparePrice); sv("eCurrency", d.currency); sv("eAvail", d.availability);
    sv("eDesc", d.desc); sv("eFeatures", d.features); sv("eShippingInfo", d.shipping); sv("eReturnPolicy", d.returns); sv("eMarkupType", d.markupType); sv("eMarkupFixed", d.markupFixed); sv("eMarkupPct", d.markupPct);
    if (d.variants && Array.isArray(d.variants)) { state.currentVariants = d.variants; renderVariantsTable(); }
    if (d.sizeGuide && d.sizeGuide.headers) { state.currentSizeGuide = d.sizeGuide; renderSizeGuideTable(); }
    if (d.selectedImages && Array.isArray(d.selectedImages)) { state.currentSelected = d.selectedImages; renderImgGrid(state.currentGridUrls); updateSelCount(); }
    return true;
  } catch(e) { return false; }
}
function clearFormPersist(key) { if (key) localStorage.removeItem(key); }

/* --- Fetch and Render Pipeline --- */
async function loadQueue() {
  document.getElementById("loading").classList.add("active");
  try {
    const r = await fetch("/api/queue");
    const d = await r.json();
    state.posts = d.posts || {};
    state.queue = d.items || [];
  } catch(e) {
    state.posts = {}; state.queue = []; toast("SYNC ERR: " + e.message);
  }
  document.getElementById("loading").classList.remove("active");
  showScreen("queue"); initLazyImages(); renderQueue();
}

function renderQueue() {
  const list = document.getElementById("qList");
  const postIds = Object.keys(state.posts);
  if (!postIds.length) {
    list.innerHTML = '<div class="empty" style="padding-top:35dvh;">All Tasks Complete<br><span style="text-transform:none; font-family:var(--font-sans); color:var(--text-2); font-weight:normal; letter-spacing:0; margin-top:8px; display:inline-block;">Archive sync finished cleanly.</span></div>';
    document.getElementById("qCount").textContent = "0"; return;
  }
  
  let totalItems = 0;
  list.innerHTML = postIds.map(pid => {
    const post = state.posts[pid];
    const items = post.items || []; totalItems += items.length;
    const pending = items.filter(it => it.status === "pending" || it.status === "partial").length;
    const thumb = items[0] ? items[0].thumb : "";
    
    return \`
      <div class="post-group" id="g_\${pid}" onclick="toggleGroup(event, '\${pid}')">
        <div class="post-header">
          <div class="post-thumb"><img data-src="\${escapeHtml(thumb)}" alt="" class="lazy-img" loading="lazy" onerror="this.style.display='none'"></div>
          <div class="post-info">
            <div class="post-id serif-headline" style="font-size:22px;">\${escapeHtml(pid)}</div>
            <div class="post-meta">\${items.length} Frame\${items.length !== 1 ? 's' : ''} &nbsp;|&nbsp; \${pending} Action\${pending !== 1 ? 's' : ''} Reqd.</div>
          </div>
          <svg class="post-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 9l6 6 6-6"/></svg>
        </div>
        <div class="post-items" onclick="event.stopPropagation()">
          \${items.map(it => \`
            <div class="item-row" data-item-id="\${it._id}-\${it.fileIdx}-\${it.frameIdx !== null ? it.frameIdx : 'img'}" onclick="openItem('\${it._id}', \${it.fileIdx}, \${it.frameIdx !== null ? it.frameIdx : null})">
              <div class="item-thumb"><img data-src="\${escapeHtml(it.thumb)}" alt="" class="lazy-img" loading="lazy" onerror="this.style.display='none'"></div>
              <div class="item-info">
                <div class="item-type">\${it.type === "frame" ? "Snapshot" : "Capture"} #\${it.frameIdx !== null ? it.frameIdx : it.fileIdx}</div>
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
    const rf = () => { const tr = document.querySelector(\`.item-row[data-item-id="\${state.lastViewedItemId}"]\`); if (tr) tr.scrollIntoView({ behavior:'smooth', block:'center' }); state.lastViewedItemId = null; };
    requestAnimationFrame(() => requestAnimationFrame(rf));
  }
}

function toggleGroup(ev, pid) { if (ev.target.closest(".item-row")) return; document.getElementById("g_" + pid).classList.toggle("open"); }

async function openItem(_id, fileIdx, frameIdx) {
  try {
    let url = \`/api/item/\${_id}/\${fileIdx}\`; if (frameIdx !== null) url += \`/\${frameIdx}\`;
    const r = await fetch(url); if (!r.ok) throw new Error("Load Fail");
    state.current = await r.json(); state.lastViewedItemId = \`\${_id}-\${fileIdx}-\${frameIdx !== null ? frameIdx : 'img'}\`;
  } catch(e) { toast(e.message); return; }
  renderItem(); showScreen("review"); window.scrollTo(0,0);
}

function renderItem() {
  const item = state.current;
  let igLink = 'https://www.instagram.com/' + item.postId + '/';
  if (!item.postId.startsWith('p/') && !item.postId.startsWith('reel/')) igLink = 'https://www.instagram.com/p/' + item.postId + '/';
  
  document.getElementById("rTitle").innerHTML = \`<a href="\${escapeHtml(igLink)}" target="_blank" style="color:var(--text); text-decoration:none;">\${escapeHtml(item.postId)}</a>\`;
  const rTopRight = document.getElementById("rTopRight"); rTopRight.innerHTML = '';
  
  if (item.type === 'frame' && item.parentUrl) {
    const watchBtn = document.createElement('button'); watchBtn.className = 'top-action mono-util'; 
    watchBtn.setAttribute('style', 'color:var(--text); text-decoration:underline; text-underline-offset: 4px; padding: 0;'); 
    watchBtn.textContent = 'Playback'; watchBtn.onclick = () => openVideo("/api/video?url=" + encodeURIComponent(item.parentUrl)); rTopRight.appendChild(watchBtn);
  }
  
  document.getElementById("rImage").src = item.url;
  const prods = item.response?.products || []; let totalSources = 0; let pendingSources = 0; let listHtml = "";

  if (!prods.length) {
    listHtml = '<div class="empty">Directory contains 0 products.</div>';
  } else {
    prods.forEach((p, pIdx) => {
      listHtml += \`<h2 class="serif-headline">\${escapeHtml(p.title || 'Artifact Unnamed')}</h2>\`;
      const sources = p.sources || []; totalSources += sources.length;
      if (!sources.length) listHtml += '<div class="empty" style="padding:20px;">Orphan Product. No Suppliers Found.</div>';
      else {
        sources.forEach((s, sIdx) => {
          if (s.reviewStatus !== "completed" && s.reviewStatus !== "rejected") pendingSources++;
          let rejectedClass = s.reviewStatus === "rejected" ? "rejected" : "";
          let btxt = "";
          if (s.reviewStatus === "rejected") btxt = '<span class="badge pending" style="opacity:1; text-decoration:line-through; font-weight:normal;">Excised</span>';
          else if (s.reviewStatus === "completed") btxt = '<span class="badge">Approved</span>';
          else {
            const es = s.textExtraction?.status;
            btxt = es === 'completed' ? '<span class="badge src-status">Analyzed</span>' : 
                   (es === 'failed' ? '<span class="badge src-status">No Ext</span>' : '<span class="badge partial">Scraping</span>');
          }
          const iUrl = getImageUrl((s.selectedImages && s.selectedImages[0]) || (s.images && s.images[0]));
          listHtml += \`
            <div class="p-card \${rejectedClass}" data-source-id="\${pIdx}-\${sIdx}" onclick="openSource(\${pIdx}, \${sIdx})">
              <div class="p-img">\${iUrl ? \`<img src="\${escapeHtml(iUrl)}" loading="lazy" alt="">\` : \`<div class="no-img">Empty</div>\`}</div>
              <div class="p-info">
                <div class="p-brand">\${escapeHtml(s.brand || s.vendor || s.store || "Generic Manufacturer")} &nbsp;/&nbsp; \${escapeHtml(formatPrice(s.price, s.currency))}</div>
                <div class="p-title">\${escapeHtml(s.name || p.title || "UNTITLED")}</div>
                <div class="p-status">\${btxt}</div>
              </div>
            </div>\`;
        });
      }
    });
  }
  document.getElementById("pList").innerHTML = listHtml;
  document.getElementById("rMeta").innerHTML = \`
    <span class="badge" style="background:var(--surface-2); color:var(--text); border:none;">Type: \${item.type==="frame"?"Snapshot":"Static"}</span>
    <span class="badge" style="background:var(--surface-2); color:var(--text); border:none;">Sources: \${totalSources}</span>
    \${pendingSources ? \`<span class="badge warning">\${pendingSources} PENDING</span>\` : ""}
  \`;
  const bc = document.getElementById("btnCommitItem");
  bc.disabled = (pendingSources > 0); bc.title = bc.disabled ? "Clear dependencies to commit" : "";
  if (state.justEditedSId !== null) {
    const rc = () => { const tg = document.querySelector(\`.p-card[data-source-id="\${state.justEditedSId}"]\`); if (tg) tg.scrollIntoView({behavior:'smooth',block:'center'}); state.justEditedSId=null;};
    requestAnimationFrame(() => requestAnimationFrame(rc));
  }
}

function openVideo(url) { const v = document.getElementById('vPlayer'); v.src = url; document.getElementById('videoModal').classList.add('active'); v.play().catch(console.error); }
function closeVideo() { const v = document.getElementById('vPlayer'); v.pause(); v.src = ''; document.getElementById('videoModal').classList.remove('active'); }

function updateFinalPrice() {
    const type = document.getElementById("eMarkupType").value;
    document.getElementById("fieldMarkupFixed").style.display = (type === "fixed") ? "block" : "none";
    document.getElementById("fieldMarkupPct").style.display = (type === "percentage") ? "block" : "none";
    const be = document.getElementById("ePrice"); const fe = document.getElementById("eFinalPrice"); if(!be || !fe) return;
    const b = parseFloat(be.value); if (isNaN(b)) { fe.value = "NA"; return; }
    const c = document.getElementById("eCurrency")?.value || ""; let f = b;
    if (type === "fixed") { const val = parseFloat(document.getElementById("eMarkupFixed")?.value); if (!isNaN(val)) f = b + val; } 
    else { const val = parseFloat(document.getElementById("eMarkupPct")?.value); if (!isNaN(val)) f = b * (1 + val/100); }
    fe.value = f.toFixed(2) + (c ? " " + c : ""); saveFormToLocalStorage();
}

function getAllImages(source) {
  const st = new Set();
  if (state.current?.url) st.add(state.current.url);
  (source.images||[]).forEach(u=>{const p=getImageUrl(u);if(p)st.add(p);});
  (source.customImages||[]).forEach(u=>st.add(String(u)));
  (source.selectedImages||[]).forEach(u=>st.add(String(u)));
  return { urls: Array.from(st) };
}

function openSource(pIdx, sIdx) {
  try {
    state.editingPIdx = pIdx; state.editingSIdx = sIdx;
    const prd = state.current.response.products[pIdx]; const s = prd.sources[sIdx];
    if(!s) return toast('Data missing');
    
    const imDat = getAllImages(s); state.currentSelected = [...(s.selectedImages||[])];
    state.currentGridUrls = Array.from(new Set([...state.currentSelected, ...imDat.urls]));
    state.currentVariants = Array.isArray(s.variants) ? JSON.parse(JSON.stringify(s.variants)) : [];
    
    const hHeaders = s.size_guide?.headers?.length > 0;
    state.currentSizeGuide = (hHeaders) ? JSON.parse(JSON.stringify(s.size_guide)) : { headers: ["US", "EU", "UK"], rows: [] };
    const hPr = getHighestSourcePrice(s); const sPrV = hPr != null ? hPr.toFixed(2) : "";
    const sCmpV = s.price?.original!=null ? getSafeNumber(s.price.original) : (s.compare_at_price!=null ? getSafeNumber(s.compare_at_price) : "");
    
    const paV = (str) => { const rm = String(str||"").toLowerCase().replace(/[^a-z]/g,''); return rm.includes('out')||rm.includes('sold') ? "OutOfStock" : rm.includes('pre') ? "PreOrder" : "InStock"; };
    const vC = (s.variant||'').trim(); let mAv;
    if(vC && Array.isArray(s.variants) && s.variants.length) {
      const fi = s.variants.filter(v=>(v.color||'').trim()===vC);
      mAv = fi.length ? (fi.map(v=>paV(v.availability)).includes('InStock') ? 'InStock' : 'OutOfStock') : paV(s.availability);
    } else mAv = paV(s.availability);
    
    const feats = Array.isArray(s.features) ? s.features.join("\\n") : (typeof s.features==="string" ? s.features : "");
    
    let html = \`
      <div class="card" style="padding-bottom:16px;">
        <h3>Assets // <span style="text-transform:none;font-weight:bold;"><span id="selCount">\${state.currentSelected.length}</span> Active</span></h3>
        <div class="carousel" id="eImgGrid"></div>
        <div style="display:flex; gap:16px; margin-top:8px;">
          <button class="btn-ghost" onclick="addImage()" style="flex:1; border:1px solid var(--border); border-style:dashed;">Drop IMG URL</button>
          <button class="btn-ghost" onclick="clearSelection()" style="flex:1; border:1px solid var(--danger); color:var(--danger); border-style:dashed;">Purge List</button>
        </div>
      </div>
      
      <div class="card">
        <h3>Primary Meta</h3>
        <div class="field"><label>Nomenclature</label><input id="eTitle" value="\${escapeHtml(s.name||prd.title||"")}" style="font-size:22px; font-family:var(--font-serif); font-weight:normal; letter-spacing:0.02em;"></div>
        <div class="field-row">
          <div class="field"><label>House / Brand</label><input id="eBrand" value="\${escapeHtml(s.brand||"")}"></div>
          <div class="field"><label>Origin / Store</label><input id="eVendor" value="\${escapeHtml(s.vendor||s.store||"")}"></div>
        </div>
        <div class="field-row">
          <div class="field"><label>Tone / Color</label><input id="eColor" value="\${escapeHtml(s.color||"")}"></div>
          <div class="field"><label>Substance / Mat.</label><input id="eMaterial" value="\${escapeHtml(s.material||"")}"></div>
        </div>
        <div class="field">
          <label>Selected Master Variant</label>
          <select id="eVariant">
            <option value="">Aggregate All</option>
            \${(()=>{
              const vs=s.variants||[]; if(!vs.length) return '';
              const uniq=[...new Set(vs.map(v=>(v.color||'').trim()).filter(c=>c))];
              const aSame=vs.map(v=>(v.color||'').trim()).every((c,i,a)=>c===a[0])&&vs[0];
              const sd=(s.variant||'').trim(); const dV= (sd&&uniq.includes(sd))?sd:(aSame?vs[0].color.trim():(uniq[0]||''));
              return uniq.map(c=>\`<option value="\${escapeHtml(c)}" \${dV===c?'selected':''}>\${escapeHtml(c)}</option>\`).join('');
            })()}
          </select>
        </div>
        <div class="field">
          <label>State / Condition</label>
          <select id="eCondition"><option value="" \${escapeHtml(s.condition||"")===""?"selected":""}>Unlisted</option><option value="New" \${escapeHtml(s.condition||"")==="New"?"selected":""}>Pristine (New)</option><option value="Used" \${escapeHtml(s.condition||"")==="Used"?"selected":""}>Archived (Used)</option></select>
        </div>
        <div class="field"><label>Classification</label><input id="eCategory" value="\${escapeHtml(s.primary_category||prd.category||"")}"></div>
        <div class="field">
          <label>Extraction Source Link</label>
          <div style="display:flex; gap:16px;">
            <input id="eUrl" type="url" value="\${escapeHtml(s.url||"")}" style="flex:1;">
            \${s.url ? \`<a href="\${escapeHtml(s.url)}" target="_blank" rel="noopener" style="font-family:var(--font-mono);font-size:10px;text-transform:uppercase;color:var(--bg);background:var(--text);border-radius:4px;text-decoration:none;display:flex;align-items:center;padding:0 24px; font-weight:bold; letter-spacing:0.05em;">LINK OUT ↗</a>\` : ''}
          </div>
          <div style="display:flex; gap:16px; margin-top:16px;">
            <button id="btnExtractLazy" class="btn-ghost" style="flex:1; border:1px solid var(--border); font-size:9px;" onclick="extractImages('lazy')">Scrape Basic</button>
            <button id="btnExtractFull" class="btn-ghost" style="flex:1; border:1px solid var(--border); font-size:9px;" onclick="extractImages('full')">Deep Analysis</button>
          </div>
        </div>
        <div class="field-row">
          <div class="field"><label>Tag (Current)</label><input id="ePrice" type="number" step="0.01" inputmode="decimal" value="\${escapeHtml(sPrV)}" oninput="updateFinalPrice()"></div>
          <div class="field"><label>Tag (Legacy)</label><input id="eComparePrice" type="number" step="0.01" inputmode="decimal" value="\${escapeHtml(sCmpV)}"></div>
          <div class="field" style="width:110px;">
            <label>Curr.</label>
            <div style="display:flex;">
              <input id="eCurrency" value="\${escapeHtml(s.price?.currency||s.currency||'USD')}" style="text-transform:uppercase;" oninput="this.value=this.value.toUpperCase();updateFinalPrice()">
            </div>
          </div>
        </div>
        <div class="field">
          <label>Inventory Presence</label>
          <select id="eAvail"><option \${mAv==="InStock"?"selected":""}>InStock</option><option \${mAv==="OutOfStock"?"selected":""}>OutOfStock</option><option \${mAv==="PreOrder"?"selected":""}>PreOrder</option></select>
        </div>
      </div>
      
      <details class="card"><summary>Granular Stock Mapping</summary>
        <div class="details-content">
          <div id="variantsContainer" class="simple-table-wrapper"></div>
          <button class="btn-ghost" onclick="addVariantRow()" style="width:100%; border:1px dashed var(--border); margin-top:20px;">+ Extend Variant Record</button>
        </div>
      </details>

      <details class="card"><summary>Anatomy Charting (Sizing)</summary>
        <div class="details-content">
          <div class="info-plate">Consult global metric logic before generating structures via clipboard inject. Paste standard schema ONLY.</div>
          <div style="display:flex; gap:16px;">
            <button class="btn-ghost" onclick="copySizeGuidePrompt()" style="flex:1; border:1px solid var(--text);">Export System Matrix ⎘</button>
            <button class="btn-ghost" onclick="pasteSizeGuideJson()" style="flex:1; background:var(--text); color:var(--bg);">Inject Architect JSON ↓</button>
          </div>
          <div id="sizeGuideContainer" class="simple-table-wrapper" style="margin-top:24px;"></div>
          <div style="display:flex; gap:16px; margin-top:16px;">
            <button class="btn-ghost" onclick="addSizeGuideRow()" style="flex:1; border:1px dashed var(--border); font-size:10px;">+ Node Y (Row)</button>
            <button class="btn-ghost" onclick="addSizeGuideCol()" style="flex:1; border:1px dashed var(--border); font-size:10px;">+ Node X (Col)</button>
          </div>
        </div>
      </details>

      <details class="card"><summary>Verbiage / Intel</summary>
        <div class="details-content" style="padding-bottom:12px;">
          <div class="field"><label>Narrative Description</label><textarea id="eDesc" style="line-height:1.6; font-size:15px; border-left:1px solid var(--border); border-bottom:1px solid var(--border); padding: 12px; margin-bottom:8px;">\${escapeHtml(s.description||prd.description||"")}</textarea></div>
          <div class="field"><label>Bullet Struct. (NL delim.)</label><textarea id="eFeatures" style="line-height:1.6; font-size:15px; border-left:1px solid var(--border); border-bottom:1px solid var(--border); padding: 12px; margin-bottom:8px;">\${escapeHtml(feats)}</textarea></div>
          <div class="field"><label>Logistics Transit</label><textarea id="eShippingInfo" style="font-family:var(--font-mono); font-size:12px; border-bottom:1px solid var(--border);">\${escapeHtml(s.shipping_info||"")}</textarea></div>
          <div class="field"><label>Return Policy Statement</label><textarea id="eReturnPolicy" style="font-family:var(--font-mono); font-size:12px; border-bottom:1px solid var(--border);">\${escapeHtml(s.return_policy||"")}</textarea></div>
        </div>
      </details>

      <details class="card"><summary>Econ Projection Parameters</summary>
        <div class="details-content">
          <div style="background:var(--surface-2); border-left: 3px solid var(--text); padding: 16px 20px; margin-bottom:24px;">
            <div class="mono-util" style="margin-bottom:8px;">Algorithm Signals</div>
            <div style="font-family:var(--font-serif); font-size:16px; line-height:1.3; margin-bottom:12px;">Warning Node: \${escapeHtml(s.dropship_advisory||"CLEAR")}</div>
            <div style="font-family:var(--font-mono); font-size:11px; display:flex; flex-wrap:wrap; gap:16px;">
              <div>[R] Price <br><strong style="font-size:14px;color:var(--text);margin-top:2px;display:block;">\${s.base_price_for_markup||"NaN"}</strong></div>
              <div>[R] Rate % <br><strong style="font-size:14px;color:var(--text);margin-top:2px;display:block;">\${s.recommended_markup_percentage?s.recommended_markup_percentage+"%":"NaN"}</strong></div>
              <div>[P] Retail <br><strong style="font-size:14px;color:var(--text);margin-top:2px;display:block;">\${s.suggested_resell_price||"NaN"}</strong></div>
            </div>
          </div>
          
          <div class="field"><label>Strategy Lock</label><select id="eMarkupType" onchange="updateFinalPrice()"><option value="percentage" \${(s.markup_type||"percentage")==="percentage"?"selected":""}>Scale Modifier (%)</option><option value="fixed" \${(s.markup_type||"")==="fixed"?"selected":""}>Static Offset (+)</option></select></div>
          <div class="field-row">
            <div class="field" id="fieldMarkupFixed" style="display:\${(s.markup_type||"percentage")==="fixed"?"block":"none"}"><label>Nominal (+)</label><input id="eMarkupFixed" type="number" step="0.01" value="\${s.markup_fixed!=null?escapeHtml(getSafeNumber(s.markup_fixed)):""}" oninput="updateFinalPrice()"></div>
            <div class="field" id="fieldMarkupPct" style="display:\${(s.markup_type||"percentage")==="percentage"?"block":"none"}"><label>Coefficient (%)</label><input id="eMarkupPct" type="number" step="0.1" value="\${s.markup_percentage!=null?escapeHtml(String(s.markup_percentage)):(s.recommended_markup_percentage!=null?escapeHtml(String(s.recommended_markup_percentage)):'30')}" oninput="updateFinalPrice()"></div>
          </div>
          <div class="field" style="margin-top: 32px;"><label style="font-size:12px;">Computed Terminal Yield</label><input id="eFinalPrice" type="text" readonly value="\${escapeHtml(computeFinalPriceDisplay(s))}" style="border-bottom: 2px solid var(--text); font-family:var(--font-mono); font-weight:bold; color:var(--text); pointer-events:none;"></div>
        </div>
      </details>
      
      <!-- Safe scroll clearance in Editor -->
      <div style="height:48px;"></div>
    \`;
    document.getElementById("eBody").innerHTML = html;
    
    renderImgGrid(state.currentGridUrls); updateSelCount();
    renderVariantsTable(); renderSizeGuideTable();
    
    state.formPersistKey = getFormPersistKey();
    restoreFormFromLocalStorage();

    const eb = document.getElementById("eBody");
    if(eb) { eb.removeEventListener('input', saveFormToLocalStorage); eb.removeEventListener('change', saveFormToLocalStorage);
             eb.addEventListener('input', ()=>saveFormToLocalStorage(), {passive:true}); eb.addEventListener('change', ()=>saveFormToLocalStorage(), {passive:true}); }
    
    showScreen("editor"); document.getElementById("eBody").scrollTop = 0; window.scrollTo(0,0);
    
  } catch(e) { toast("RUNTIME FAULT: " + e.message); }
}

function updateSelCount() { const e=document.getElementById('selCount'); if(e) e.textContent=state.currentSelected.length; }

function toggleImageSelection(url) {
  const i=state.currentSelected.indexOf(url);
  if(i>-1) state.currentSelected.splice(i,1); else state.currentSelected.push(url);
  renderImgGrid(state.currentGridUrls); updateSelCount(); saveFormToLocalStorage();
}
function clearSelection() {
  if(!confirm('ERASE ASSET LOCKS?')) return;
  state.currentSelected=[]; renderImgGrid(state.currentGridUrls); updateSelCount(); saveFormToLocalStorage();
}

function renderImgGrid(urls) {
  const gr = document.getElementById("eImgGrid");
  if(!urls.length) { gr.innerHTML = '<div class="empty" style="flex:1;">Awaiting Media Drop</div>'; return; }
  gr.innerHTML = urls.map(u => {
    const si = state.currentSelected.indexOf(u); const isOn = si > -1;
    return \`<div class="img-cell \${isOn?'on':''}" onclick="toggleImageSelection('\${escapeHtml(u)}')">
      <img src="\${escapeHtml(u)}" loading="lazy" alt="" onload="this.classList.add('loaded')" onerror="this.src='data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22><rect width=%22100%25%22 height=%22100%25%22 fill=%22%23222%22/></svg>'">
      <div class="check">\${isOn?(si+1):''}</div>
    </div>\`;
  }).join('');
}

async function addImage() {
  try {
    const text=await navigator.clipboard.readText(); if(!text){ toast("BOARD EMP."); return; }
    let u=text.trim(); if(!/^https?:\\/\\//i.test(u)){ toast("NO HREF IDENTIFIED."); return; }
    const s = state.current.response.products[state.editingPIdx].sources[state.editingSIdx];
    s.customImages=s.customImages||[]; if(!s.customImages.includes(u)) s.customImages.push(u);
    if(!state.currentSelected.includes(u)) state.currentSelected.push(u);
    if(!state.currentGridUrls.includes(u)) state.currentGridUrls.unshift(u);
    renderImgGrid(state.currentGridUrls); updateSelCount(); saveFormToLocalStorage(); toast("LOCK APPENDED");
  } catch(e) { toast("SYS CLIP ERR"); }
}

async function extractImages(mode) {
  const url=document.getElementById("eUrl").value; if(!url) return toast("NULL FIELD - URI");
  const cg=document.getElementById("eImgGrid"); const bl=document.getElementById("btnExtractLazy"); const bf=document.getElementById("btnExtractFull");
  if(cg) cg.classList.add("extracting"); if(bl)bl.disabled=true; if(bf)bf.disabled=true;
  try {
    const r=await fetch("/api/extract", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({url,mode}) });
    const d=await r.json(); if(d.error) throw new Error(d.error);
    if(d.images?.length > 0) {
      const s = state.current.response.products[state.editingPIdx].sources[state.editingSIdx];
      const nu = d.images.filter(i=>!state.currentGridUrls.includes(i)).slice(0,20);
      if(nu.length > 0) {
        s.customImages=[...nu, ...(s.customImages||[])];
        state.currentGridUrls=[...nu, ...state.currentGridUrls];
        nu.forEach(x=>{if(!state.currentSelected.includes(x))state.currentSelected.push(x)});
        renderImgGrid(state.currentGridUrls); updateSelCount(); saveFormToLocalStorage(); toast(\`INDUCT \${nu.length}\`);
      } else toast("INDEX COLLISION - ALL CACHED");
    } else toast("SCRAPE 0 YIELD");
  } catch(e) { toast(e.message); } finally {
    if(cg)cg.classList.remove("extracting"); if(bl)bl.disabled=false; if(bf)bf.disabled=false;
  }
}

/* --- Granular --- */
function renderVariantsTable() {
  const ct = document.getElementById("variantsContainer");
  if (!state.currentVariants.length) { ct.innerHTML = ''; return; }
  let ht = '<table class="simple-table"><thead><tr><th style="padding-left:0;">F/Factor</th><th>Tonal</th><th>Node</th><th>Units</th><th>Vol (C$)</th><th style="width:36px; border:none;"></th></tr></thead><tbody>';
  state.currentVariants.forEach((v, i) => {
    let aStr = String(v.availability||"").toLowerCase().replace(/[^a-z]/g,'');
    let mAv = aStr.includes('out')||aStr.includes('sold') ? "OutOfStock" : (aStr.includes('pre')?"PreOrder":"InStock");
    ht += \`<tr class="v-row" data-idx="\${i}">
      <td><input type="text" class="v-size mono-util" value="\${escapeHtml(v.size||'')}" style="font-size:12px; font-weight:normal; letter-spacing:0;"></td>
      <td><input type="text" class="v-color" value="\${escapeHtml(v.color||'')}" style="font-size:13px; font-weight:normal;"></td>
      <td style="padding-top:14px;"><select class="v-avail mono-util" style="font-size:9px; border-bottom:none;"><option \${mAv==="InStock"?"selected":""}>InStock</option><option \${mAv==="OutOfStock"?"selected":""}>OutOfStock</option><option \${mAv==="PreOrder"?"selected":""}>PreOrder</option></select></td>
      <td><input type="number" class="v-qty" value="\${escapeHtml(v.inventory_quantity!=null?String(v.inventory_quantity):'')}" style="font-size:13px; font-family:var(--font-mono);"></td>
      <td><input type="number" step="0.01" class="v-price" value="\${escapeHtml(v.price!=null?getSafeNumber(v.price):'')}" style="font-size:13px; font-family:var(--font-mono);"></td>
      <td style="text-align:right;"><button class="table-btn" onclick="delVariantRow(\${i})" style="border:none;">&times;</button></td>
    </tr>\`;
  });
  ct.innerHTML = ht + '</tbody></table>';
}
function syncVariantsFromDOM() {
  const rs = document.querySelectorAll(".v-row");
  state.currentVariants = Array.from(rs).map(r => {
    const qv = r.querySelector(".v-qty").value; const pv = r.querySelector(".v-price").value;
    return {
      size: r.querySelector(".v-size").value, color: r.querySelector(".v-color").value, availability: r.querySelector(".v-avail").value,
      inventory_quantity: qv!==''?parseInt(qv,10):null, price: pv!==''?parseFloat(pv):null
    };
  });
}
function addVariantRow(){syncVariantsFromDOM();state.currentVariants.push({size:"",color:"",availability:"InStock",inventory_quantity:null,price:null});renderVariantsTable();saveFormToLocalStorage();}
function delVariantRow(i){syncVariantsFromDOM();state.currentVariants.splice(i,1);renderVariantsTable();saveFormToLocalStorage();}

/* --- Architect JSON sizing --- */
function renderSizeGuideTable() {
  const ct = document.getElementById("sizeGuideContainer");
  const sg = state.currentSizeGuide || {headers:[], rows:[]}; if(!sg.rows)sg.rows=[];
  if (!sg.headers || !sg.headers.length) { ct.innerHTML = ''; return; }
  let ht = '<table class="simple-table" style="border:1px solid var(--border);"><thead><tr>';
  sg.headers.forEach((h, c) => {
    ht += \`<th style="padding:4px 8px; border-right:1px solid var(--border); border-bottom:1px solid var(--border); background:var(--surface-2);"><div style="display:flex;align-items:center;"><input type="text" class="sg-header mono-util" data-cidx="\${c}" value="\${escapeHtml(h)}" style="flex:1; border:none; text-transform:uppercase;"><button class="table-btn" onclick="delSizeGuideCol(\${c})" style="border:none; height:18px;">&times;</button></div></th>\`;
  });
  ht += '<th style="width:30px; border-bottom:1px solid var(--border); background:var(--surface-2);"></th></tr></thead><tbody>';
  sg.rows.forEach((r, i) => {
    ht += \`<tr class="sg-row">\`;
    sg.headers.forEach((_, c) => { ht += \`<td style="padding:2px 8px; border-right:1px solid var(--border);"><input type="text" class="sg-cell" data-ridx="\${i}" data-cidx="\${c}" value="\${escapeHtml(r[c]||"")}" style="border:none; font-family:var(--font-mono); font-size:12px;"></td>\`;});
    ht += \`<td style="text-align:center;"><button class="table-btn" onclick="delSizeGuideRow(\${i})" style="border:none;">&times;</button></td></tr>\`;
  });
  ct.innerHTML = ht + '</tbody></table>';
}
function syncSizeGuideFromDOM() {
  const sg=state.currentSizeGuide; document.querySelectorAll(".sg-header").forEach(n=>sg.headers[parseInt(n.dataset.cidx,10)]=n.value);
  document.querySelectorAll(".sg-cell").forEach(n=>{const r=parseInt(n.dataset.ridx,10),c=parseInt(n.dataset.cidx,10); if(!sg.rows[r])sg.rows[r]=[]; sg.rows[r][c]=n.value;});
}
function addSizeGuideRow(){syncSizeGuideFromDOM();if(!state.currentSizeGuide.headers.length)state.currentSizeGuide.headers=["REF","ALT"];state.currentSizeGuide.rows.push(new Array(state.currentSizeGuide.headers.length).fill(""));renderSizeGuideTable();saveFormToLocalStorage();}
function addSizeGuideCol(){syncSizeGuideFromDOM();state.currentSizeGuide.headers.push("TBD");state.currentSizeGuide.rows.forEach(r=>r.push(""));renderSizeGuideTable();saveFormToLocalStorage();}
function delSizeGuideRow(i){syncSizeGuideFromDOM();state.currentSizeGuide.rows.splice(i,1);renderSizeGuideTable();saveFormToLocalStorage();}
function delSizeGuideCol(c){syncSizeGuideFromDOM();state.currentSizeGuide.headers.splice(c,1);state.currentSizeGuide.rows.forEach(r=>r.splice(c,1));renderSizeGuideTable();saveFormToLocalStorage();}

function copySizeGuidePrompt() {
  const pIdx=state.editingPIdx, sIdx=state.editingSIdx, s=state.current?.response?.products?.[pIdx]?.sources?.[sIdx];
  if(!s) return toast("BAD HLD");
  const sDat = { name: s.name, brand: s.brand, vendor: s.vendor||s.store, category: s.primary_category, url: s.url, desc: s.description, guide: s.size_guide||null, variantData: (s.variants||[]).map(v=>v.size+"_"+v.color) };
  
  const prom = \`Return raw structured size metric logic for UI layout referencing exact fields found from online intel. Strict JSON matching { "headers":["Alpha","...cm"], "rows":[["XS",".."],...] } . Data basis:\n\${JSON.stringify(sDat)}\`;
  navigator.clipboard.writeText(prom).then(()=>toast("Prompt Bound")).catch(()=>toast("Permission Denied"));
}
async function pasteSizeGuideJson() {
  try {
    const raw = await navigator.clipboard.readText(); if(!raw) return;
    const cln = raw.trim().replace(/^\`\`\`[a-z]*\\n?/i, '').replace(/\\n?\`\`\`$/,'').trim();
    const d = JSON.parse(cln);
    if(d.headers&&d.rows){ state.currentSizeGuide={headers:d.headers.map(String), rows:d.rows.map(x=>x.map(String)), ...d}; renderSizeGuideTable(); saveFormToLocalStorage(); toast("Injected Structural Nodes"); }
    else toast("Corrupt Format Tree");
  } catch(e) { toast("Rejection or parse issue."); }
}


/* --- IO Mutators --- */
async function saveSource(status="completed") {
  syncVariantsFromDOM(); syncSizeGuideFromDOM();
  const px = state.editingPIdx, sx = state.editingSIdx, bst = state.current.response.products[px].sources[sx];
  const prv = parseFloat(document.getElementById("ePrice").value), cmpv = parseFloat(document.getElementById("eComparePrice").value);
  const np = { ...bst.price, current: isNaN(prv)?null:prv, original: isNaN(cmpv)?null:cmpv, currency: document.getElementById("eCurrency").value };
  
  const typ = document.getElementById("eMarkupType").value, fv = parseFloat(document.getElementById("eMarkupFixed").value), pv = parseFloat(document.getElementById("eMarkupPct").value);
  const ovs = bst.variants||[], nvs = state.currentVariants.map(v => ({...(ovs.find(o=>o.size===v.size&&o.color===v.color)||{}), ...v}));

  const pay = {
    ...bst, name: document.getElementById("eTitle").value, brand: document.getElementById("eBrand").value, vendor: document.getElementById("eVendor").value,
    color: document.getElementById("eColor").value, variant: document.getElementById("eVariant").value, material: document.getElementById("eMaterial").value, condition: document.getElementById("eCondition").value,
    url: document.getElementById("eUrl").value, primary_category: document.getElementById("eCategory").value, price: np, compare_at_price: np.original,
    is_on_sale: (np.original!=null&&np.current!=null&&np.original>np.current), currency: np.currency, availability: document.getElementById("eAvail").value, description: document.getElementById("eDesc").value,
    features: document.getElementById("eFeatures").value.split("\\n").map(x=>x.trim()).filter(Boolean), shipping_info: document.getElementById("eShippingInfo").value, return_policy: document.getElementById("eReturnPolicy").value,
    markup_type: typ, markup_fixed: typ==="fixed"?(isNaN(fv)?null:fv):null, markup_percentage: typ==="percentage"?(isNaN(pv)?null:pv):null,
    variants: nvs, size_guide: state.currentSizeGuide, selectedImages: [...state.currentSelected], reviewStatus: status
  };

  const btn = document.querySelector('.modal-header button:last-child');
  if (btn) { btn.disabled = true; btn.textContent = 'I/O'; }
  try {
    const rp = await fetch("/api/product", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({ docId: state.current._id, fileIdx: state.current.fileIdx, frameIdx: state.current.frameIdx, prodIdx: px, sourceIdx: sx, source: pay }) });
    if (!rp.ok) throw new Error("Sync failure");
    state.current.response.products[px].sources[sx] = pay;
    clearFormPersist(state.formPersistKey); state.justEditedSId = \`\${px}-\${sx}\`; toast("Parameter Overridden");
    renderItem(); closeEditor();
  } catch(e) { toast("Err: "+e.message); } finally { if (btn) { btn.disabled = false; btn.textContent = 'Done'; } }
}

async function deleteSource() {
  if(!confirm("CONFIRM FULL SEVERANCE OF SOURCE?")) return;
  try {
    const rb = {docId:state.current._id, fileIdx:state.current.fileIdx, frameIdx:state.current.frameIdx, prodIdx:state.editingPIdx, sourceIdx:state.editingSIdx};
    const rx = await fetch("/api/delete-source", {method:"POST",headers:{"Content-Type":"application/json"}, body:JSON.stringify(rb)});
    if(!rx.ok) throw new Error("Delete issue");
    clearFormPersist(state.formPersistKey); state.current.response.products[state.editingPIdx].sources.splice(state.editingSIdx,1); toast("Asset Excised.");
    renderItem(); closeEditor();
  } catch(e) { toast(e.message); }
}

function closeEditor() {
  showScreen("review");
  if(state.editingPIdx!==null&&state.editingSIdx!==null) {
    requestAnimationFrame(()=>{ const el=document.querySelector(\`.p-card[data-source-id="\${state.editingPIdx}-\${state.editingSIdx}"]\`); if(el) el.scrollIntoView({behavior:'smooth',block:'center'}); });
  }
}

async function commitItem() {
  try {
    const rx = await fetch("/api/commit", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({docId:state.current._id, fileIdx:state.current.fileIdx, frameIdx:state.current.frameIdx})});
    if(rx.status===409) { toast("Audit Missing Flags."); return; }
    if(!rx.ok) throw new Error("Fault");
    toast("Validated."); 
    const mtch=(a,b,c)=>(x)=>x._id===a&&x.fileIdx===b&&x.frameIdx===c;
    const curMtch=mtch(state.current?._id,state.current?.fileIdx,state.current?.frameIdx??null);
    state.queue=state.queue.filter(it=>!curMtch(it));
    for(const pid in state.posts) {
      state.posts[pid].items=state.posts[pid].items.filter(it=>!curMtch(it));
      if(state.posts[pid].items.length===0) delete state.posts[pid];
    }
    state.current=null; showScreen("queue"); renderQueue();
  } catch(e) { toast("Err: " + e.message); }
}

async function deleteItem() {
  if(!confirm("NULLIFY ENTIRE ITEM RECORD?")) return;
  try {
    const r=await fetch("/api/delete",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({docId:state.current._id,fileIdx:state.current.fileIdx,frameIdx:state.current.frameIdx})});
    if(!r.ok) throw new Error("Wipe Err"); toast("Directory Voided.");
    const curMtch=(x)=>x._id===state.current._id&&x.fileIdx===state.current.fileIdx&&(state.current.frameIdx===undefined?x.frameIdx===null:x.frameIdx===state.current.frameIdx);
    state.queue=state.queue.filter(i=>!curMtch(i));
    for(let pid in state.posts) { state.posts[pid].items=state.posts[pid].items.filter(i=>!curMtch(i)); if(!state.posts[pid].items.length) delete state.posts[pid]; }
    state.current=null; showScreen("queue"); renderQueue();
  } catch(e) { toast("Fault: " + e.message); }
}

function showQueue() { showScreen("queue"); }

/* Peripheral Bindings */
function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (document.getElementById('videoModal').classList.contains('active')) closeVideo();
      else if (document.getElementById('editor').classList.contains('active')) closeEditor();
      else if (document.getElementById('review').classList.contains('active')) showQueue();
    }
  });
}

function initSwipeNavigation() {
  const hr=document.querySelector('.hero'); if(!hr)return;
  let sx=0, sy=0, sT=0, sW=false; const ST_TH = () => Math.min(window.innerWidth * 0.3, 130);
  hr.addEventListener('touchstart',e=>{if(e.touches.length===1){sx=e.touches[0].clientX;sy=e.touches[0].clientY;sT=Date.now();sW=false;}},{passive:true});
  hr.addEventListener('touchend',e=>{
    if(!sT)return; const dx=e.changedTouches[0].clientX-sx, dy=e.changedTouches[0].clientY-sy, dt=Date.now()-sT; sT=0;
    if(dt>400||Math.abs(dy)>Math.abs(dx)||Math.abs(dx)<ST_TH())return; sW=true;
    const cid=(it)=>it._id===state.current?._id&&it.fileIdx===state.current?.fileIdx&&it.frameIdx===state.current?.frameIdx;
    const x=state.queue.findIndex(cid); if(x===-1)return;
    if(dx<0&&x+1<state.queue.length){let n=state.queue[x+1];openItem(n._id,n.fileIdx,n.frameIdx);}
    else if(dx>0&&x>0){let p=state.queue[x-1];openItem(p._id,p.fileIdx,p.frameIdx);}
    else toast(dx<0?'EOL Right':'BOL Left');
  },{passive:true});
  hr.addEventListener('mousedown',e=>{sx=e.clientX;sy=e.clientY;sT=Date.now();});
  hr.addEventListener('mouseup',e=>{
    if(!sT)return; const dx=e.clientX-sx,dy=e.clientY-sy,dt=Date.now()-sT; sT=0;
    if(dt>400||Math.abs(dy)>Math.abs(dx)||Math.abs(dx)<ST_TH())return; sW=true;
    const x=state.queue.findIndex(it=>it._id===state.current?._id&&it.fileIdx===state.current?.fileIdx&&it.frameIdx===state.current?.frameIdx);
    if(x===-1)return;
    if(dx<0&&x+1<state.queue.length){let n=state.queue[x+1];openItem(n._id,n.fileIdx,n.frameIdx);}
    else if(dx>0&&x>0){let p=state.queue[x-1];openItem(p._id,p.fileIdx,p.frameIdx);}
  });
  hr.addEventListener('click',e=>{if(sW){e.preventDefault();e.stopPropagation();sW=false;}},true);
}

loadQueue(); initKeyboard(); initSwipeNavigation();
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

    if (totalSources === 0) return 'done';
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
    log('info', '  REVIEW SERVER — Production Human Review v2.4 (Minimalist iOS)');
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
