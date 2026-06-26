import { launch } from 'cloakbrowser/puppeteer';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import os from 'os';
import crypto from 'crypto';
import { spawn, execSync } from 'child_process';

// --- CONFIG ---
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
};

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

// --- SCREEN RECORDER ---
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
                // dropped
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
                log('warn', 'ffmpeg not found. Saved frames only.');
                const frameList = path.join(this.framesDir, '..', path.basename(this.outputPath) + '_frames.txt');
                fs.writeFileSync(frameList, 'Frames: ' + this.frameCount + '\nDir: ' + this.framesDir);
                resolve();
                return;
            }

            const [width, height] = CONFIG.recording.resolution.split('x');
            const args = [
                '-y', '-framerate', String(CONFIG.recording.fps),
                '-i', path.join(this.framesDir, 'frame_%06d.jpg'),
                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '28', '-preset', 'fast', '-movflags', '+faststart',
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
                    log('warn', 'ffmpeg exited ' + code + '. ' + stderr.slice(0, 150));
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
            try { execSync('which ' + c, { stdio: 'ignore' }); return c; } catch (e) {}
        }
        return null;
    }
}

// --- BLOCK DETECTION ---
const BLOCK_KEYWORDS = ['unusual traffic', 'robot', 'captcha', 'recaptcha', 'verify you are human', 'i\'m not a robot', 'try again later', 'rate limit', 'too many requests', 'access denied', 'blocked', 'suspicious activity', 'automated requests', 'temporarily unavailable'];
const RATE_LIMIT_KEYWORDS = ['rate limit', 'too many requests', 'try again later', 'temporarily unavailable', 'slow down'];

