import { launch } from 'cloakbrowser/puppeteer';
import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import os from 'os';
import { spawn, execSync } from 'child_process';

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
    const prefix = `[${ts}] [${level.toUpperCase()}]`;
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
            log('warn', `⏳ ${label} fail ${i + 1}/${attempts}: ${err.message.slice(0, 50)}. Retry ${delayMs}ms`);
            await new Promise(r => setTimeout(r, delayMs));
        }
    }
    throw new Error(`${label} failed ${attempts}x: ${lastErr.message}`);
}

function atomicWrite(filePath, data) {
    const tmpPath = `${filePath}.tmp.${Date.now()}`;
    fs.writeFileSync(tmpPath, data, 'utf8');
    fs.renameSync(tmpPath, filePath);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  GLOBAL SCREEN RECORDER — One file for entire session
// ═══════════════════════════════════════════════════════════════════════════════
class GlobalScreenRecorder {
    constructor(outputPath) {
        this.outputPath = outputPath;
        this.framesDir = path.join(path.dirname(outputPath), `.frames_global`);
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
        this.page = page;
        this.startTime = Date.now();
        if (!fs.existsSync(this.framesDir)) fs.mkdirSync(this.framesDir, { recursive: true });

        // Add overlay div to page
        await this.page.evaluate((cfg) => {
            const existing = document.getElementById('glens-overlay');
            if (existing) existing.remove();
            const div = document.createElement('div');
            div.id = 'glens-overlay';
            div.style.cssText = `
                position: fixed !important;
                top: 8px !important;
                left: 8px !important;
                z-index: 999999 !important;
                background: rgba(0,0,0,0.7) !important;
                color: ${cfg.overlayColor} !important;
                font-family: monospace !important;
                font-size: ${cfg.overlaySize}px !important;
                padding: 6px 10px !important;
                border-radius: 4px !important;
                pointer-events: none !important;
                line-height: 1.4 !important;
                white-space: pre !important;
                max-width: 80vw !important;
                overflow: hidden !important;
                text-overflow: ellipsis !important;
            `;
            div.textContent = '[STARTING...]';
            document.body.appendChild(div);
        }, CONFIG.recording);

        // Start CDP screencast
        this.client = await this.page.target().createCDPSession();
        await this.client.send('Page.startScreencast', {
            format: 'jpeg',
            quality: CONFIG.recording.quality,
            maxWidth: parseInt(CONFIG.recording.resolution.split('x')[0]),
            maxHeight: parseInt(CONFIG.recording.resolution.split('x')[1]),
            everyNthFrame: Math.max(1, Math.round(60 / CONFIG.recording.fps)),
        });

        this.client.on('Page.screencastFrame', async (frame) => {
            if (!this.isRecording) return;
            try {
                const buf = Buffer.from(frame.data, 'base64');
                const framePath = path.join(this.framesDir, `frame_${String(this.frameCount).padStart(6, '0')}.jpg`);
                fs.writeFileSync(framePath, buf);
                this.frameCount++;
                await this.client.send('Page.screencastFrameAck', { sessionId: frame.sessionId });
            } catch (e) {
                // Frame dropped, continue
            }
        });

        this.isRecording = true;
        log('info', `🎬 Global recording started: ${path.basename(this.outputPath)} @ ${CONFIG.recording.fps}fps`);
    }

    async updateLabel(label, status = '') {
        if (!CONFIG.recording.enabled || !this.page) return;
        this.currentLabel = label;
        if (status) this.currentStatus = status;
        try {
            const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
            await this.page.evaluate((lbl, st, el) => {
                const div = document.getElementById('glens-overlay');
                if (div) div.textContent = `${lbl}\n[${st}] ${el}s`;
            }, label, this.currentStatus, elapsed);
        } catch (e) {}
    }

    async updateStatus(status) {
        this.currentStatus = status;
        await this.updateLabel(this.currentLabel, status);
    }

    async detach() {
        if (!CONFIG.recording.enabled) return;
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

        // Encode with ffmpeg if available
        if (this.frameCount > 0) {
            await this._encodeVideo();
        }

        // Cleanup frames
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
                const frameList = path.join(this.framesDir, '..', `global_frames.txt`);
                fs.writeFileSync(frameList, `Frames: ${this.frameCount}\nDir: ${this.framesDir}\nffmpeg command:\nffmpeg -framerate ${CONFIG.recording.fps} -i ${path.join(this.framesDir, 'frame_%06d.jpg')} -c:v libx264 -pix_fmt yuv420p -crf 23 ${this.outputPath}`);
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
                '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`,
                this.outputPath
            ];

            const proc = spawn(ffmpegPath, args, { stdio: 'pipe' });
            let stderr = '';
            proc.stderr.on('data', d => stderr += d);
            proc.on('close', (code) => {
                if (code === 0) {
                    const stats = fs.statSync(this.outputPath);
                    log('info', `🎬 Video saved: ${path.basename(this.outputPath)} (${(stats.size/1024/1024).toFixed(1)}MB, ${this.frameCount} frames)`);
                } else {
                    log('warn', `ffmpeg exited ${code}. ${stderr.slice(0, 200)}`);
                }
                resolve();
            });
            proc.on('error', (err) => {
                log('warn', `ffmpeg error: ${err.message}`);
                resolve();
            });

            // Timeout after 120s for full session encoding
            setTimeout(() => {
                try { proc.kill('SIGKILL'); } catch(e) {}
                resolve();
            }, 120000);
        });
    }

    _findFfmpeg() {
        const candidates = ['ffmpeg', '/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg'];
        for (const c of candidates) {
            try {
                execSync(`which ${c}`, { stdio: 'ignore' });
                return c;
            } catch (e) {}
        }
        return null;
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  BLOCK DETECTION — Critical for avoiding wasted retries on CAPTCHA
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
//  IMAGE DISCOVERY
// ═══════════════════════════════════════════════════════════════════════════════
const IMAGE_DIR_CANDIDATES = [
    path.join(process.cwd(), 'images'),
    path.join(process.cwd(), 'contents', 'images'),
    '/content/images',
    '/contents/images',
];

let IMAGE_PATHS = [];
for (const dir of IMAGE_DIR_CANDIDATES) {
    if (fs.existsSync(dir)) {
        const files = fs.readdirSync(dir)
            .filter(f => /\.(png|jpg|jpe?g|gif|webp|bmp)$/i.test(f))
            .map(f => path.join(dir, f));
        if (files.length > 0) { IMAGE_PATHS = files; log('info', `Found ${files.length} image(s)`); break; }
    }
}

if (IMAGE_PATHS.length === 0) {
    log('error', 'No images found');
    process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  PROMPT
// ═══════════════════════════════════════════════════════════════════════════════
/*const PROMPT_TEMPLATE = `Analyze this image and identify all visible products (clothing, footwear, accessories, jewelry, etc.). For each product found, provide:

1. Title: Product name
2. Brand: Manufacturer/brand name
3. Description: What it is, key features, colors, materials
4. Category: Type of product (top, bottom, footwear, accessory, etc.)
5. Price: Current price and original/sale price if discounted
6. Availability: In stock, out of stock, pre-order, etc.
7. Sizing: Available sizes or size range
8. Sources: At least 5 direct product page URLs where this exact or very similar item can be purchased. Sort by reliability (official brand store first, then major retailers, then resellers). Each source should include:
   - Store name
   - Direct product URL (very important)
   - Price at that source (if known)
   - Availability at that source

Return ONLY raw JSON. No code blocks, no explanations. Raw JSON text in one line.

Schema:

{"products":[{"title":"string","brand":"string","description":"string","category":"string","price":{"current":"string","original":"string|null","currency":"string"},"availability":"string","sizing":["string"],"sources":[{"store":"string","url":"string","price":"string|null","availability":"string|null"}]}]}

Heres the image URL: {IMAGE_URL}`;*/

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
async function resizeImage(imgPath) {
    const filename = path.basename(imgPath, path.extname(imgPath)) + '.jpg';
    const outPath = path.join(TMP_DIR, filename);
    try {
        const meta = await sharp(imgPath).metadata();
        const needs = meta.width > CONFIG.image.maxDimension || meta.height > CONFIG.image.maxDimension;
        const pipeline = needs
            ? sharp(imgPath).resize(CONFIG.image.maxDimension, CONFIG.image.maxDimension, { fit: 'inside', withoutEnlargement: true })
            : sharp(imgPath);
        await pipeline.jpeg({ quality: CONFIG.image.quality, progressive: true }).toFile(outPath);
        log('debug', `${filename}: ${(fs.statSync(imgPath).size/1024).toFixed(0)}KB -> ${(fs.statSync(outPath).size/1024).toFixed(0)}KB`);
        return { originalPath: imgPath, resizedPath: outPath, filename };
    } catch (e) {
        log('warn', `Resize fail ${filename}: ${e.message}. Using original.`);
        return { originalPath: imgPath, resizedPath: imgPath, filename };
    }
}

function cleanupTempImages() {
    try {
        if (!fs.existsSync(TMP_DIR)) return;
        const files = fs.readdirSync(TMP_DIR);
        let removed = 0;
        for (const f of files) { try { fs.unlinkSync(path.join(TMP_DIR, f)); removed++; } catch(e) {} }
        log('info', `Cleaned ${removed} temp files`);
    } catch (e) { log('warn', `Cleanup: ${e.message}`); }
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
    if (!url.startsWith('http')) throw new Error(`Catbox: ${url.slice(0, 80)}`);
    return url;
}

async function uploadToLitterbox(filePath) {
    const buf = fs.readFileSync(filePath);
    const blob = new Blob([buf]);
    const form = new FormData();
    form.append('reqtype', 'fileupload');
    form.append('time', '72h');
    form.append('fileToUpload', blob, path.basename(filePath));
    const res = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', {
        method: 'POST',
        body: form
    });
    const url = (await res.text()).trim();
    if (!url.startsWith('http')) throw new Error(`Litterbox: ${url.slice(0, 80)}`);
    return url;
}

