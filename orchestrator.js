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
 *  6. AI Review (Gemini) — collages of unreviewed images/frames
 *  6.5 JSON Audit & Repair (Gemini)
 *  7. Data Enrichment (Text Extraction + LLM Structuring) — runs ecom-text-extractor.py
 *     and Gemini LLM on sources to fetch actual product data, replaces sources in MongoDB.
 *  8. Product Source Image Extraction — Fallback logic if Step 7 misses images.
 */

import { launch } from 'cloakbrowser/puppeteer';
import fs from 'fs';
import path from 'path';
import { spawn, execSync } from 'child_process';
import { MongoClient } from 'mongodb';
import { createHash } from 'crypto';
import os from 'os';
import sharp from 'sharp';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

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
        enabled:          process.env.ORCH_REVIEW_ENABLED !== 'false', 
        fetchLimit:       parseInt(process.env.ORCH_REVIEW_FETCH_LIMIT     || '60',  10),
        maxRowsPerCollage: parseInt(process.env.ORCH_REVIEW_MAX_ROWS       || '4',   10),
        maxColsPerRow:     parseInt(process.env.ORCH_REVIEW_MAX_COLS       || '5',   10),
        targetRowHeight:   parseInt(process.env.ORCH_REVIEW_ROW_HEIGHT     || '480', 10),
        collageMaxWidth:   parseInt(process.env.ORCH_REVIEW_COLLAGE_WIDTH  || '2200',10),
        jpegQuality:       parseInt(process.env.ORCH_REVIEW_JPEG_QUALITY   || '82',  10),
        cellAspectRatio:  parseFloat(process.env.ORCH_REVIEW_CELL_ASPECT_RATIO || '0.75'),
        collageGutter:    parseInt(process.env.ORCH_REVIEW_COLLAGE_GUTTER  || '8',   10),
        model:            process.env.ORCH_GEMINI_MODEL    || 'gemini-3.5-flash-lite',
        apiKeys:          (process.env.ORCH_GEMINI_API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean),
        quotaCollection:  process.env.ORCH_GEMINI_QUOTA_COLLECTION || 'gemini_quotas',
        rateLimitCooldownMs: parseInt(process.env.ORCH_GEMINI_RATE_LIMIT_COOLDOWN_MS || String(10 * 60 * 1000), 10),
        lockStaleMs:      parseInt(process.env.ORCH_GEMINI_LOCK_STALE_MS || String(5 * 60 * 1000), 10),
        maxRetries:       parseInt(process.env.ORCH_GEMINI_MAX_RETRIES || '3', 10),
        saveCollages:     process.env.ORCH_REVIEW_SAVE_COLLAGES === 'true',
    },
    audit: {
        enabled:     process.env.ORCH_AUDIT_ENABLED !== 'false', 
        limit:       parseInt(process.env.ORCH_AUDIT_LIMIT || '40', 10),
        model:       process.env.ORCH_AUDIT_MODEL || process.env.ORCH_GEMINI_MODEL || 'gemini-3.5-flash-lite',
        targetBatchTokens: parseInt(process.env.ORCH_AUDIT_BATCH_TOKENS || '60000', 10),
        saveChanges: process.env.ORCH_AUDIT_SAVE_CHANGES === 'true',
    },
    textExtraction: {
        enabled:          process.env.ORCH_TEXT_EXTRACT_ENABLED !== 'false',
        sourceLimit:      parseInt(process.env.ORCH_TEXT_EXTRACT_SOURCE_LIMIT || '50', 10),
        batchSize:        parseInt(process.env.ORCH_TEXT_EXTRACT_BATCH_SIZE || '50', 10),
        llmBatchSize:     parseInt(process.env.ORCH_TEXT_LLM_BATCH_SIZE || '2', 10),
        scriptPath:       path.join(SCRIPT_DIR, 'ecom-text-extractor.py'),
        pythonPath:       process.env.ORCH_PYTHON_PATH || 'python3',
        timeoutMs:        parseInt(process.env.ORCH_TEXT_EXTRACT_TIMEOUT_MS || '300000', 10),
    },
    productImageExtraction: {
        enabled:          process.env.ORCH_PRODUCT_IMG_ENABLED !== 'false',
        batchSize:        parseInt(process.env.ORCH_PRODUCT_IMG_BATCH_SIZE || '50', 10),
        lazyExtraction:   process.env.ORCH_PRODUCT_IMG_LAZY !== 'false',
        minScore:         parseInt(process.env.ORCH_PRODUCT_IMG_MIN_SCORE || '3', 10),
        hashThreshold:    parseInt(process.env.ORCH_PRODUCT_IMG_HASH_THRESHOLD || '6', 10),
        cdpPort:          parseInt(process.env.ORCH_PRODUCT_IMG_CDP_PORT || '9243', 10),
        adaptiveCutoff:   process.env.ORCH_PRODUCT_IMG_ADAPTIVE_CUTOFF !== 'false',
        pythonPath:       process.env.ORCH_PRODUCT_IMG_PYTHON || 'python3',
        scriptPath:       process.env.ORCH_PRODUCT_IMG_SCRIPT || path.join(SCRIPT_DIR, 'ecom-image-extractor.py'),
        timeoutMs:        parseInt(process.env.ORCH_PRODUCT_IMG_TIMEOUT_MS || '300000', 10),
    },
    timeouts: {
        navigation:     45_000,
        downloaderIdle: 15_000,
        idleReset:      10_000,
    },
    recording: {
        enabled:      process.env.ORCH_RECORDING !== 'false',
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

// Ensure required dirs exist
[CONFIG.outputDir, CONFIG.tmpDir, RECORDINGS_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

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

function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── PYTHON SCRIPT FOR EXTRACTING VIDEO FRAMES ────────────────────────────────
const EXTRACT_FRAMES_PY = `
import sys
import os
import cv2
import numpy as np
from scipy.fft import dct as scipy_dct
from scenedetect import open_video, SceneManager
from scenedetect.detectors import ContentDetector
from ultralytics import YOLO

def laplacian_sharpness(gray):
    return cv2.Laplacian(gray, cv2.CV_64F).var()

def phash(frame_bgr, hash_size=8, high_freq_factor=4):
    img_size = hash_size * high_freq_factor
    small = cv2.resize(frame_bgr, (img_size, img_size), interpolation=cv2.INTER_AREA)
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.float32)
    dct_rows = scipy_dct(gray, axis=0, norm='ortho')
    dct_full = scipy_dct(dct_rows, axis=1, norm='ortho')
    low_freq = dct_full[:hash_size, :hash_size]
    flat = low_freq.flatten()
    ac_coeffs = flat[1:]
    median = np.median(ac_coeffs)
    return (flat > median)

def hamming_distance(h1, h2):
    return int(np.count_nonzero(h1 != h2))

def extract_frames(video_path, out_dir):
    video = open_video(video_path)
    scene_manager = SceneManager()
    scene_manager.add_detector(ContentDetector(threshold=27.0, min_scene_len=int(0.4 * video.frame_rate)))
    scene_manager.detect_scenes(video=video)
    scene_list = scene_manager.get_scene_list()
    if not scene_list:
        scene_list = [(video.base_timecode, video.duration)]
    fps = video.frame_rate

    step = max(1, round(fps / 2.0))
    wanted = {}
    for shot_idx, (start, end) in enumerate(scene_list):
        start_f = start.frame_num
        end_f = max(start_f + 1, end.frame_num)
        for idx in range(start_f, end_f, step):
            wanted[idx] = shot_idx

    wanted_sorted = sorted(wanted.keys())
    cap = cv2.VideoCapture(video_path)
    shot_frames = {}
    current_pos = 0
    ptr = 0

    while ptr < len(wanted_sorted):
        target = wanted_sorted[ptr]
        while current_pos < target:
            cap.grab()
            current_pos += 1
        ok, frame = cap.read()
        if not ok:
            ptr += 1
            current_pos += 1
            continue
        shot_idx = wanted[current_pos]
        h, w = frame.shape[:2]
        small = cv2.resize(frame, (360, int(h * 360 / w)))
        gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
        sharp = laplacian_sharpness(gray)
        shot_frames.setdefault(shot_idx, []).append((current_pos, frame, sharp))
        current_pos += 1
        ptr += 1
    cap.release()

    candidates = []
    for shot_idx, frames in shot_frames.items():
        frames.sort(key=lambda x: x[2], reverse=True)
        for idx, frame, sharp in frames[:1]:
            candidates.append({'shot_idx': shot_idx, 'frame_idx': idx, 'timecode_sec': idx / fps, 'frame': frame, 'sharpness': sharp})
    candidates.sort(key=lambda c: c['timecode_sec'])

    if candidates:
        hashes = [phash(c['frame']) for c in candidates]
        used = [False] * len(candidates)
        kept = []
        for i in range(len(candidates)):
            if used[i]: continue
            cluster = [i]
            for j in range(i + 1, len(candidates)):
                if not used[j] and hamming_distance(hashes[i], hashes[j]) < 22:
                    cluster.append(j)
                    used[j] = True
            used[i] = True
            best = max(cluster, key=lambda k: candidates[k]['sharpness'])
            kept.append(candidates[best])
        kept.sort(key=lambda c: c['timecode_sec'])
        candidates = kept

    yolo_model = YOLO('yolov8n.pt')
    yolo_model.to('cpu')
    gated_candidates = []
    for c in candidates:
        results = yolo_model(c['frame'], classes=[0], conf=0.35, imgsz=640, device='cpu', verbose=False)
        has_person = False
        for r in results:
            if len(r.boxes) > 0:
                has_person = True
                break
        if has_person:
            gated_candidates.append(c)

    if gated_candidates:
        hashes = [phash(c['frame']) for c in gated_candidates]
        used = [False] * len(gated_candidates)
        kept = []
        for i in range(len(gated_candidates)):
            if used[i]: continue
            cluster = [i]
            for j in range(i + 1, len(gated_candidates)):
                if not used[j] and hamming_distance(hashes[i], hashes[j]) < 15:
                    cluster.append(j)
                    used[j] = True
            used[i] = True
            best = max(cluster, key=lambda k: gated_candidates[k]['sharpness'])
            kept.append(gated_candidates[best])
        kept.sort(key=lambda c: c['timecode_sec'])
        gated_candidates = kept

    os.makedirs(out_dir, exist_ok=True)
    for i, c in enumerate(gated_candidates):
        out_path = os.path.join(out_dir, f"frame_{i}.jpg")
        cv2.imwrite(out_path, c['frame'])

if __name__ == "__main__":
    extract_frames(sys.argv[1], sys.argv[2])
`;


// ─── Gemini prompts ──────────────────────────────────────────────────────────
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
        .sort(); 

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

async function hfUploadBlob(fileBuffer, repoFilePath) {
    const sha256 = createHash('sha256').update(fileBuffer).digest('hex');

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
    const obj       = lfsData.objects?.[0];
    const uploadUrl = obj?.actions?.upload?.href;

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

        const verifyUrl     = obj?.actions?.verify?.href;
        const verifyHeaders = obj?.actions?.verify?.header || {};
        if (verifyUrl) {
            await fetch(verifyUrl, {
                method:  'POST',
                headers: { ...verifyHeaders, 'Content-Type': 'application/vnd.git-lfs+json' },
                body:    JSON.stringify({ oid: sha256, size: fileBuffer.length }),
            }).catch(() => {});
        }
    }

    return {
        path: repoFilePath,
        oid:  sha256,
        size: fileBuffer.length,
        url:  `https://huggingface.co/datasets/${CONFIG.hf.repo}/resolve/main/${repoFilePath}`,
    };
}

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
//  GEMINI API KEY ROTATION
// ═══════════════════════════════════════════════════════════════════════════════

function getRandomKeyFallback() {
    const keys = CONFIG.review.apiKeys;
    if (!keys.length) return null;
    return keys[Math.floor(Math.random() * keys.length)];
}

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
//  COLLAGE BUILDER
// ═══════════════════════════════════════════════════════════════════════════════

function calculateCollageLayout(items, containerWidth, targetRowHeight, maxRows, maxCols, cellAspectRatio, gutter) {
    const rows = [];
    let currentRow = [];

    const fixedRatio = (cellAspectRatio > 0) ? cellAspectRatio : 0;

    for (const item of items) {
        if (rows.length >= maxRows) break; 

        if (fixedRatio > 0) {
            currentRow.push({ item, ratio: fixedRatio });

            if (currentRow.length >= maxCols) {
                const totalGutter = gutter * (maxCols - 1);
                const cellW = (containerWidth - totalGutter) / maxCols;
                const cellH = cellW / fixedRatio;
                rows.push({ images: currentRow, height: cellH, isJustified: false });
                currentRow = [];
            }
        } else {
            const ratio = item.width / item.height;
            currentRow.push({ item, ratio });
            const currentRatioSum = currentRow.reduce((s, c) => s + c.ratio, 0);
            const projectedHeight = containerWidth / currentRatioSum;

            if (projectedHeight <= targetRowHeight) {
                rows.push({ images: currentRow, height: projectedHeight, isJustified: true });
                currentRow = [];
            } else if (currentRow.length >= maxCols) {
                rows.push({ images: currentRow, height: projectedHeight, isJustified: true });
                currentRow = [];
            }
        }
    }

    if (currentRow.length > 0 && rows.length < maxRows) {
        if (fixedRatio > 0) {
            const totalGutter = gutter * (maxCols - 1);
            const cellW = (containerWidth - totalGutter) / maxCols;
            const cellH = cellW / fixedRatio;
            rows.push({ images: currentRow, height: cellH, isJustified: false });
        } else {
            rows.push({ images: currentRow, height: targetRowHeight, isJustified: false });
        }
    }

    return rows;
}

function chunkItemsIntoCollages(items, containerWidth, targetRowHeight, maxRows, maxCols, cellAspectRatio, gutter) {
    const collages = [];
    let remaining = items.slice();

    while (remaining.length > 0) {
        const rows = calculateCollageLayout(remaining, containerWidth, targetRowHeight, maxRows, maxCols, cellAspectRatio, gutter);
        const used = rows.reduce((sum, r) => sum + r.images.length, 0);
        if (used === 0) break;
        collages.push({ rows, items: remaining.slice(0, used) });
        remaining = remaining.slice(used);
    }

    return collages;
}

async function renderCollage(rows, containerWidth, quality, cellAspectRatio, gutter) {
    const fixedRatio = (cellAspectRatio > 0) ? cellAspectRatio : 0;
    const refMap = new Map();
    const composites = [];

    if (fixedRatio > 0) {
        const maxCols = Math.max(...rows.map(r => r.images.length));
        const totalGutterW = gutter * (maxCols - 1);
        const cellW = Math.max(1, Math.round((containerWidth - totalGutterW) / maxCols));
        const cellH = Math.max(1, Math.round(cellW / fixedRatio));

        const numRows = rows.length;
        const totalGutterH = gutter * (numRows - 1);
        const canvasW = cellW * maxCols + gutter * (maxCols - 1);
        const canvasH = cellH * numRows + totalGutterH;

        let y = 0;
        for (let rowIdx = 0; rowIdx < rows.length; rowIdx++) {
            const row = rows[rowIdx];
            let x = 0;
            for (let colIdx = 0; colIdx < row.images.length; colIdx++) {
                const { item } = row.images[colIdx];

                const resized = await sharp(item.buffer)
                    .resize(cellW, cellH, { fit: 'cover', position: 'centre' })
                    .toBuffer();

                composites.push({ input: resized, left: x, top: y });
                refMap.set(`${colIdx}:${rowIdx}`, item);

                x += cellW + (colIdx < row.images.length - 1 ? gutter : 0);
            }
            y += cellH + (rowIdx < rows.length - 1 ? gutter : 0);
        }

        const buffer = await sharp({
            create: {
                width:      canvasW,
                height:     canvasH,
                channels:   3,
                background: { r: 255, g: 255, b: 255 },
            },
        })
            .composite(composites)
            .jpeg({ quality })
            .toBuffer();

        return { buffer, refMap };

    } else {
        const totalHeight = Math.round(rows.reduce((sum, r) => sum + r.height, 0));

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
                background: { r: 13, g: 13, b: 13 },
            },
        })
            .composite(composites)
            .jpeg({ quality })
            .toBuffer();

        return { buffer, refMap };
    }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  GEMINI API CALLS