function detectBlockPage(text) {
    if (!text || text.length < 100) return false;
    const lower = text.toLowerCase();
    return BLOCK_KEYWORDS.some(kw => lower.includes(kw));
}
function detectRateLimit(text) {
    if (!text || text.length < 50) return false;
    const lower = text.toLowerCase();
    return RATE_LIMIT_KEYWORDS.some(kw => lower.includes(kw));
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

// --- PATHS ---
const OUTPUT_DIR = CONFIG.output.dir;
const SCREENSHOTS_DIR = path.join(OUTPUT_DIR, 'screenshots');
const RESPONSES_DIR = path.join(OUTPUT_DIR, 'responses');
const RECORDINGS_DIR = path.join(OUTPUT_DIR, 'recordings');
const TMP_DIR = path.join(process.cwd(), 'tmp_resized');

[OUTPUT_DIR, SCREENSHOTS_DIR, RESPONSES_DIR, RECORDINGS_DIR, TMP_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// --- IMAGE DISCOVERY ---
const IMAGE_DIR_CANDIDATES = [
    path.join(process.cwd(), 'images'),
    path.join(process.cwd(), 'contents', 'images'),
    '/content/images',
    '/contents/images',
];

let IMAGE_PATHS = [];
const ENV_URLS = process.env.GLENS_IMAGE_URLS;

if (ENV_URLS && ENV_URLS.trim()) {
    try {
        const parsed = JSON.parse(ENV_URLS);
        if (Array.isArray(parsed) && parsed.length > 0) {
            IMAGE_PATHS = parsed.map((url, i) => {
                let basename = 'image.jpg';
                try { basename = path.basename(new URL(url).pathname); } catch(e) {}
                return { type: 'url', url: url, filename: 'url_' + i + '_' + basename };
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
            const files = fs.readdirSync(dir).filter(f => /\.(png|jpg|jpe?g|gif|webp|bmp)$/i.test(f)).map(f => path.join(dir, f));
            if (files.length > 0) { IMAGE_PATHS = files; log('info', 'Found ' + files.length + ' image(s)'); break; }
        }
    }
}
if (IMAGE_PATHS.length === 0) {
    log('error', 'No images found');
    process.exit(1);
}

// --- PROMPT ---
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

Return ONLY raw JSON. No code blocks, no explanations. Raw JSON text in one line.

Schema:
{"products":[{"title":"string","brand":"string","description":"string","category":"string","price":{"current":"string","original":"string|null","currency":"string"},"availability":"string","sizing":["string"],"sources":[{"store":"string","url":"string","price":"string|null","availability":"string|null"}],"socialAppearances":[{"platform":"string","url":"string|null","context":"string|null"}],"dropshipViability":{"score":1-10,"reasoning":"string","risks":["string"]},"estimatedResaleRange":{"low":"string","high":"string","currency":"string"},"alternatives":[{"title":"string","brand":"string","url":"string","price":"string|null","why":"string"}]}]}

Heres the image URL: {IMAGE_URL}`;

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

// --- IMAGE RESIZE ---
async function resizeImage(imgPathOrInfo) {
    if (typeof imgPathOrInfo === 'object' && imgPathOrInfo.type === 'url') {
        imgPathOrInfo.originalId = imgPathOrInfo.url;
        return imgPathOrInfo;
    }
    const imgPath = imgPathOrInfo;
    const filename = path.basename(imgPath, path.extname(imgPath)) + '.jpg';
    const outPath = path.join(TMP_DIR, filename);
    const originalId = path.basename(imgPath);
    try {
        const meta = await sharp(imgPath).metadata();
        const needs = meta.width > CONFIG.image.maxDimension || meta.height > CONFIG.image.maxDimension;
        const pipeline = needs ? sharp(imgPath).resize(CONFIG.image.maxDimension, CONFIG.image.maxDimension, { fit: 'inside', withoutEnlargement: true }) : sharp(imgPath);
        await pipeline.jpeg({ quality: CONFIG.image.quality, progressive: true }).toFile(outPath);
        return { type: 'local', originalPath: imgPath, resizedPath: outPath, filename, originalId };
    } catch (e) {
        return { type: 'local', originalPath: imgPath, resizedPath: imgPath, filename, originalId };
    }
}
function cleanupTempImages() {
    try {
        if (!fs.existsSync(TMP_DIR)) return;
        let removed = 0;
        for (const f of fs.readdirSync(TMP_DIR)) { try { fs.unlinkSync(path.join(TMP_DIR, f)); removed++; } catch(e) {} }
    } catch (e) {}
}

// --- UPLOAD ---
async function uploadToCatbox(filePath) {
    const buf = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('fileToUpload', new Blob([buf]), path.basename(filePath));
    const res = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: form });
    const url = (await res.text()).trim();
    if (!url.startsWith('http')) throw new Error('Catbox: ' + url.slice(0, 80));
    return url;
}
async function uploadToLitterbox(filePath) {
    const buf = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('time', '72h');
    form.append('fileToUpload', new Blob([buf]), path.basename(filePath));
    const res = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', { method: 'POST', body: form });
    const url = (await res.text()).trim();
    if (!url.startsWith('http')) throw new Error('Litterbox: ' + url.slice(0, 80));
    return url;
}
async function uploadImage(filePath) {
    const methods = [{ name: 'catbox', fn: uploadToCatbox }, { name: 'litterbox', fn: uploadToLitterbox }];
    for (const m of methods) {
        try { return await retry(() => m.fn(filePath), { attempts: CONFIG.retry.uploadAttempts, label: m.name }); }
        catch (e) { log('warn', m.name + ' fail: ' + e.message.slice(0, 60)); }
    }
    throw new Error('All uploads failed');
}

// --- JSON EXTRACTION ---
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
function repairTruncatedJson(text) {
    let open = 0, inStr = false, esc = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (esc) { esc = false; continue; }
        if (ch === '\\') { esc = true; continue; }
        if (ch === '"' && !inStr) { inStr = true; continue; }
        if (ch === '"' && inStr) { inStr = false; continue; }
        if (inStr) continue;
        if (ch === '{') open++; if (ch === '}') open--;
    }
    let r = text.replace(/,\s*$/, '');
    while (open > 0) { r += '}'; open--; }
    try { JSON.parse(r); return r; } catch { return null; }
}
function extractJsonFromText(text) {
    if (!text || text.length < 10) return null;
    for (const sig of ['{"products":[', '{"products": [']) {
        let pos = 0;
        while ((pos = text.indexOf(sig, pos)) !== -1) {
            const c = extractBalancedJson(text, pos);
            if (c && isRealProductData(c)) return c;
            pos++;
        }
    }
    let pos = 0;
    while ((pos = text.indexOf('{', pos)) !== -1) {
        const c = extractBalancedJson(text, pos);
        if (c && c.length > 100 && isRealProductData(c)) return c;
        pos++;
    }
    const last = text.lastIndexOf('}');
    if (last > 100) {
        const r = repairTruncatedJson(text.slice(text.indexOf('{'), last + 1));
        if (r && isRealProductData(r)) return r;
    }
    return null;
}

// --- STREAMED RESPONSE ---
async function getResponseTextFromPage(page) {
    await page.evaluate(FIND_DEEP_SCRIPT);
    const selectors = ['model-response', '[class*="response"]', '[class*="message"]', '[class*="chat"]', '[class*="conversation"]', 'article', '[role="region"]', '[role="main"]', 'main', '[class*="markdown"]', '[class*="content"]'];
    for (const sel of selectors) {
        try {
            const texts = await page.evaluate((s) => findAllDeep(document.body, s).map(e => getVisibleTextDeep(e)).filter(t => t.length > 50), sel);
            if (texts.length) {
                const best = texts.reduce((a, b) => a.length > b.length ? a : b, '');
                if (best.length > 100) return best;
            }
        } catch(e) {}
    }
    return await page.evaluate(() => getVisibleTextDeep(document.body));
}

async function waitForStreamedResponse(page, recorder) {
    const checkInterval = 400, maxWait = CONFIG.timeouts.response, jsonIdle = CONFIG.timeouts.jsonIdle;
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
                if (recorder) await recorder.updateStatus('JSON FOUND');
            }
        } else stable++;

        const idle = Date.now() - lastChange;

        if (lastJson && idle >= jsonIdle) {
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
            if (recorder) await recorder.updateStatus('TIMEOUT');
            const j = extractJsonFromText(current) || lastJson;
            return { text: j || current, html: '', duration: Date.now() - start, jsonExtracted: !!j };
        }
        if (ticks % 12 === 0 && recorder) await recorder.updateStatus('SCANNING ' + current.length + 'ch');
        await new Promise(r => setTimeout(r, checkInterval));
    }
}

async function takeScreenshot(page, ssPath) {
    if (!CONFIG.screenshots.enabled) return;
    if (CONFIG.screenshots.onErrorOnly && !ssPath.includes('error')) return;
    try { await page.screenshot({ path: ssPath, fullPage: true }); } catch(e) {}
}

// --- CORE MODES ---
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
        const fullPrompt = PROMPT_TEMPLATE.replace('{IMAGE_URL}', imageUrl);
        const ctx = await browser.createBrowserContext();
        const page = await ctx.newPage();

        try {
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
            await page.setViewport({ width: 1366, height: 768 });

            if (recorder) {
                await recorder.attach(page);
                await recorder.updateLabel('[' + (index + 1) + '/' + total + '] ' + filename.slice(0, 30), 'NAVIGATING');
            }

            await retry(() => page.goto('https://google.com/ai?hl=en&gl=us', { waitUntil: CONFIG.perf.navWaitUntil, timeout: CONFIG.timeouts.navigation }), { attempts: CONFIG.retry.navigationAttempts, label: 'Nav' });
            if (recorder) await recorder.updateStatus('PAGE LOADED');

            const promptSels = ['textarea[placeholder*="Ask" i]', 'textarea[aria-label*="message" i]', '[contenteditable="true"]', 'textarea', '[role="textbox"]'];
            let promptEl = null;
            for (const s of promptSels) { promptEl = await page.$(s); if (promptEl) break; }
            if (!promptEl) throw new Error('No prompt input');

            await promptEl.click();
            await page.evaluate((t) => { const el = document.activeElement || document.querySelector('textarea'); if (el) { el.value = t; el.dispatchEvent(new Event('input', { bubbles: true })); } }, fullPrompt);
            if (recorder) await recorder.updateStatus('PROMPT SET');

            const sendSels = ['button[aria-label*="Send" i]', 'button[aria-label*="send" i]', 'button[type="submit"]', '[data-testid="send-button"]'];
            let sent = false;
            for (const s of sendSels) {
                const btn = await page.$(s);
                if (btn && !(await btn.evaluate(el => el.disabled))) { await btn.click(); sent = true; break; }
            }
            if (!sent) await page.keyboard.press('Enter');
            if (recorder) await recorder.updateStatus('SUBMITTED');

            const resp = await waitForStreamedResponse(page, recorder);
            log('info', 'Response: ' + resp.text.length + ' chars');
            
            const analysis = analyzeResponse(resp.text);
            if (analysis.isBlocked || analysis.isCaptchaHtml) {
                if (recorder) await recorder.updateStatus('BLOCKED');
            }

            return { filename, originalId: imageInfo.originalId, imageUrl, response: resp.text, html: resp.html, duration: Date.now() - t0, error: null, timedOut: false, jsonExtracted: resp.jsonExtracted };
        } finally {
            if (recorder) { await recorder.stop(); activeRecorders.delete(recorder); }
            await ctx.close();
        }
    } catch (err) {
        if (recorder) { await recorder.stop(); activeRecorders.delete(recorder); }
        log('error', 'Fail ' + filename + ': ' + err.message);
        return { filename, originalId: imageInfo.originalId, imageUrl: null, response: '', html: '', duration: Date.now() - t0, error: err.message, timedOut: false, jsonExtracted: false };
    }
}

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
        const fullPrompt = PROMPT_TEMPLATE.replace('{IMAGE_URL}', imageUrl);
        const ctx = await browser.createBrowserContext();
        const page = await ctx.newPage();

        try {
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
            await page.setViewport({ width: 1366, height: 768 });

            if (recorder) {
                await recorder.attach(page);
                await recorder.updateLabel('[' + (index + 1) + '/' + total + '] ' + filename.slice(0, 30), 'NAVIGATING');
            }

            const lensUrl = 'https://lens.google.com/uploadbyurl?url=' + encodeURIComponent(imageUrl) + '&q=' + encodeURIComponent(fullPrompt);
            await retry(() => page.goto(lensUrl, { waitUntil: CONFIG.perf.navWaitUntil, timeout: CONFIG.timeouts.navigation }), { attempts: CONFIG.retry.navigationAttempts, label: 'Lens' });
            if (recorder) await recorder.updateStatus('LENS LOADED');

            const finalUrl = page.url();
            let aiUrl = finalUrl.includes('udm=') ? finalUrl.replace(/udm=[^&]+/, 'udm=50') : finalUrl + (finalUrl.includes('?') ? '&' : '?') + 'udm=50';
            try { const u = new URL(finalUrl); u.searchParams.set('udm', '50'); aiUrl = u.toString(); } catch {}

            if (recorder) await recorder.updateStatus('AI MODE');
            try {
                await page.evaluate((url) => { window.location.href = url; }, aiUrl);
                await page.waitForNavigation({ waitUntil: CONFIG.perf.navWaitUntil, timeout: 10000 });
            } catch (e) {
                await retry(() => page.goto(aiUrl, { waitUntil: CONFIG.perf.navWaitUntil, timeout: CONFIG.timeouts.navigation }), { attempts: 1, label: 'AI fallback' });
            }
            if (recorder) await recorder.updateStatus('AI LOADED');

            const resp = await waitForStreamedResponse(page, recorder);
            log('info', 'Response: ' + resp.text.length + ' chars');

            const analysis = analyzeResponse(resp.text);
            if (analysis.isBlocked || analysis.isCaptchaHtml) {
                if (recorder) await recorder.updateStatus('BLOCKED');
            }

            return { filename, originalId: imageInfo.originalId, imageUrl, response: resp.text, html: resp.html, duration: Date.now() - t0, error: null, timedOut: false, jsonExtracted: resp.jsonExtracted };
        } finally {
            if (recorder) { await recorder.stop(); activeRecorders.delete(recorder); }
            await ctx.close();
        }
    } catch (err) {
        if (recorder) { await recorder.stop(); activeRecorders.delete(recorder); }
        log('error', 'Fail ' + filename + ': ' + err.message);
        return { filename, originalId: imageInfo.originalId, imageUrl: null, response: '', html: '', duration: Date.now() - t0, error: err.message, timedOut: false, jsonExtracted: false };
    }
}

async function processImage(browser, imageInfo, index, total) {
    return CONFIG.mode === 'lens' ? processImageLens(browser, imageInfo, index, total) : processImageStandard(browser, imageInfo, index, total);
}

// --- BATCHING & VIDEO COMPILATION ---
function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
    return chunks;
}

async function processBatch(browser, batch, batchIndex, totalBatches, offset) {
    log('info', 'BATCH [' + (batchIndex + 1) + '/' + totalBatches + '] ' + batch.length + ' img [' + CONFIG.mode + ']');
    const results = [];
    if (CONFIG.batch.enabled) {
        results.push(...await Promise.all(batch.map((img, i) => processImage(browser, img, offset + i, IMAGE_PATHS.length))));
    } else {
        for (let i = 0; i < batch.length; i++) {
            results.push(await processImage(browser, batch[i], offset + i, IMAGE_PATHS.length));
            if (i < batch.length - 1) await new Promise(r => setTimeout(r, CONFIG.batch.delayBetweenSearchesMs));
        }
    }
    return results;
}

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
    files.sort((a, b) => (parseInt(a.split('_')[1]) || 0) - (parseInt(b.split('_')[1]) || 0));
    fs.writeFileSync(listPath, files.map(f => "file '" + f.replace(/'/g, "'\\''") + "'").join('\n') + '\n');

    return new Promise((resolve) => {
        let ffmpegPath = null;
        for (const c of ['ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
            try { execSync('which ' + c, { stdio: 'ignore' }); ffmpegPath = c; break; } catch (e) {}
        }
        if (!ffmpegPath) { log('warn', 'ffmpeg not found. Videos remain separate.'); resolve(); return; }

        const proc = spawn(ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', sessionPath], { cwd: recordingsDir });
        proc.on('close', (code) => {
            if (code === 0) {
                log('info', '🎬 Compiled ' + files.length + ' clips into: ' + sessionName);
                for (const f of files) { try { fs.unlinkSync(path.join(recordingsDir, f)); } catch(e) {} }
            } else log('warn', 'Failed to compile clips.');
            try { fs.unlinkSync(listPath); } catch(e) {}
            resolve();
        });
        proc.on('error', () => { try { fs.unlinkSync(listPath); } catch(e) {} resolve(); });
    });
}

// --- MAIN RUNNER ---
let activeBrowser = null;
const activeRecorders = new Set();
let isShuttingDown = false;

async function gracefulShutdown(sig) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log('warn', 'Signal ' + sig + '. Shutdown...');
    for (const rec of activeRecorders) await rec.stop();
    if (activeBrowser) {
        activeBrowser.close().catch(() => {});
        setTimeout(() => { try { activeBrowser.process()?.kill('SIGKILL'); } catch(e) {} }, 3000);
    }
    cleanupTempImages();
    process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

async function startTesting() {
    log('info', 'GLENS PRODUCTION v6.3');
    const tStart = Date.now();
    const imageInfos = await Promise.all(IMAGE_PATHS.map(p => resizeImage(p)));

    activeBrowser = await launch({
        headless: true, humanize: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--window-size=1366,768']
    });

    const allResults = [];
    let isGloballyBlocked = false;

    try {
        const batches = chunkArray(imageInfos, CONFIG.batch.size);
        for (let b = 0; b < batches.length; b++) {
            if (isGloballyBlocked) {
                log('warn', '🚫 IP blocked. Skipping remaining batches.');
                allResults.push(...imageInfos.slice(b * CONFIG.batch.size).map(img => ({
                    filename: img.filename, originalId: img.originalId, imageUrl: null, response: '', error: 'Skipped: IP blocked'
                })));
                break;
            }

            const results = await processBatch(activeBrowser, batches[b], b, batches.length, b * CONFIG.batch.size);
            allResults.push(...results);

            const blockedCount = results.filter(r => analyzeResponse(r.response).isBlocked || analyzeResponse(r.response).isCaptchaHtml).length;
            if (blockedCount > 0) isGloballyBlocked = true;

            if (!isGloballyBlocked && b < batches.length - 1) {
                await new Promise(r => setTimeout(r, CONFIG.batch.delayBetweenBatchesMs));
            }
        }
    } finally {
        if (activeBrowser) {
            activeBrowser.close().catch(() => {});
            setTimeout(() => { try { activeBrowser.process()?.kill('SIGKILL'); } catch(e) {} }, 3000);
        }
    }

    const output = {
        timestamp: new Date().toISOString(),
        totalImages: imageInfos.length,
        results: allResults.map(r => ({
            filename: r.filename, originalId: r.originalId, imageUrl: r.imageUrl, response: r.response, error: r.error
        })),
    };

    const jsonPath = path.join(RESPONSES_DIR, 'ai_responses.json');
    if (CONFIG.output.atomicWrites) atomicWrite(jsonPath, JSON.stringify(output, null, 2));
    else fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2));

    const SUCCESSFUL_DIR = path.join(OUTPUT_DIR, 'successful');
    if (!fs.existsSync(SUCCESSFUL_DIR)) fs.mkdirSync(SUCCESSFUL_DIR, { recursive: true });

    const successfulResults = allResults.filter(r => !r.error && r.response);
    for (const r of successfulResults) {
        const identifier = r.originalId || r.filename;
        const hash = crypto.createHash('md5').update(identifier).digest('hex');
        const filePath = path.join(SUCCESSFUL_DIR, hash + '.json');
        const data = JSON.stringify({ originalId: identifier, filename: hash + '.json', imageURL: r.imageUrl, response: r.response }, null, 2);
        if (CONFIG.output.atomicWrites) atomicWrite(filePath, data); else fs.writeFileSync(filePath, data);
    }

    cleanupTempImages();

    if (CONFIG.recording.enabled) {
        log('info', 'Compiling separate recordings into one session file...');
        await compileRecordings(RECORDINGS_DIR);
    }

    const total = ((Date.now() - tStart) / 1000).toFixed(1);
    log('info', 'DONE ' + total + 's | ' + successfulResults.length + '/' + imageInfos.length + ' OK');
    if (isGloballyBlocked) process.exitCode = 1;
}

startTesting().catch(err => {
    log('error', 'Fatal:', err.message);
    gracefulShutdown('FATAL');
});
