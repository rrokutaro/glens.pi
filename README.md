# GLENS.PI — Google Lens Product Identifier

![](./assets/banner.gif)

Automated pipeline that uploads images to Google Lens, extracts AI-generated product analysis (titles, brands, prices, sources, dropship viability, social appearances), and outputs structured JSON. It does not rely on manually clicking elements; instead it navigates directly to URLs and extracts the returned JSON data from the DOM. This makes it far more robust and reliable than fragile UI-automation scripts that break when selectors change.

Runs on **GitHub Actions** (with optional HuggingFace upload) or locally with Node.js.

---

## What it does

1. **Discovers** images from `./images/` (or from a JSON array of URLs)
2. **Resizes** them for fast upload (configurable max dimension/quality)
3. **Uploads** to a temporary image host (catbox.moe / litterbox)
4. **Navigates** Google Lens with the image URL + structured prompt
5. **Extracts** the AI response as clean JSON (with robust fallback parsing)
6. **Records** the entire browser session as an MP4 (optional) and compiles all clips into a single session video
7. **Saves** everything to `./output/` and optionally **pushes successful results to a HuggingFace repo**

---

## Launch Methods

There are **three** supported ways to launch the workflow:

### 1. GitHub Actions — Manual Run (workflow_dispatch)
Best for one-off runs or testing.

1. Fork or create a repo with these files:
   ```
   .github/workflows/glens.yml
   glens.js
   images/   (optional if you provide URLs)
   ```

2. Go to **Actions → GLENS → Run workflow**

3. *(Optional)* Fill in the inputs:
   - **image_urls** — JSON array of direct image URLs, e.g. `["https://i.imgur.com/abc.jpg"]`. If left empty, the workflow looks for images in the `./images/` directory.
   - **hf_token** — HuggingFace write token. If provided, successful JSON results are auto-uploaded to your HF repo.
   - **hf_repo** — Target repo ID (default: `hfusername/ugc-dropship`).
   - **hf_path** — Directory inside the repo (default: `assets/glens-responses`).
   - **hf_repo_type** — `dataset`, `model`, or `space` (default: `dataset`).

4. Download artifacts from the completed run (`glens-output`) or find your files on HuggingFace.

### 2. GitHub Actions — API / Webhook (repository_dispatch)
Best for triggering remotely from another service, script, or scheduler.

Send a `POST` request to the GitHub Dispatches API:

```bash
curl -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: token YOUR_PERSONAL_ACCESS_TOKEN" \
  https://api.github.com/repos/OWNER/REPO/dispatches \
  -d '{
    "event_type": "glens-run",
    "client_payload": {
      "image_urls": ["https://example.com/shoe1.jpg", "https://example.com/bag2.jpg"],
      "hf_token": "hf_xxxxxxxx",
      "hf_repo": "yourname/ugc-dropship",
      "hf_path": "assets/glens-responses",
      "hf_repo_type": "dataset"
    }
  }'
```

- `event_type` **must** be exactly `glens-run`.
- All `client_payload` fields are optional; the workflow falls back to defaults if omitted.
- If `image_urls` is omitted, the runner expects images in the `./images/` folder.

### 3. Local Execution
Best for development, debugging, or running on your own infrastructure.

```bash
# 1. System deps (Ubuntu/Debian)
sudo apt-get update
sudo apt-get install -y ffmpeg libnss3 libxss1 libasound2t64 libatk1.0-0 \
  libatk-bridge2.0-0 libcups2 libgbm1 libxkbcommon-x11-0 libxcomposite1 \
  libxrandr2 libpango-1.0-0 libcairo2 libxdamage1

# 2. Node deps
npm install cloakbrowser puppeteer puppeteer-core mmdb-lib formdata-node sharp

# 3. Install stealth Chromium
npx cloakbrowser install

# 4. Add images (local mode)
mkdir -p images
# ... copy your images here ...

# 5. Configure & run
export GLENS_MODE=lens
export GLENS_BATCH_SIZE=3
export GLENS_RECORDING=true
# export GLENS_IMAGE_URLS='["https://i.imgur.com/abc.jpg"]'  # optional URL mode
node glens.js
```

---

## Configuration

