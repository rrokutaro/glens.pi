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
import { createHash } from 'crypto';
import os from 'os';
import sharp from 'sharp';

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
    review: {
        enabled:          process.env.ORCH_REVIEW_ENABLED !== 'false', // on by default
        // How many individual file_urls entries (images only) to pull from
        // MongoDB and run through the Gemini reviewer in this run.
        fetchLimit:       parseInt(process.env.ORCH_REVIEW_FETCH_LIMIT     || '60',  10),
        // Collage constraints (mirrors the Infinite Collage Maker tool).
        maxRowsPerCollage: parseInt(process.env.ORCH_REVIEW_MAX_ROWS       || '4',   10),
        maxColsPerRow:     parseInt(process.env.ORCH_REVIEW_MAX_COLS       || '5',   10),
        targetRowHeight:   parseInt(process.env.ORCH_REVIEW_ROW_HEIGHT     || '480', 10),
        collageMaxWidth:   parseInt(process.env.ORCH_REVIEW_COLLAGE_WIDTH  || '2200',10),
        jpegQuality:       parseInt(process.env.ORCH_REVIEW_JPEG_QUALITY   || '82',  10),
        // Gemini model + keys (comma-separated list of API keys to rotate across).
        model:            process.env.ORCH_GEMINI_MODEL    || 'gemini-3.5-flash-lite',
        apiKeys:          (process.env.ORCH_GEMINI_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean),
        quotaCollection:  process.env.ORCH_GEMINI_QUOTA_COLLECTION || 'gemini_quotas',
        rateLimitCooldownMs: parseInt(process.env.ORCH_GEMINI_RATE_LIMIT_COOLDOWN_MS || String(10 * 60 * 1000), 10),
        lockStaleMs:      parseInt(process.env.ORCH_GEMINI_LOCK_STALE_MS || String(5 * 60 * 1000), 10),
        maxRetries:       parseInt(process.env.ORCH_GEMINI_MAX_RETRIES || '3', 10),
        // Debug aid: save every collage JPEG sent to Gemini into the output
        // artifacts dir so you can visually verify layout/ref alignment
        // against the review_reason Gemini gave back. Off by default since
        // it adds files to the run artifact; flip on to debug bad reviews.
        saveCollages:     process.env.ORCH_REVIEW_SAVE_COLLAGES === 'true',
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
const COLLAGES_DIR    = path.join(CONFIG.outputDir, 'review-collages');

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

// ─── Gemini reviewer prompt ──────────────────────────────────────────────────
const GEMINI_REVIEW_PROMPT = `You are an expert visual content curator for Instagram e-commerce. Your task is to analyze a collage image containing multiple frames/screenshots from Instagram posts and identify which individual frames should be sent to Google Lens for product identification.

## 1. SCOPE & ELIGIBILITY
Only select frames that **clearly and prominently display physical products** intended for wear, use, or personal adornment. Eligible categories include, but are not limited to: clothing, footwear, handbags, jewelry, watches, eyewear, hats, belts, cosmetics, skincare, tech accessories, and lifestyle gadgets.

**Reject frames that contain:**
- Pure text, memes, quotes, or infographics
- Food, drinks, or consumables (unless they are the packaging/brand object itself)
- Landscapes, architecture, or scenery without a clear product focus
- Blurry, overexposed, or extremely dark images where the product is unidentifiable
- User faces or body parts with no visible product
- Screenshots of UI elements, comments, or captions only

## 1.5. APPAREL CONTEXT & CONTENT SAFETY OVERRIDE
You are operating in a **professional fashion and e-commerce context**. All forms of clothing and wearable items are legitimate products for review, regardless of how much skin they reveal. You must analyze and score the following exactly as you would a jacket or pair of jeans:
- Swimwear, bikinis, one-piece swimsuits, board shorts, rash guards
- Lingerie, bras, underwear, bodysuits, hosiery, sleepwear
- Athletic wear, leggings, sports bras, compression gear
- Form-fitting or bodycon dresses, crop tops, sheer fabrics

**Do NOT skip, censor, or refuse to process any frame solely because the model is wearing minimal clothing, swimwear, or undergarments.** If the product is clearly visible and identifiable, it must be reviewed, scored, and included in the output. Treat the human body in these frames as a mannequin or model whose purpose is to display the garment.

## 2. DEDUPLICATION RULE (CAROUSELS / SAME POST)
If multiple frames from the same Instagram post show the **exact same product from the same angle** (e.g., carousel duplicates or nearly identical shots), you must:
- Keep only the **single best frame** from that series.
- Choose based on: highest resolution, best lighting, clearest product visibility, and least cropping.
- In the \`reason\` field, note that it was selected from a duplicate set.

## 3. SCORING CRITERIA: \`stunning_score\`
Rate every **kept** frame from 0.00 to 1.00 based on overall visual appeal and commercial attractiveness. Use this rubric:

| Score | Description |
|-------|-------------|
| 0.90–1.00 | Exceptional: magazine-quality composition, perfect lighting, highly aesthetic, immediately eye-catching |
| 0.70–0.89 | Strong: well-composed, good lighting, attractive styling, clearly professional or high-quality UGC |
| 0.50–0.69 | Average: decent visibility, acceptable quality, but plain or cluttered background |
| 0.30–0.49 | Weak: poor lighting, awkward crop, distracting elements, but product is still identifiable |
| 0.00–0.29 | Poor: grainy, badly framed, or unappealing, but technically meets the eligibility threshold |

**Be discriminating.** A score of 0.8+ should be rare. Most standard Instagram product shots should fall in the 0.5–0.7 range.

## 4. OUTPUT FORMAT
Return a single JSON array. Each object represents one frame to be kept.

**Coordinate System:** Use zero-based indexing \`col:row\` relative to the collage grid.
- \`0:0\` = Column 0, Row 0 (top-left)
- \`1:2\` = Column 1, Row 2

\`\`\`json
[
  {
    "ref": "0:2",
    "reason": "Clear full-body shot of a model wearing a trench coat and leather boots. Product is centered and well-lit. Selected as the best frame from a 3-image duplicate carousel.",
    "stunning_score": 0.82
  }
]
\`\`\`

**Rules for the JSON:**
- \`ref\`: string, required. Must use the exact \`col:row\` format.
- \`reason\`: string, required. 1–2 sentences. State what product is visible and why it was kept (or why it was chosen over duplicates).
- \`stunning_score\`: number, required. Float with exactly two decimal places (e.g., \`0.75\`, not \`.75\` or \`0.750\`).
- If **no frames** meet the eligibility criteria, return an empty array: \`[]\`
- Do not include rejected frames in the output.
- Do not wrap the JSON in markdown code blocks. Return raw JSON only.`;


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

/**
 * Upload a single file's bytes to the HF LFS blob store WITHOUT committing it
 * to the repo tree. This lets us push the bytes for many files first, and
 * only perform ONE git commit at the very end (avoids hitting the per-hour
 * commit rate limit when downloading many posts).
 *
 * @returns {Promise<{path:string, oid:string, size:number, url:string}>}
 */
async function hfUploadBlob(fileBuffer, repoFilePath) {
    const sha256 = createHash('sha256').update(fileBuffer).digest('hex');

    // Step 1: LFS batch — always returns an upload URL if the blob is missing
    const lfsResp = await fetch(`https://huggingface.co/datasets/${CONFIG.hf.repo}.git/info/lfs/objects/batch`, {
        method:  'POST',
        headers: {
            Authorization:  `Bearer ${CONFIG.hf.token}`,
            'Content-Type': 'application/vnd.git-lfs+json',
            Accept:         'application/vnd.git-lfs+json',
        },
        body: JSON.stringify({
            operation: 'upload',
            transfers: ['basic'],
            objects:   [{ oid: sha256, size: fileBuffer.length }],
        }),
    });

    if (!lfsResp.ok) {
        const body = await lfsResp.text().catch(() => '');
        throw new Error(`LFS batch failed (${lfsResp.status}): ${body.slice(0, 200)}`);
    }

    const lfsData   = await lfsResp.json();
    log('info', `  LFS batch → ${JSON.stringify(lfsData).slice(0, 300)}`);
    const obj       = lfsData.objects?.[0];
    const uploadUrl = obj?.actions?.upload?.href;

    // Step 2: PUT to S3 — only if LFS says the blob is missing
    if (uploadUrl) {
        const upHeaders = obj.actions.upload.header || {};
        const upResp = await fetch(uploadUrl, {
            method:  'PUT',
            headers: { ...upHeaders, 'Content-Type': 'application/octet-stream' },
            body:    fileBuffer,
        });
        if (!upResp.ok) {
            const body = await upResp.text().catch(() => '');
            throw new Error(`LFS PUT failed (${upResp.status}): ${body.slice(0, 200)}`);
        }
        log('info', `  LFS blob uploaded (${(fileBuffer.length / 1024).toFixed(0)} KB)`);

        // Step 2b: verify if LFS gave us a verify URL
        const verifyUrl     = obj?.actions?.verify?.href;
        const verifyHeaders = obj?.actions?.verify?.header || {};
        if (verifyUrl) {
            await fetch(verifyUrl, {
                method:  'POST',
                headers: { ...verifyHeaders, 'Content-Type': 'application/vnd.git-lfs+json' },
                body:    JSON.stringify({ oid: sha256, size: fileBuffer.length }),
            }).catch(() => {});
        }
    } else {
        log('info', `  LFS blob already exists on HF — skipping PUT`);
    }

    return {
        path: repoFilePath,
        oid:  sha256,
        size: fileBuffer.length,
        url:  `https://huggingface.co/datasets/${CONFIG.hf.repo}/resolve/main/${repoFilePath}`,
    };
}

/**
 * Commit a batch of already-uploaded LFS blobs (see hfUploadBlob) to the repo
 * tree in a SINGLE git commit. This is what actually consumes the HF
 * "commits per hour" rate limit, so callers should batch as many files as
 * possible into one call instead of committing per-file.
 *
 * @param {Array<{path:string, oid:string, size:number}>} lfsFiles
 * @param {string} summary
 */
async function hfCommitFiles(lfsFiles, summary) {
    if (!lfsFiles.length) return;

    const commitBody = {
        summary,
        files:    [],
        lfsFiles: lfsFiles.map(f => ({ path: f.path, oid: f.oid, size: f.size, algo: 'sha256' })),
    };

    const commitResp = await fetch(`https://huggingface.co/api/datasets/${CONFIG.hf.repo}/commit/main`, {
        method:  'POST',
        headers: {
            Authorization:  `Bearer ${CONFIG.hf.token}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(commitBody),
    });

    if (!commitResp.ok) {
        const body = await commitResp.text().catch(() => '');
        throw new Error(`HF commit failed (${commitResp.status}): ${body.slice(0, 200)}`);
    }

    log('info', `  📦 HF commit: ${lfsFiles.length} file(s) — "${summary}"`);
}

async function downloadToBuffer(url) {
    const resp = await fetch(url, { redirect: 'follow' });
    if (!resp.ok) throw new Error(`Download failed (${resp.status}): ${url.slice(0, 80)}`);

    const buffer = Buffer.from(await resp.arrayBuffer());
    const ct     = resp.headers.get('content-type') || '';

    // Catch error pages / empty responses before they reach HF
    if (buffer.length < 1024)
        throw new Error(`Too small (${buffer.length} bytes) — not real media: ${url.slice(0, 80)}`);
    if (ct.includes('text/html'))
        throw new Error(`Got HTML instead of media — link expired: ${url.slice(0, 80)}`);

    log('info', `  ✓ Downloaded ${(buffer.length / 1024).toFixed(0)} KB  ct=${ct}`);

    let ext = '.bin';
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
//  GEMINI API KEY ROTATION  (multi-instance safe, backed by MongoDB)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Mirrors the locking strategy from the user's existing code: each key has a
// quota doc in `gemini_quotas`. We lock the least-recently-used, non-rate-
// limited key, use it, then release the lock (and record rate_limited_until
// on 429s) when done.

function getRandomKeyFallback() {
    const keys = CONFIG.review.apiKeys;
    if (!keys.length) return null;
    return keys[Math.floor(Math.random() * keys.length)];
}

/** Ensure every configured API key has a quota doc in MongoDB (idempotent). */
async function ensureGeminiQuotaDocs(db) {
    if (!CONFIG.review.apiKeys.length) return;
    const quotaCollection = db.collection(CONFIG.review.quotaCollection);
    try {
        await quotaCollection.createIndex({ key_hash: 1 }, { unique: true });
    } catch (e) {
        log('warn', 'MongoDB gemini_quotas index: ' + e.message);
    }
    for (const key of CONFIG.review.apiKeys) {
        const keyHash = createHash('sha256').update(key).digest('hex').slice(0, 16);
        await quotaCollection.updateOne(
            { key_hash: keyHash },
            {
                $setOnInsert: {
                    key_hash:   keyHash,
                    api_key:    key,
                    locked_by:  null,
                    locked_at:  null,
                    'quota.last_used': 0,
                    'quota.uses':      0,
                    rate_limited_until: 0,
                },
            },
            { upsert: true }
        );
    }
}

/**
 * Lock and return the best available Gemini API key (least-recently-used,
 * not currently locked by another instance, not rate-limited).
 * @returns {Promise<{keyHash:string, apiKey:string} | null>}
 */
async function getBestGeminiApiKey(db) {
    const quotaCollection = db.collection(CONFIG.review.quotaCollection);
    const instanceId = process.env.INSTANCE_ID || os.hostname();
    const staleThreshold = Date.now() - CONFIG.review.lockStaleMs;

    const result = await quotaCollection.findOneAndUpdate(
        {
            $and: [
                {
                    $or: [
                        { locked_by: null },
                        { locked_by: { $exists: false } },
                        { locked_at: { $lt: staleThreshold } },
                    ],
                },
                {
                    $or: [
                        { rate_limited_until: { $exists: false } },
                        { rate_limited_until: { $lt: Date.now() } },
                    ],
                },
            ],
        },
        { $set: { locked_by: instanceId, locked_at: Date.now() } },
        { sort: { 'quota.last_used': 1 }, returnDocument: 'after' }
    );

    if (!result) {
        log('warn', 'Gemini: no available DB key (all locked/rate-limited) — falling back to random config key');
        const fallback = getRandomKeyFallback();
        return fallback ? { keyHash: null, apiKey: fallback } : null;
    }

    log('debug', `Gemini: locked key ${result.key_hash}`);
    return { keyHash: result.key_hash, apiKey: result.api_key };
}

/** Release a key's lock and bump its usage stats. */
async function releaseGeminiApiKey(db, keyHash) {
    if (!keyHash) return;
    const quotaCollection = db.collection(CONFIG.review.quotaCollection);
    await quotaCollection.updateOne(
        { key_hash: keyHash },
        {
            $set:  { locked_by: null, locked_at: null, 'quota.last_used': Date.now() },
            $inc:  { 'quota.uses': 1 },
        }
    ).catch(err => log('warn', `Gemini: failed to release key ${keyHash}: ${err.message}`));
}

/** Mark a key as rate-limited for a cooldown period and release its lock. */
async function markGeminiKeyRateLimited(db, keyHash) {
    if (!keyHash) return;
    const quotaCollection = db.collection(CONFIG.review.quotaCollection);
    await quotaCollection.updateOne(
        { key_hash: keyHash },
        {
            $set: {
                locked_by: null,
                locked_at: null,
                rate_limited_until: Date.now() + CONFIG.review.rateLimitCooldownMs,
            },
        }
    ).catch(err => log('warn', `Gemini: failed to flag key ${keyHash} as rate-limited: ${err.message}`));
}

// ═══════════════════════════════════════════════════════════════════════════════
//  COLLAGE BUILDER  (ports the Infinite Collage Maker's justified-row layout)
// ═══════════════════════════════════════════════════════════════════════════════
//
// Same algorithm as calculateLayout()/renderToCanvas() in the collage tool:
// greedily fill a row by accumulating width/height ratios until the row's
// projected height drops to the target, then justify (stretch) that row to
// exactly fill the canvas width. The final, incomplete row is left
// unjustified at natural size.
//
// UNLIKE the original HTML tool (which only optimizes for a nice-looking
// visual grid and lets a row hold as many images as fit the height target),
// this version ALSO caps columns per row at CONFIG.review.maxColsPerRow.
// Without that cap, narrow/portrait images can pack 6-7+ frames into a single
// row while still satisfying the height target — each frame then shrinks to
// a sliver too small for the AI to actually make out any product detail.
// Rows are capped at maxRowsPerCollage AND maxColsPerRow — once either cap is
// hit, remaining images spill into a new collage entirely.

/** @returns {Array<{images: Array<{item:any, ratio:number}>, height:number, isJustified:boolean}>} */
function calculateCollageLayout(items, containerWidth, targetRowHeight, maxRows, maxCols) {
    const rows = [];
    let currentRow = [];
    let currentRatioSum = 0;

    for (const item of items) {
        if (rows.length >= maxRows) break; // row cap reached — caller starts a new collage with leftovers

        const ratio = item.width / item.height;
        currentRow.push({ item, ratio });
        currentRatioSum += ratio;
        const projectedHeight = containerWidth / currentRatioSum;

        // Close the row once it's either (a) hit the target height, justified,
        // OR (b) hit the max-columns cap — whichever comes first. Without the
        // column cap, a row of many narrow/portrait images can satisfy the
        // height target while packing in far too many frames to be visually
        // distinguishable (e.g. 6-7+ images crammed into one 1600px-wide row).
        if (projectedHeight <= targetRowHeight) {
            rows.push({ images: currentRow, height: projectedHeight, isJustified: true });
            currentRow = [];
            currentRatioSum = 0;
        } else if (currentRow.length >= maxCols) {
            // Hit the column cap before reaching the target height — justify
            // anyway (stretches slightly taller than targetRowHeight) so we
            // never exceed maxCols frames in a single row.
            rows.push({ images: currentRow, height: projectedHeight, isJustified: true });
            currentRow = [];
            currentRatioSum = 0;
        }
    }

    if (currentRow.length > 0 && rows.length < maxRows) {
        rows.push({ images: currentRow, height: targetRowHeight, isJustified: false });
    }

    return rows;
}

/**
 * Split `items` (each needs .width/.height/.buffer) into chunks that each fit
 * within maxRowsPerCollage × maxColsPerRow, mirroring the same greedy
 * row-fill logic so the chunk boundaries match exactly where a real collage
 * would start a new row beyond either cap.
 */
function chunkItemsIntoCollages(items, containerWidth, targetRowHeight, maxRows, maxCols) {
    const collages = [];
    let remaining = items.slice();

    while (remaining.length > 0) {
        const rows = calculateCollageLayout(remaining, containerWidth, targetRowHeight, maxRows, maxCols);
        const used = rows.reduce((sum, r) => sum + r.images.length, 0);
        if (used === 0) break; // safety guard against infinite loop
        collages.push({ rows, items: remaining.slice(0, used) });
        remaining = remaining.slice(used);
    }

    return collages;
}

/**
 * Render one collage (a set of justified rows) to a JPEG buffer using sharp,
 * and return a map of `col:row` → original item, so the caller can translate
 * Gemini's refs back to file_urls/post_id.
 *
 * @returns {Promise<{buffer: Buffer, refMap: Map<string, any>}>}
 */
async function renderCollage(rows, containerWidth, quality) {
    const totalHeight = Math.round(rows.reduce((sum, r) => sum + r.height, 0));
    const refMap = new Map();
    const composites = [];

    let y = 0;
    for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
        const row = rows[rowIdx];
        let x = 0;
        for (let colIdx = 0; colIdx < row.images.length; colIdx++) {
            const { item, ratio } = row.images[colIdx];
            let w = row.height * ratio;
            const drawX = Math.floor(x);
            const drawY = Math.floor(y);
            let drawW = Math.ceil(w);
            const drawH = Math.ceil(row.height);
            if (row.isJustified && colIdx === row.images.length - 1) {
                drawW = Math.ceil(containerWidth - x);
            }

            const resized = await sharp(item.buffer)
                .resize(Math.max(1, drawW), Math.max(1, drawH), { fit: 'fill' })
                .toBuffer();

            composites.push({ input: resized, left: drawX, top: drawY });
            refMap.set(`${colIdx}:${rowIdx}`, item);

            x += w;
        }
        y += row.height;
    }

    const buffer = await sharp({
        create: {
            width:      Math.round(containerWidth),
            height:     totalHeight,
            channels:   3,
            background: { r: 13, g: 13, b: 13 }, // matches --bg: #0d0d0d
        },
    })
        .composite(composites)
        .jpeg({ quality })
        .toBuffer();

    return { buffer, refMap };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  GEMINI REVIEWER CALL
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Send one collage image to Gemini with the review prompt, rotating API keys
 * via MongoDB-backed locking, with retry on 429 (rotates to a different key).
 * @returns {Promise<Array<{ref:string, reason:string, stunning_score:number}>>}
 */
async function reviewCollageWithGemini(db, collageBuffer) {
    const base64 = collageBuffer.toString('base64');
    let lastErr = null;

    for (let attempt = 0; attempt < CONFIG.review.maxRetries; attempt++) {
        const keyInfo = await getBestGeminiApiKey(db);
        if (!keyInfo || !keyInfo.apiKey) {
            throw new Error('No Gemini API key available (none configured or all rate-limited)');
        }

        const { keyHash, apiKey } = keyInfo;
        try {
            const resp = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.review.model}:generateContent?key=${apiKey}`,
                {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{
                            parts: [
                                { text: GEMINI_REVIEW_PROMPT },
                                { inline_data: { mime_type: 'image/jpeg', data: base64 } },
                            ],
                        }],
                        generationConfig: {
                            temperature: 0.2,
                            responseMimeType: 'application/json',
                        },
                    }),
                }
            );

            if (resp.status === 429) {
                log('warn', `Gemini: 429 rate-limited on key ${keyHash ?? '(fallback)'} — rotating`);
                await markGeminiKeyRateLimited(db, keyHash);
                lastErr = new Error('Gemini 429 rate limited');
                continue;
            }

            if (!resp.ok) {
                const body = await resp.text().catch(() => '');
                await releaseGeminiApiKey(db, keyHash);
                throw new Error(`Gemini API error (${resp.status}): ${body.slice(0, 300)}`);
            }

            const data = await resp.json();
            await releaseGeminiApiKey(db, keyHash);

            const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!text) throw new Error('Gemini response missing text content');

            const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '');
            const parsed = JSON.parse(cleaned);
            if (!Array.isArray(parsed)) throw new Error('Gemini response was not a JSON array');
            return parsed;
        } catch (err) {
            if (err.message?.includes('429')) continue; // already rotated above
            lastErr = err;
            log('warn', `Gemini: attempt ${attempt + 1}/${CONFIG.review.maxRetries} failed: ${err.message.slice(0, 200)}`);
        }
    }

    throw lastErr || new Error('Gemini review failed after retries');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  REVIEW STAGE — fetch unreviewed images, collage, send to Gemini, reconcile
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Pull up to `limit` individual image file_urls entries (across any posts)
 * that have not yet been reviewed (no `reviewed:true` on the entry itself),
 * tagged with their parent post_id and their index within that post's
 * file_urls array, so we can map results back after review.
 *
 * @returns {Promise<Array<{postId:string, postObjectId:any, fileIndex:number, url:string, type:string}>>}
 */
