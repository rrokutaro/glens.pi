import { launch } from 'cloakbrowser/puppeteer';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import os from 'os';
import crypto from 'crypto';
import { spawn, execSync } from 'child_process';
import { jsonrepair } from 'jsonrepair';

// ═══════════════════════════════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════════════════════════════
const CONFIG = {
    mode: process.env.GLENS_MODE || 'lens',
    batch: {
        enabled: true,
        size: parseInt(process.env.GLENS_BATCH_SIZE || '3', 10),
        delayBetweenBatchesMs: parseInt(process.env.GLENS_BATCH_DELAY_MS || '2000', 10),
        delayBetweenSearchesMs: parseInt(process.env.GLENS_SEARCH_DELAY_MS || '200', 10),
    },
    timeouts: {
        navigation: parseInt(process.env.GLENS_NAV_TIMEOUT || '30000', 10),
        response: parseInt(process.env.GLENS_RESP_TIMEOUT || '30000', 10),
        jsonIdle: parseInt(process.env.GLENS_JSON_IDLE_MS || '800', 10),
        upload: parseInt(process.env.GLENS_UPLOAD_TIMEOUT || '10000', 10),
    },
    upload: {
        // imgbb requires a free API key (https://api.imgbb.com/). Optional —
        // if unset, the imgbb upload method is simply skipped in the fallback chain.
        imgbbApiKey: process.env.GLENS_IMGBB_API_KEY || '',
        // Litterbox only accepts hour-granularity values: 1h, 12h, 24h, 72h.
        // 1h is the shortest it offers — plenty for a pipeline that only
        // needs the URL alive for a couple of minutes during a Lens lookup.
        litterboxTime: process.env.GLENS_LITTERBOX_TIME || '1h',
        // imgbb accepts second-granularity expiration (60-15552000s).
        // Default 600s (10 min) — comfortably covers the lookup without
        // leaving images sitting on a public host indefinitely.
        imgbbExpirationSeconds: parseInt(process.env.GLENS_IMGBB_EXPIRATION_SECONDS || '600', 10),
    },
    retry: {
        uploadAttempts: parseInt(process.env.GLENS_UPLOAD_RETRIES || '2', 10),
        navigationAttempts: parseInt(process.env.GLENS_NAV_RETRIES || '2', 10),
        maxImageRetries: parseInt(process.env.GLENS_MAX_RETRIES || '1', 10),
        backoffBaseMs: parseInt(process.env.GLENS_BACKOFF_BASE_MS || '300', 10),
        backoffMaxMs: parseInt(process.env.GLENS_BACKOFF_MAX_MS || '3000', 10),
    },
    image: {
        maxDimension: parseInt(process.env.GLENS_MAX_DIM || '1024', 10),
        quality: parseInt(process.env.GLENS_QUALITY || '85', 10),
    },
    screenshots: {
        enabled: process.env.GLENS_SCREENSHOTS === 'true',
        onErrorOnly: process.env.GLENS_SCREENSHOTS_ERROR_ONLY !== 'false',
    },
    recording: {
        enabled: process.env.GLENS_RECORDING === 'true',
        fps: parseInt(process.env.GLENS_RECORDING_FPS || '12', 10),
        quality: parseInt(process.env.GLENS_RECORDING_QUALITY || '60', 10),
        resolution: process.env.GLENS_RECORDING_RES || '1280x720',
        overlayColor: process.env.GLENS_RECORDING_OVERLAY_COLOR || '#FF0000',
        overlaySize: parseInt(process.env.GLENS_RECORDING_OVERLAY_SIZE || '16', 10),
    },
    output: {
        dir: process.env.GLENS_OUTPUT_DIR || path.join(process.cwd(), 'output'),
        atomicWrites: true,
    },
    perf: {
        skipImageReadyCheck: process.env.GLENS_SKIP_READY_CHECK !== 'false',
        fastClose: process.env.GLENS_FAST_CLOSE !== 'false',
        navWaitUntil: process.env.GLENS_NAV_WAIT || 'domcontentloaded',
    },
    logLevel: process.env.GLENS_LOG_LEVEL || 'info',
    mongodb: {
        uri: process.env.GLENS_MONGODB_URI || '',
        db: process.env.GLENS_MONGODB_DB || 'ugc-dropship',
        collection: process.env.GLENS_MONGODB_COLLECTION || 'scraped-posts',
        limit: parseInt(process.env.GLENS_MONGODB_LIMIT || '20', 10),
        // ── Distributed locking (multi-instance safety) ──
        // lockTtlMs: how long a claim is valid with no heartbeat before another
        //   worker is allowed to steal it (i.e. assume we died).
        // heartbeatIntervalMs: how often we refresh our own locks while still
        //   working, so we can keep lockTtlMs low (fast recovery from a dead
        //   runner) without losing a lock mid-way through a slow video/image.
        lockTtlMs: parseInt(process.env.GLENS_MONGODB_LOCK_TTL_MS || '45000', 10),
        heartbeatIntervalMs: parseInt(process.env.GLENS_MONGODB_HEARTBEAT_MS || '15000', 10),
    },
};

// Unique identity for this process. GLENS_RUN_ID comes from the GitHub Actions
// workflow (github.run_id), so all claims from one job share a prefix — but we
// add a random suffix too, since matrix jobs / repository_dispatch fan-out can
// share a run id, and a single workflow could still spin up more than one node
// process. WORKER_ID is what gets written to `lockedBy`, so we only ever
// release or extend locks that we ourselves currently hold.
const WORKER_ID = (process.env.GLENS_RUN_ID || 'local') + '_' + crypto.randomBytes(6).toString('hex');
const GLOBAL_HF_TOKEN = process.env.GLENS_HF_TOKEN || process.env.HF_TOKEN || '';

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
function log(level, ...args) {
    if (LOG_LEVELS[level] < LOG_LEVELS[CONFIG.logLevel]) return;
    const ts = new Date().toISOString().slice(11, 23);
    const prefix = '[' + ts + '] [' + level.toUpperCase() + ']';
    if (level === 'error') console.error(prefix, ...args);
    else if (level === 'warn') console.warn(prefix, ...args);
    else console.log(prefix, ...args);
}

async function retry(fn, { attempts = 2, label = 'op' } = {}) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (err) {
            lastErr = err;
            if (i === attempts - 1) break;
            const delayMs = Math.min(CONFIG.retry.backoffBaseMs * (i + 1), CONFIG.retry.backoffMaxMs);
            log('warn', '⏳ ' + label + ' fail ' + (i + 1) + '/' + attempts + ': ' + err.message.slice(0, 50) + '. Retry ' + delayMs + 'ms');
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
    throw new Error(label + ' failed ' + attempts + 'x: ' + lastErr.message);
}