// ═══════════════════════════════════════════════════════════════════════════════

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
            if (err.message?.includes('429')) continue; 
            lastErr = err;
            log('warn', `Gemini: attempt ${attempt + 1}/${CONFIG.review.maxRetries} failed: ${err.message.slice(0, 200)}`);
        }
    }

    throw lastErr || new Error('Gemini review failed after retries');
}

async function extractDataBatchWithGemini(db, batch) {
    const payload = JSON.stringify(batch);
    let lastErr = null;

    for (let attempt = 0; attempt < CONFIG.review.maxRetries; attempt++) {
        const keyInfo = await getBestGeminiApiKey(db);
        if (!keyInfo || !keyInfo.apiKey) {
            throw new Error('No Gemini API key available for data extraction');
        }

        const { keyHash, apiKey } = keyInfo;
        try {
            const resp = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.audit.model}:generateContent?key=${apiKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{
                            parts: [
                                { text: DATA_EXTRACTION_PROMPT },
                                { text: payload },
                            ],
                        }],
                        generationConfig: {
                            temperature: 0.1,
                            maxOutputTokens: 65536, // <-- Overrides default 8k limit to prevent JSON cutoff
                            responseMimeType: 'application/json',
                            thinkingConfig: {
                                thinkingLevel: "HIGH" // <-- High thinking level configuration
                            }
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
            if (!text) throw new Error('Data Extraction: Gemini response missing text content');

            const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '');
            const parsed = JSON.parse(cleaned);
            if (!Array.isArray(parsed)) throw new Error('Data Extraction: Gemini response was not a JSON array');
            return parsed;
        } catch (err) {
            if (err.message?.includes('429')) continue;
            lastErr = err;
            log('warn', `Data Extraction: attempt ${attempt + 1}/${CONFIG.review.maxRetries} failed: ${err.message.slice(0, 200)}`);
        }
    }

    throw lastErr || new Error('Data extraction batch failed after retries');
}

// ═══════════════════════════════════════════════════════════════════════════════
//  REVIEW STAGE — fetch unreviewed images & video frames, send to Gemini
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchUnreviewedFiles(collection, limit) {
    const candidatePosts = await collection
        .find({
            discarded: { $ne: true },
            $or: [
                {
                    file_urls: {
                        $elemMatch: {
                            type: 'image',
                            reviewed: { $ne: true },
                        }
                    }
                },
                {
                    'file_urls.frames': {
                        $elemMatch: {
                            reviewed: { $ne: true },
                        }
                    }
                }
            ]
        })
        .project({ post_id: 1, file_urls: 1 })
        .limit(limit * 3 + 10)
        .toArray();

    const candidates = [];

    outer:
    for (const post of candidatePosts) {
        if (!Array.isArray(post.file_urls)) continue;

        for (let i = 0; i < post.file_urls.length; i++) {
            if (candidates.length >= limit) break outer;

            const file = post.file_urls[i];
            if (!file) continue;

            if (file.type === 'image') {
                if (file.reviewed) continue;
                candidates.push({
                    postId:       post.post_id,
                    postObjectId: post._id,
                    fileIndex:    i,
                    frameIndex:   -1,
                    url:          file.url,
                    type:         file.type,
                });
            } else if (file.type === 'video' && Array.isArray(file.frames)) {
                for (let j = 0; j < file.frames.length; j++) {
                    if (candidates.length >= limit) break outer;

                    const frame = file.frames[j];
                    if (!frame || frame.reviewed) continue;
                    candidates.push({
                        postId:       post.post_id,
                        postObjectId: post._id,
                        fileIndex:    i,
                        frameIndex:   j,
                        url:          frame.url,
                        type:         frame.type,
                    });
                }
            }
        }
    }

    return candidates;
}

async function fetchImageForCollage(fileEntry) {
    const headers = CONFIG.hf.token ? { Authorization: `Bearer ${CONFIG.hf.token}` } : {};
    const resp = await fetch(fileEntry.url, { redirect: 'follow', headers });
    if (!resp.ok) throw new Error(`Failed to fetch image for review (${resp.status}): ${fileEntry.url.slice(0, 80)}`);
    const buffer = Buffer.from(await resp.arrayBuffer());
    const meta = await sharp(buffer).metadata();
    return { ...fileEntry, buffer, width: meta.width || 1, height: meta.height || 1 };
}