async function fetchUnreviewedFiles(collection, limit) {
    const cursor = collection.aggregate([
        { $match: { file_urls: { $exists: true, $ne: [] } } },
        { $project: { post_id: 1, file_urls: 1 } },
        { $unwind: { path: '$file_urls', includeArrayIndex: 'fileIndex' } },
        { $match: {
            'file_urls.type': 'image',
            'file_urls.reviewed': { $ne: true },
        } },
        { $limit: limit },
    ]);

    const docs = await cursor.toArray();
    return docs.map(d => ({
        postId:       d.post_id,
        postObjectId: d._id,
        fileIndex:    d.fileIndex,
        url:          d.file_urls.url,
        type:         d.file_urls.type,
    }));
}

/** Download an image file's bytes + dimensions for collage building. */
async function fetchImageForCollage(fileEntry) {
    // file_urls point at our own HuggingFace dataset repo, which may be
    // private — send the same bearer token used for upload/commit, mirroring
    // hfFetch(). Harmless to send on public repos too.
    const headers = CONFIG.hf.token ? { Authorization: `Bearer ${CONFIG.hf.token}` } : {};
    const resp = await fetch(fileEntry.url, { redirect: 'follow', headers });
    if (!resp.ok) throw new Error(`Failed to fetch image for review (${resp.status}): ${fileEntry.url.slice(0, 80)}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    const meta = await sharp(buffer).metadata();
    return { ...fileEntry, buffer, width: meta.width || 1, height: meta.height || 1 };
}

/**
 * Run the full review stage:
 *  1. Fetch up to fetchLimit unreviewed image file_urls (across posts).
 *  2. Download bytes + build collages respecting maxRowsPerCollage.
 *  3. Send each collage to Gemini; mark kept refs reviewed:true immediately.
 *  4. After ALL collages are processed, remove every file_urls entry that
 *     was part of this batch but NOT kept, in one bulk operation.
 */
async function runReviewStage(db, collection) {
    log('info', '── Review Stage: Fetching unreviewed images ──');

    await ensureGeminiQuotaDocs(db);

    const candidates = await fetchUnreviewedFiles(collection, CONFIG.review.fetchLimit);
    log('info', `Found ${candidates.length} unreviewed image file(s) (limit=${CONFIG.review.fetchLimit}).`);

    const results = { reviewed: 0, kept: 0, rejected: 0, collages: 0, failed: 0 };
    if (candidates.length === 0) return results;

    if (!CONFIG.review.apiKeys.length) {
        log('warn', 'No Gemini API keys configured (ORCH_GEMINI_API_KEYS) — skipping review stage.');
        return results;
    }

    // Download all candidate image bytes + dimensions up front.
    const downloaded = [];
    for (const fileEntry of candidates) {
        try {
            downloaded.push(await fetchImageForCollage(fileEntry));
        } catch (err) {
            log('warn', `Review: skipping unfetchable image — ${err.message.slice(0, 150)}`);
            results.failed++;
        }
    }

    const collages = chunkItemsIntoCollages(
        downloaded,
        CONFIG.review.collageMaxWidth,
        CONFIG.review.targetRowHeight,
        CONFIG.review.maxRowsPerCollage,
        CONFIG.review.maxColsPerRow
    );
    log('info', `Built ${collages.length} collage(s) from ${downloaded.length} image(s) (max ${CONFIG.review.maxRowsPerCollage} rows × ${CONFIG.review.maxColsPerRow} cols each).`);

    // Track every entry that went through review, so we know what to remove
    // at the end if it wasn't explicitly kept.
    const allProcessed = []; // { postObjectId, postId, fileIndex, url }
    const keptKeys = new Set(); // `${postObjectId}:${fileIndex}`

    for (let i = 0; i < collages.length; i++) {
        const { rows, items } = collages[i];
        log('info', `Review: collage ${i + 1}/${collages.length} — ${items.length} image(s), ${rows.length} row(s)`);

        for (const item of items) allProcessed.push(item);

        let refMap;
        let collageBuffer;
        try {
            const rendered = await renderCollage(rows, CONFIG.review.collageMaxWidth, CONFIG.review.jpegQuality);
            collageBuffer = rendered.buffer;
            refMap = rendered.refMap;
        } catch (err) {
            log('error', `Review: failed to render collage ${i + 1}: ${err.message.slice(0, 200)}`);
            results.failed += items.length;
            continue;
        }

        results.collages++;

        // Debug aid: persist the exact JPEG bytes sent to Gemini so you can
        // visually cross-check layout/ref alignment against the
        // review_reason it returns. Saved BEFORE the Gemini call so the
        // artifact exists even if that call fails. Does not affect review
        // logic at all — purely a side-effect write to disk.
        if (CONFIG.review.saveCollages) {
            try {
                fs.mkdirSync(COLLAGES_DIR, { recursive: true });
                const collageFilename = `collage_${CONFIG.runId}_${String(i + 1).padStart(2, '0')}.jpg`;
                fs.writeFileSync(path.join(COLLAGES_DIR, collageFilename), collageBuffer);

                // Sidecar JSON: ref -> which post/file this frame actually is,
                // so you can cross-check Gemini's reason text against ground
                // truth without guessing from pixel position alone.
                const refMapJson = {};
                for (const [ref, item] of refMap.entries()) {
                    refMapJson[ref] = { postId: item.postId, fileIndex: item.fileIndex, url: item.url };
                }
                const sidecarFilename = `collage_${CONFIG.runId}_${String(i + 1).padStart(2, '0')}.refmap.json`;
                fs.writeFileSync(path.join(COLLAGES_DIR, sidecarFilename), JSON.stringify(refMapJson, null, 2));

                log('info', `Review: saved collage artifact → ${collageFilename} (+ refmap)`);
            } catch (err) {
                log('warn', `Review: failed to save collage artifact for collage ${i + 1}: ${err.message.slice(0, 150)}`);
            }
        }

        let kept;
        try {
            kept = await reviewCollageWithGemini(db, collageBuffer);
        } catch (err) {
            log('error', `Review: Gemini call failed for collage ${i + 1}: ${err.message.slice(0, 200)}`);
            results.failed += items.length;
            continue;
        }

        for (const decision of kept) {
            const item = refMap.get(decision.ref);
            if (!item) {
                log('warn', `Review: Gemini returned unknown ref "${decision.ref}" — ignoring`);
                continue;
            }

            const key = `${item.postObjectId}:${item.fileIndex}`;
            keptKeys.add(key);

            // Mark kept file immediately as reviewed:true on its post document.
            try {
                await collection.updateOne(
                    { _id: item.postObjectId },
                    { $set: {
                        [`file_urls.${item.fileIndex}.reviewed`]:       true,
                        [`file_urls.${item.fileIndex}.stunning_score`]: decision.stunning_score,
                        [`file_urls.${item.fileIndex}.review_reason`]:  decision.reason,
                    } }
                );
                results.kept++;
            } catch (err) {
                log('error', `Review: failed to mark kept file reviewed (post ${item.postId}, idx ${item.fileIndex}): ${err.message}`);
            }
        }

        results.reviewed += items.length;
        log('info', `Review: collage ${i + 1} — ${kept.length}/${items.length} frame(s) kept`);
    }

    // ── Remove every processed-but-not-kept file_urls entry, in one pass ──
    const rejected = allProcessed.filter(item => !keptKeys.has(`${item.postObjectId}:${item.fileIndex}`));
    log('info', `Review: ${rejected.length} rejected file(s) to remove across affected posts.`);

    if (rejected.length > 0) {
        // Group rejected file URLs by post so we can $pull all of them for a
        // post in a single update (file_urls.url is unique per post here).
        const byPost = new Map();
        for (const item of rejected) {
            if (!byPost.has(String(item.postObjectId))) byPost.set(String(item.postObjectId), { postObjectId: item.postObjectId, urls: [] });
            byPost.get(String(item.postObjectId)).urls.push(item.url);
        }

        const bulkOps = [...byPost.values()].map(({ postObjectId, urls }) => ({
            updateOne: {
                filter: { _id: postObjectId },
                update: { $pull: { file_urls: { url: { $in: urls } } } },
            },
        }));

        try {
            await collection.bulkWrite(bulkOps, { ordered: false });
            results.rejected = rejected.length;
            log('info', `Review: removed ${rejected.length} rejected file(s) across ${bulkOps.length} post(s) in one bulk operation.`);
        } catch (err) {
            log('error', `Review: bulk removal of rejected files failed: ${err.message}`);
        }
    }

    return results;
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

    const existing = await collection.distinct('post_id', { post_id: { $in: postIds } });
    const existingSet = new Set(existing);
    const newPostIds = postIds.filter(pid => !existingSet.has(pid));
    
    if (newPostIds.length === 0) {
        log('info', 'Sync complete. 0 new post(s) — all post_ids already in MongoDB.');
        return 0;
    }
    
    const docs = newPostIds.map(pid => ({ post_id: pid, timestamp: Date.now() }));
    let inserted = 0;
    try {
        const result = await collection.insertMany(docs, { ordered: false });
        inserted = result.insertedCount;
    } catch (err) {
        if (err.code === 11000 || err.writeErrors) {
            inserted = err.result?.nInserted ?? err.insertedCount ?? 0;
        } else { throw err; }
    }
    
    log('info', `Sync complete. ${inserted} new post(s) inserted (${postIds.length - newPostIds.length} already existed).`);
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

        log('info', `[FastDL] Processing ${postId}`);

        await page.goto('https://fastdl.app/en3', {
            waitUntil: 'domcontentloaded',
            timeout: CONFIG.timeouts.navigation,
        });

        const inputSel = '#search-form-input';
        await page.waitForSelector(inputSel, { timeout: 15_000 });

        // Click to focus, select all existing text, then delete it — fires real events
        await page.click(inputSel, { clickCount: 3 });
        await page.keyboard.press('Backspace');

        // Type the URL character-by-character so input/change events fire correctly
        await page.type(inputSel, igUrl, { delay: 10 });

        // Dispatch a native input event in case the site uses a framework listener
        await page.evaluate(sel => {
            const el = document.querySelector(sel);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }, inputSel);

        await page.click('#searchFormButton');

        log('debug', `[FastDL] Submitted: ${igUrl}`);

        await page.waitForFunction(() => {
            if (document.querySelectorAll('a.button__download[href*="media.fastdl.app"]').length > 0) return true;
            if (document.querySelectorAll('a[href*="media.fastdl.app/get"]').length > 0) return true;
            const items = document.querySelectorAll('.output-list__item');
            if (items.length > 0 && items[0].querySelector('a[href]')) return true;
            return false;
        }, { timeout: CONFIG.timeouts.downloaderIdle });

        await sleep(2000);

        const results = await page.evaluate(() => {
            const items = [];
            const seen  = new Set();

            let anchors = [...document.querySelectorAll('a.button__download[href*="media.fastdl.app"]')];
            if (anchors.length === 0)
                anchors = [...document.querySelectorAll('a[href*="media.fastdl.app/get"]')];
            if (anchors.length === 0)
                anchors = [...document.querySelectorAll('.output-list__item a[href]')];

            for (const a of anchors) {
                const href = a.href;
                if (!href || seen.has(href)) continue;
                seen.add(href);

                let directUrl = href;
                let uri       = null;
                try {
                    const uriParam = new URL(href).searchParams.get('uri');
                    if (uriParam) {
                        uri       = decodeURIComponent(uriParam);
                        directUrl = uri;
                    }
                } catch (_) {}

                items.push({ directUrl, uri: uri || href });
            }

            return items;
        });

        log('info', `[FastDL] ✅ ${results.length} link(s) for ${postId}`);

        if (results.length === 0) {
            const safeName = postId.replace(/[^a-z0-9]/gi, '');
            await page.screenshot({
                path: path.join(CONFIG.tmpDir, `fastdl-debug-${safeName}-${Date.now()}.png`),
            }).catch(() => {});
        }

        return results;
    }
}

class SnapInstaDownloader extends InstagramDownloader {
    constructor() { super('SnapInsta'); }

    async extractLinks(page, postId) {
        const igUrl = `https://www.instagram.com/${postId}/`;

        log('info', `[SnapInsta] Processing ${postId}`);

        await page.goto('https://snapinsta.to/en5', {
            waitUntil: 'domcontentloaded',
            timeout: CONFIG.timeouts.navigation,
        });

        await page.waitForSelector('#s_input', { timeout: 15_000 });

        // Triple-click to select any pre-existing value, then delete it — fires real events
        await page.click('#s_input', { clickCount: 3 });
        await page.keyboard.press('Backspace');

        // Type character-by-character so the site's input listeners track the value
        await page.type('#s_input', igUrl, { delay: 10 });

        // Dispatch native input/change events for framework-based validation
        await page.evaluate(() => {
            const el = document.querySelector('#s_input');
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });

        await page.click('button[onclick*="ksearchvideo"]');

        log('debug', `[SnapInsta] Submitted: ${igUrl}`);

        await page.waitForFunction(() => {
            return document.querySelector('#search-result ul.download-box') !== null;
        }, { timeout: CONFIG.timeouts.downloaderIdle });

        await sleep(1500);

        const results = await page.evaluate(() => {
            const items = [];
            const seen  = new Set();

            document.querySelectorAll('a.abutton.btn-premium[href*="dl.snapcdn.app"]').forEach(a => {
                const href = a.href;
                if (!href || seen.has(href)) return;
                seen.add(href);
                items.push({ directUrl: href, uri: href });
            });

            if (items.length === 0) {
                document.querySelectorAll('a[href*="dl.snapcdn.app"]').forEach(a => {
                    const href = a.href;
                    if (!href || seen.has(href)) return;
                    seen.add(href);
                    items.push({ directUrl: href, uri: href });
                });
            }

            if (items.length === 0) {
                document.querySelectorAll('.download-items select.minimal').forEach(sel => {
                    const first = sel.options[0]?.value;
                    if (first && !seen.has(first)) {
                        seen.add(first);
                        items.push({ directUrl: first, uri: first });
                    }
                });
            }

            return items;
        });

        log('info', `[SnapInsta] ✅ ${results.length} link(s) for ${postId}`);

        if (results.length === 0) {
            const safeName = postId.replace(/[^a-z0-9]/gi, '');
            await page.screenshot({
                path: path.join(CONFIG.tmpDir, `snapinsta-debug-${safeName}-${Date.now()}.png`),
            }).catch(() => {});
        }

        return results;
    }
}