function atomicWrite(filePath, data) {
    const tmpPath = filePath + '.tmp.' + Date.now();
    fs.writeFileSync(tmpPath, data, 'utf8');
    fs.renameSync(tmpPath, filePath);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SCREEN RECORDER
// ═══════════════════════════════════════════════════════════════════════════════
class ScreenRecorder {
    constructor(outputPath) {
        this.outputPath = outputPath;
        this.framesDir = outputPath + '_frames';
        this.frameCount = 0;
        this.isRecording = false;
        this.client = null;
        this.page = null;
        this.startTime = null;
        this.currentLabel = '';
        this.currentStatus = 'IDLE';
    }

    async attach(page) {
        if (!CONFIG.recording.enabled) return;
        if (this.page) return;
        this.page = page;
        this.startTime = Date.now();
        if (!fs.existsSync(this.framesDir)) fs.mkdirSync(this.framesDir, { recursive: true });

        const color = CONFIG.recording.overlayColor;
        const size = CONFIG.recording.overlaySize;

        await this.page.evaluate((c, s) => {
            const existing = document.getElementById('glens-overlay');
            if (existing) existing.remove();
            const div = document.createElement('div');
            div.id = 'glens-overlay';
            div.style.cssText =
                'position:fixed!important;top:8px!important;left:8px!important;' +
                'z-index:999999!important;background:rgba(0,0,0,0.7)!important;' +
                'color:' + c + '!important;font-family:monospace!important;' +
                'font-size:' + s + 'px!important;padding:6px 10px!important;' +
                'border-radius:4px!important;pointer-events:none!important;' +
                'line-height:1.4!important;white-space:pre!important;' +
                'max-width:80vw!important;overflow:hidden!important;' +
                'text-overflow:ellipsis!important;';
            div.textContent = '[STARTING...]';
            document.body.appendChild(div);
        }, color, size);

        const client = await this.page.target().createCDPSession();
        await client.send('Page.startScreencast', {
            format: 'jpeg',
            quality: CONFIG.recording.quality,
            maxWidth: parseInt(CONFIG.recording.resolution.split('x')[0]),
            maxHeight: parseInt(CONFIG.recording.resolution.split('x')[1]),
            everyNthFrame: Math.max(1, Math.round(60 / CONFIG.recording.fps)),
        });

        client.on('Page.screencastFrame', async (frame) => {
            if (!this.isRecording) return;
            try {
                const buf = Buffer.from(frame.data, 'base64');
                const framePath = path.join(this.framesDir, 'frame_' + String(this.frameCount).padStart(6, '0') + '.jpg');
                fs.writeFileSync(framePath, buf);
                this.frameCount++;
                await client.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
            } catch (e) {
                // Frame dropped, continue
            }
        });

        this.client = client;
        this.isRecording = true;
        log('info', '🎬 Recording started: ' + path.basename(this.outputPath) + ' @ ' + CONFIG.recording.fps + 'fps');
    }

    async updateLabel(label, status) {
        if (!CONFIG.recording.enabled || !this.page) return;
        this.currentLabel = label;
        if (status) this.currentStatus = status;
        try {
            const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
            await this.page.evaluate((lbl, st, el) => {
                const div = document.getElementById('glens-overlay');
                if (div) div.textContent = lbl + '\n[' + st + '] ' + el + 's';
            }, label, this.currentStatus, elapsed);
        } catch (e) {}
    }

    async updateStatus(status) {
        this.currentStatus = status;
        await this.updateLabel(this.currentLabel, status);
    }

    async detach(page) {
        if (!CONFIG.recording.enabled) return;
        const targetPage = page || this.page;
        if (!targetPage || (page && this.page !== page)) return;
        try {
            if (this.client) {
                await this.client.send('Page.stopScreencast').catch(() => {});
                await this.client.detach().catch(() => {});
            }
            this.client = null;
            this.page = null;
        } catch (e) {}
    }

    async stop() {
        if (!CONFIG.recording.enabled || !this.isRecording) return;
        this.isRecording = false;
        await this.detach();

        if (this.frameCount > 0) {
            await this._encodeVideo();
        }

        try {
            if (fs.existsSync(this.framesDir)) {
                const files = fs.readdirSync(this.framesDir);
                for (const f of files) fs.unlinkSync(path.join(this.framesDir, f));
                fs.rmdirSync(this.framesDir);
            }
        } catch (e) {}
    }

    async _encodeVideo() {
        return new Promise((resolve) => {
            const ffmpegPath = this._findFfmpeg();
            if (!ffmpegPath) {
                log('warn', 'ffmpeg not found. Frames saved as image sequence.');
                resolve();
                return;
            }

            const [width, height] = CONFIG.recording.resolution.split('x');
            const args = [
                '-y',
                '-framerate', String(CONFIG.recording.fps),
                '-i', path.join(this.framesDir, 'frame_%06d.jpg'),
                '-c:v', 'libx264',
                '-pix_fmt', 'yuv420p',
                '-crf', '28',
                '-preset', 'fast',
                '-movflags', '+faststart',
                '-vf', 'scale=' + width + ':' + height + ':force_original_aspect_ratio=decrease,pad=' + width + ':' + height + ':(ow-iw)/2:(oh-ih)/2:black',
                this.outputPath
            ];

            const proc = spawn(ffmpegPath, args, { stdio: 'pipe' });
            let stderr = '';
            proc.stderr.on('data', d => { stderr += d; });

            const timeoutId = setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch(e) {}
                resolve();
            }, 120000);

            proc.on('close', (code) => {
                clearTimeout(timeoutId);
                if (code === 0) {
                    const stats = fs.statSync(this.outputPath);
                    log('info', '🎬 Video clip saved: ' + path.basename(this.outputPath) + ' (' + (stats.size / 1024 / 1024).toFixed(1) + 'MB)');
                } else {
                    log('warn', 'ffmpeg exited ' + code + '. ' + stderr.slice(0, 200));
                }
                resolve();
            });
            proc.on('error', (err) => {
                clearTimeout(timeoutId);
                log('warn', 'ffmpeg error: ' + err.message);
                resolve();
            });
        });
    }

    _findFfmpeg() {
        const candidates = ['ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
        for (const c of candidates) {
            try {
                execSync('which ' + c, { stdio: 'ignore' });
                return c;
            } catch (e) {}
        }
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  BLOCK DETECTION
// ═══════════════════════════════════════════════════════════════════════════════
const BLOCK_KEYWORDS = [
    'unusual traffic',
    'robot',
    'captcha',
    'recaptcha',
    'verify you are human',
    'i\'m not a robot',
    'try again later',
    'rate limit',
    'too many requests',
    'access denied',
    'blocked',
    'suspicious activity',
    'automated requests',
    'temporarily unavailable',
];

const RATE_LIMIT_KEYWORDS = [
    'rate limit',
    'too many requests',
    'try again later',
    'temporarily unavailable',
    'slow down',
];

function detectBlockPage(text) {
    if (!text || text.length < 100) return false;
    const lower = text.toLowerCase();
    return BLOCK_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

function detectRateLimit(text) {
    if (!text || text.length < 50) return false;
    const lower = text.toLowerCase();
    return RATE_LIMIT_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
}

function analyzeResponse(text) {
    const result = {
        hasJson: !!extractJsonFromText(text || ''),
        isBlocked: detectBlockPage(text),
        isRateLimited: detectRateLimit(text),
        isEmpty: !text || text.trim().length < 50,
        isCaptchaHtml: text && text.includes('Our systems have detected unusual traffic'),
        charCount: (text || '').length,
    };
    result.isRetryable = !result.isBlocked && !result.isRateLimited && !result.isCaptchaHtml && !result.isEmpty;
    return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PATHS
// ═══════════════════════════════════════════════════════════════════════════════
const OUTPUT_DIR = CONFIG.output.dir;
const SCREENSHOTS_DIR = path.join(OUTPUT_DIR, 'screenshots');
const RESPONSES_DIR = path.join(OUTPUT_DIR, 'responses');
const RECORDINGS_DIR = path.join(OUTPUT_DIR, 'recordings');
const TMP_DIR = path.join(process.cwd(), 'tmp_resized');

[OUTPUT_DIR, SCREENSHOTS_DIR, RESPONSES_DIR, RECORDINGS_DIR, TMP_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  MONGODB + VIDEO FRAME HELPERS
// ═══════════════════════════════════════════════════════════════════════════════
async function processVideoFrames(videoUrl, frames, name) {
    // Left as backwards compatibility if legacy un-processed videos ever arrive
    const safeName = name.replace(/[^a-z0-9_-]/gi, '_');
    const videoPath = path.join(TMP_DIR, `vid_${safeName}.mp4`);
    const framesDir = path.join(TMP_DIR, `frames_${safeName}`);
    fs.mkdirSync(framesDir, { recursive: true });

    log('debug', `Downloading video for ${safeName}...`);
    const headers = GLOBAL_HF_TOKEN ? { 'Authorization': `Bearer ${GLOBAL_HF_TOKEN}` } : {};
    const resp = await fetch(videoUrl, { headers, redirect: 'follow' });
    
    if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`HTTP ${resp.status} for video ${videoUrl}. Body: ${body.slice(0, 150)}`);
    }
    
    const buffer = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(videoPath, buffer);
    log('debug', `Video ${safeName}: ${(buffer.length / 1024 / 1024).toFixed(1)}MB`);

    const framePaths = [];
    for (let i = 0; i < frames.length; i++) {
        const ts = frames[i];
        const outFrame = path.join(framesDir, `frame_${i}.jpg`);
        const cmd = `ffmpeg -y -ss ${ts} -i "${videoPath}" -vframes 1 -q:v 2 "${outFrame}"`;
        try {
            execSync(cmd, { stdio: 'ignore', timeout: 30000 });
            if (fs.existsSync(outFrame)) {
                framePaths.push(outFrame);
            } else {
                log('warn', `Frame ${i} at ${ts}s not created for ${safeName}`);
            }
        } catch (e) {
            log('warn', `Frame extraction failed for ${safeName} at ${ts}s: ${e.message.slice(0, 100)}`);
        }
    }

    if (framePaths.length === 0) {
        fs.unlinkSync(videoPath);
        fs.rmdirSync(framesDir);
        throw new Error(`No frames extracted for ${safeName}`);
    }

    const mergedPath = path.join(TMP_DIR, `merged_${safeName}.jpg`);
    if (framePaths.length === 1) {
        fs.copyFileSync(framePaths[0], mergedPath);
    } else {
        const inputs = framePaths.map((p, i) => `-i "${p}"`).join(' ');
        const filter = framePaths.map((_, i) => `[${i}:v]`).join('') + `vstack=inputs=${framePaths.length}`;
        const cmd = `ffmpeg -y ${inputs} -filter_complex "${filter}" -frames:v 1 "${mergedPath}"`;
        try {
            execSync(cmd, { stdio: 'ignore', timeout: 60000 });
            if (!fs.existsSync(mergedPath)) throw new Error('ffmpeg did not create merged image');
        } catch (e) {
            for (const fp of framePaths) try { fs.unlinkSync(fp); } catch(e) {}
            fs.unlinkSync(videoPath);
            fs.rmdirSync(framesDir);
            throw new Error(`Frame merge failed: ${e.message}`);
        }
    }

    try {
        fs.unlinkSync(videoPath);
        for (const fp of framePaths) fs.unlinkSync(fp);
        fs.rmdirSync(framesDir);
    } catch (e) { /* ignore cleanup errors */ }

    return mergedPath;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  MONGODB DISTRIBUTED LOCKING (file-level)
// ═══════════════════════════════════════════════════════════════════════════════
function nowPlusMs(ms) {
    return new Date(Date.now() + ms);
}

/**
 * Find posts that have at least one claimable reviewed file or video frame.
 */
async function findCandidatePosts(collection, fetchLimit) {
    const now = new Date();
    return collection
        .find({
            discarded: { $ne: true },
            $or: [
                {
                    file_urls: {
                        $elemMatch: {
                            type: 'image',
                            reviewed: true,
                            response: { $in: [null, undefined] },
                            $or: [
                                { lockedBy: { $exists: false } },
                                { lockedBy: null },
                                { lockExpiresAt: { $lt: now } }
                            ]
                        }
                    }
                },
                {
                    "file_urls.frames": {
                        $elemMatch: {
                            type: 'image',
                            reviewed: true,
                            response: { $in: [null, undefined] },
                            $or: [
                                { lockedBy: { $exists: false } },
                                { lockedBy: null },
                                { lockExpiresAt: { $lt: now } }
                            ]
                        }
                    }
                }
            ]
        })
        .limit(fetchLimit)
        .toArray();
}

/**
 * Helper to execute an atomic claim against a specific dot-path index in MongoDB.
 */
async function tryClaim(collection, post, pathStr, now) {
    const filter = {
        _id: post._id,
        [`${pathStr}.response`]: { $in: [null, undefined] },
        $or: [
            { [`${pathStr}.lockedBy`]: { $exists: false } },
            { [`${pathStr}.lockedBy`]: null },
            { [`${pathStr}.lockExpiresAt`]: { $lt: now } },
        ],
    };
    const update = {
        $set: {
            [`${pathStr}.lockedBy`]: WORKER_ID,
            [`${pathStr}.lockedAt`]: now,
            [`${pathStr}.lockExpiresAt`]: nowPlusMs(CONFIG.mongodb.lockTtlMs),
        },
    };
    try {
        const result = await collection.findOneAndUpdate(filter, update, { returnDocument: 'after' });
        return result && result.value !== undefined ? result.value : result;
    } catch (e) {
        return null;
    }
}

/**
 * Atomically claim up to `limit` individual FILES (not posts) across
 * multiple documents. Targets the exact dot-path of the element for atomicity.
 */
async function claimFiles(collection, limit) {
    const now = new Date();
    const claimed = [];
    const seenDocIds = new Set();

    const candidatePosts = await findCandidatePosts(collection, limit * 3 + 5);

    outer:
    for (const post of candidatePosts) {
        if (!Array.isArray(post.file_urls)) continue;

        for (let i = 0; i < post.file_urls.length; i++) {
            if (claimed.length >= limit) break outer;

            const file = post.file_urls[i];
            if (!file) continue;

            if (file.type === 'image' && file.reviewed) {
                if (file.response) continue; // already done
                const pathStr = `file_urls.${i}`;
                const claimedTarget = await tryClaim(collection, post, pathStr, now);
                if (claimedTarget) {
                    claimed.push({ post: claimedTarget, path: pathStr, file: claimedTarget.file_urls[i], docId: post._id });
                    seenDocIds.add(String(post._id));
                }
            } else if (file.type === 'video' && Array.isArray(file.frames)) {
                for (let j = 0; j < file.frames.length; j++) {
                    if (claimed.length >= limit) break outer;
                    const frame = file.frames[j];
                    if (frame && frame.type === 'image' && frame.reviewed) {
                        if (frame.response) continue;
                        const pathStr = `file_urls.${i}.frames.${j}`;
                        const claimedTarget = await tryClaim(collection, post, pathStr, now);
                        if (claimedTarget) {
                            claimed.push({ post: claimedTarget, path: pathStr, file: claimedTarget.file_urls[i].frames[j], docId: post._id });
                            seenDocIds.add(String(post._id));
                        }
                    }
                }
            }
        }
    }

    return claimed;
}

/**
 * Refresh (extend) the lock expiry for files we're actively working on.
 */
async function heartbeatLocks(collection, claims) {
    if (!claims || claims.length === 0) return;
    try {
        const ops = claims.map(({ docId, path }) => ({
            updateOne: {
                filter: { _id: docId, [`${path}.lockedBy`]: WORKER_ID },
                update: { $set: { [`${path}.lockExpiresAt`]: nowPlusMs(CONFIG.mongodb.lockTtlMs) } },
            },
        }));
        await collection.bulkWrite(ops, { ordered: false });
        log('debug', `Heartbeat: extended lock on ${claims.length} file(s)`);
    } catch (e) {
        log('warn', 'Heartbeat failed: ' + e.message);
    }
}

/**
 * Release our lock on files we're done with (success or failure).
 */
async function releaseLocks(collection, claims) {
    if (!claims || claims.length === 0) return;
    try {
        const ops = claims.map(({ docId, path }) => ({
            updateOne: {
                filter: { _id: docId, [`${path}.lockedBy`]: WORKER_ID },
                update: {
                    $unset: {
                        [`${path}.lockedBy`]: '',
                        [`${path}.lockedAt`]: '',
                        [`${path}.lockExpiresAt`]: '',
                    },
                },
            },
        }));
        await collection.bulkWrite(ops, { ordered: false });
        log('debug', `Released lock on ${claims.length} file(s)`);
    } catch (e) {
        log('warn', 'Lock release failed: ' + e.message);
    }
}

const mongoLockState = {
    client: null,
    collection: null,
    claimedFiles: [], // [{ post, path, file, docId }]
    heartbeatTimer: null,
};

function startLockHeartbeat() {
    if (mongoLockState.heartbeatTimer) return; // already running
    if (!mongoLockState.claimedFiles.length) return; // nothing to keep alive
    mongoLockState.heartbeatTimer = setInterval(() => {
        heartbeatLocks(mongoLockState.collection, mongoLockState.claimedFiles);
    }, CONFIG.mongodb.heartbeatIntervalMs);
    if (mongoLockState.heartbeatTimer.unref) mongoLockState.heartbeatTimer.unref();
}

function stopLockHeartbeat() {
    if (mongoLockState.heartbeatTimer) {
        clearInterval(mongoLockState.heartbeatTimer);
        mongoLockState.heartbeatTimer = null;
    }
}

async function releaseAllLocksAndClose() {
    stopLockHeartbeat();
    if (!mongoLockState.client) return;
    try {
        if (mongoLockState.claimedFiles.length > 0) {
            await releaseLocks(mongoLockState.collection, mongoLockState.claimedFiles);
        }
        await mongoLockState.client.close();
    } catch (e) {
        log('warn', 'releaseAllLocksAndClose: ' + e.message);
    } finally {
        mongoLockState.client = null;
        mongoLockState.collection = null;
        mongoLockState.claimedFiles = [];
    }
}

async function fetchFromMongoDB() {
    const { MongoClient } = await import('mongodb');
    const client = new MongoClient(CONFIG.mongodb.uri, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
    const db = client.db(CONFIG.mongodb.db);
    const collection = db.collection(CONFIG.mongodb.collection);

    log('info', `MongoDB: querying ${CONFIG.mongodb.db}.${CONFIG.mongodb.collection} for reviewed files (limit: ${CONFIG.mongodb.limit})...`);
    log('info', `MongoDB: worker id ${WORKER_ID} | lock TTL ${CONFIG.mongodb.lockTtlMs}ms | heartbeat ${CONFIG.mongodb.heartbeatIntervalMs}ms`);

    const claims = await claimFiles(collection, CONFIG.mongodb.limit);

    log('info', `MongoDB: claimed ${claims.length} file(s) across ${new Set(claims.map(c => String(c.docId))).size} post(s)`);

    mongoLockState.client = client;
    mongoLockState.collection = collection;
    mongoLockState.claimedFiles = claims;
    startLockHeartbeat();

    const imagePaths = [];
    let imageCount = 0;
    let skipCount = 0;

    for (const { post, path: objPath, file, docId } of claims) {
        const meta = {
            docId: docId,
            postId: post.post_id || docId.toString(),
            path: objPath,
            originalUrl: file.url,
            type: file.type || 'unknown'
        };

        try {
            if (file.type === 'image') {
                const uniqueSuffix = objPath.replace(/[^a-z0-9]/gi, '_');
                const safeName = meta.postId.replace(/[^a-z0-9_-]/gi, '_');
                
                let ext = '.jpg';
                try { ext = path.extname(new URL(file.url).pathname) || '.jpg'; } catch(e) {}
                const localPath = path.join(TMP_DIR, `dl_${safeName}_${uniqueSuffix}${ext}`);

                log('debug', `Downloading local copy of ${file.url}...`);
                
                const headers = GLOBAL_HF_TOKEN ? { 'Authorization': `Bearer ${GLOBAL_HF_TOKEN}` } : {};
                const resp = await fetch(file.url, { headers, redirect: 'follow' });
                
                if (!resp.ok) {
                    const body = await resp.text().catch(() => '');
                    throw new Error(`HTTP ${resp.status} fetching ${file.url}. Body: ${body.slice(0, 150)}`);
                }
                
                const buffer = Buffer.from(await resp.arrayBuffer());
                fs.writeFileSync(localPath, buffer);

                imagePaths.push({
                    type: 'local', // Pass as 'local' so GLENS uploads it to the public temp storage!
                    originalPath: localPath,
                    filename: `mongo_${safeName}_${uniqueSuffix}${ext}`,
                    mongoMeta: meta
                });
                imageCount++;
            } else {
                // Skips any non-image items (like un-processed videos that slip through).
                skipCount++;
            }
        } catch (e) {
            log('warn', `Failed to fetch/process ${meta.postId} ${objPath}: ${e.message.slice(0, 300)}`);
            skipCount++;
        }
    }

    log('info', `MongoDB: fetched ${imageCount} local image(s), ${skipCount} skipped`);
    return imagePaths;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  IMAGE DISCOVERY
// ═══════════════════════════════════════════════════════════════════════════════
const IMAGE_DIR_CANDIDATES = [
    path.join(process.cwd(), 'images'),
    path.join(process.cwd(), 'contents', 'images'),
    '/content/images',
    '/contents/images',
];

let IMAGE_PATHS = [];
const ENV_URLS = process.env.GLENS_IMAGE_URLS;

if (!CONFIG.mongodb.uri) {
    if (ENV_URLS && ENV_URLS.trim()) {
        try {
            const parsed = JSON.parse(ENV_URLS);
            if (Array.isArray(parsed) && parsed.length > 0) {
                IMAGE_PATHS = parsed.map((url, i) => {
                    let basename = 'image.jpg';
                    try { basename = path.basename(new URL(url).pathname); } catch(e) {}
                    return {
                        type: 'url',
                        url: url,
                        filename: 'url_' + i + '_' + basename
                    };
                });
                log('info', 'Using ' + parsed.length + ' provided URL(s)');
            } else {
                throw new Error('Empty or non-array');
            }
        } catch (e) {
            log('error', 'GLENS_IMAGE_URLS must be a JSON array of strings. ' + e.message);
            process.exit(1);
        }
    } else {
        for (const dir of IMAGE_DIR_CANDIDATES) {
            if (fs.existsSync(dir)) {
                const files = fs.readdirSync(dir)
                    .filter(f => /\.(png|jpg|jpe?g|gif|webp|bmp)$/i.test(f))
                    .map(f => path.join(dir, f));
                if (files.length > 0) { IMAGE_PATHS = files; log('info', 'Found ' + files.length + ' image(s)'); break; }
            }
        }
    }
}

if (IMAGE_PATHS.length === 0 && !CONFIG.mongodb.uri) {
    log('error', 'No images found');
    process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PROMPT
// ═══════════════════════════════════════════════════════════════════════════════
const PROMPT_TEMPLATE = `Analyze this image and identify all visible products (clothing, footwear, accessories, jewelry, etc.). For each product found, provide:

1. Title: Product name
2. Brand: Manufacturer/brand name
3. Description: What it is, key features, colors, materials
4. Category: Type of product (top, bottom, footwear, accessory, etc.)
5. Price: Current price and original/sale price if discounted
6. Availability: In stock, out of stock, pre-order, etc.
7. Sizing: Available sizes or size range
8. Sources (top priority): At least 5 direct product page URLs where this exact or very similar item can be purchased. Sort by reliability (official brand store first, then major retailers, then resellers). Each source should include:
   - Store name
   - Direct product URL (very important)
   - Price at that source (if known)
   - Availability at that source
9. SocialAppearances: Any social media posts (Instagram, TikTok, Pinterest, etc.) where this exact product or very similar item appears. Include:
   - Platform name
   - Post URL (if identifiable)
   - Brief context (e.g., "viral try-on haul", "styled outfit post")
10. DropshipViability: Rate 1-10 with reasoning. Consider: brand recognition, price point, shipping complexity, seasonality, trend status, competition saturation
11. EstimatedResaleRange: Typical resale markup range based on category and brand tier (e.g., fast fashion 2-3x, luxury 1.2-1.5x)
12. Alternatives: 2-3 similar but cheaper or more available alternatives if the exact item is expensive, out of stock, or from a restrictive supplier
13. SizingGuide: Unified sizing guidance synthesized from all sources (e.g., fit notes, measurement recommendations, "runs small — size up", model stats, etc.)
14. BasePrice: The item's true original/non-discounted price, if any source shows one. If no source shows an original price anywhere, use the highest current price found across sources instead. Use the same currency as price.currency.
15. RecommendedMarkup: Recommended resale markup, based on typical markup norms for this product's category and brand tier. Use type "percentage" (e.g., value: "30") or type "fixed" (e.g., value: "25.00"). Include currency for fixed amounts.
16. RecommendedShippingRate: Recommended flat-rate shipping cost to cover international orders, based on typical shipping costs for this product's size/weight category. Include amount, currency, and coverage description (e.g., "Worldwide", "International").
17. ShippingAndReturns: A summary of shipping and returns policy specifically from the top-ranked (first-listed) source (e.g., "Free shipping over $50. 30-day returns. Excludes final sale items.").

Return ONLY raw JSON. No code blocks, no explanations. Raw JSON text in one line.

Schema:

{"products":[{"title":"string","brand":"string","description":"string","category":"string","price":{"current":"string","original":"string|null","currency":"string"},"availability":"string","sizing":["string"],"sources":[{"store":"string","url":"string","price":"string|null","availability":"string|null"}],"socialAppearances":[{"platform":"string","url":"string|null","context":"string|null"}],"dropshipViability":{"score":1-10,"reasoning":"string","risks":["string"]},"estimatedResaleRange":{"low":"string","high":"string","currency":"string"},"alternatives":[{"title":"string","brand":"string","url":"string","price":"string|null","why":"string"}],"sizingGuide":"string","basePrice":"string","recommendedMarkup":{"type":"percentage|fixed","value":"string","currency":"string|null"},"recommendedShippingRate":{"amount":"string","currency":"string","coverage":"string"},"shippingAndReturns":"string"}]}

Heres the image URL: {IMAGE_URL}`;


// ═══════════════════════════════════════════════════════════════════════════════
//  DOM UTILITIES
// ═══════════════════════════════════════════════════════════════════════════════
const FIND_DEEP_SCRIPT = `
function findAllDeep(root, selector) {
  const results = [];
  if (!root) return results;
  try { results.push(...root.querySelectorAll(selector)); } catch(e) {}
  for (const child of (root.children || [])) results.push(...findAllDeep(child, selector));
  if (root.shadowRoot) results.push(...findAllDeep(root.shadowRoot, selector));
  return results;
}
function getVisibleTextDeep(root) {
  if (!root) return '';
  if (root.nodeType === Node.TEXT_NODE) return root.textContent || '';
  if (root.nodeType !== Node.ELEMENT_NODE) return '';
  const tag = root.tagName.toLowerCase();
  if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'svg') return '';
  try {
    const s = window.getComputedStyle(root);
    if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') return '';
    if (s.position === 'absolute') {
      const w = parseFloat(s.width), h = parseFloat(s.height);
      if ((w <= 1 && h <= 1) || s.clip !== 'auto') return '';
    }
  } catch(e) {}
  let text = '';
  if (root.shadowRoot) for (const c of root.shadowRoot.childNodes) text += getVisibleTextDeep(c);
  for (const c of root.childNodes) text += getVisibleTextDeep(c);
  return text;
}
`;

// ═══════════════════════════════════════════════════════════════════════════════
//  IMAGE RESIZE
// ═══════════════════════════════════════════════════════════════════════════════
async function resizeImage(imgPathOrInfo) {
    const baseMeta = (typeof imgPathOrInfo === 'object' && imgPathOrInfo.mongoMeta)
        ? { mongoMeta: imgPathOrInfo.mongoMeta }
        : {};

    if (typeof imgPathOrInfo === 'object' && imgPathOrInfo.type === 'url') {
        return { ...imgPathOrInfo, originalId: imgPathOrInfo.url, ...baseMeta };
    }

    if (typeof imgPathOrInfo === 'object' && imgPathOrInfo.type === 'local') {
        const imgPath = imgPathOrInfo.originalPath;
        const filename = imgPathOrInfo.filename || path.basename(imgPath);
        const outFilename = 'rsz_' + filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const outPath = path.join(TMP_DIR, outFilename);
        try {
            const meta = await sharp(imgPath).metadata();
            const needs = meta.width > CONFIG.image.maxDimension || meta.height > CONFIG.image.maxDimension;
            const pipeline = needs
                ? sharp(imgPath).resize(CONFIG.image.maxDimension, CONFIG.image.maxDimension, { fit: 'inside', withoutEnlargement: true })
                : sharp(imgPath);
            await pipeline.jpeg({ quality: CONFIG.image.quality, progressive: true }).toFile(outPath);
            log('debug', filename + ': ' + (fs.statSync(imgPath).size / 1024).toFixed(0) + 'KB -> ' + (fs.statSync(outPath).size / 1024).toFixed(0) + 'KB');
            return { type: 'local', originalPath: imgPath, resizedPath: outPath, filename, originalId: filename, ...baseMeta };
        } catch (e) {
            log('warn', 'Resize fail ' + filename + ': ' + e.message + '. Using original.');
            return { type: 'local', originalPath: imgPath, resizedPath: imgPath, filename, originalId: filename, ...baseMeta };
        }
    }

    const imgPath = imgPathOrInfo;
    const filename = path.basename(imgPath, path.extname(imgPath)) + '.jpg';
    const outPath = path.join(TMP_DIR, filename);
    const originalId = path.basename(imgPath);
    try {
        const meta = await sharp(imgPath).metadata();
        const needs = meta.width > CONFIG.image.maxDimension || meta.height > CONFIG.image.maxDimension;
        const pipeline = needs
            ? sharp(imgPath).resize(CONFIG.image.maxDimension, CONFIG.image.maxDimension, { fit: 'inside', withoutEnlargement: true })
            : sharp(imgPath);
        await pipeline.jpeg({ quality: CONFIG.image.quality, progressive: true }).toFile(outPath);
        log('debug', filename + ': ' + (fs.statSync(imgPath).size / 1024).toFixed(0) + 'KB -> ' + (fs.statSync(outPath).size / 1024).toFixed(0) + 'KB');
        return { type: 'local', originalPath: imgPath, resizedPath: outPath, filename, originalId, ...baseMeta };
    } catch (e) {
        log('warn', 'Resize fail ' + filename + ': ' + e.message + '. Using original.');
        return { type: 'local', originalPath: imgPath, resizedPath: imgPath, filename, originalId, ...baseMeta };
    }
}

function cleanupTempImages() {
    try {
        if (!fs.existsSync(TMP_DIR)) return;
        const files = fs.readdirSync(TMP_DIR);
        let removed = 0;
        for (const f of files) { try { fs.unlinkSync(path.join(TMP_DIR, f)); removed++; } catch(e) {} }
        log('info', 'Cleaned ' + removed + ' temp files');
    } catch (e) { log('warn', 'Cleanup: ' + e.message); }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  UPLOAD
// ═══════════════════════════════════════════════════════════════════════════════
async function uploadToCatbox(filePath) {
    const buf = fs.readFileSync(filePath);
    const blob = new Blob([buf]);
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('fileToUpload', blob, path.basename(filePath));
    const res = await fetch('https://catbox.moe/user/api.php', {
        method: 'POST',
        body: form
    });
    const url = (await res.text()).trim();
    if (!url.startsWith('http')) throw new Error('Catbox: ' + url.slice(0, 80));
    return url;
}

async function uploadToLitterbox(filePath) {
    const buf = fs.readFileSync(filePath);
    const blob = new Blob([buf]);
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('time', CONFIG.upload.litterboxTime);
    form.append('fileToUpload', blob, path.basename(filePath));
    const res = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', {
        method: 'POST',
        body: form
    });
    const url = (await res.text()).trim();
    if (!url.startsWith('http')) throw new Error('Litterbox: ' + url.slice(0, 80));
    return url;
}

async function uploadToUguu(filePath) {
    const buf = fs.readFileSync(filePath);
    const blob = new Blob([buf]);
    const form = new FormData();
    form.append('files[]', blob, path.basename(filePath));
    const res = await fetch('https://uguu.se/upload', {
        method: 'POST',
        body: form
    });
    const text = (await res.text()).trim();
    let json;
    try { json = JSON.parse(text); } catch (e) { throw new Error('Uguu: bad JSON: ' + text.slice(0, 80)); }
    const url = json && Array.isArray(json.files) && json.files[0] && json.files[0].url;
    if (!url || !url.startsWith('http')) throw new Error('Uguu: ' + text.slice(0, 80));
    return url;
}

async function uploadToStorageTo(filePath) {
    const buf = fs.readFileSync(filePath);
    const blob = new Blob([buf]);
    const form = new FormData();
    form.append('file', blob, path.basename(filePath));
    const res = await fetch('https://storage.to/api/sharex/upload', {
        method: 'POST',
        body: form
    });
    const json = await res.json();
    const url = json && (json.raw_url || json.url);
    if (!json || !json.success || !url || !url.startsWith('http')) {
        throw new Error('storage.to: ' + JSON.stringify(json).slice(0, 80));
    }
    return url;
}

async function uploadToImgbb(filePath) {
    if (!CONFIG.upload.imgbbApiKey) throw new Error('imgbb: no API key configured (GLENS_IMGBB_API_KEY)');
    const buf = fs.readFileSync(filePath);
    const blob = new Blob([buf]);
    const form = new FormData();
    form.append('image', blob, path.basename(filePath));
    const res = await fetch('https://api.imgbb.com/1/upload?key=' + encodeURIComponent(CONFIG.upload.imgbbApiKey) + '&expiration=' + CONFIG.upload.imgbbExpirationSeconds, {
        method: 'POST',
        body: form
    });
    const json = await res.json();
    const url = json && json.data && (json.data.url || json.data.display_url);
    if (!json || !json.success || !url || !url.startsWith('http')) {
        throw new Error('imgbb: ' + JSON.stringify(json).slice(0, 80));
    }
    return url;
}

async function uploadImage(filePath) {
    const methods = [
        { name: 'catbox.moe', fn: async (p) => uploadToCatbox(p) },
        { name: 'litterbox.catbox.moe', fn: async (p) => uploadToLitterbox(p) },
        { name: 'uguu.se', fn: async (p) => uploadToUguu(p) },
        { name: 'storage.to', fn: async (p) => uploadToStorageTo(p) },
        { name: 'imgbb.com', fn: async (p) => uploadToImgbb(p) },
    ];
    for (const m of methods) {
        try {
            log('debug', 'Upload ' + m.name + '...');
            const url = await retry(() => m.fn(filePath), { attempts: CONFIG.retry.uploadAttempts, label: m.name });
            log('info', 'Uploaded -> ' + url.slice(0, 50) + '...');
            return url;
        } catch (e) { log('warn', m.name + ' fail: ' + e.message.slice(0, 60)); }
    }
    throw new Error('All uploads failed');
}

function buildPrompt(imageUrl) {
    return PROMPT_TEMPLATE.replace('{IMAGE_URL}', imageUrl);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  JSON EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════════
function isRealProductData(s) {
    if (!s || !s.includes('"products"')) return false;
    if (s.includes('"title":"string"') || s.includes('"brand":"string"')) return false;
    return /"url":"https?:\/\//.test(s) || /"current":"[^"]*\d/.test(s) || /"brand":"(?!string)[^"]+"/.test(s);
}

function extractBalancedJson(text, start) {
    if (!text || start < 0 || text[start] !== '{') return null;
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"' && !inStr) { inStr = true; continue; }
        if (ch === '"' && inStr) { inStr = false; continue; }
        if (inStr) continue;
        if (ch === '{') depth++; else if (ch === '}') depth--;
        if (depth === 0) return text.slice(start, i + 1);
    }
    return null;
}

function ensureValidJson(candidate) {
    if (!candidate) return candidate;

    try {
        JSON.parse(candidate);
        return candidate; // already valid, nothing to do
    } catch (e) {
        // fall through to repair attempt
    }

    try {
        const repaired = jsonrepair(candidate);
        JSON.parse(repaired); // confirm the repair actually produced valid JSON
        log('debug', 'JSON repair fixed a malformed response.');
        return repaired;
    } catch (e) {
        log('debug', 'JSON repair could not fix response, keeping original text: ' + e.message.slice(0, 100));
        return candidate; // leave as the original string, exactly as before
    }
}

function extractJsonFromText(text) {
    if (!text || text.length < 10) return null;

    let searchArea = text;
    const promptMarker = 'Heres the image URL:';
    const promptIdx = text.lastIndexOf(promptMarker);
    if (promptIdx !== -1) {
        const afterPrompt = text.indexOf('{', promptIdx + promptMarker.length);
        if (afterPrompt !== -1) {
            searchArea = text.slice(afterPrompt);
        }
    }

    for (const sig of ['{"products":[', '{"products": [']) {
        let pos = 0;
        while ((pos = searchArea.indexOf(sig, pos)) !== -1) {
            const c = extractBalancedJson(searchArea, pos);
            if (c && isRealProductData(c)) return ensureValidJson(c);
            pos++;
        }
    }

    let pos = 0;
    while ((pos = searchArea.indexOf('{', pos)) !== -1) {
        const c = extractBalancedJson(searchArea, pos);
        if (c && c.length > 100 && isRealProductData(c)) return ensureValidJson(c);
        pos++;
    }

    const firstBrace = searchArea.indexOf('{');
    const lastBrace = searchArea.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
        const fallbackSlice = searchArea.slice(firstBrace, lastBrace + 1);
        if (isRealProductData(fallbackSlice)) {
            return ensureValidJson(fallbackSlice);
        }
    }

    return null;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  RESPONSE EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════════
async function getResponseTextFromPage(page) {
    await page.evaluate(FIND_DEEP_SCRIPT);
    const selectors = [
        'model-response', '[class*="response"]', '[class*="message"]', '[class*="chat"]',
        '[class*="conversation"]', 'article', '[role="region"]', '[role="main"]', 'main',
        '[class*="markdown"]', '[class*="content"]'
    ];
    for (const sel of selectors) {
        try {
            const texts = await page.evaluate((s) => {
                return findAllDeep(document.body, s)
                    .map(e => getVisibleTextDeep(e))
                    .filter(t => t.length > 50);
            }, sel);
            if (texts.length) {
                const best = texts.reduce((a, b) => a.length > b.length ? a : b, '');
                if (best.length > 100) {
                    if (extractJsonFromText(best)) return best;
                    return best;
                }
            }
        } catch(e) {}
    }
    return await page.evaluate(() => getVisibleTextDeep(document.body));
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STREAMED RESPONSE
// ═══════════════════════════════════════════════════════════════════════════════
async function waitForStreamedResponse(page, recorder) {
    const checkInterval = 400;
    const maxWait = CONFIG.timeouts.response;
    const jsonIdle = CONFIG.timeouts.jsonIdle;
    log('info', 'Wait response...');

    let lastText = '', lastJson = null, lastChange = Date.now(), start = Date.now(), stable = 0, ticks = 0;

    while (true) {
        ticks++;
        const current = await getResponseTextFromPage(page);
        const changed = current !== lastText;

        if (changed) {
            lastText = current; lastChange = Date.now(); stable = 0;
            const json = extractJsonFromText(current);
            if (json && json !== lastJson) {
                lastJson = json;
                log('info', 'JSON ' + json.length + ' chars');
                if (recorder) await recorder.updateStatus('JSON FOUND');
            }
        } else {
            stable++;
        }

        const idle = Date.now() - lastChange;

        if (lastJson && idle >= jsonIdle) {
            log('info', 'JSON stable ' + jsonIdle + 'ms. Done.');
            if (recorder) await recorder.updateStatus('DONE');
            return { text: lastJson, html: '', duration: Date.now() - start, jsonExtracted: true };
        }

        if (stable >= 2 && current.length > 500 && idle >= 2000) {
            const j = extractJsonFromText(current);
            if (j) {
                if (recorder) await recorder.updateStatus('STABLE');
                return { text: j, html: '', duration: Date.now() - start, jsonExtracted: true };
            }
        }

        if (idle >= maxWait) {
            log('warn', 'Timeout ' + maxWait + 'ms');
            if (recorder) await recorder.updateStatus('TIMEOUT');
            const j = extractJsonFromText(current) || lastJson;
            if (j) return { text: j, html: '', duration: Date.now() - start, jsonExtracted: true };
            return { text: current, html: '', duration: Date.now() - start, jsonExtracted: false };
        }

        if (ticks % 12 === 0) {
            log('info', ((maxWait - idle) / 1000).toFixed(0) + 's left | ' + current.length + ' chars | JSON: ' + (lastJson ? lastJson.length + 'ch' : 'scan'));
            if (recorder) await recorder.updateStatus('SCANNING ' + current.length + 'ch');
        }
        await new Promise(r => setTimeout(r, checkInterval));
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  SCREENSHOT HELPER
// ═══════════════════════════════════════════════════════════════════════════════
async function takeScreenshot(page, ssPath) {
    if (!CONFIG.screenshots.enabled) return;
    if (CONFIG.screenshots.onErrorOnly && !ssPath.includes('error')) return;
    try { await page.screenshot({ path: ssPath, fullPage: true }); }
    catch(e) { log('warn', 'SS: ' + e.message.slice(0, 40)); }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STANDARD MODE
// ═══════════════════════════════════════════════════════════════════════════════
async function processImageStandard(browser, imageInfo, index, total) {
    const { filename } = imageInfo;
    const safeName = filename.replace(/[^a-z0-9]/gi, '_');
    const ssPrefix = path.join(SCREENSHOTS_DIR, 'std_' + (index + 1) + '_' + safeName);
    const t0 = Date.now();

    log('info', '[STD] [' + (index + 1) + '/' + total + '] ' + filename);

    let recorder = null;
    if (CONFIG.recording.enabled) {
        const vidPath = path.join(RECORDINGS_DIR, `std_${index + 1}_${safeName}.mp4`);
        recorder = new ScreenRecorder(vidPath);
        activeRecorders.add(recorder);
    }

    try {
        const imageUrl = imageInfo.type === 'url' ? imageInfo.url : await uploadImage(imageInfo.resizedPath);
        const fullPrompt = buildPrompt(imageUrl);
        const ctx = await browser.createBrowserContext();
        const page = await ctx.newPage();

        try {
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
            await page.setViewport({ width: 1366, height: 768 });

            if (recorder) {
                await recorder.attach(page);
                await recorder.updateLabel('[' + (index + 1) + '/' + total + '] ' + filename.slice(0, 30), 'NAVIGATING');
            }

            await retry(() => page.goto('https://google.com/ai?hl=en&gl=us', {
                waitUntil: CONFIG.perf.navWaitUntil,
                timeout: CONFIG.timeouts.navigation
            }), { attempts: CONFIG.retry.navigationAttempts, label: 'Nav' });
            if (recorder) await recorder.updateStatus('PAGE LOADED');
            await takeScreenshot(page, ssPrefix + '_loaded.png');

            const promptSels = ['textarea[placeholder*="Ask" i]', 'textarea[aria-label*="message" i]', '[contenteditable="true"]', 'textarea', '[role="textbox"]'];
            let promptEl = null;
            for (const s of promptSels) { promptEl = await page.$(s); if (promptEl) break; }
            if (!promptEl) throw new Error('No prompt input');

            await promptEl.click();
            await page.evaluate((t) => { const el = document.activeElement || document.querySelector('textarea'); if (el) { el.value = t; el.dispatchEvent(new Event('input', { bubbles: true })); } }, fullPrompt);
            if (recorder) await recorder.updateStatus('PROMPT SET');
            await takeScreenshot(page, ssPrefix + '_prompt.png');

            const sendSels = ['button[aria-label*="Send" i]', 'button[aria-label*="send" i]', 'button[type="submit"]', '[data-testid="send-button"]'];
            let sent = false;
            for (const s of sendSels) {
                const btn = await page.$(s);
                if (btn && !(await btn.evaluate(el => el.disabled))) { await btn.click(); sent = true; break; }
            }
            if (!sent) await page.keyboard.press('Enter');
            if (recorder) await recorder.updateStatus('SUBMITTED');
            await takeScreenshot(page, ssPrefix + '_submitted.png');

            const resp = await waitForStreamedResponse(page, recorder);
            log('info', 'Response: ' + resp.text.length + ' chars');
            await takeScreenshot(page, ssPrefix + '_response.png');

            const analysis = analyzeResponse(resp.text);
            let finalError = null;
            if (analysis.isBlocked || analysis.isCaptchaHtml) {
                if (recorder) await recorder.updateStatus('BLOCKED');
                finalError = 'Blocked: IP blocked/CAPTCHA detected';
            } else if (analysis.isRateLimited) {
                finalError = 'Blocked: Rate limited';
            } else if (!analysis.hasJson) {
                finalError = 'Failed: No valid JSON found in response';
            }

            return {
                filename, originalId: imageInfo.originalId, imageUrl, response: resp.text,
                html: resp.html, duration: Date.now() - t0, error: finalError, timedOut: false,
                jsonExtracted: resp.jsonExtracted, mongoMeta: imageInfo.mongoMeta || null
            };
        } finally {
            if (recorder) {
                await recorder.stop();
                activeRecorders.delete(recorder);
            }
            await ctx.close();
        }
    } catch (err) {
        if (recorder) {
            await recorder.stop();
            activeRecorders.delete(recorder);
        }
        log('error', 'Fail ' + filename + ': ' + err.message);
        return {
            filename, originalId: imageInfo.originalId, imageUrl: null, response: '', html: '',
            duration: Date.now() - t0, error: err.message, timedOut: false, jsonExtracted: false,
            mongoMeta: imageInfo.mongoMeta || null
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  LENS MODE
// ═══════════════════════════════════════════════════════════════════════════════
async function processImageLens(browser, imageInfo, index, total) {
    const { filename } = imageInfo;
    const safeName = filename.replace(/[^a-z0-9]/gi, '_');
    const ssPrefix = path.join(SCREENSHOTS_DIR, 'lens_' + (index + 1) + '_' + safeName);
    const t0 = Date.now();

    log('info', '[LENS] [' + (index + 1) + '/' + total + '] ' + filename);

    let recorder = null;
    if (CONFIG.recording.enabled) {
        const vidPath = path.join(RECORDINGS_DIR, `lens_${index + 1}_${safeName}.mp4`);
        recorder = new ScreenRecorder(vidPath);
        activeRecorders.add(recorder);
    }

    try {
        const imageUrl = imageInfo.type === 'url' ? imageInfo.url : await uploadImage(imageInfo.resizedPath);
        const fullPrompt = buildPrompt(imageUrl);
        const ctx = await browser.createBrowserContext();
        const page = await ctx.newPage();

        try {
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
            await page.setViewport({ width: 1366, height: 768 });

            if (recorder) {
                await recorder.attach(page);
                await recorder.updateLabel('[' + (index + 1) + '/' + total + '] ' + filename.slice(0, 30), 'NAVIGATING');
            }

            const encodedPrompt = encodeURIComponent(fullPrompt);
            const lensUrl = 'https://lens.google.com/uploadbyurl?url=' + encodeURIComponent(imageUrl) + '&q=' + encodedPrompt;

            await retry(() => page.goto(lensUrl, {
                waitUntil: CONFIG.perf.navWaitUntil,
                timeout: CONFIG.timeouts.navigation
            }), { attempts: CONFIG.retry.navigationAttempts, label: 'Lens' });
            if (recorder) await recorder.updateStatus('LENS LOADED');
            await takeScreenshot(page, ssPrefix + '_lens.png');

            const finalUrl = page.url();
            log('debug', 'Redirect: ' + finalUrl.slice(0, 80));

            let aiUrl;
            try {
                const u = new URL(finalUrl);
                u.searchParams.delete('udm');
                u.searchParams.set('udm', '50');
                aiUrl = u.toString();
            } catch {
                aiUrl = finalUrl.includes('udm=') ? finalUrl.replace(/udm=[^&]+/, 'udm=50')
                    : finalUrl + (finalUrl.includes('?') ? '&' : '?') + 'udm=50';
            }

            if (recorder) await recorder.updateStatus('AI MODE');
            let aiNavigated = false;
            try {
                await page.evaluate((url) => { window.location.href = url; }, aiUrl);
                await page.waitForNavigation({ waitUntil: CONFIG.perf.navWaitUntil, timeout: 10000 });
                aiNavigated = true;
            } catch (e) {
                log('debug', 'Eval nav fail, fallback goto: ' + e.message.slice(0, 50));
                await retry(() => page.goto(aiUrl, {
                    waitUntil: CONFIG.perf.navWaitUntil,
                    timeout: CONFIG.timeouts.navigation
                }), { attempts: 1, label: 'AI fallback' });
            }
            if (recorder) await recorder.updateStatus('AI LOADED');
            await takeScreenshot(page, ssPrefix + '_ai.png');

            const resp = await waitForStreamedResponse(page, recorder);
            log('info', 'Response: ' + resp.text.length + ' chars');
            await takeScreenshot(page, ssPrefix + '_response.png');

            const analysis = analyzeResponse(resp.text);
            let finalError = null;
            if (analysis.isBlocked || analysis.isCaptchaHtml) {
                if (recorder) await recorder.updateStatus('BLOCKED');
                finalError = 'Blocked: IP blocked/CAPTCHA detected';
            } else if (analysis.isRateLimited) {
                finalError = 'Blocked: Rate limited';
            } else if (!analysis.hasJson) {
                finalError = 'Failed: No valid JSON found in response';
            }

            return {
                filename, originalId: imageInfo.originalId, imageUrl, response: resp.text,
                html: resp.html, duration: Date.now() - t0, error: finalError, timedOut: false,
                jsonExtracted: resp.jsonExtracted, mongoMeta: imageInfo.mongoMeta || null
            };
        } finally {
            if (recorder) {
                await recorder.stop();
                activeRecorders.delete(recorder);
            }
            await ctx.close();
        }
    } catch (err) {
        if (recorder) {
            await recorder.stop();
            activeRecorders.delete(recorder);
        }
        log('error', 'Fail ' + filename + ': ' + err.message);
        return {
            filename, originalId: imageInfo.originalId, imageUrl: null, response: '', html: '',
            duration: Date.now() - t0, error: err.message, timedOut: false, jsonExtracted: false,
            mongoMeta: imageInfo.mongoMeta || null
        };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ROUTER
// ═══════════════════════════════════════════════════════════════════════════════
async function processImage(browser, imageInfo, index, total) {
    return CONFIG.mode === 'lens'
        ? processImageLens(browser, imageInfo, index, total)
        : processImageStandard(browser, imageInfo, index, total);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  BATCH PROCESSING
// ═══════════════════════════════════════════════════════════════════════════════
function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
    return chunks;
}
async function jitteredDelay(baseMs) {
    await new Promise(r => setTimeout(r, baseMs + Math.random() * 200));
}

async function processBatch(browser, batch, batchIndex, totalBatches, offset) {
    log('info', 'BATCH [' + (batchIndex + 1) + '/' + totalBatches + '] ' + batch.length + ' img [' + CONFIG.mode + ']');
    const results = [];
    if (CONFIG.batch.enabled) {
        const promises = batch.map((img, i) => processImage(browser, img, offset + i, IMAGE_PATHS.length));
        results.push(...await Promise.all(promises));
    } else {
        for (let i = 0; i < batch.length; i++) {
            results.push(await processImage(browser, batch[i], offset + i, IMAGE_PATHS.length));
            if (i < batch.length - 1) await jitteredDelay(CONFIG.batch.delayBetweenSearchesMs);
        }
    }
    return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  VIDEO COMPILATION
// ═══════════════════════════════════════════════════════════════════════════════
async function compileRecordings(recordingsDir) {
    if (!fs.existsSync(recordingsDir)) return;
    const files = fs.readdirSync(recordingsDir).filter(f => f.endsWith('.mp4') && !f.startsWith('session_'));
    if (files.length === 0) return;

    const sessionName = 'session_' + new Date().toISOString().replace(/[:.]/g, '-') + '.mp4';
    const sessionPath = path.join(recordingsDir, sessionName);

    if (files.length === 1) {
        fs.renameSync(path.join(recordingsDir, files[0]), sessionPath);
        log('info', '🎬 Session video saved: ' + sessionName);
        return;
    }

    const listPath = path.join(recordingsDir, 'concat_list.txt');

    files.sort((a, b) => {
        const numA = parseInt(a.split('_')[1]) || 0;
        const numB = parseInt(b.split('_')[1]) || 0;
        return numA - numB;
    });

    const listContent = files.map(f => {
        const absolutePath = path.resolve(recordingsDir, f);
        return "file '" + absolutePath.replace(/'/g, "'\\''") + "'";
    }).join('\n') + '\n';

    fs.writeFileSync(listPath, listContent);

    return new Promise((resolve) => {
        let ffmpegPath = null;
        for (const c of ['ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
            try { execSync('which ' + c, { stdio: 'ignore' }); ffmpegPath = c; break; } catch (e) {}
        }

        if (!ffmpegPath) {
            log('warn', 'ffmpeg not found. Videos will remain separate clips.');
            resolve();
            return;
        }

        const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', sessionPath];
        const proc = spawn(ffmpegPath, args);

        let stderr = '';
        if (proc.stderr) proc.stderr.on('data', d => stderr += d);

        proc.on('close', (code) => {
            if (code === 0 && fs.existsSync(sessionPath)) {
                log('info', '🎬 Compiled ' + files.length + ' separate clips into one session video: ' + sessionName);
                for (const f of files) {
                    try { fs.unlinkSync(path.join(recordingsDir, f)); } catch(e) {}
                }
            } else {
                log('warn', 'Failed to compile clips (exit code ' + code + '). ffmpeg error: ' + stderr.slice(0, 300));
            }
            try { fs.unlinkSync(listPath); } catch(e) {}
            resolve();
        });
        proc.on('error', (err) => {
            log('warn', 'Failed to start ffmpeg compilation: ' + err.message);
            try { fs.unlinkSync(listPath); } catch(e) {}
            resolve();
        });
    });
}

// ═══════════════════════════════════════════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════════════
let activeBrowser = null;
const activeRecorders = new Set();
let isShuttingDown = false;

async function gracefulShutdown(sig) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log('warn', 'Signal ' + sig + '. Shutdown...');
    for (const rec of activeRecorders) await rec.stop();
    if (activeBrowser) {
        let closed = false;
        activeBrowser.close().then(() => { closed = true; }).catch(() => {});
        await new Promise(r => setTimeout(r, 5000));
        if (!closed) {
            log('warn', 'Browser close hung. Force killing...');
            try {
                const proc = activeBrowser.process && activeBrowser.process();
                if (proc) proc.kill('SIGKILL');
            } catch(e) {}
        }
    }
    // Release any MongoDB locks we're holding so other instances don't have
    // to wait out the full lock TTL just because this one got cancelled.
    await releaseAllLocksAndClose();
    cleanupTempImages();
    process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log('error', 'Unhandled:', err.message));

// ═══════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═══════════════════════════════════════════════════════════════════════════════
async function startTesting() {
    log('info', '═══════════════════════════════════════════════════════════════');
    log('info', '  GLENS PRODUCTION v6.3 — FILE-LEVEL MONGO LOCK & UPLOAD');
    log('info', '═══════════════════════════════════════════════════════════════');
    log('info', 'Mode: ' + CONFIG.mode.toUpperCase() + ' | Batch: ' + CONFIG.batch.size + ' | JSON idle: ' + CONFIG.timeouts.jsonIdle + 'ms');
    log('info', 'Nav wait: ' + CONFIG.perf.navWaitUntil + ' | Screenshots: ' + (CONFIG.screenshots.enabled ? 'ON' : 'OFF'));
    log('info', 'Recording: ' + (CONFIG.recording.enabled ? 'ON' : 'OFF') + ' | ' + CONFIG.recording.fps + 'fps | ' + CONFIG.recording.resolution);
    log('info', 'CPUs: ' + os.cpus().length + ' | Mem: ' + (os.totalmem() / 1024 / 1024 / 1024).toFixed(1) + 'GB');

    if (CONFIG.mongodb.uri) {
        log('info', 'MongoDB source enabled. Pulling reviewed files/frames...');
        IMAGE_PATHS = await fetchFromMongoDB();
    }

    if (IMAGE_PATHS.length === 0) {
        log('error', 'No images found');
        process.exit(1);
    }

    const tStart = Date.now();

    log('info', 'Resize...');
    const tResize = Date.now();
    const imageInfos = await Promise.all(IMAGE_PATHS.map(p => resizeImage(p)));
    log('info', 'Resized ' + imageInfos.length + ' in ' + ((Date.now() - tResize) / 1000).toFixed(1) + 's');

    log('info', 'Launch browser...');
    const tBrowser = Date.now();
    activeBrowser = await launch({
        headless: true,
        humanize: true,
        args: [
            '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
            '--disable-gpu', '--window-size=1366,768',
            '--disable-background-networking', '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
        ]
    });
    log('info', 'Browser ' + ((Date.now() - tBrowser) / 1000).toFixed(1) + 's');

    const allResults = [];
    let isGloballyBlocked = false;

    try {
        const batches = chunkArray(imageInfos, CONFIG.batch.size);
        for (let b = 0; b < batches.length; b++) {
            if (isGloballyBlocked) {
                log('warn', '🚫 IP is blocked. Skipping remaining ' + (batches.length - b) + ' batches.');
                const remaining = imageInfos.slice(b * CONFIG.batch.size);
                for (const img of remaining) {
                    allResults.push({
                        filename: img.filename,
                        originalId: img.originalId,
                        imageUrl: null,
                        response: '',
                        html: '',
                        duration: 0,
                        error: 'Skipped: IP blocked',
                        timedOut: false,
                        jsonExtracted: false,
                        mongoMeta: img.mongoMeta || null
                    });
                }
                break;
            }

            const offset = b * CONFIG.batch.size;
            const results = await processBatch(activeBrowser, batches[b], b, batches.length, offset);
            allResults.push(...results);

            const analysis = results.map(r => analyzeResponse(r.response));
            const blockedCount = analysis.filter(a => a.isBlocked || a.isCaptchaHtml).length;
            const rateLimitedCount = analysis.filter(a => a.isRateLimited).length;
            const noJsonCount = analysis.filter(a => !a.hasJson && !a.isBlocked && !a.isRateLimited).length;

            if (blockedCount > 0) {
                log('warn', '⚠️ BATCH BLOCKED: ' + blockedCount + '/' + results.length + ' images hit CAPTCHA/block');
                if (blockedCount >= 1) {
                    isGloballyBlocked = true;
                    log('error', '🚫 IP BLOCKED DETECTED. Stopping all further processing.');
                }
            }

            if (rateLimitedCount > 0) log('warn', '⏳ Rate limited on ' + rateLimitedCount + '/' + results.length + ' images');
            if (noJsonCount > 0) log('info', noJsonCount + '/' + results.length + ' images without JSON');

            if (!isGloballyBlocked && b < batches.length - 1) {
                const cooldown = rateLimitedCount > 0 ? CONFIG.batch.delayBetweenBatchesMs * 2 : CONFIG.batch.delayBetweenBatchesMs;
                log('info', 'Cooldown ' + cooldown + 'ms...');
                await jitteredDelay(cooldown);
            }
        }
    } finally {
        if (CONFIG.perf.fastClose) {
            log('info', 'Close browser (async)...');
            let closed = false;
            activeBrowser.close().then(() => { closed = true; }).catch(() => {});
            await new Promise(r => setTimeout(r, 10));
            if (!closed) {
                try {
                    const proc = activeBrowser.process && activeBrowser.process();
                    if (proc) proc.kill('SIGKILL');
                } catch(e) {}
            }
            activeBrowser = null;
        } else {
            log('info', 'Close browser...');
            let closed = false;
            activeBrowser.close().then(() => { closed = true; }).catch(() => {});
            await new Promise(r => setTimeout(r, 10000));
            if (!closed) {
                log('warn', 'Browser close hung. Force killing...');
                try {
                    const proc = activeBrowser.process && activeBrowser.process();
                    if (proc) proc.kill('SIGKILL');
                } catch(e) {}
            }
            activeBrowser = null;
        }
    }

    // ── Update MongoDB with successful responses, then release all locks ──
    if (CONFIG.mongodb.uri) {
        try {
            // Reuse the connection opened during claiming (mongoLockState) so
            // we don't pay for a second connect, and so the lock-release at
            // the end happens against the same client. If for some reason it
            // isn't open (e.g. fetchFromMongoDB was never called), fall back
            // to opening one here.
            let collection = mongoLockState.collection;
            let ownClient = false;
            if (!collection) {
                const { MongoClient } = await import('mongodb');
                const client = new MongoClient(CONFIG.mongodb.uri, { serverSelectionTimeoutMS: 10000 });
                await client.connect();
                collection = client.db(CONFIG.mongodb.db).collection(CONFIG.mongodb.collection);
                mongoLockState.client = client;
                mongoLockState.collection = collection;
                ownClient = true;
            }

            // Heartbeat off — we're about to do the final writes + release,
            // no need to keep extending leases mid-shutdown.
            stopLockHeartbeat();

            let updatedCount = 0;
            for (const r of allResults) {
                const extractedJson = extractJsonFromText(r.response || '');
                if (!r.error && !r.timedOut && extractedJson && r.mongoMeta) {
                    try {
                        let valueToStore;
                        try {
                            valueToStore = JSON.parse(extractedJson);
                        } catch (parseErr) {
                            valueToStore = extractedJson;
                        }
                        await collection.updateOne(
                            { _id: r.mongoMeta.docId },
                            { $set: { [`${r.mongoMeta.path}.response`]: valueToStore } }
                        );
                        
                        updatedCount++;
                        log('debug', `MongoDB updated: ${r.mongoMeta.postId} ${r.mongoMeta.path}`);
                    } catch (e) {
                        log('warn', `MongoDB update failed for ${r.mongoMeta.postId}: ${e.message}`);
                    }
                }
            }
            log('info', `MongoDB: Updated ${updatedCount} file(s) with responses`);

            // Release every file we claimed this run — successful, failed,
            // or skipped-due-to-block alike — so they're immediately
            // reclaimable by another instance instead of waiting out the
            // lock TTL. (Files that did get a `response` written above are
            // already excluded from future claim filters regardless, but we
            // still want the lock fields cleared for a clean doc state.)
            await releaseLocks(collection, mongoLockState.claimedFiles);

            if (ownClient) {
                await mongoLockState.client.close();
                mongoLockState.client = null;
                mongoLockState.collection = null;
            }
            mongoLockState.claimedFiles = [];
        } catch (e) {
            log('error', 'MongoDB update phase failed: ' + e.message);
        } finally {
            // Belt-and-suspenders: make sure we don't leave a dangling
            // connection open even if something above threw.
            await releaseAllLocksAndClose();
        }
    }

    const successful = allResults.filter(r => !r.error && !r.timedOut && extractJsonFromText(r.response || '')).length;
    const withJson = allResults.filter(r => !!extractJsonFromText(r.response || '')).length;
    const blocked = allResults.filter(r => {
        const a = analyzeResponse(r.response);
        return a.isBlocked || a.isCaptchaHtml;
    }).length;
    const skippedBlocked = allResults.filter(r => r.error && r.error.includes('Skipped: IP blocked')).length;
    const rateLimited = allResults.filter(r => {
        const a = analyzeResponse(r.response);
        return a.isRateLimited;
    }).length;
    const failed = allResults.filter(r => r.error || r.timedOut).length;

    const output = {
        timestamp: new Date().toISOString(),
        totalImages: imageInfos.length,
        successful, failed, withValidJson: withJson, blocked, skippedBlocked, rateLimited,
        mode: CONFIG.mode,
        config: { batchSize: CONFIG.batch.size, jsonIdle: CONFIG.timeouts.jsonIdle, navWaitUntil: CONFIG.perf.navWaitUntil, recording: CONFIG.recording },
        system: { platform: os.platform(), cpus: os.cpus().length, totalMemoryGB: (os.totalmem() / 1024 / 1024 / 1024).toFixed(1) },
        results: allResults.map(r => {
            const a = analyzeResponse(r.response);
            return {
                filename: r.filename, originalId: r.originalId, imageUrl: r.imageUrl, 
                response: extractJsonFromText(r.response || '') || r.response,
                duration: r.duration, error: r.error || null, timedOut: r.timedOut || false,
                isBlocked: a.isBlocked || a.isCaptchaHtml,
                isRateLimited: a.isRateLimited,
                hasJson: a.hasJson,
                mongoMeta: r.mongoMeta || null,
            };
        }),
    };

    const jsonPath = path.join(RESPONSES_DIR, 'ai_responses.json');
    const jsonData = JSON.stringify(output, null, 2);
    if (CONFIG.output.atomicWrites) atomicWrite(jsonPath, jsonData);
    else fs.writeFileSync(jsonPath, jsonData);
    log('info', 'Saved -> ' + jsonPath);

    const SUCCESSFUL_DIR = path.join(OUTPUT_DIR, 'successful');
    if (!fs.existsSync(SUCCESSFUL_DIR)) fs.mkdirSync(SUCCESSFUL_DIR, { recursive: true });

    const successfulResults = allResults.filter(r => !r.error && !r.timedOut && extractJsonFromText(r.response || ''));

    for (const r of successfulResults) {
        const identifier = r.originalId || r.filename;
        const hash = crypto.createHash('md5').update(identifier).digest('hex');
        const outputFilename = hash + '.json';

        const extractedJson = extractJsonFromText(r.response || '');
        const payload = {
            originalId: identifier,
            filename: outputFilename,
            imageURL: r.imageUrl,
            response: extractedJson
        };
        const filePath = path.join(SUCCESSFUL_DIR, outputFilename);
        const data = JSON.stringify(payload, null, 2);
        if (CONFIG.output.atomicWrites) atomicWrite(filePath, data);
        else fs.writeFileSync(filePath, data, 'utf8');
    }

    if (successfulResults.length > 0) {
        log('info', 'Saved ' + successfulResults.length + ' successful result(s) to ' + SUCCESSFUL_DIR);
    }

    cleanupTempImages();

    if (CONFIG.recording.enabled) {
        log('info', 'Compiling separate recordings into one session file...');
        await compileRecordings(RECORDINGS_DIR);
    }

    const total = ((Date.now() - tStart) / 1000).toFixed(1);
    log('info', '═══════════════════════════════════════════════════════════════');
    log('info', 'DONE ' + total + 's | ' + successful + '/' + imageInfos.length + ' OK | ' + withJson + ' JSON | ' + blocked + ' BLOCKED | ' + skippedBlocked + ' SKIPPED | ' + rateLimited + ' RATE-LIMITED | ' + failed + ' FAIL');
    if (CONFIG.recording.enabled) log('info', 'Recordings saved in: ' + RECORDINGS_DIR);
    log('info', '═══════════════════════════════════════════════════════════════');
    if (blocked > 0) log('warn', 'Google detected unusual traffic. Retry on a different IP.');
    if (failed > 0) process.exitCode = 1;
}

startTesting().catch(err => {
    log('error', 'Fatal:', err.message);
    for (const rec of activeRecorders) rec.stop().catch(() => {});
    if (activeBrowser) {
        let closed = false;
        activeBrowser.close().then(() => { closed = true; }).catch(() => {});
        setTimeout(() => {
            if (!closed) {
                try {
                    const proc = activeBrowser.process && activeBrowser.process();
                    if (proc) proc.kill('SIGKILL');
                } catch(e) {}
            }
        }, 5000);
    }
    // Best-effort: free up any claimed files so other instances don't have
    // to wait out the full lock TTL after a fatal crash.
    releaseAllLocksAndClose().catch(() => {}).finally(() => {
        cleanupTempImages();
        process.exit(1);
    });
});