async function runReviewStage(db, collection) {
    log('info', '── Review Stage: Fetching unreviewed images/frames ──');

    await ensureGeminiQuotaDocs(db);

    const candidates = await fetchUnreviewedFiles(collection, CONFIG.review.fetchLimit);
    log('info', `Found ${candidates.length} unreviewed item(s) (limit=${CONFIG.review.fetchLimit}).`);

    const results = { reviewed: 0, kept: 0, rejected: 0, collages: 0, failed: 0 };
    if (candidates.length === 0) return results;

    if (!CONFIG.review.apiKeys.length) {
        log('warn', 'No Gemini API keys configured (ORCH_GEMINI_API_KEYS) — skipping review stage.');
        return results;
    }

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
        CONFIG.review.maxColsPerRow,
        CONFIG.review.cellAspectRatio,
        CONFIG.review.collageGutter
    );
    log('info', `Built ${collages.length} collage(s) from ${downloaded.length} item(s) (max ${CONFIG.review.maxRowsPerCollage} rows × ${CONFIG.review.maxColsPerRow} cols each, cell ratio ${CONFIG.review.cellAspectRatio > 0 ? CONFIG.review.cellAspectRatio.toFixed(2) : 'natural'}, gutter ${CONFIG.review.collageGutter}px).`);

    const allProcessed = []; 
    const keptKeys = new Set(); 

    for (let i = 0; i < collages.length; i++) {
        const { rows, items } = collages[i];
        log('info', `Review: collage ${i + 1}/${collages.length} — ${items.length} item(s), ${rows.length} row(s)`);

        for (const item of items) allProcessed.push(item);

        let refMap;
        let collageBuffer;
        try {
            const rendered = await renderCollage(rows, CONFIG.review.collageMaxWidth, CONFIG.review.jpegQuality, CONFIG.review.cellAspectRatio, CONFIG.review.collageGutter);
            collageBuffer = rendered.buffer;
            refMap = rendered.refMap;
        } catch (err) {
            log('error', `Review: failed to render collage ${i + 1}: ${err.message.slice(0, 200)}`);
            results.failed += items.length;
            continue;
        }

        results.collages++;

        if (CONFIG.review.saveCollages) {
            try {
                fs.mkdirSync(COLLAGES_DIR, { recursive: true });
                const collageFilename = `collage_${CONFIG.runId}_${String(i + 1).padStart(2, '0')}.jpg`;
                fs.writeFileSync(path.join(COLLAGES_DIR, collageFilename), collageBuffer);

                const refMapJson = {};
                for (const [ref, item] of refMap.entries()) {
                    refMapJson[ref] = { postId: item.postId, fileIndex: item.fileIndex, frameIndex: item.frameIndex, url: item.url };
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

            const key = `${item.postObjectId}:${item.fileIndex}:${item.frameIndex}`;
            keptKeys.add(key);

            let updatePath = `file_urls.${item.fileIndex}`;
            if (item.frameIndex !== -1) {
                updatePath = `file_urls.${item.fileIndex}.frames.${item.frameIndex}`;
            }

            try {
                await collection.updateOne(
                    { _id: item.postObjectId },
                    { $set: {
                        [`${updatePath}.reviewed`]:       true,
                        [`${updatePath}.stunning_score`]: decision.stunning_score,
                        [`${updatePath}.review_reason`]:  decision.reason,
                    } }
                );
                results.kept++;
            } catch (err) {
                log('error', `Review: failed to mark kept file reviewed (post ${item.postId}): ${err.message}`);
            }
        }

        results.reviewed += items.length;
        log('info', `Review: collage ${i + 1} — ${kept.length}/${items.length} item(s) kept`);
    }

    const rejected = allProcessed.filter(item => !keptKeys.has(`${item.postObjectId}:${item.fileIndex}:${item.frameIndex}`));
    log('info', `Review: ${rejected.length} rejected item(s) to remove across affected posts.`);

    if (rejected.length > 0) {
        const byPost = new Map();
        for (const item of rejected) {
            if (!byPost.has(String(item.postObjectId))) byPost.set(String(item.postObjectId), { postObjectId: item.postObjectId, topUrls: [], frameUrls: [] });
            
            if (item.frameIndex === -1) {
                byPost.get(String(item.postObjectId)).topUrls.push(item.url);
            } else {
                byPost.get(String(item.postObjectId)).frameUrls.push(item.url);
            }
        }

        const bulkOps = [];
        for (const { postObjectId, topUrls, frameUrls } of byPost.values()) {
            if (topUrls.length > 0) {
                bulkOps.push({
                    updateOne: {
                        filter: { _id: postObjectId },
                        update: { $pull: { file_urls: { url: { $in: topUrls } } } },
                    },
                });
            }
            if (frameUrls.length > 0) {
                bulkOps.push({
                    updateOne: {
                        filter: { _id: postObjectId },
                        update: { $pull: { 'file_urls.$[].frames': { url: { $in: frameUrls } } } },
                    },
                });
            }
        }

        try {
            await collection.bulkWrite(bulkOps, { ordered: false });
            results.rejected = rejected.length;
            log('info', `Review: removed ${rejected.length} rejected item(s) across ${bulkOps.length} DB operation(s).`);
        } catch (err) {
            log('error', `Review: bulk removal of rejected files failed: ${err.message}`);
        }
    }

    try {
        const pullEmptyVideos = await collection.updateMany(
            { file_urls: { $elemMatch: { type: 'video', frames: { $size: 0 } } } },
            { $pull: { file_urls: { type: 'video', frames: { $size: 0 } } } }
        );
        if (pullEmptyVideos.modifiedCount > 0) {
            log('info', `Review: removed empty videos across ${pullEmptyVideos.modifiedCount} post(s).`);
        }

        const flagDiscarded = await collection.updateMany(
            { file_urls: { $size: 0 }, discarded: { $ne: true }, downloaded: true },
            { $set: { discarded: true } }
        );
        if (flagDiscarded.modifiedCount > 0) {
            log('info', `Review: flagged ${flagDiscarded.modifiedCount} post(s) as discarded (0 files remaining).`);
        }
    } catch (err) {
        log('error', `Review: cleanup of empty videos/posts failed: ${err.message}`);
    }

    return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  JSON AUDIT & REPAIR STAGE (STEP 6.5)
// ═══════════════════════════════════════════════════════════════════════════════

function estimateTokens(text) {
    if (!text || typeof text !== 'string') return 0;
    return Math.ceil((text.length / 4) * 1.1);
}

function chunkAuditBatches(items, targetTokens) {
    const batches = [];
    let current = [];
    let currentTokens = 0;

    for (const item of items) {
        const itemTokens = estimateTokens(item.raw);
        if (current.length > 0 && currentTokens + itemTokens > targetTokens) {
            batches.push(current);
            current = [item];
            currentTokens = itemTokens;
        } else {
            current.push(item);
            currentTokens += itemTokens;
        }
    }
    if (current.length > 0) batches.push(current);
    return batches;
}

const AUDIT_PROMPT = `You are a JSON repair and data-quality enforcement engine. Your sole job is to receive an array of raw product-analysis responses, fix any structural or logical defects, and return a strictly formatted result array.

INPUT FORMAT:
You will receive a JSON object with a single key "items". Each item has:
- seq: integer (your reference ID — echo it back exactly)
- raw: string containing either valid JSON, malformed JSON, or plain text

OUTPUT FORMAT:
Return ONLY a JSON object with key "results". Each result has:
- seq: integer (must match the input seq exactly)
- status: one of "fixed", "unchanged", "empty", "unfixable"
- products: array of product objects, or null if unfixable
- changes: array of short human-readable strings describing what was modified

Schema:
{"results":[{"seq":0,"status":"fixed|unchanged|empty|unfixable","products":[...],"changes":[]}]}

RULES — apply in this exact order:

1. PARSING
   - If "raw" is valid JSON and contains a "products" array → proceed to validation.
   - If "raw" is malformed JSON but you can confidently reconstruct the intended structure → status: "fixed".
   - If "raw" is unparseable garbage, contains no product data, or is just conversational text → status: "unfixable", products: null.
   - If parseable but "products" array is empty after validation → status: "empty", products: [].

2. PER-PRODUCT VALIDATION (mutate every product in place)
   Required fields:
   - title: non-empty string. If missing/empty → "Unknown Product".
   - brand: non-empty string. If missing/empty → "Unknown".
   - description: string. If missing/empty → "".
   - category: must be one of: clothing, footwear, accessory, jewelry, bag, watch, eyewear, hat, belt, cosmetics, skincare, tech_accessory, lifestyle, other. If invalid → "other".
   - price.current: string containing a numeric value. If missing/invalid → "0.00".
   - price.original: string or null. If same as current → null. If missing → null.
   - price.currency: 3-letter ISO code (USD, EUR, GBP, etc.). If missing/invalid → "USD".
   - availability: one of "In stock", "Out of stock", "Pre-order", "Limited", "Unknown". If invalid → "Unknown".
   - sizing: array of strings. If a plain string → wrap in array. If missing/invalid → [].
   - sources: array of source objects. If missing → []. If not an array → [].
   - dropshipViability.score: integer 1–10. Clamp to range if outside.
   - dropshipViability.reasoning: non-empty string. If missing → "".
   - dropshipViability.risks: array of strings. If missing/invalid → [].
   - alternatives: array of alternative objects. If missing → []. If not an array → [].
   - sizingGuide: string. If missing → "".
   - basePrice: string. If missing → use price.current.
   - recommendedMarkup.type: "percentage" or "fixed". If invalid → "percentage".
   - recommendedMarkup.value: string. If missing/invalid → "30".
   - recommendedMarkup.currency: string or null. If type is "percentage" → null.
   - recommendedShippingRate.amount: string. If missing → "0".
   - recommendedShippingRate.currency: string. If missing → "USD".
   - recommendedShippingRate.coverage: string. If missing → "Worldwide".
   - shippingAndReturns: string. If missing → "".

3. SOURCE URL CLEANUP (sources array)
   Remove any source where url:
   - Is a bare domain (no path, or path is exactly "/" or "/home" or "/index.html")
   - Contains any of these path segments: /collections/, /category/, /categories/, /shop/, /store/, /search, /find, /query, /blog/, /article/, /news/, /about/, /contact/
   - Has query params indicating search: ?q=, ?search=, ?query=, ?find=
   - Path is generic without a product slug (e.g., "/products" with no identifier after it)

   After removal, deduplicate sources by exact URL string:
   - Normalize before comparing: lowercase the full URL, strip trailing slash, strip common tracking query params (utm_source, utm_medium, utm_campaign, fbclid, gclid).
   - Keep the FIRST occurrence in the original order. Discard later duplicates.

4. ALTERNATIVE URL CLEANUP (alternatives array)
   Apply the SAME invalid-URL removal rules as sources.
   Then deduplicate alternatives by exact normalized URL (same normalization as above).
   Then remove any alternative whose normalized URL exactly matches any source's normalized URL in the SAME product.

5. POST-CLEANUP PRODUCT STATE
   - If a product's sources array becomes empty after cleanup → set sources: [].
   - If a product's alternatives array becomes empty → set alternatives: [].
   - Do NOT remove the product from the array just because it has no sources.

6. OUTPUT CONSTRAINTS
   - Return ONLY the JSON object. No markdown code blocks, no explanations, no conversational text.
   - Do not hallucinate product data. If you cannot reconstruct a product with confidence, omit it.
   - The "changes" array should be concise: e.g., "Fixed malformed JSON", "Removed 2 invalid source URLs", "Deduplicated 1 alternative", "Clamped dropshipViability.score from 15 to 10".`;

async function fetchUnauditedFiles(collection, limit) {
    const candidatePosts = await collection
        .find({
            discarded: { $ne: true },
            $or: [
                {
                    file_urls: {
                        $elemMatch: {
                            type: 'image',
                            reviewed: true,
                            response: { $exists: true, $ne: null },
                            auditedAt: { $exists: false },
                        }
                    }
                },
                {
                    'file_urls.frames': {
                        $elemMatch: {
                            type: 'image',
                            reviewed: true,
                            response: { $exists: true, $ne: null },
                            auditedAt: { $exists: false },
                        }
                    }
                }
            ]
        })
        .project({ post_id: 1, file_urls: 1 })
        .limit(limit * 3 + 10)
        .toArray();

    const items = [];

    outer:
    for (const post of candidatePosts) {
        if (!Array.isArray(post.file_urls)) continue;

        for (let i = 0; i < post.file_urls.length; i++) {
            if (items.length >= limit) break outer;

            const file = post.file_urls[i];
            if (!file) continue;

            if (file.type === 'image' && file.reviewed && file.response != null && !file.auditedAt) {
                const raw = typeof file.response === 'object'
                    ? JSON.stringify(file.response)
                    : String(file.response);
                items.push({
                    seq: items.length,
                    postId: post.post_id,
                    postObjectId: post._id,
                    path: `file_urls.${i}`,
                    raw,
                });
            } else if (file.type === 'video' && Array.isArray(file.frames)) {
                for (let j = 0; j < file.frames.length; j++) {
                    if (items.length >= limit) break outer;

                    const frame = file.frames[j];
                    if (!frame || !frame.reviewed || frame.response == null || frame.auditedAt) continue;

                    const raw = typeof frame.response === 'object'
                        ? JSON.stringify(frame.response)
                        : String(frame.response);
                    items.push({
                        seq: items.length,
                        postId: post.post_id,
                        postObjectId: post._id,
                        path: `file_urls.${i}.frames.${j}`,
                        raw,
                    });
                }
            }
        }
    }

    return items;
}

async function auditBatchWithGemini(db, batchItems) {
    const payload = JSON.stringify({ items: batchItems.map(({ seq, raw }) => ({ seq, raw })) });
    let lastErr = null;

    for (let attempt = 0; attempt < CONFIG.review.maxRetries; attempt++) {
        const keyInfo = await getBestGeminiApiKey(db);
        if (!keyInfo || !keyInfo.apiKey) {
            throw new Error('No Gemini API key available (none configured or all rate-limited)');
        }

        const { keyHash, apiKey } = keyInfo;
        try {
            const resp = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.audit.model}:generateContent?key=${apiKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{
                            parts: [
                                { text: AUDIT_PROMPT },
                                { text: payload },
                            ],
                        }],
                        generationConfig: {
                            temperature: 0.1,
                            responseMimeType: 'application/json',
                        },
                    }),
                }
            );

            if (resp.status === 429) {
                log('warn', `Audit: Gemini 429 rate-limited on key ${keyHash ?? '(fallback)'} — rotating`);
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
            if (!text) throw new Error('Audit: Gemini response missing text content');

            const cleaned = text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '');
            const parsed = JSON.parse(cleaned);
            if (!parsed || !Array.isArray(parsed.results)) {
                throw new Error('Audit: Gemini response missing "results" array');
            }
            return parsed.results;

        } catch (err) {
            if (err.message?.includes('429')) continue;
            lastErr = err;
            log('warn', `Audit: attempt ${attempt + 1}/${CONFIG.review.maxRetries} failed: ${err.message.slice(0, 200)}`);
        }
    }

    throw lastErr || new Error('Audit batch failed after retries');
}