class InSaverDownloader extends InstagramDownloader {
    constructor() { super('InSaver'); }

    async extractLinks(page, postId) {
        const igUrl = `https://www.instagram.com/${postId}/`;

        log('info', `[InSaver] Processing ${postId}`);

        await page.goto('https://insaver.to/en', {
            waitUntil: 'domcontentloaded',
            timeout: CONFIG.timeouts.navigation,
        });

        await page.waitForSelector('#s_input', { timeout: 15_000 });

        await page.click('#s_input', { clickCount: 3 });
        await page.keyboard.press('Backspace');
        await page.type('#s_input', igUrl, { delay: 10 });

        await page.evaluate(() => {
            const el = document.querySelector('#s_input');
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });

        await page.click('button[onclick*="ksearchvideo"]');

        log('debug', `[InSaver] Submitted: ${igUrl}`);

        await page.waitForFunction(() => {
            return document.querySelector('#search-result ul.download-box') !== null
                && document.querySelector('#search-result ul.download-box li') !== null;
        }, { timeout: CONFIG.timeouts.downloaderIdle });

        await sleep(1500);

        const results = await page.evaluate(() => {
            const items = [];
            const seen  = new Set();

            document.querySelectorAll('#search-result .download-items').forEach(item => {
                // For photos: grab the highest-res option (first <option> value)
                const select = item.querySelector('.photo-option select.minimal');
                if (select && select.options.length > 0) {
                    const href = select.options[0].value;
                    if (href && !seen.has(href)) {
                        seen.add(href);
                        items.push({ directUrl: href, uri: href });
                    }
                    return;
                }

                // For videos: grab the btn-premium href
                const btn = item.querySelector('a.btn-premium[href*="dl.snapcdn.app"]');
                if (btn) {
                    const href = btn.href;
                    if (href && !seen.has(href)) {
                        seen.add(href);
                        items.push({ directUrl: href, uri: href });
                    }
                }
            });

            return items;
        });

        log('info', `[InSaver] ✅ ${results.length} link(s) for ${postId}`);

        if (results.length === 0) {
            const safeName = postId.replace(/[^a-z0-9]/gi, '');
            await page.screenshot({
                path: path.join(CONFIG.tmpDir, `insaver-debug-${safeName}-${Date.now()}.png`),
            }).catch(() => {});
        }

        return results;
    }
}

