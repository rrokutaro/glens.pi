/**
 * orchestrator.js
 *
 * Pipeline:
 *  1. Sync HuggingFace data.json  →  MongoDB "scraped-posts" collection
 *  2. Fetch un-downloaded posts from MongoDB
 *  3. Download media via Instagram downloader sites (CloakBrowser/Puppeteer)
 *     — each browser page is screen-recorded, clips compiled into one session MP4
 *  4. Upload assets to HuggingFace under scraped-posts/assets/
 *  5. Mark posts as downloaded:true + file_urls in MongoDB
 */

import { launch } from 'cloakbrowser/puppeteer';
import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { MongoClient } from 'mongodb';

// ═══════════════════════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════════════════════
const CONFIG = {
    mongodb: {
        uri:        process.env.ORCH_MONGODB_URI        || '',
        db:         process.env.ORCH_MONGODB_DB         || 'ugc-dropship',
        collection: process.env.ORCH_MONGODB_COLLECTION || 'scraped-posts',
    },
    hf: {
        token:      process.env.ORCH_HF_TOKEN       || '',
        repo:       process.env.ORCH_HF_REPO        || 'rrokutaro/ugc-dropship',
        assetsPath: process.env.ORCH_HF_ASSETS_PATH || 'scraped-posts/assets',
        dataJson:   'scraped-posts/data.json',
        repoType:   'dataset',
    },
    batch: {
        size:        parseInt(process.env.ORCH_BATCH_SIZE             || '10', 10),
        concurrency: parseInt(process.env.ORCH_DOWNLOADER_CONCURRENCY || '3',  10),
    },
    timeouts: {
        navigation:     45_000,
        downloaderIdle: 30_000,
        idleReset:      10_000,
    },
    recording: {
        enabled:      process.env.ORCH_RECORDING !== 'false',   // on by default
        fps:          parseInt(process.env.ORCH_RECORDING_FPS     || '12',   10),
        quality:      parseInt(process.env.ORCH_RECORDING_QUALITY || '60',   10),
        resolution:   process.env.ORCH_RECORDING_RES              || '1280x800',
        overlayColor: process.env.ORCH_RECORDING_OVERLAY_COLOR    || '#00CFFF',
        overlaySize:  parseInt(process.env.ORCH_RECORDING_OVERLAY_SIZE || '14', 10),
    },
    logLevel:  process.env.ORCH_LOG_LEVEL || 'info',
    runId:     process.env.ORCH_RUN_ID    || 'local',
    outputDir: path.join(process.cwd(), 'orchestrator-output'),
    tmpDir:    path.join(process.cwd(), 'orchestrator-tmp'),
};

const RECORDINGS_DIR = path.join(CONFIG.outputDir, 'recordings');