async function runAuditStage(db, collection) {
    log('info', '── Audit Stage: Fetching un-audited reviewed responses ──');

    await ensureGeminiQuotaDocs(db);

    if (!CONFIG.review.apiKeys.length) {
        log('warn', 'No Gemini API keys configured (ORCH_GEMINI_API_KEYS) — skipping audit stage.');
        return { audited: 0, fixed: 0, unchanged: 0, empty: 0, unfixable: 0, discarded: 0, failed: 0 };
    }

    const allItems = await fetchUnauditedFiles(collection, CONFIG.audit.limit);
    log('info', `Found ${allItems.length} un-audited item(s) (limit=${CONFIG.audit.limit}).`);

    const results = { audited: 0, fixed: 0, unchanged: 0, empty: 0, unfixable: 0, discarded: 0, failed: 0 };
    if (allItems.length === 0) return results;

    const batches = chunkAuditBatches(allItems, CONFIG.audit.targetBatchTokens);
    log('info', `Audit: ${allItems.length} item(s) split into ${batches.length} batch(es).`);

    for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        log('info', `Audit: batch ${b + 1}/${batches.length} — ${batch.length} item(s)`);

        let llmResults;
        try {
            llmResults = await auditBatchWithGemini(db, batch);
        } catch (err) {
            log('error', `Audit: Gemini call failed for batch ${b + 1}: ${err.message.slice(0, 200)}`);
            results.failed += batch.length;
            continue;
        }

        const batchResultBySeq = new Map();
        for (const r of llmResults) {
            if (typeof r.seq === 'number') batchResultBySeq.set(r.seq, r);
        }

        for (const batchItem of batch) {
            const llmResult = batchResultBySeq.get(batchItem.seq);
            if (!llmResult) {
                log('warn', `Audit: no result returned for seq=${batchItem.seq} (${batchItem.postId} ${batchItem.path}) — skipping`);
                results.failed++;
                continue;
            }

            const { status, products, changes } = llmResult;
            const { path, postObjectId, postId } = batchItem;

            const now = new Date();
            let $set;

            if (status === 'fixed' || status === 'unchanged') {
                const productsArray = Array.isArray(products) ? products : [];
                $set = {
                    [`${path}.response`]:     { products: productsArray },
                    [`${path}.auditedAt`]:    now,
                    [`${path}.auditStatus`]:  'audited',
                };
                if (CONFIG.audit.saveChanges && Array.isArray(changes)) {
                    $set[`${path}.auditChanges`] = changes;
                }
                results[status === 'fixed' ? 'fixed' : 'unchanged']++;
            } else if (status === 'empty') {
                $set = {
                    [`${path}.response`]:    { products: [] },
                    [`${path}.auditedAt`]:   now,
                    [`${path}.auditStatus`]: 'audited',
                };
                if (CONFIG.audit.saveChanges && Array.isArray(changes)) {
                    $set[`${path}.auditChanges`] = changes;
                }
                results.empty++;
            } else {
                $set = {
                    [`${path}.response`]:    { products: [] },
                    [`${path}.auditedAt`]:   now,
                    [`${path}.auditStatus`]: 'unfixable',
                };
                if (CONFIG.audit.saveChanges && Array.isArray(changes)) {
                    $set[`${path}.auditChanges`] = changes;
                }
                results.unfixable++;
            }

            try {
                await collection.updateOne({ _id: postObjectId }, { $set });
                results.audited++;
            } catch (err) {
                log('error', `Audit: failed to write audit result for ${postId} ${path}: ${err.message}`);
                results.failed++;
            }
        }
    }

    const affectedPostIds = [...new Set(allItems.map(i => String(i.postObjectId)))];

    for (const postObjIdStr of affectedPostIds) {
        try {
            const postDoc = await collection.findOne(
                { _id: allItems.find(i => String(i.postObjectId) === postObjIdStr).postObjectId },
                { projection: { post_id: 1, file_urls: 1, discarded: 1 } }
            );
            if (!postDoc || postDoc.discarded) continue;
            if (!Array.isArray(postDoc.file_urls) || postDoc.file_urls.length === 0) continue;

            let allEmpty = true;
            for (const file of postDoc.file_urls) {
                if (!file) continue;

                if (file.type === 'image') {
                    const productsEmpty = !file.response ||
                        !Array.isArray(file.response.products) ||
                        file.response.products.length === 0;
                    const isUnfixable = file.auditStatus === 'unfixable';
                    if (!(productsEmpty || isUnfixable)) { allEmpty = false; break; }
                } else if (file.type === 'video' && Array.isArray(file.frames)) {
                    for (const frame of file.frames) {
                        if (!frame) continue;
                        const productsEmpty = !frame.response ||
                            !Array.isArray(frame.response.products) ||
                            frame.response.products.length === 0;
                        const isUnfixable = frame.auditStatus === 'unfixable';
                        if (!(productsEmpty || isUnfixable)) { allEmpty = false; break; }
                    }
                    if (!allEmpty) break;
                }
            }

            if (allEmpty) {
                await collection.updateOne(
                    { _id: postDoc._id },
                    { $set: { discarded: true, discardedReason: 'audit: all products empty or unfixable' } }
                );
                results.discarded++;
                log('info', `Audit: discarded post ${postDoc.post_id} — all products empty/unfixable`);
            }
        } catch (err) {
            log('warn', `Audit: post-discard check failed for ${postObjIdStr}: ${err.message}`);
        }
    }

    return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STEP 7 — DATA ENRICHMENT (TEXT EXTRACTION & LLM STRUCTURING)