// Priority-ordered fallback chain
// const DOWNLOADERS = [new SnapInstaDownloader(), new InSaverDownloader(), new FastDLDownloader()];
const DOWNLOADERS = [new InSaverDownloader(), new SnapInstaDownloader(), new FastDLDownloader()];

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
 * Process one post: navigate downloader → collect links → download → upload HF blob.
 * The page passed in already has a ScreenRecorder attached.
 *
 * NOTE: this uploads file bytes to HF's LFS store but does NOT commit them to
 * the repo tree yet — that happens once, in a single batched commit, after
 * ALL posts in this run have finished downloading (see processBatch/main).
 *
 * @returns {Promise<{fileUrls: Array<{url:string,type:string}>, lfsFiles: Array<{path:string,oid:string,size:number}>}>}
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
    const lfsFiles = [];
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
        log('debug', `  Uploading blob: ${repoPath} (${(buffer.length / 1024).toFixed(0)} KB)`);
        const blob = await hfUploadBlob(buffer, repoPath);

        fileUrls.push({ url: blob.url, type });
        lfsFiles.push({ path: blob.path, oid: blob.oid, size: blob.size });
        log('info', `  ✓ [${i}] ${type}: ${blob.url}`);
    }

    await recorder.updateLabel(postId, 'DONE');
    return { fileUrls, lfsFiles };
}