// ─── Logging ───────────────────────────────────────────────────────────────────
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
function log(level, ...args) {
    if ((LOG_LEVELS[level] ?? 1) < (LOG_LEVELS[CONFIG.logLevel] ?? 1)) return;
    const ts     = new Date().toISOString().slice(11, 23);
    const prefix = `[${ts}] [${level.toUpperCase()}]`;
    if (level === 'error') console.error(prefix, ...args);
    else if (level === 'warn') console.warn(prefix, ...args);
    else console.log(prefix, ...args);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Ensure required dirs exist
[CONFIG.outputDir, CONFIG.tmpDir, RECORDINGS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ═══════════════════════════════════════════════════════════════════════════════
//  SCREEN RECORDER
// ═══════════════════════════════════════════════════════════════════════════════
let recorderSeq = 0; // monotonic clip index for ffmpeg concat ordering

class ScreenRecorder {
    constructor() {
        const idx        = String(++recorderSeq).padStart(4, '0');
        this.outputPath  = path.join(RECORDINGS_DIR, `clip_${idx}_${Date.now()}.mp4`);
        this.framesDir   = this.outputPath + '_frames';
        this.frameCount  = 0;
        this.isRecording = false;
        this.client      = null;
        this.page        = null;
        this.startTime   = null;
        this.label       = '';
        this.status      = 'IDLE';
    }

    async attach(page) {
        if (!CONFIG.recording.enabled || this.page) return;
        this.page      = page;
        this.startTime = Date.now();
        fs.mkdirSync(this.framesDir, { recursive: true });

        const { overlayColor: color, overlaySize: size } = CONFIG.recording;
        await this.page.evaluate((c, s) => {
            document.getElementById('orch-overlay')?.remove();
            const div = document.createElement('div');
            div.id = 'orch-overlay';
            div.style.cssText =
                'position:fixed!important;top:8px!important;left:8px!important;' +
                'z-index:999999!important;background:rgba(0,0,0,0.72)!important;' +
                `color:${c}!important;font-family:monospace!important;` +
                `font-size:${s}px!important;padding:5px 10px!important;` +
                'border-radius:4px!important;pointer-events:none!important;' +
                'line-height:1.4!important;white-space:pre!important;' +
                'max-width:80vw!important;overflow:hidden!important;' +
                'text-overflow:ellipsis!important;';
            div.textContent = '[STARTING…]';
            document.body?.appendChild(div);
        }, color, size).catch(() => {});

        const client = await this.page.target().createCDPSession();
        const [w, h] = CONFIG.recording.resolution.split('x').map(Number);
        await client.send('Page.startScreencast', {
            format:        'jpeg',
            quality:       CONFIG.recording.quality,
            maxWidth:      w,
            maxHeight:     h,
            everyNthFrame: Math.max(1, Math.round(60 / CONFIG.recording.fps)),
        });

        client.on('Page.screencastFrame', async (frame) => {
            if (!this.isRecording) return;
            try {
                const buf  = Buffer.from(frame.data, 'base64');
                const fPath = path.join(this.framesDir, `frame_${String(this.frameCount).padStart(6, '0')}.jpg`);
                fs.writeFileSync(fPath, buf);
                this.frameCount++;
                await client.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
            } catch (_) {}
        });

        this.client      = client;
        this.isRecording = true;
        log('info', `🎬 Recording: ${path.basename(this.outputPath)} @ ${CONFIG.recording.fps}fps`);
    }

    async updateLabel(label, status) {
        if (!CONFIG.recording.enabled || !this.page) return;
        if (label  !== undefined) this.label  = label;
        if (status !== undefined) this.status = status;
        try {
            const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
            await this.page.evaluate((lbl, st, el) => {
                const div = document.getElementById('orch-overlay');
                if (div) div.textContent = `${lbl}\n[${st}] ${el}s`;
            }, this.label, this.status, elapsed);
        } catch (_) {}
    }

    async stop() {
        if (!CONFIG.recording.enabled || !this.isRecording) return;
        this.isRecording = false;
        try {
            if (this.client) {
                await this.client.send('Page.stopScreencast').catch(() => {});
                await this.client.detach().catch(() => {});
            }
        } catch (_) {}
        this.client = null;
        this.page   = null;

        if (this.frameCount > 0) await this._encode();

        // Clean up frame images
        try {
            if (fs.existsSync(this.framesDir)) {
                for (const f of fs.readdirSync(this.framesDir))
                    fs.unlinkSync(path.join(this.framesDir, f));
                fs.rmdirSync(this.framesDir);
            }
        } catch (_) {}
    }

    async _encode() {
        const ffmpeg = this._ffmpeg();
        if (!ffmpeg) { log('warn', 'ffmpeg not found — frames kept as image sequence'); return; }

        const [w, h] = CONFIG.recording.resolution.split('x');
        const args = [
            '-y',
            '-framerate', String(CONFIG.recording.fps),
            '-i', path.join(this.framesDir, 'frame_%06d.jpg'),
            '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '28', '-preset', 'fast',
            '-movflags', '+faststart',
            '-vf', `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black`,
            this.outputPath,
        ];

        return new Promise(resolve => {
            const proc = spawn(ffmpeg, args, { stdio: 'pipe' });
            let stderr = '';
            proc.stderr?.on('data', d => { stderr += d; });
            const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch(_) {} resolve(); }, 120_000);
            proc.on('close', code => {
                clearTimeout(timer);
                if (code === 0 && fs.existsSync(this.outputPath)) {
                    const mb = (fs.statSync(this.outputPath).size / 1024 / 1024).toFixed(1);
                    log('info', `🎬 Clip saved: ${path.basename(this.outputPath)} (${mb}MB, ${this.frameCount} frames)`);
                } else {
                    log('warn', `ffmpeg exited ${code}: ${stderr.slice(0, 200)}`);
                }
                resolve();
            });
            proc.on('error', err => { clearTimeout(timer); log('warn', 'ffmpeg error: ' + err.message); resolve(); });
        });
    }

    _ffmpeg() {
        for (const c of ['ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
            try { execSync(`which ${c}`, { stdio: 'ignore' }); return c; } catch (_) {}
        }
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  VIDEO COMPILATION
// ═══════════════════════════════════════════════════════════════════════════════
async function compileRecordings() {
    if (!CONFIG.recording.enabled) return;
    if (!fs.existsSync(RECORDINGS_DIR)) return;

    const clips = fs.readdirSync(RECORDINGS_DIR)
        .filter(f => f.endsWith('.mp4') && !f.startsWith('session_'))
        .sort(); // clip_0001_... clip_0002_... already sort correctly

    if (clips.length === 0) { log('info', 'No recording clips to compile.'); return; }

    const sessionName = `session_${new Date().toISOString().replace(/[:.]/g, '-')}.mp4`;
    const sessionPath = path.join(RECORDINGS_DIR, sessionName);

    if (clips.length === 1) {
        fs.renameSync(path.join(RECORDINGS_DIR, clips[0]), sessionPath);
        log('info', `🎬 Session video (single clip): ${sessionName}`);
        return;
    }

    const listPath    = path.join(RECORDINGS_DIR, 'concat_list.txt');
    const listContent = clips
        .map(f => `file '${path.resolve(RECORDINGS_DIR, f).replace(/'/g, "'\\''")}'`)
        .join('\n') + '\n';
    fs.writeFileSync(listPath, listContent);

    let ffmpeg = null;
    for (const c of ['ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
        try { execSync(`which ${c}`, { stdio: 'ignore' }); ffmpeg = c; break; } catch (_) {}
    }
    if (!ffmpeg) { log('warn', 'ffmpeg not found — clips remain separate'); return; }

    return new Promise(resolve => {
        const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', sessionPath];
        const proc = spawn(ffmpeg, args, { stdio: 'pipe' });
        let stderr = '';
        proc.stderr?.on('data', d => { stderr += d; });
        proc.on('close', code => {
            if (code === 0 && fs.existsSync(sessionPath)) {
                const mb = (fs.statSync(sessionPath).size / 1024 / 1024).toFixed(1);
                log('info', `🎬 Compiled ${clips.length} clips → ${sessionName} (${mb}MB)`);
                for (const f of clips) { try { fs.unlinkSync(path.join(RECORDINGS_DIR, f)); } catch(_) {} }
            } else {
                log('warn', `Compile failed (exit ${code}): ${stderr.slice(0, 300)}`);
                log('warn', 'Individual clips preserved in recordings/');
            }
            try { fs.unlinkSync(listPath); } catch(_) {}
            resolve();
        });
        proc.on('error', err => {
            log('warn', 'ffmpeg compile error: ' + err.message);
            try { fs.unlinkSync(listPath); } catch(_) {}
            resolve();
        });
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════════════
let activeBrowser    = null;
const activeRecorders = new Set();
let isShuttingDown   = false;

async function gracefulShutdown(sig) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log('warn', `Signal ${sig} — shutting down…`);
    for (const rec of activeRecorders) await rec.stop().catch(() => {});
    activeRecorders.clear();
    if (activeBrowser) {
        let closed = false;
        activeBrowser.close().then(() => { closed = true; }).catch(() => {});
        await sleep(5000);
        if (!closed) {
            try { const p = activeBrowser.process?.(); if (p) p.kill('SIGKILL'); } catch(_) {}
        }
        activeBrowser = null;
    }
    await compileRecordings();
    process.exit(0);
}
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('unhandledRejection', err => log('error', 'Unhandled rejection:', err?.message ?? err));

// ═══════════════════════════════════════════════════════════════════════════════
//  HUGGINGFACE HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

async function hfFetch(filePath) {
    const url  = `https://huggingface.co/datasets/${CONFIG.hf.repo}/resolve/main/${filePath}`;
    const resp = await fetch(url, {
        headers: CONFIG.hf.token ? { Authorization: `Bearer ${CONFIG.hf.token}` } : {},
    });
    return resp;
}

async function hfUpload(fileBuffer, repoFilePath, mimeType = 'application/octet-stream') {
    const url  = `https://huggingface.co/api/datasets/${CONFIG.hf.repo}/upload/${repoFilePath}`;
    const resp = await fetch(url, {
        method:  'POST',
        headers: { Authorization: `Bearer ${CONFIG.hf.token}`, 'Content-Type': mimeType },
        body:    fileBuffer,
    });
    if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`HF upload failed (${resp.status}): ${body.slice(0, 200)}`);
    }
    return `https://huggingface.co/datasets/${CONFIG.hf.repo}/resolve/main/${repoFilePath}`;
}

async function downloadToBuffer(url) {
    const resp = await fetch(url, { redirect: 'follow' });
    if (!resp.ok) throw new Error(`Download failed (${resp.status}): ${url.slice(0, 80)}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    const ct     = resp.headers.get('content-type') || '';
    let ext      = '.bin';
    if      (ct.includes('jpeg') || ct.includes('jpg')) ext = '.jpg';
    else if (ct.includes('png'))   ext = '.png';
    else if (ct.includes('webp'))  ext = '.webp';
    else if (ct.includes('mp4') || ct.includes('video')) ext = '.mp4';
    else if (ct.includes('gif'))   ext = '.gif';
    if (ext === '.bin') {
        const m = new URL(url).pathname.match(/\.(jpg|jpeg|png|webp|mp4|gif)$/i);
        if (m) ext = '.' + m[1].toLowerCase();
    }
    return { buffer, ext, mimeType: ct.split(';')[0].trim() || 'application/octet-stream' };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STEP 1 — Sync data.json → MongoDB
// ═══════════════════════════════════════════════════════════════════════════════

async function syncDataJsonToMongo(collection) {
    log('info', '── Step 1: Syncing data.json → MongoDB ──');

    const resp = await hfFetch(CONFIG.hf.dataJson);
    if (!resp.ok) throw new Error(`Could not fetch data.json from HF (${resp.status}). Check repo/token.`);

    const postIds = await resp.json();
    if (!Array.isArray(postIds) || postIds.length === 0) {
        log('warn', 'data.json is empty or invalid — nothing to sync.');
        return 0;
    }
    log('info', `data.json contains ${postIds.length} post(s).`);

    const docs = postIds.map(pid => ({ post_id: pid, timestamp: Date.now() }));
    let inserted = 0;
    try {
        const result = await collection.insertMany(docs, { ordered: false });
        inserted = result.insertedCount;
    } catch (err) {
        if (err.code === 11000 || err.writeErrors) {
            inserted = err.result?.nInserted ?? err.insertedCount ?? 0;
        } else { throw err; }
    }

    log('info', `Sync complete. ${inserted} new post(s) inserted (duplicates ignored).`);
    return inserted;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  DOWNLOADER CLASS — extensible, one subclass per site
// ═══════════════════════════════════════════════════════════════════════════════

class InstagramDownloader {
    constructor(name) { this.name = name; }
    /** @returns {Promise<Array<{directUrl:string, uri:string|null}>>} */
    async extractLinks(_page, _postId) {
        throw new Error(`${this.name}.extractLinks() not implemented`);
    }
}

// ── fastdl.app ──────────────────────────────────────────────────────────────
class FastDLDownloader extends InstagramDownloader {
    constructor() { super('FastDL'); }

    async extractLinks(page, postId) {
        const igUrl = `https://www.instagram.com/${postId}/`;

        log('debug', `[FastDL] Navigating for ${postId}`);
        await page.goto('https://fastdl.app/en2', { waitUntil: 'domcontentloaded', timeout: CONFIG.timeouts.navigation });

        // Block images/media to speed up link discovery
        await page.setRequestInterception(true);
        page.on('request', req => {
            const rt = req.resourceType();
            if (rt === 'image' || rt === 'media' || rt === 'font') req.abort().catch(() => {});
            else req.continue().catch(() => {});
        });

        // Find the URL input
        const inputSel = [
            'input[type="text"][placeholder*="link" i]',
            'input[type="text"][placeholder*="paste" i]',
            'input[type="text"][placeholder*="insert" i]',
            'input[type="url"]',
        ].join(', ');
        await page.waitForSelector(inputSel, { timeout: 15_000 });
        await page.evaluate((sel, val) => { document.querySelector(sel).value = val; }, inputSel, igUrl);
        await page.keyboard.press('Enter');

        log('debug', `[FastDL] Submitted: ${igUrl}`);

        // Collect links with idle-reset strategy
        const PATTERN = /https:\/\/media\.fastdl\.app\/get/;
        const collected = new Set();
        let idleTimer = null;
        let resolve, reject;
        const waitP = new Promise((res, rej) => { resolve = res; reject = rej; });

        const resetIdle = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => resolve(), CONFIG.timeouts.idleReset);
        };

        // Hard deadline — fail if nothing at all appears
        const deadline = setTimeout(() => {
            if (collected.size === 0) reject(new Error('[FastDL] Timeout: no download links found'));
            else resolve();
        }, CONFIG.timeouts.downloaderIdle);

        const poll = setInterval(async () => {
            try {
                const found = await page.evaluate(pat => {
                    return [...document.querySelectorAll('a[href]')]
                        .map(a => a.href)
                        .filter(h => new RegExp(pat).test(h));
                }, PATTERN.source);
                let newFound = false;
                for (const link of found) {
                    if (!collected.has(link)) { collected.add(link); newFound = true; }
                }
                if (newFound) {
                    log('debug', `[FastDL] ${collected.size} link(s) so far for ${postId}`);
                    resetIdle();
                }
            } catch (_) {}
        }, 500);

        try {
            await waitP;
        } finally {
            clearInterval(poll);
            clearTimeout(deadline);
            clearTimeout(idleTimer);
        }

        // Re-query in DOM order to preserve carousel sequence
        const ordered = await page.evaluate(pat => {
            return [...document.querySelectorAll('a[href]')]
                .map(a => a.href)
                .filter(h => new RegExp(pat).test(h));
        }, PATTERN.source);

        const seen = new Set();
        const results = [];
        for (const href of ordered) {
            if (seen.has(href)) continue;
            seen.add(href);
            let uri = null;
            try {
                const raw = new URL(href).searchParams.get('uri');
                if (raw) uri = decodeURIComponent(raw);
            } catch (_) {}
            results.push({ directUrl: href, uri });
        }

        log('info', `[FastDL] ${results.length} link(s) for ${postId}`);
        return results;
    }
}

// Priority-ordered fallback chain — add more downloaders here
const DOWNLOADERS = [new FastDLDownloader()];

// ═══════════════════════════════════════════════════════════════════════════════
//  STEP 2 — Fetch un-downloaded posts
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchUndownloadedPosts(collection) {
    return collection.find({
        $or: [
            { downloaded: { $exists: false } },
            { downloaded: false },
            { downloaded: null },
        ],
    }).limit(CONFIG.batch.size).toArray();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STEPS 3-5 — Download, upload to HF, update MongoDB
// ═══════════════════════════════════════════════════════════════════════════════

function buildAssetFilename(postId, index, ext) {
    // "p/ABC" → "p-ABC-0.jpg"   "reel/ABC" → "reel-ABC-1.mp4"
    return `${postId.replace('/', '-')}-${index}${ext}`;
}

function mimeToType(mimeType, ext) {
    return (mimeType.startsWith('video') || ext === '.mp4') ? 'video' : 'image';
}

/**
 * Process one post: navigate downloader → collect links → download → upload HF.
 * The page passed in already has a ScreenRecorder attached.
 */
async function processPost(postDoc, page, recorder) {
    const postId = postDoc.post_id;
    log('info', `⬇  Processing: ${postId}`);
    await recorder.updateLabel(postId, 'NAVIGATING');

    let links = [];
    for (const downloader of DOWNLOADERS) {
        try {
            links = await downloader.extractLinks(page, postId);
            if (links.length > 0) break;
        } catch (err) {
            log('warn', `[${downloader.name}] Failed for ${postId}: ${err.message.slice(0, 120)}`);
        }
    }

    if (links.length === 0) throw new Error(`No download links found for ${postId}`);

    await recorder.updateLabel(postId, 'DOWNLOADING');

    const fileUrls = [];
    for (let i = 0; i < links.length; i++) {
        const { directUrl, uri } = links[i];
        const downloadUrl = uri || directUrl;
        log('debug', `  Downloading [${i}]: ${downloadUrl.slice(0, 80)}`);

        let buffer, ext, mimeType;
        try {
            ({ buffer, ext, mimeType } = await downloadToBuffer(downloadUrl));
        } catch (err) {
            if (uri && directUrl !== uri) {
                log('warn', `  URI failed, falling back to full URL: ${err.message.slice(0, 60)}`);
                ({ buffer, ext, mimeType } = await downloadToBuffer(directUrl));
            } else { throw err; }
        }

        const filename = buildAssetFilename(postId, i, ext);
        const repoPath = `${CONFIG.hf.assetsPath}/${filename}`;
        const type     = mimeToType(mimeType, ext);

        await recorder.updateLabel(postId, `UPLOADING [${i + 1}/${links.length}]`);
        log('debug', `  Uploading: ${repoPath} (${(buffer.length / 1024).toFixed(0)} KB)`);
        const hfUrl = await hfUpload(buffer, repoPath, mimeType);

        fileUrls.push({ url: hfUrl, type });
        log('info', `  ✓ [${i}] ${type}: ${hfUrl}`);
    }

    await recorder.updateLabel(postId, 'DONE');
    return fileUrls;
}

/**
 * Process posts in parallel chunks.  Each page gets its own ScreenRecorder.
 */
async function processBatch(posts, browser, collection) {
    const concurrency = Math.min(CONFIG.batch.concurrency, posts.length);
    const results     = { ok: 0, fail: 0 };

    for (let offset = 0; offset < posts.length; offset += concurrency) {
        const chunk = posts.slice(offset, offset + concurrency);

        await Promise.allSettled(chunk.map(async (postDoc) => {
            const page     = await browser.newPage();
            const recorder = new ScreenRecorder();
            activeRecorders.add(recorder);

            try {
                await page.setViewport({ width: 1280, height: 800 });
                await recorder.attach(page);
                await recorder.updateLabel(postDoc.post_id, 'STARTING');

                const fileUrls = await processPost(postDoc, page, recorder);

                await collection.updateOne(
                    { _id: postDoc._id },
                    { $set: { downloaded: true, file_urls: fileUrls } }
                );

                log('info', `✅ ${postDoc.post_id} — ${fileUrls.length} file(s) saved`);
                results.ok++;
            } catch (err) {
                log('error', `❌ ${postDoc.post_id} — ${err.message.slice(0, 200)}`);
                await recorder.updateLabel(postDoc.post_id, 'FAILED').catch(() => {});
                results.fail++;
            } finally {
                await recorder.stop();
                activeRecorders.delete(recorder);
                await page.close().catch(() => {});
            }
        }));

        if (offset + concurrency < posts.length) await sleep(2000);
    }

    return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MONGO SETUP
// ═══════════════════════════════════════════════════════════════════════════════

async function ensureIndexes(collection) {
    try {
        await collection.createIndex({ post_id: 1 }, { unique: true });
        log('debug', 'MongoDB: unique index on post_id confirmed.');
    } catch (e) {
        log('warn', 'MongoDB index: ' + e.message);
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════════════════

async function main() {
    const tStart = Date.now();
    log('info', '═══════════════════════════════════════════════════════════════');
    log('info', `ORCHESTRATOR  run=${CONFIG.runId}  batch=${CONFIG.batch.size}  concurrency=${CONFIG.batch.concurrency}`);
    log('info', `Recording: ${CONFIG.recording.enabled ? 'ON' : 'OFF'} | ${CONFIG.recording.fps}fps | ${CONFIG.recording.resolution}`);
    log('info', '═══════════════════════════════════════════════════════════════');

    if (!CONFIG.mongodb.uri) {
        log('error', 'ORCH_MONGODB_URI is required.');
        process.exit(1);
    }
    if (!CONFIG.hf.token) {
        log('error', 'ORCH_HF_TOKEN is required.');
        process.exit(1);
    }

    // ── MongoDB connect ──────────────────────────────────────────────────────
    log('info', 'Connecting to MongoDB…');
    const mongoClient = new MongoClient(CONFIG.mongodb.uri, { serverSelectionTimeoutMS: 15_000 });
    await mongoClient.connect();
    const db         = mongoClient.db(CONFIG.mongodb.db);
    const collection = db.collection(CONFIG.mongodb.collection);
    await ensureIndexes(collection);
    log('info', `MongoDB: connected → ${CONFIG.mongodb.db}.${CONFIG.mongodb.collection}`);

    // ── Step 1 ───────────────────────────────────────────────────────────────
    await syncDataJsonToMongo(collection);

    // ── Step 2 ───────────────────────────────────────────────────────────────
    log('info', '── Step 2: Fetching un-downloaded posts ──');
    const posts = await fetchUndownloadedPosts(collection);
    log('info', `Found ${posts.length} post(s) pending download.`);

    let downloadResults = { ok: 0, fail: 0 };

    if (posts.length > 0) {
        log('info', '── Steps 3-5: Download → HuggingFace → MongoDB ──');
        activeBrowser = await launch({
            headless: true,
            args: [
                '--no-sandbox', '--disable-setuid-sandbox',
                '--disable-dev-shm-usage', '--disable-gpu',
                '--window-size=1280,800',
            ],
        });

        try {
            downloadResults = await processBatch(posts, activeBrowser, collection);
        } finally {
            let closed = false;
            activeBrowser.close().then(() => { closed = true; }).catch(() => {});
            await sleep(3000);
            if (!closed) {
                try { const p = activeBrowser.process?.(); if (p) p.kill('SIGKILL'); } catch(_) {}
            }
            activeBrowser = null;
        }
    } else {
        log('info', 'No posts pending download — skipping browser phase.');
    }

    // ── Compile recordings ───────────────────────────────────────────────────
    if (CONFIG.recording.enabled) {
        log('info', 'Compiling recordings into one session video…');
        await compileRecordings();
    }

    // ── MongoDB close ────────────────────────────────────────────────────────
    await mongoClient.close();

    // ── Summary ──────────────────────────────────────────────────────────────
    const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
    log('info', '═══════════════════════════════════════════════════════════════');
    log('info', `DONE in ${elapsed}s`);
    log('info', `  Sync:     data.json → MongoDB (see logs above)`);
    log('info', `  Download: ${downloadResults.ok} OK | ${downloadResults.fail} FAIL out of ${posts.length} post(s)`);
    if (CONFIG.recording.enabled) log('info', `  Recording: ${RECORDINGS_DIR}`);
    log('info', '═══════════════════════════════════════════════════════════════');

    fs.writeFileSync(
        path.join(CONFIG.outputDir, 'orchestrator-summary.json'),
        JSON.stringify({
            runId: CONFIG.runId,
            timestamp: new Date().toISOString(),
            totalPending: posts.length,
            downloaded: downloadResults.ok,
            failed: downloadResults.fail,
            elapsedSeconds: parseFloat(elapsed),
            recording: CONFIG.recording.enabled,
        }, null, 2)
    );

    if (downloadResults.fail > 0) process.exitCode = 1;
}

main().catch(async err => {
    log('error', 'Fatal:', err.message);
    for (const rec of activeRecorders) await rec.stop().catch(() => {});
    await compileRecordings().catch(() => {});
    process.exit(1);
});