// ═══════════════════════════════════════════════════════════════════════════════

function parseGlensPrice(priceStr) {
    if (!priceStr) return null;
    const match = String(priceStr).match(/[\d,.]+/);
    return match ? parseFloat(match[0].replace(/,/g, '')) : null;
}

function createFallbackSource(oldSource, errorMsg) {
    return {
        source_id: oldSource.source_id || "",
        url: oldSource.url,
        canonical_url: null,
        success: false,
        status_code: 400,
        extracted_at: new Date().toISOString(),
        name: "Unknown Product",
        brand: oldSource.store || oldSource.vendor || oldSource.brand || null,
        primary_category: null,
        product_type: null,
        color: null,
        material: null,
        description: null,
        features: [],
        price: parseGlensPrice(oldSource.price),
        compare_at_price: null,
        is_on_sale: false,
        currency: "USD", // Assumed fallback
        availability: oldSource.availability || "Unknown",
        sku: null,
        handle: null,
        product_id: null,
        vendor: oldSource.store || oldSource.vendor || oldSource.brand || null,
        images: Array.isArray(oldSource.images) ? oldSource.images : [], // Preserve any existing fallback images
        rating: null,
        review_count: null,
        reviews: [],
        variants: [],
        size_guide: null,
        shipping_info: null,
        return_policy: null,
        coupon_codes: [],
        product_tags: [],
        breadcrumb: [],
        base_price_for_markup: parseGlensPrice(oldSource.price),
        recommended_markup_percentage: null,
        calculated_markup_amount: null,
        suggested_resell_price: null,
        dropship_advisory: "Data extraction failed: " + errorMsg,
        textExtraction: {
            status: 'failed',
            error: errorMsg
        }
    };
}

function gatherPendingTextSources(post) {
    const pending = [];
    if (!Array.isArray(post.file_urls)) return pending;

    const processProducts = (file, i, frameIndex = -1) => {
        if (!file || file.auditStatus !== 'audited' || !file.response || !Array.isArray(file.response.products)) return;
        
        for (let p = 0; p < file.response.products.length; p++) {
            const product = file.response.products[p];
            if (!product || !Array.isArray(product.sources)) continue;
            
            for (let s = 0; s < product.sources.length; s++) {
                const source = product.sources[s];
                if (source && source.url && (!source.textExtraction || source.textExtraction.status !== 'completed' && source.textExtraction.status !== 'failed')) {
                    pending.push({
                        docId: post._id,
                        fileUrlIndex: i,
                        frameIndex,
                        productIndex: p,
                        sourceIndex: s,
                        url: source.url,
                        source_id: `src_${post._id}_${i}_${frameIndex}_${p}_${s}`,
                        oldSource: source // Retained so we can map fallback fields
                    });
                }
            }
        }
    };

    for (let i = 0; i < post.file_urls.length; i++) {
        const file = post.file_urls[i];
        processProducts(file, i);
        if (file && Array.isArray(file.frames)) {
            for (let j = 0; j < file.frames.length; j++) {
                processProducts(file.frames[j], i, j);
            }
        }
    }
    return pending;
}

async function runTextExtractorScript(urls, cfg) {
    const ts = Date.now();
    const urlsPath = path.join(CONFIG.tmpDir, `text_in_${ts}.json`);
    const outPath  = path.join(CONFIG.tmpDir, `text_out_${ts}.json`);
    fs.writeFileSync(urlsPath, JSON.stringify(urls));

    const args = [
        '-u', // Force Python to print logs instantly (unbuffered)
        cfg.scriptPath,
        '-u', urlsPath,
        '-o', outPath,
        '--lazy-extraction'
    ];

    const scriptDir = path.dirname(cfg.scriptPath);
    return new Promise((resolve, reject) => {
        const proc = spawn(cfg.pythonPath, args, { stdio: 'pipe', cwd: scriptDir });
        let stderr = '';
        let killed = false;

        const timer = setTimeout(() => {
            killed = true;
            proc.kill('SIGKILL');
            reject(new Error(`Text extraction timed out after ${cfg.timeoutMs}ms`));
        }, cfg.timeoutMs);

        // Stream logs directly to the console in real-time
        proc.stdout.on('data', d => process.stdout.write(`[TEXT-EXTRACTOR] ${d}`));
        proc.stderr.on('data', d => { 
            stderr += d; 
            process.stderr.write(`[TEXT-EXTRACTOR] ${d}`); 
        });

        proc.on('close', code => {
            clearTimeout(timer);
            if (killed) return;
            try { fs.unlinkSync(urlsPath); } catch (_) {}

            if (code !== 0) {
                try { fs.unlinkSync(outPath); } catch (_) {}
                return reject(new Error(`Text Extractor exited ${code}: ${stderr.slice(0, 300)}`));
            }

            try {
                const raw = fs.readFileSync(outPath, 'utf8');
                const parsed = JSON.parse(raw);
                try { fs.unlinkSync(outPath); } catch (_) {}
                resolve(parsed);
            } catch (e) {
                try { fs.unlinkSync(outPath); } catch (_) {}
                reject(new Error(`Failed to parse text extractor output: ${e.message}`));
            }
        });
        proc.on('error', err => {
            clearTimeout(timer);
            try { fs.unlinkSync(urlsPath); } catch (_) {}
            reject(err);
        });
    });
}

async function runDataEnrichmentStage(db, collection) {
    log('info', '── Step 7: Data Enrichment (Text Extraction + LLM) ──');

    if (!fs.existsSync(CONFIG.textExtraction.scriptPath)) {
        log('warn', `Text Extractor script not found at ${CONFIG.textExtraction.scriptPath} — skipping.`);
        return { processed: 0, succeeded: 0, failed: 0, updatedPosts: 0 };
    }

    const posts = await collection.find({
        discarded: { $ne: true },
        $or: [
            {
                file_urls: {
                    $elemMatch: {
                        auditStatus: 'audited',
                        'response.products': {
                            $elemMatch: {
                                sources: {
                                    $elemMatch: {
                                        url: { $exists: true },
                                        $or: [
                                            { textExtraction: { $exists: false } },
                                            { 'textExtraction.status': { $nin: ['completed', 'failed'] } }
                                        ]
                                    }
                                }
                            }
                        }
                    }
                }
            },
            {
                'file_urls.frames': {
                    $elemMatch: {
                        auditStatus: 'audited',
                        'response.products': {
                            $elemMatch: {
                                sources: {
                                    $elemMatch: {
                                        url: { $exists: true },
                                        $or: [
                                            { textExtraction: { $exists: false } },
                                            { 'textExtraction.status': { $nin: ['completed', 'failed'] } }
                                        ]
                                    }
                                }
                            }
                        }
                    }
                }
            }
        ]
    }).limit(CONFIG.textExtraction.batchSize).toArray();

    let allPending = [];
    for (const post of posts) {
        allPending.push(...gatherPendingTextSources(post));
        // Hard limit on how many sources we process per run to avoid pipeline timeouts
        if (allPending.length >= CONFIG.textExtraction.sourceLimit) {
            log('info', `Source limit reached (${CONFIG.textExtraction.sourceLimit}). Halting further source discovery for this run.`);
            allPending = allPending.slice(0, CONFIG.textExtraction.sourceLimit);
            break;
        }
    }

    if (allPending.length === 0) {
        return { processed: 0, succeeded: 0, failed: 0, updatedPosts: 0 };
    }

    const uniqueUrls = [...new Set(allPending.map(item => item.url))];
    log('info', `Running text extraction on ${uniqueUrls.length} unique URL(s) from ${allPending.length} source(s)...`);

    let pythonResults = {};
    // Chunk URLs into batches of 30 to prevent the Python script from timing out
    const urlBatches = chunkArray(uniqueUrls, 30);
    
    for (let b = 0; b < urlBatches.length; b++) {
        log('info', `Text extraction batch ${b + 1}/${urlBatches.length} (${urlBatches[b].length} URLs)...`);
        try {
            const batchResults = await runTextExtractorScript(urlBatches[b], CONFIG.textExtraction);
            Object.assign(pythonResults, batchResults);
        } catch (err) {
            log('error', `Text extraction batch ${b + 1} failed: ${err.message}`);
            // If a batch fails (e.g. timeout), we gracefully catch it. 
            // Missing URLs will be flagged as failed further down the loop.
        }
    }

    if (Object.keys(pythonResults).length === 0) {
        log('error', 'All text extraction batches failed. Skipping LLM structuring.');
        // We will process them anyway down below to ensure they get fallback schemas and are marked as failed.
    }

    const bulkOps = [];
    const llmBatchQueue = []; 
    let succeeded = 0;
    let failed = 0;

    for (const item of allPending) {
        const dbPath = item.frameIndex === -1
            ? `file_urls.${item.fileUrlIndex}.response.products.${item.productIndex}.sources.${item.sourceIndex}`
            : `file_urls.${item.fileUrlIndex}.frames.${item.frameIndex}.response.products.${item.productIndex}.sources.${item.sourceIndex}`;

        const rawData = pythonResults[item.url];
        
        if (!rawData || !rawData.success) {
            log('warn', `Text extraction failed for ${item.url}: ${rawData?.error || 'No data returned'}`);
            bulkOps.push({
                updateOne: {
                    filter: { _id: item.docId },
                    update: { $set: { [dbPath]: createFallbackSource(item.oldSource, rawData?.error || 'Unknown error') } }
                }
            });
            failed++;
            continue;
        }

        llmBatchQueue.push({
            source_id: item.source_id,
            dbPath,
            docId: item.docId,
            oldSource: item.oldSource,
            payload: {
                source_id: item.source_id,
                raw_data: rawData
            }
        });
    }

    const llmChunks = chunkArray(llmBatchQueue, CONFIG.textExtraction.llmBatchSize);
    
    // Process as many batches concurrently as you have API keys (fallback to 1 if empty)
    const llmConcurrency = Math.max(1, CONFIG.review.apiKeys.length);

    for (let c = 0; c < llmChunks.length; c += llmConcurrency) {
        const concurrentChunks = llmChunks.slice(c, c + llmConcurrency);
        log('info', `Gemini LLM Structuring: processing batches ${c + 1} to ${c + concurrentChunks.length} of ${llmChunks.length} concurrently...`);

        // Execute LLM API calls in parallel
        await Promise.all(concurrentChunks.map(async (chunk, chunkIdx) => {
            const batchNum = c + chunkIdx + 1;
            let cleanResults = [];
            
            try {
                cleanResults = await extractDataBatchWithGemini(db, chunk.map(i => i.payload));
            } catch (err) {
                log('error', `Gemini batch ${batchNum} failed: ${err.message}`);
                for (const item of chunk) {
                    bulkOps.push({
                        updateOne: {
                            filter: { _id: item.docId },
                            update: { $set: { [item.dbPath]: createFallbackSource(item.oldSource, 'LLM structuring failed') } }
                        }
                    });
                    failed++;
                }
                return; // Exit this parallel promise early on fail
            }

            for (const item of chunk) {
                const cleanJson = cleanResults.find(r => r.source_id === item.source_id);
                if (!cleanJson) {
                    log('warn', `Gemini missed source_id ${item.source_id} in batch ${batchNum}`);
                    bulkOps.push({
                        updateOne: {
                            filter: { _id: item.docId },
                            update: { $set: { [item.dbPath]: createFallbackSource(item.oldSource, 'Gemini missed source_id') } }
                        }
                    });
                    failed++;
                    continue;
                }

                try {
                    // Carry over original fallback details
                    cleanJson.url = cleanJson.url || item.oldSource.url;
                    if (!Array.isArray(cleanJson.images) || cleanJson.images.length === 0) {
                        cleanJson.images = Array.isArray(item.oldSource.images) ? item.oldSource.images : [];
                    }
                    cleanJson.textExtraction = { status: 'completed' };

                    // Replace the entire source object with the clean schema
                    bulkOps.push({
                        updateOne: {
                            filter: { _id: item.docId },
                            update: { $set: { [item.dbPath]: cleanJson } }
                        }
                    });
                    succeeded++;
                } catch (err) {
                    log('error', `Failed processing clean result for ${item.source_id}: ${err.message}`);
                    bulkOps.push({
                        updateOne: {
                            filter: { _id: item.docId },
                            update: { $set: { [item.dbPath]: createFallbackSource(item.oldSource, 'Result processing failed') } }
                        }
                    });
                    failed++;
                }
            }
        }));

        await sleep(2000); // Brief pause before the next concurrent wave
    }
    
    let updatedPosts = 0;
    if (bulkOps.length > 0) {
        try {
            const uniqueDocs = new Set(bulkOps.map(op => String(op.updateOne.filter._id)));
            await collection.bulkWrite(bulkOps, { ordered: false });
            updatedPosts = uniqueDocs.size;
            log('info', `Saved enriched text data to ${updatedPosts} post(s)`);
        } catch (err) {
            log('error', `Failed to write enriched text data to MongoDB: ${err.message}`);
        }
    }

    return { processed: allPending.length, succeeded, failed, updatedPosts };
}