All settings are controlled via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `GLENS_MODE` | `lens` | `lens` (Google Lens) or `standard` (google.com/ai) |
| `GLENS_BATCH_SIZE` | `3` | Images processed in parallel per batch |
| `GLENS_BATCH_DELAY_MS` | `2000` | Delay between batches |
| `GLENS_SEARCH_DELAY_MS` | `200` | Delay between individual searches (non-batch) |
| `GLENS_NAV_TIMEOUT` | `30000` | Page navigation timeout (ms) |
| `GLENS_RESP_TIMEOUT` | `30000` | Response wait timeout (ms) |
| `GLENS_JSON_IDLE_MS` | `800` | How long JSON must be stable before considered complete |
| `GLENS_UPLOAD_TIMEOUT` | `10000` | Image upload timeout (ms) |
| `GLENS_UPLOAD_RETRIES` | `2` | Upload retry attempts per provider |
| `GLENS_NAV_RETRIES` | `2` | Navigation retry attempts |
| `GLENS_MAX_RETRIES` | `1` | Max image-level retries |
| `GLENS_BACKOFF_BASE_MS` | `300` | Base retry backoff |
| `GLENS_BACKOFF_MAX_MS` | `3000` | Max retry backoff |
| `GLENS_MAX_DIM` | `1024` | Max image dimension for resize |
| `GLENS_QUALITY` | `85` | JPEG quality for resized images |
| `GLENS_SCREENSHOTS` | `false` | Enable screenshots |
| `GLENS_SCREENSHOTS_ERROR_ONLY` | `true` | Only screenshot on errors |
| `GLENS_RECORDING` | `true` | Enable session screen recording |
| `GLENS_RECORDING_FPS` | `12` | Recording framerate |
| `GLENS_RECORDING_QUALITY` | `60` | JPEG quality for frames |
| `GLENS_RECORDING_RES` | `1280x720` | Recording resolution |
| `GLENS_RECORDING_OVERLAY_COLOR` | `#FF0000` | Overlay text color |
| `GLENS_RECORDING_OVERLAY_SIZE` | `16` | Overlay font size |
| `GLENS_OUTPUT_DIR` | `./output` | Output directory |
| `GLENS_SKIP_READY_CHECK` | `true` | Skip image ready check for speed |
| `GLENS_FAST_CLOSE` | `true` | Close browser asynchronously |
| `GLENS_NAV_WAIT` | `domcontentloaded` | Navigation wait condition |
| `GLENS_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `GLENS_IMAGE_URLS` | `""` | JSON array of image URLs to process instead of local files |
| `GLENS_RUN_ID` | `""` | Optional CI run ID (auto-set in GitHub Actions) |

---

## Output Structure

```
output/
├── responses/
│   └── ai_responses.json          # Full results + metadata
├── successful/
│   ├── a1b2c3....json             # Individual successful results (MD5 hash filenames)
│   └── ...
├── screenshots/
│   ├── lens_1_xxx_loaded.png     # Per-image screenshots (if enabled)
│   ├── lens_1_xxx_lens.png
│   └── ...
└── recordings/
    └── session_YYYY-MM-DD...mp4  # Compiled session video (if enabled)
```

### JSON Output Schema

```json
{
  "timestamp": "2026-06-24T17:32:41.147Z",
  "totalImages": 11,
  "successful": 11,
  "failed": 0,
  "withValidJson": 10,
  "blocked": 0,
  "skippedBlocked": 0,
  "rateLimited": 0,
  "mode": "lens",
  "config": { ... },
  "system": { ... },
  "results": [
    {
      "filename": "image.jpg",
      "originalId": "image.jpg",
      "imageUrl": "https://litter.catbox.moe/...",
      "response": "{\"products\":[...]}",
      "duration": 12345,
      "error": null,
      "timedOut": false,
      "isBlocked": false,
      "isRateLimited": false,
      "hasJson": true
    }
  ]
}
```

Each `response` contains a `products` array with:
- `title`, `brand`, `description`, `category`
- `price` (current, original, currency)
- `availability`, `sizing`
- `sources` — 5+ direct product URLs (official store → major retailers → resellers)
- `socialAppearances` — Instagram/TikTok/Pinterest posts
- `dropshipViability` — score 1-10 + reasoning + risks
- `estimatedResaleRange` — typical markup range
- `alternatives` — 2-3 cheaper/similar alternatives

---

## HuggingFace Integration

If you provide a `hf_token`, every successful JSON result is automatically uploaded to your HuggingFace repo inside the configured path. This is useful for:
- Building a persistent dataset of product analyses
- Serving results to downstream apps via the HF Hub
- Collaborating without passing GitHub artifacts around

The token is masked in GitHub Actions logs for security.

---

## How it works

### Batch Processing & Global Block Detection
Images are processed in parallel batches (default 3). If **any** image in a batch triggers a Google CAPTCHA or block page, the pipeline assumes the IP is burned and **skips all remaining batches** immediately. This prevents pointless retries and wasted runner minutes.

### Upload Providers
- **Primary:** catbox.moe (permanent, anonymous)
- **Fallback:** litterbox.catbox.moe (72h temporary, anonymous)

Both are free, require no API keys, and work from GitHub Actions runners.

### Screen Recording & Compilation
Each browser context records its own clip. When the run finishes (success, failure, or block), all clips are stitched into a single `session_*.mp4` via ffmpeg. If compilation fails, individual clips are preserved.

### JSON Extraction
The extractor isolates the AI's actual response (ignoring the prompt text), attempts balanced-brace parsing, and falls back to a first-brace-to-last-brace slice if the model hallucinates malformed JSON.

### Block Detection
The script detects CAPTCHA, rate limits, and unusual-traffic pages by scanning response text for keywords. Blocked results are flagged but **not retried** — the IP is already flagged.

---

## Troubleshooting

| Issue | Cause | Fix |
|-------|-------|-----|
| `No images found` | `images/` directory empty or wrong path; `GLENS_IMAGE_URLS` empty or malformed | Add images to `./images/`, or pass a valid JSON array to `GLENS_IMAGE_URLS` / workflow input |
| `All uploads failed` | Upload services down/changed | Already handled by catbox.moe fallback |
| `IP BLOCKED DETECTED` | Google flagged the runner IP | Wait and retry, or use a different runner/region |
| `0 JSON` | Response didn't contain valid product data | Check `ai_responses.json` raw response for errors |
| Workflow stalls after completion | ffmpeg encoding the session video | 2-minute timeout — will auto-kill if stuck |
| `SyntaxError: Unexpected token '%'` | `%%writefile` from Colab left in file | Ensure first line is `import { launch }` |
| HF upload fails | Token lacks write access or repo doesn't exist | Verify `hf_token` and `hf_repo` |

---

## Tech Stack

- **Node.js 24** + ES modules
- **Puppeteer** (via CloakBrowser) for stealth automation
- **Sharp** for image resizing
- **ffmpeg** for session video encoding
- **GitHub Actions** `ubuntu-latest` runner
- **HuggingFace Hub** for optional dataset persistence

---

## License

MIT — use at your own risk. Google Lens terms apply.