async function uploadImage(filePath) {
    const methods = [
        { name: 'catbox.moe', fn: async (p) => uploadToCatbox(p) },
        { name: 'litterbox.catbox.moe', fn: async (p) => uploadToLitterbox(p) },
    ];
    for (const m of methods) {
        try {
            log('debug', `Upload ${m.name}...`);
            const url = await retry(() => m.fn(filePath), { attempts: CONFIG.retry.uploadAttempts, label: m.name });
            log('info', `Uploaded -> ${url.slice(0, 50)}...`);
            return url;
        } catch (e) { log('warn', `${m.name} fail: ${e.message.slice(0, 60)}`); }
    }
    throw new Error('All uploads failed');
}

function buildPrompt(imageUrl) {
    return PROMPT_TEMPLATE.replace('{IMAGE_URL}', imageUrl);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  JSON EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════════
function isSchemaTemplate(s) {
    if (!s) return false;
    return s.includes('"title":"string"') || s.includes('"brand":"string"');
}
function isRealProductData(s) {
    if (!s || !s.includes('"products"')) return false;
    if (isSchemaTemplate(s)) return false;
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
async function waitForStreamedResponse(page, recorder = null) {
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
                log('info', `JSON ${json.length} chars`);
                if (recorder) await recorder.updateStatus('JSON FOUND');
            }
        } else {
            stable++;
        }

        const idle = Date.now() - lastChange;

        if (lastJson && idle >= jsonIdle) {
            log('info', `JSON stable ${jsonIdle}ms. Done.`);
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
            log('warn', `Timeout ${maxWait}ms`);
            if (recorder) await recorder.updateStatus('TIMEOUT');
            const j = extractJsonFromText(current) || lastJson;
            if (j) return { text: j, html: '', duration: Date.now() - start, jsonExtracted: true };
            return { text: current, html: '', duration: Date.now() - start, jsonExtracted: false };
        }

        if (ticks % 12 === 0) {
            log('info', `${((maxWait - idle)/1000).toFixed(0)}s left | ${current.length} chars | JSON: ${lastJson ? lastJson.length + 'ch' : 'scan'}`);
            if (recorder) await recorder.updateStatus(`SCANNING ${current.length}ch`);
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
    catch(e) { log('warn', `SS: ${e.message.slice(0, 40)}`); }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STANDARD MODE
// ═══════════════════════════════════════════════════════════════════════════════
async function processImageStandard(browser, imageInfo, index, total, recorder = null) {
    const { resizedPath, filename } = imageInfo;
    const safeName = filename.replace(/[^a-z0-9]/gi, '_');
    const ssPrefix = path.join(SCREENSHOTS_DIR, `std_${index + 1}_${safeName}`);
    const t0 = Date.now();

    log('info', `[STD] [${index + 1}/${total}] ${filename}`);

    try {
        const imageUrl = await uploadImage(resizedPath);
        const fullPrompt = buildPrompt(imageUrl);
        const ctx = await browser.createBrowserContext();
        const page = await ctx.newPage();

        try {
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
            await page.setViewport({ width: 1366, height: 768 });

            if (recorder) {
                await recorder.attach(page);
                await recorder.updateLabel(`[${index + 1}/${total}] ${filename.slice(0, 30)}`, 'NAVIGATING');
            }

            await retry(() => page.goto('https://google.com/ai?hl=en&gl=us', {
                waitUntil: CONFIG.perf.navWaitUntil,
                timeout: CONFIG.timeouts.navigation
            }), { attempts: CONFIG.retry.navigationAttempts, label: 'Nav' });
            if (recorder) await recorder.updateStatus('PAGE LOADED');
            await takeScreenshot(page, `${ssPrefix}_loaded.png`);

            const promptSels = ['textarea[placeholder*="Ask" i]', 'textarea[aria-label*="message" i]', '[contenteditable="true"]', 'textarea', '[role="textbox"]'];
            let promptEl = null;
            for (const s of promptSels) { promptEl = await page.$(s); if (promptEl) break; }
            if (!promptEl) throw new Error('No prompt input');

            await promptEl.click();
            await page.evaluate((t) => { const el = document.activeElement || document.querySelector('textarea'); if (el) { el.value = t; el.dispatchEvent(new Event('input', { bubbles: true })); } }, fullPrompt);
            if (recorder) await recorder.updateStatus('PROMPT SET');
            await takeScreenshot(page, `${ssPrefix}_prompt.png`);

            const sendSels = ['button[aria-label*="Send" i]', 'button[aria-label*="send" i]', 'button[type="submit"]', '[data-testid="send-button"]'];
            let sent = false;
            for (const s of sendSels) {
                const btn = await page.$(s);
                if (btn && !(await btn.evaluate(el => el.disabled))) { await btn.click(); sent = true; break; }
            }
            if (!sent) await page.keyboard.press('Enter');
            if (recorder) await recorder.updateStatus('SUBMITTED');
            await takeScreenshot(page, `${ssPrefix}_submitted.png`);

            const resp = await waitForStreamedResponse(page, recorder);
            log('info', `Response: ${resp.text.length} chars`);
            await takeScreenshot(page, `${ssPrefix}_response.png`);

            // Check for block - if blocked, detach recorder (it stays running) and return
            const analysis = analyzeResponse(resp.text);
            if (analysis.isBlocked || analysis.isCaptchaHtml) {
                if (recorder) await recorder.updateStatus('BLOCKED');
            }

            return { filename, imageUrl, response: resp.text, html: resp.html, duration: Date.now() - t0, error: null, timedOut: false, jsonExtracted: resp.jsonExtracted };
        } finally {
            if (recorder) await recorder.detach();
            await ctx.close();
        }
    } catch (err) {
        log('error', `Fail ${filename}: ${err.message}`);
        return { filename, imageUrl: null, response: '', html: '', duration: Date.now() - t0, error: err.message, timedOut: false, jsonExtracted: false };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  LENS MODE
// ═══════════════════════════════════════════════════════════════════════════════
async function processImageLens(browser, imageInfo, index, total, recorder = null) {
    const { resizedPath, filename } = imageInfo;
    const safeName = filename.replace(/[^a-z0-9]/gi, '_');
    const ssPrefix = path.join(SCREENSHOTS_DIR, `lens_${index + 1}_${safeName}`);
    const t0 = Date.now();

    log('info', `[LENS] [${index + 1}/${total}] ${filename}`);

    try {
        const imageUrl = await uploadImage(resizedPath);
        const fullPrompt = buildPrompt(imageUrl);
        const ctx = await browser.createBrowserContext();
        const page = await ctx.newPage();

        try {
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.0.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
            await page.setViewport({ width: 1366, height: 768 });

            if (recorder) {
                await recorder.attach(page);
                await recorder.updateLabel(`[${index + 1}/${total}] ${filename.slice(0, 30)}`, 'NAVIGATING');
            }

            const encodedPrompt = encodeURIComponent(fullPrompt);
            const lensUrl = `https://lens.google.com/uploadbyurl?url=${encodeURIComponent(imageUrl)}&q=${encodedPrompt}`;

            await retry(() => page.goto(lensUrl, {
                waitUntil: CONFIG.perf.navWaitUntil,
                timeout: CONFIG.timeouts.navigation
            }), { attempts: CONFIG.retry.navigationAttempts, label: 'Lens' });
            if (recorder) await recorder.updateStatus('LENS LOADED');
            await takeScreenshot(page, `${ssPrefix}_lens.png`);

            const finalUrl = page.url();
            log('debug', `Redirect: ${finalUrl.slice(0, 80)}`);

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
                log('debug', `Eval nav fail, fallback goto: ${e.message.slice(0, 50)}`);
                await retry(() => page.goto(aiUrl, {
                    waitUntil: CONFIG.perf.navWaitUntil,
                    timeout: CONFIG.timeouts.navigation
                }), { attempts: 1, label: 'AI fallback' });
            }
            if (recorder) await recorder.updateStatus('AI LOADED');
            await takeScreenshot(page, `${ssPrefix}_ai.png`);

            const resp = await waitForStreamedResponse(page, recorder);
            log('info', `Response: ${resp.text.length} chars`);
            await takeScreenshot(page, `${ssPrefix}_response.png`);

            // Check for block - if blocked, mark it
            const analysis = analyzeResponse(resp.text);
            if (analysis.isBlocked || analysis.isCaptchaHtml) {
                if (recorder) await recorder.updateStatus('BLOCKED');
            }

            return { filename, imageUrl, response: resp.text, html: resp.html, duration: Date.now() - t0, error: null, timedOut: false, jsonExtracted: resp.jsonExtracted };
        } finally {
            if (recorder) await recorder.detach();
            await ctx.close();
        }
    } catch (err) {
        log('error', `Fail ${filename}: ${err.message}`);
        return { filename, imageUrl: null, response: '', html: '', duration: Date.now() - t0, error: err.message, timedOut: false, jsonExtracted: false };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  ROUTER
// ═══════════════════════════════════════════════════════════════════════════════
async function processImage(browser, imageInfo, index, total, recorder = null) {
    return CONFIG.mode === 'lens'
        ? processImageLens(browser, imageInfo, index, total, recorder)
        : processImageStandard(browser, imageInfo, index, total, recorder);
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

async function processBatch(browser, batch, batchIndex, totalBatches, offset, recorder = null) {
    log('info', `BATCH [${batchIndex + 1}/${totalBatches}] ${batch.length} img [${CONFIG.mode}]`);
    const results = [];
    if (CONFIG.batch.enabled) {
        const promises = batch.map((img, i) => processImage(browser, img, offset + i, IMAGE_PATHS.length, recorder));
        results.push(...await Promise.all(promises));
    } else {
        for (let i = 0; i < batch.length; i++) {
            results.push(await processImage(browser, batch[i], offset + i, IMAGE_PATHS.length, recorder));
            if (i < batch.length - 1) await jitteredDelay(CONFIG.batch.delayBetweenSearchesMs);
        }
    }
    return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════════════════════
let activeBrowser = null;
let globalRecorder = null;
let isShuttingDown = false;
async function gracefulShutdown(sig) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    log('warn', `Signal ${sig}. Shutdown...`);
    if (globalRecorder) await globalRecorder.stop();
    if (activeBrowser) try { activeBrowser.close(); } catch(e) {}
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
    log('info', '  GLENS PRODUCTION v6.2 — GLOBAL SCREEN RECORDER');
    log('info', '═══════════════════════════════════════════════════════════════');
    log('info', `Mode: ${CONFIG.mode.toUpperCase()} | Batch: ${CONFIG.batch.size} | JSON idle: ${CONFIG.timeouts.jsonIdle}ms`);
    log('info', `Nav wait: ${CONFIG.perf.navWaitUntil} | Screenshots: ${CONFIG.screenshots.enabled ? 'ON' : 'OFF'}`);
    log('info', `Recording: ${CONFIG.recording.enabled ? 'ON' : 'OFF'} | ${CONFIG.recording.fps}fps | ${CONFIG.recording.resolution}`);
    log('info', `CPUs: ${os.cpus().length} | Mem: ${(os.totalmem()/1024/1024/1024).toFixed(1)}GB`);

    const tStart = Date.now();
    const globalVideoPath = path.join(RECORDINGS_DIR, `session_${new Date().toISOString().replace(/[:.]/g, '-')}.mp4`);

    log('info', 'Resize...');
    const tResize = Date.now();
    const imageInfos = await Promise.all(IMAGE_PATHS.map(p => resizeImage(p)));
    log('info', `Resized ${imageInfos.length} in ${((Date.now()-tResize)/1000).toFixed(1)}s`);

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
    log('info', `Browser ${((Date.now()-tBrowser)/1000).toFixed(1)}s`);

    // Initialize global recorder
    globalRecorder = new GlobalScreenRecorder(globalVideoPath);

    const allResults = [];
    let isGloballyBlocked = false;

    try {
        const batches = chunkArray(imageInfos, CONFIG.batch.size);
        for (let b = 0; b < batches.length; b++) {
            if (isGloballyBlocked) {
                log('warn', `🚫 IP is blocked. Skipping remaining ${batches.length - b} batches.`);
                // Mark remaining images as blocked
                const remaining = imageInfos.slice(b * CONFIG.batch.size);
                for (const img of remaining) {
                    allResults.push({
                        filename: img.filename,
                        imageUrl: null,
                        response: '',
                        html: '',
                        duration: 0,
                        error: 'Skipped: IP blocked',
                        timedOut: false,
                        jsonExtracted: false
                    });
                }
                break;
            }

            const offset = b * CONFIG.batch.size;
            const results = await processBatch(activeBrowser, batches[b], b, batches.length, offset, globalRecorder);
            allResults.push(...results);

            const analysis = results.map(r => analyzeResponse(r.response));
            const blockedCount = analysis.filter(a => a.isBlocked || a.isCaptchaHtml).length;
            const rateLimitedCount = analysis.filter(a => a.isRateLimited).length;
            const noJsonCount = analysis.filter(a => !a.hasJson && !a.isBlocked && !a.isRateLimited).length;

            if (blockedCount > 0) {
                log('warn', `⚠️ BATCH BLOCKED: ${blockedCount}/${results.length} images hit CAPTCHA/block`);
                // If ANY image in batch is blocked, IP is blocked - stop immediately
                if (blockedCount >= 1) {
                    isGloballyBlocked = true;
                    log('error', `🚫 IP BLOCKED DETECTED. Stopping all further processing.`);
                    // Stop recorder immediately so we don't stall waiting for it
                    if (globalRecorder) {
                        log('info', 'Stopping recorder early due to IP block...');
                        await globalRecorder.stop();
                    }
                }
            }

            if (rateLimitedCount > 0) log('warn', `⏳ Rate limited on ${rateLimitedCount}/${results.length} images`);
            if (noJsonCount > 0) log('info', `${noJsonCount}/${results.length} images without JSON`);

            // No cooldown if blocked - we already decided to stop
            if (!isGloballyBlocked && b < batches.length - 1) {
                const cooldown = rateLimitedCount > 0 ? CONFIG.batch.delayBetweenBatchesMs * 2 : CONFIG.batch.delayBetweenBatchesMs;
                log('info', `Cooldown ${cooldown}ms...`);
                await jitteredDelay(cooldown);
            }
        }
    } finally {
        // Stop global recorder before closing browser (idempotent - safe even if already stopped)
        if (globalRecorder) await globalRecorder.stop();

        if (CONFIG.perf.fastClose) {
            log('info', 'Close browser (async)...');
            activeBrowser.close().catch(() => {});
            activeBrowser = null;
        } else {
            log('info', 'Close browser...');
            await activeBrowser.close();
            activeBrowser = null;
        }
    }

    // NO RETRY LOGIC for blocked IPs - what failed stays failed
    // Only retry non-blocked failures if desired, but per user request we skip retries entirely
    // when blocked since IP won't change

    const successful = allResults.filter(r => !r.error && !r.timedOut).length;
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
        system: { platform: os.platform(), cpus: os.cpus().length, totalMemoryGB: (os.totalmem()/1024/1024/1024).toFixed(1) },
        results: allResults.map(r => {
            const a = analyzeResponse(r.response);
            return {
                filename: r.filename, imageUrl: r.imageUrl, response: r.response,
                duration: r.duration, error: r.error || null, timedOut: r.timedOut || false,
                isBlocked: a.isBlocked || a.isCaptchaHtml,
                isRateLimited: a.isRateLimited,
                hasJson: a.hasJson,
            };
        }),
    };

    const jsonPath = path.join(RESPONSES_DIR, 'ai_responses.json');
    const jsonData = JSON.stringify(output, null, 2);
    if (CONFIG.output.atomicWrites) atomicWrite(jsonPath, jsonData);
    else fs.writeFileSync(jsonPath, jsonData);
    log('info', `Saved -> ${jsonPath}`);

    cleanupTempImages();

    const total = ((Date.now() - tStart) / 1000).toFixed(1);
    log('info', '═══════════════════════════════════════════════════════════════');
    log('info', `DONE ${total}s | ${successful}/${imageInfos.length} OK | ${withJson} JSON | ${blocked} BLOCKED | ${skippedBlocked} SKIPPED | ${rateLimited} RATE-LIMITED | ${failed} FAIL`);
    if (CONFIG.recording.enabled) log('info', `Recording: ${globalVideoPath}`);
    log('info', '═══════════════════════════════════════════════════════════════');
    if (blocked > 0) log('warn', 'Google detected unusual traffic. Retry on a different IP.');
    if (failed > 0) process.exitCode = 1;
}

startTesting().catch(err => {
    log('error', 'Fatal:', err.message);
    if (globalRecorder) globalRecorder.stop().catch(() => {});
    if (activeBrowser) try { activeBrowser.close(); } catch(e) {}
    cleanupTempImages();
    process.exit(1);
});