// ═══════════════════════════════════════════════════════════════════════════════
//  STEP 8 — PRODUCT SOURCE IMAGE EXTRACTION (FALLBACK)
// ═══════════════════════════════════════════════════════════════════════════════

function gatherPendingImageSources(post) {
    const pending = [];
    if (!Array.isArray(post.file_urls)) return pending;

    const processProducts = (file, i, frameIndex = -1) => {
        if (!file || file.auditStatus !== 'audited' || !file.response || !Array.isArray(file.response.products)) return;
        
        for (let p = 0; p < file.response.products.length; p++) {
            const product = file.response.products[p];
            if (!product || !Array.isArray(product.sources)) continue;
            
            for (let s = 0; s < product.sources.length; s++) {
                const source = product.sources[s];
                
                const hasImages = Array.isArray(source.images) && source.images.length > 0;
                const textExtractionCompleted = source.textExtraction?.status === 'completed';
                
                if (source && source.url && !hasImages && textExtractionCompleted) {
                    pending.push({
                        docId: post._id,
                        fileUrlIndex: i,
                        frameIndex,
                        productIndex: p,
                        sourceIndex: s,
                        url: source.url,
                        // Pull from the new schema vendor/brand if store is missing
                        store: source.store || source.vendor || source.brand || '',
                    });
                }
            }
        }
    };

    for (let i = 0; i < post.file_urls.length; i++) {
        const file = post.file_urls[i];
        processProducts(file, i);
        if (file && Array.isArray(file.frames)) {
            for (let j = 0; j < file.frames.length; j++) {
                processProducts(file.frames[j], i, j);
            }
        }
    }
    return pending;
}

async function fetchPostsWithPendingImages(collection, limit) {
    return collection.find({
        discarded: { $ne: true },
        $or: [
            {
                file_urls: {
                    $elemMatch: {
                        auditStatus: 'audited',
                        'response.products': {
                            $elemMatch: {
                                sources: {
                                    $elemMatch: {
                                        url: { $exists: true },
                                        $or: [
                                            { images: { $exists: false } },
                                            { images: { $size: 0 } }
                                        ],
                                        'textExtraction.status': 'completed'
                                    }
                                }
                            }
                        }
                    }
                }
            },
            {
                'file_urls.frames': {
                    $elemMatch: {
                        auditStatus: 'audited',
                        'response.products': {
                            $elemMatch: {
                                sources: {
                                    $elemMatch: {
                                        url: { $exists: true },
                                        $or: [
                                            { images: { $exists: false } },
                                            { images: { $size: 0 } }
                                        ],
                                        'textExtraction.status': 'completed'
                                    }
                                }
                            }
                        }
                    }
                }
            }
        ]
    }).limit(limit).toArray();
}

async function runImageExtractorScript(urls, cfg) {
    const ts = Date.now();
    const urlsPath = path.join(CONFIG.tmpDir, `extract_urls_${ts}.json`);
    const outPath  = path.join(CONFIG.tmpDir, `extract_out_${ts}.json`);
    fs.writeFileSync(urlsPath, JSON.stringify(urls));

    const args = [
        cfg.scriptPath,
        '-u', urlsPath,
        '-o', outPath,
        '--min-score', String(cfg.minScore),
        '--hash-threshold', String(cfg.hashThreshold),
        '--cdp-port', String(cfg.cdpPort),
    ];
    if (cfg.lazyExtraction) args.push('--lazy-extraction');
    else args.push('--no-lazy-extraction');
    if (cfg.adaptiveCutoff) args.push('--adaptive-cutoff');
    else args.push('--no-adaptive-cutoff');

    const scriptDir = path.dirname(cfg.scriptPath);
    return new Promise((resolve, reject) => {
        const proc = spawn(cfg.pythonPath, args, { stdio: 'pipe', cwd: scriptDir });
        let stderr = '';
        let killed = false;

        const timer = setTimeout(() => {
            killed = true;
            proc.kill('SIGKILL');
            reject(new Error(`Product image extraction timed out after ${cfg.timeoutMs}ms`));
        }, cfg.timeoutMs);

        proc.stderr.on('data', d => { stderr += d; });
        proc.on('close', code => {
            clearTimeout(timer);
            if (killed) return;
            try { fs.unlinkSync(urlsPath); } catch (_) {}

            if (code !== 0) {
                try { fs.unlinkSync(outPath); } catch (_) {}
                return reject(new Error(`Extractor exited ${code}: ${stderr.slice(0, 300)}`));
            }

            try {
                const raw = fs.readFileSync(outPath, 'utf8');
                const parsed = JSON.parse(raw);
                try { fs.unlinkSync(outPath); } catch (_) {}
                resolve(parsed);
            } catch (e) {
                try { fs.unlinkSync(outPath); } catch (_) {}
                reject(new Error(`Failed to parse extractor output: ${e.message}`));
            }
        });
        proc.on('error', err => {
            clearTimeout(timer);
            try { fs.unlinkSync(urlsPath); } catch (_) {}
            reject(err);
        });
    });
}

async function runProductImageExtractionStage(db, collection) {
    log('info', '── Step 8: Product Source Image Extraction (Fallback) ──');

    if (!fs.existsSync(CONFIG.productImageExtraction.scriptPath)) {
        log('warn', `Image Extractor script not found at ${CONFIG.productImageExtraction.scriptPath} — skipping.`);
        return { processed: 0, succeeded: 0, failed: 0, updatedPosts: 0 };
    }

    const posts = await fetchPostsWithPendingImages(collection, CONFIG.productImageExtraction.batchSize);
    log('info', `Found ${posts.length} post(s) with fallback image needs.`);

    let allPending = [];
    for (const post of posts) {
        allPending.push(...gatherPendingImageSources(post));
    }

    log('info', `Discovered ${allPending.length} pending source(s) needing fallback image extraction.`);

    if (allPending.length === 0) {
        return { processed: 0, succeeded: 0, failed: 0, updatedPosts: 0 };
    }

    const seenUrls = new Set();
    const uniquePending = [];
    for (const item of allPending) {
        if (!seenUrls.has(item.url)) {
            seenUrls.add(item.url);
            uniquePending.push(item);
        }
    }

    const batchSize = CONFIG.productImageExtraction.batchSize;
    const batches = chunkArray(uniquePending, batchSize);

    const urlToImages = new Map();
    let succeeded = 0;
    let failed = 0;

    for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        const urls = batch.map(x => x.url);
        log('info', `Extracting batch ${b + 1}/${batches.length} (${urls.length} URL(s))…`);

        try {
            const results = await runImageExtractorScript(urls, CONFIG.productImageExtraction);
            for (const [url, data] of Object.entries(results)) {
                if (Array.isArray(data)) {
                    urlToImages.set(url, data);
                    succeeded++;
                } else if (data && data.error) {
                    log('warn', `Extractor error for ${url}: ${data.error}`);
                    urlToImages.set(url, []);
                    failed++;
                } else {
                    urlToImages.set(url, []);
                    failed++;
                }
            }
        } catch (err) {
            log('error', `Batch ${b + 1} extraction failed: ${err.message}`);
            for (const url of urls) {
                failed++;
            }
        }

        if (b < batches.length - 1) {
            await sleep(2000);
        }
    }

    let updatedPosts = 0;
    const bulkOps = [];

    for (const post of posts) {
        const pending = gatherPendingImageSources(post);
        if (pending.length === 0) continue;

        const $set = {};
        let hasUpdates = false;

        for (const item of pending) {
            if (!urlToImages.has(item.url)) continue;

            const images = urlToImages.get(item.url);
            let dbPath;
            if (item.frameIndex === -1) {
                dbPath = `file_urls.${item.fileUrlIndex}.response.products.${item.productIndex}.sources.${item.sourceIndex}.images`;
            } else {
                dbPath = `file_urls.${item.fileUrlIndex}.frames.${item.frameIndex}.response.products.${item.productIndex}.sources.${item.sourceIndex}.images`;
            }
            $set[dbPath] = images;
            hasUpdates = true;
        }

        if (hasUpdates) {
            bulkOps.push({
                updateOne: {
                    filter: { _id: post._id },
                    update: { $set }
                }
            });
        }
    }

    if (bulkOps.length > 0) {
        try {
            await collection.bulkWrite(bulkOps, { ordered: false });
            updatedPosts = bulkOps.length;
            log('info', `Updated ${updatedPosts} post(s) with extracted fallback source images.`);
        } catch (err) {
            log('error', `Failed to write source images back to MongoDB: ${err.message}`);
        }
    }

    return { processed: allPending.length, succeeded, failed, updatedPosts };
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
//  DOWNLOADER CLASS
// ═══════════════════════════════════════════════════════════════════════════════