/**
 * Process posts in parallel chunks.  Each page gets its own ScreenRecorder.
 *
 * All file blobs are uploaded to HF during this pass, but the repo commit and
 * the MongoDB `downloaded:true` update are both deferred until every post has
 * been attempted — see the comment in main(). This guarantees we only ever
 * make ONE HF commit per run (avoiding the commits-per-hour rate limit) and
 * that MongoDB is only updated for posts whose assets are confirmed committed.
 */
async function processBatch(posts, browser, collection) {
    const concurrency = Math.min(CONFIG.batch.concurrency, posts.length);
    const results      = { ok: 0, fail: 0 };
    const pendingCommit = []; // { postDoc, fileUrls, lfsFiles }

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

                const { fileUrls, lfsFiles } = await processPost(postDoc, page, recorder);

                pendingCommit.push({ postDoc, fileUrls, lfsFiles });

                log('info', `✅ ${postDoc.post_id} — ${fileUrls.length} file(s) uploaded (pending commit)`);
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

    // ── Single batched HF commit for every uploaded file across all posts ──
    const allLfsFiles = pendingCommit.flatMap(p => p.lfsFiles);
    if (allLfsFiles.length > 0) {
        log('info', `── Committing ${allLfsFiles.length} file(s) across ${pendingCommit.length} post(s) to HuggingFace in ONE commit ──`);
        try {
            await hfCommitFiles(allLfsFiles, `orchestrator: add assets for ${pendingCommit.length} post(s) [run ${CONFIG.runId}]`);

            // Commit succeeded — now (and only now) mark posts as downloaded in MongoDB.
            for (const { postDoc, fileUrls } of pendingCommit) {
                try {
                    await collection.updateOne(
                        { _id: postDoc._id },
                        { $set: { downloaded: true, file_urls: fileUrls } }
                    );
                } catch (err) {
                    log('error', `MongoDB update failed for ${postDoc.post_id} after successful HF commit: ${err.message}`);
                    results.ok--;
                    results.fail++;
                }
            }
        } catch (err) {
            // Commit failed — do NOT mark any of these posts as downloaded, since
            // their assets are not actually committed on HF yet. They'll be
            // retried (re-downloaded) on the next run.
            log('error', `HF batch commit failed — MongoDB will NOT be updated for this run's ${pendingCommit.length} post(s): ${err.message}`);
            results.ok -= pendingCommit.length;
            results.fail += pendingCommit.length;
        }
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

    // ── Step 6 — AI Review (Gemini) ──────────────────────────────────────────
    let reviewResults = { reviewed: 0, kept: 0, rejected: 0, collages: 0, failed: 0 };
    if (CONFIG.review.enabled) {
        log('info', '── Step 6: AI Review (Gemini) ──');
        try {
            reviewResults = await runReviewStage(db, collection);
        } catch (err) {
            log('error', `Review stage failed: ${err.message}`);
        }
    } else {
        log('info', 'Review stage disabled (ORCH_REVIEW_ENABLED=false) — skipping.');
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
    if (CONFIG.review.enabled) log('info', `  Review:   ${reviewResults.reviewed} reviewed | ${reviewResults.kept} kept | ${reviewResults.rejected} rejected | ${reviewResults.collages} collage(s) | ${reviewResults.failed} failed`);
    if (CONFIG.review.enabled && CONFIG.review.saveCollages) log('info', `  Collages: ${COLLAGES_DIR}`);
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
            review: CONFIG.review.enabled ? reviewResults : null,
            collagesSaved: CONFIG.review.enabled && CONFIG.review.saveCollages,
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