class InstagramDownloader {
    constructor(name) { this.name = name; }
    /** @returns {Promise<Array<{directUrl:string, uri:string|null}>>} */
    async extractLinks(_page, _postId) {
        throw new Error(`${this.name}.extractLinks() not implemented`);
    }
}

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

        await page.click(inputSel, { clickCount: 3 });
        await page.keyboard.press('Backspace');

        await page.type(inputSel, igUrl, { delay: 10 });

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

        await page.click('#s_input', { clickCount: 3 });
        await page.keyboard.press('Backspace');

        await page.type('#s_input', igUrl, { delay: 10 });

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
                const select = item.querySelector('.photo-option select.minimal');
                if (select && select.options.length > 0) {
                    const href = select.options[0].value;
                    if (href && !seen.has(href)) {
                        seen.add(href);
                        items.push({ directUrl: href, uri: href });
                    }
                    return;
                }

                let pushed = false;
                item.querySelectorAll('.download-items__btn:not(.dl-thumb)').forEach(container => {
                    const btn = container.querySelector('a.btn-premium[href*="dl.snapcdn.app"]');
                    if (btn) {
                        const href = btn.href;
                        if (href && !seen.has(href)) {
                            seen.add(href);
                            items.push({ directUrl: href, uri: href });
                            pushed = true;
                        }
                    }
                });

                if (!pushed) {
                    const btn = item.querySelector('a.btn-premium[href*="dl.snapcdn.app"]');
                    if (btn) {
                        const href = btn.href;
                        if (href && !seen.has(href)) {
                            seen.add(href);
                            items.push({ directUrl: href, uri: href });
                        }
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

class PicnobDownloader extends InstagramDownloader {
    constructor() { super('Picnob'); }

    async extractLinks(page, postId) {
        if (postId?.includes("reel")) {
            log('warn', `Picnob doesnt support reels, skipping [${postId}]`);
            return [];
        }
        
        const shortcode = postId.replace(/^\/+|\/+$/g, '').split('/').pop();

        log('info', `[Picnob] Processing ${shortcode}`);

        const candidates = [ `https://www.picnob.com/post/${shortcode}/` ];

        let lastErr = null;

        for (const url of candidates) {
            try {
                const resp = await page.goto(url, {
                    waitUntil: 'domcontentloaded',
                    timeout: CONFIG.timeouts.navigation,
                });

                if (resp && resp.status() >= 400) {
                    lastErr = new Error(`HTTP ${resp.status()} for ${url}`);
                    continue;
                }

                const found = await page.waitForFunction(() => {
                    if (document.querySelector('.down a.downbtn[href]')) return true;
                    if (document.querySelector('.entry-body a[href]')) return true;
                    if (document.querySelector('video source[src]')) return true;
                    if (document.querySelector('video[src]')) return true;
                    return false;
                }, { timeout: CONFIG.timeouts.downloaderIdle })
                    .then(() => true)
                    .catch(() => false);

                if (!found) {
                    lastErr = new Error(`No media found at ${url}`);
                    continue;
                }

                await sleep(1000);

                const links = await page.evaluate(() => {
                    const items = [];
                    const seen  = new Set();

                    const push = (href) => {
                        if (!href || seen.has(href)) return;
                        seen.add(href);
                        items.push({ directUrl: href, uri: href });
                    };

                    document.querySelectorAll('.down a.downbtn[href]').forEach(a => push(a.href));
                    document.querySelectorAll('video source[src]').forEach(s => push(s.src));
                    document.querySelectorAll('video[src]').forEach(v => push(v.src));

                    if (items.length === 0) {
                        document.querySelectorAll('.entry-body a[href]').forEach(a => push(a.href));
                    }

                    if (items.length === 0) {
                        document.querySelectorAll('a[href*="cdninstagram.com"]').forEach(a => push(a.href));
                    }

                    return items;
                });

                if (links.length > 0) {
                    log('info', `[Picnob] ✅ ${links.length} link(s) for ${shortcode} @ ${url}`);
                    return links;
                }

                lastErr = new Error(`Media markers present but no links extracted at ${url}`);
            } catch (err) {
                lastErr = err;
                log('debug', `[Picnob] ${url} failed: ${err.message.slice(0, 150)}`);
            }
        }

        log('warn', `[Picnob] Failed for ${shortcode}: ${lastErr ? lastErr.message : 'unknown error'}`);

        const safeName = shortcode.replace(/[^a-z0-9]/gi, '');
        await page.screenshot({
            path: path.join(CONFIG.tmpDir, `picnob-debug-${safeName}-${Date.now()}.png`),
        }).catch(() => {});

        return [];
    }
}

class PicukiSiteDownloader extends InstagramDownloader {
    constructor() { super('PicukiSite'); }

    async extractLinks(page, postId) {
        if (postId?.includes("reel")) {
            log('warn', `Picuki has issues with reels, skipping [${postId}]`);
            return [];
        }
        
        const igUrl = `https://www.instagram.com/${postId}/`;

        log('info', `[PicukiSite] Processing ${postId}`);

        await page.evaluateOnNewDocument(() => {
            window.open = function() { return null; };
        });

        await page.goto('https://picuki.site/', {
            waitUntil: 'domcontentloaded',
            timeout: CONFIG.timeouts.navigation,
        });

        const inputSel = 'form input[type="text"], input[placeholder*="username"], input[placeholder*="link"]';
        await page.waitForSelector(inputSel, { timeout: 15_000 });

        await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) {
                el.focus();
                el.value = '';
            }
        }, inputSel);

        await page.type(inputSel, igUrl, { delay: 10 });

        await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) {
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }, inputSel);

        await page.keyboard.press('Enter');

        log('debug', `[PicukiSite] Submitted: ${igUrl}`);

        await page.waitForFunction(() => {
            const anchors = Array.from(document.querySelectorAll('a'));
            return anchors.some(a => 
                a.hasAttribute('download') || 
                (a.href && a.href.includes('media.picuki.site')) || 
                (a.href && a.href.includes('uri='))
            );
        }, { timeout: CONFIG.timeouts.downloaderIdle });

        await sleep(1500);

        const results = await page.evaluate(() => {
            const items = [];
            const seen = new Set();
            const allAnchors = document.querySelectorAll('a');
            
            for (const a of allAnchors) {
                const href = a.href;
                if (!href) continue;

                const isDownloadLink = a.hasAttribute('download') || 
                                       href.includes('uri=') || 
                                       href.includes('media.picuki.site/get');
                
                if (isDownloadLink && !seen.has(href)) {
                    seen.add(href);

                    let directUrl = href;
                    let proxyUrl = href;
                    
                    try {
                        const urlObj = new URL(href);
                        const uriParam = urlObj.searchParams.get('uri');
                        if (uriParam) {
                            directUrl = decodeURIComponent(uriParam); 
                        }
                    } catch (_) {}

                    items.push({ directUrl, uri: proxyUrl });
                }
            }

            return items;
        });

        log('info', `[PicukiSite] ✅ ${results.length} link(s) for ${postId}`);

        if (results.length === 0) {
            const safeName = postId.replace(/[^a-z0-9]/gi, '');
            await page.screenshot({
                path: path.join(CONFIG.tmpDir, `picukisite-debug-${safeName}-${Date.now()}.png`),
            }).catch(() => {});
        }

        return results;
    }
}

class SaveClipDownloader extends InstagramDownloader {
    constructor() { super('SaveClip'); }

    async extractLinks(page, postId) {
        const igUrl = `https://www.instagram.com/${postId}/`;

        log('info', `[SaveClip] Processing ${postId}`);

        await page.evaluateOnNewDocument(() => {
            window.open = function() { return null; };
        });

        await page.goto('https://saveclip.app/en3', {
            waitUntil: 'domcontentloaded',
            timeout: CONFIG.timeouts.navigation,
        });

        const inputSel = 'form#search-form input[name="q"], #s_input, input[placeholder*="Instagram"]';
        await page.waitForSelector(inputSel, { timeout: 15_000 });

        await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) {
                el.focus();
                el.value = '';
            }
        }, inputSel);

        await page.type(inputSel, igUrl, { delay: 10 });

        await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if (el) {
                el.dispatchEvent(new Event('input', { bubbles: true }));
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }, inputSel);

        const btnSel = 'form#search-form button, #search-form button.btn-default';
        const btnExists = await page.$(btnSel);
        if (btnExists) {
            await page.click(btnSel);
        } else {
            await page.keyboard.press('Enter');
        }

        log('debug', `[SaveClip] Submitted: ${igUrl}`);

        await page.waitForFunction(() => {
            return document.querySelector('#search-result .download-items') !== null || 
                   document.querySelector('#search-result ul.download-box') !== null;
        }, { timeout: CONFIG.timeouts.downloaderIdle });

        await sleep(1500);

        const results = await page.evaluate(() => {
            const items = [];
            const seen = new Set();

            document.querySelectorAll('#search-result .download-items').forEach(item => {
                const select = item.querySelector('.photo-option select, select.minimal');
                if (select && select.options.length > 0) {
                    const href = select.options[0].value;
                    if (href && !seen.has(href)) {
                        seen.add(href);
                        items.push({ directUrl: href, uri: href });
                    }
                    return; 
                }

                const btnContainers = item.querySelectorAll('.download-items__btn:not(.dl-thumb)');
                for (const container of btnContainers) {
                    const a = container.querySelector('a[href]');
                    if (a && a.href && !seen.has(a.href)) {
                        if (a.href.includes('token=') || a.href.includes('snapcdn.app') || a.hasAttribute('download')) {
                            seen.add(a.href);
                            items.push({ directUrl: a.href, uri: a.href });
                            break;
                        }
                    }
                }
            });

            return items;
        });

        log('info', `[SaveClip] ✅ ${results.length} link(s) for ${postId}`);

        if (results.length === 0) {
            const safeName = postId.replace(/[^a-z0-9]/gi, '');
            await page.screenshot({
                path: path.join(CONFIG.tmpDir, `saveclip-debug-${safeName}-${Date.now()}.png`),
            }).catch(() => {});
        }

        return results;
    }
}

const DOWNLOADERS = [new PicnobDownloader(), new SaveClipDownloader(), new InSaverDownloader(), new FastDLDownloader(), new PicukiSiteDownloader()];

// ═══════════════════════════════════════════════════════════════════════════════
//  STEP 2 — Fetch un-downloaded posts
// ═══════════════════════════════════════════════════════════════════════════════

async function fetchUndownloadedPosts(collection) {
    return collection.find({
        $and: [
            {
                $or: [
                    { downloaded: { $exists: false } },
                    { downloaded: false },
                    { downloaded: null },
                ]
            },
            { discarded: { $ne: true } }
        ]
    }).limit(CONFIG.batch.size).toArray();
}

// ═══════════════════════════════════════════════════════════════════════════════
//  STEPS 3-5 — Download, upload to HF, update MongoDB
// ═══════════════════════════════════════════════════════════════════════════════

function buildAssetFilename(postId, index, ext) {
    return `${postId.replace('/', '-')}-${index}${ext}`;
}

function mimeToType(mimeType, ext) {
    return (mimeType.startsWith('video') || ext === '.mp4') ? 'video' : 'image';
}

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

        await recorder.updateLabel(postId, `PROCESSING [${i + 1}/${links.length}]`);
        
        let fileEntry = { url: null, type };
        let frames = [];

        if (type === 'video') {
            const tmpVidPath = path.join(CONFIG.tmpDir, `vid_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
            fs.writeFileSync(tmpVidPath, buffer);
            const tmpFramesDir = tmpVidPath + '_frames';
            
            try {
                const pyPath = path.join(CONFIG.tmpDir, 'extract_frames.py');
                log('info', 'Extracting video frames...');
                execSync(`python3 "${pyPath}" "${tmpVidPath}" "${tmpFramesDir}"`, { stdio: 'ignore' });
            } catch (e) {
                log('warn', `  Frame extraction failed for ${postId}: ${e.message}`);
            }

            if (fs.existsSync(tmpFramesDir)) {
                const frameFiles = fs.readdirSync(tmpFramesDir).filter(f => f.endsWith('.jpg'));
                for (const [fIdx, f] of frameFiles.entries()) {
                    const frameBuf = fs.readFileSync(path.join(tmpFramesDir, f));
                    const frameName = `${postId.replace('/', '-')}-${i}-frame-${fIdx}.jpg`;
                    const frameRepoPath = `${CONFIG.hf.assetsPath}/${frameName}`;
                    
                    log('debug', `  Uploading frame blob: ${frameRepoPath} (${(frameBuf.length / 1024).toFixed(0)} KB)`);
                    const frameBlob = await hfUploadBlob(frameBuf, frameRepoPath);
                    frames.push({ url: frameBlob.url, type: 'image' });
                    lfsFiles.push({ path: frameBlob.path, oid: frameBlob.oid, size: frameBlob.size });
                }
            }
            try { fs.unlinkSync(tmpVidPath); } catch(_) {}
            try { fs.rmSync(tmpFramesDir, { recursive: true, force: true }); } catch(_) {}

            if (frames.length === 0) {
                log('info', `  [!] Video yielded 0 frames. Discarding video entirely.`);
                continue; 
            }
            fileEntry.frames = frames;
        }

        log('debug', `  Uploading blob: ${repoPath} (${(buffer.length / 1024).toFixed(0)} KB)`);
        const blob = await hfUploadBlob(buffer, repoPath);
        fileEntry.url = blob.url;
        lfsFiles.push({ path: blob.path, oid: blob.oid, size: blob.size });

        fileUrls.push(fileEntry);
        log('info', `  ✓ [${i}] ${type}: ${blob.url}${type === 'video' ? ` (${frames.length} frames)` : ''}`);
    }

    await recorder.updateLabel(postId, 'DONE');
    return { fileUrls, lfsFiles };
}

async function processBatch(posts, browser, collection) {
    const concurrency = Math.min(CONFIG.batch.concurrency, posts.length);
    const results      = { ok: 0, fail: 0 };
    const pendingCommit = [];

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

    const allLfsFiles = pendingCommit.flatMap(p => p.lfsFiles);
    if (allLfsFiles.length > 0) {
        log('info', `── Committing ${allLfsFiles.length} file(s) across ${pendingCommit.length} post(s) to HuggingFace in ONE commit ──`);
        try {
            await hfCommitFiles(allLfsFiles, `orchestrator: add assets for ${pendingCommit.length} post(s) [run ${CONFIG.runId}]`);

            for (const { postDoc, fileUrls } of pendingCommit) {
                try {
                    const updateObj = { downloaded: true, file_urls: fileUrls };
                    if (fileUrls.length === 0) {
                        updateObj.discarded = true;
                    }
                    await collection.updateOne(
                        { _id: postDoc._id },
                        { $set: updateObj }
                    );
                } catch (err) {
                    log('error', `MongoDB update failed for ${postDoc.post_id} after successful HF commit: ${err.message}`);
                    results.ok--;
                    results.fail++;
                }
            }
        } catch (err) {
            log('error', `HF batch commit failed — MongoDB will NOT be updated for this run's ${pendingCommit.length} post(s): ${err.message}`);
            results.ok -= pendingCommit.length;
            results.fail += pendingCommit.length;
        }
    } else {
        for (const { postDoc, fileUrls } of pendingCommit) {
            if (fileUrls.length === 0) {
                try {
                    await collection.updateOne(
                        { _id: postDoc._id },
                        { $set: { downloaded: true, file_urls: [], discarded: true } }
                    );
                } catch (err) {
                    log('error', `MongoDB update failed for discarded post ${postDoc.post_id}: ${err.message}`);
                }
            }
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

    fs.writeFileSync(path.join(CONFIG.tmpDir, 'extract_frames.py'), EXTRACT_FRAMES_PY);

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

    // ── Step 6.5 — JSON Audit & Repair ────────────────────────────────────────
    let auditResults = { audited: 0, fixed: 0, unchanged: 0, empty: 0, unfixable: 0, discarded: 0, failed: 0 };
    if (CONFIG.audit.enabled) {
        log('info', '── Step 6.5: JSON Audit & Repair (Gemini) ──');
        try {
            auditResults = await runAuditStage(db, collection);
        } catch (err) {
            log('error', `Audit stage failed: ${err.message}`);
        }
    } else {
        log('info', 'Audit stage disabled (ORCH_AUDIT_ENABLED=false) — skipping.');
    }

    // ── Step 7 — Data Enrichment (Text Extraction + LLM Structuring) ──
    let dataEnrichmentResults = { processed: 0, succeeded: 0, failed: 0, updatedPosts: 0 };
    if (CONFIG.textExtraction.enabled) {
        try {
            dataEnrichmentResults = await runDataEnrichmentStage(db, collection);
        } catch (err) {
            log('error', `Data enrichment stage failed: ${err.message}`);
        }
    } else {
        log('info', 'Data enrichment stage disabled (ORCH_TEXT_EXTRACT_ENABLED=false) — skipping.');
    }

    // ── Step 8 — Product Source Image Extraction (Fallback) ──
    let productImageResults = { processed: 0, succeeded: 0, failed: 0, updatedPosts: 0 };
    if (CONFIG.productImageExtraction.enabled) {
        try {
            productImageResults = await runProductImageExtractionStage(db, collection);
        } catch (err) {
            log('error', `Product image extraction stage failed: ${err.message}`);
        }
    } else {
        log('info', 'Product image extraction stage disabled (ORCH_PRODUCT_IMG_ENABLED=false) — skipping.');
    }

    await mongoClient.close();

    // ── Summary ──────────────────────────────────────────────────────────────
    const elapsed = ((Date.now() - tStart) / 1000).toFixed(1);
    log('info', '═══════════════════════════════════════════════════════════════');
    log('info', `DONE in ${elapsed}s`);
    log('info', `  Sync:     data.json → MongoDB`);
    log('info', `  Download: ${downloadResults.ok} OK | ${downloadResults.fail} FAIL out of ${posts.length} post(s)`);
    if (CONFIG.recording.enabled) log('info', `  Recording: ${RECORDINGS_DIR}`);
    if (CONFIG.review.enabled) log('info', `  Review:   ${reviewResults.reviewed} reviewed | ${reviewResults.kept} kept | ${reviewResults.rejected} rejected | ${reviewResults.collages} collage(s) | ${reviewResults.failed} failed`);
    if (CONFIG.audit.enabled) log('info', `  Audit:    ${auditResults.audited} audited | ${auditResults.fixed} fixed | ${auditResults.discarded} discarded | ${auditResults.failed} failed`);
    if (CONFIG.textExtraction.enabled) log('info', `  Data Enrich: ${dataEnrichmentResults.processed} processed | ${dataEnrichmentResults.succeeded} succeeded | ${dataEnrichmentResults.failed} failed | ${dataEnrichmentResults.updatedPosts} post(s) updated`);
    if (CONFIG.productImageExtraction.enabled) log('info', `  Image FB: ${productImageResults.processed} processed | ${productImageResults.succeeded} succeeded | ${productImageResults.failed} failed | ${productImageResults.updatedPosts} post(s) updated`);
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
            audit: CONFIG.audit.enabled ? auditResults : null,
            dataEnrichment: CONFIG.textExtraction.enabled ? dataEnrichmentResults : null,
            productImageExtraction: CONFIG.productImageExtraction.enabled ? productImageResults : null,
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
