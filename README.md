# GLENS.PI - Google Lens Product Identifier

![](./assets/banner.gif)

This system automatically scrapes Instagram posts, downloads their photos and videos, and runs an AI reviewer to keep only the best product shots. The kept images are then fed into Google Lens to identify exactly what products are shown, find where to buy them, and score their dropshipping potential — all managed through GitHub Actions with results stored in MongoDB and HuggingFace.

Two GitHub Actions workflows that automate Instagram media scraping, AI review, and product reverse-search.

| Workflow | What it does | Trigger event |
|---|---|---|
| **Orchestrator** | Downloads posts → uploads to HuggingFace → Gemini AI review → MongoDB | `orchestrator-run` |
| **GLENS** | Pulls reviewed images → Google Lens / AI lookup → extracts product JSON | `glens-run` |

---

## Required Secrets

Add these in **Settings → Secrets and variables → Actions**:

| Secret | Used by | Purpose |
|---|---|---|
| `ORCHESTRATOR_MONGODB_URI` | Orchestrator | MongoDB connection string |
| `ORCHESTRATOR_HF_TOKEN` | Orchestrator | HuggingFace write token |
| `ORCHESTRATOR_GEMINI_API_KEYS` | Orchestrator | Comma-separated Gemini keys (optional) |
| `GLENS_MONGODB_URI` | GLENS | MongoDB connection string (skip if using direct image URLs) |
| `GLENS_HF_TOKEN` | GLENS | HuggingFace read token (falls back to `ORCHESTRATOR_HF_TOKEN`) |
| `GLENS_IMGBB_API_KEY` | GLENS | imgbb API key (optional upload fallback) |

---

## Configuration

### Orchestrator

| Env Variable | Payload Key | Default | Set via | Description |
|---|---|---|---|---|
| `ORCH_MONGODB_URI` | `mongodb_uri` | — | Payload / Secret | MongoDB URI |
| `ORCH_MONGODB_DB` | `mongodb_db` | `ugc-dropship` | Payload | Database name |
| `ORCH_MONGODB_COLLECTION` | `mongodb_collection` | `scraped-posts` | Payload | Collection name |
| `ORCH_HF_TOKEN` | `hf_token` | — | Payload / Secret | HuggingFace token |
| `ORCH_HF_REPO` | `hf_repo` | `rrokutaro/ugc-dropship` | Payload | HF repo ID |
| `ORCH_HF_ASSETS_PATH` | `hf_assets_path` | `scraped-posts/assets` | Payload | Asset path in repo |
| `ORCH_BATCH_SIZE` | `batch_size` | `10` | Payload | Posts per run |
| `ORCH_DOWNLOADER_CONCURRENCY` | `downloader_concurrency` | `3` | Payload | Parallel downloads |
| `ORCH_LOG_LEVEL` | `log_level` | `info` | Payload | debug / info / warn / error |
| `ORCH_RECORDING` | `recording` | `true` | Payload | Screen record browser |
| `ORCH_RECORDING_FPS` | `recording_fps` | `12` | Payload | Recording framerate |
| `ORCH_RECORDING_QUALITY` | `recording_quality` | `60` | Payload | JPEG quality (1-100) |
| `ORCH_RECORDING_RES` | `recording_res` | `1280x800` | Payload | Recording resolution |
| `ORCH_REVIEW_ENABLED` | `review_enabled` | `true` | Payload | Enable Gemini review |
| `ORCH_REVIEW_FETCH_LIMIT` | `review_fetch_limit` | `60` | Payload | Max images to review |
| `ORCH_REVIEW_MAX_ROWS` | `review_max_rows` | `4` | Payload | Collage rows |
| `ORCH_REVIEW_MAX_COLS` | `review_max_cols` | `5` | Payload | Collage columns |
| `ORCH_REVIEW_CELL_ASPECT_RATIO` | `review_cell_aspect_ratio` | `0.75` | Payload | Cell ratio (0 = natural) |
| `ORCH_REVIEW_COLLAGE_GUTTER` | `review_collage_gutter` | `8` | Payload | Gutter px |
| `ORCH_GEMINI_MODEL` | `gemini_model` | `gemini-3.5-flash-lite` | Payload | Gemini model |
| `ORCH_GEMINI_API_KEYS` | `gemini_api_keys` | — | Payload / Secret | Comma-separated keys |
| `ORCH_REVIEW_SAVE_COLLAGES` | `review_save_collages` | `false` | Payload | Save review JPEGs |

**Advanced — edit workflow env block:**
`ORCH_REVIEW_ROW_HEIGHT` (480), `ORCH_REVIEW_COLLAGE_WIDTH` (2200), `ORCH_REVIEW_JPEG_QUALITY` (82), `ORCH_GEMINI_QUOTA_COLLECTION` (gemini_quotas), `ORCH_GEMINI_RATE_LIMIT_COOLDOWN_MS` (600000), `ORCH_GEMINI_LOCK_STALE_MS` (300000), `ORCH_GEMINI_MAX_RETRIES` (3), `ORCH_RECORDING_OVERLAY_COLOR` (#00CFFF), `ORCH_RECORDING_OVERLAY_SIZE` (14), `ORCH_RUN_ID` (auto).

### GLENS

| Env Variable | Payload Key | Default | Set via | Description |
|---|---|---|---|---|
| `GLENS_MONGODB_URI` | `mongodb_uri` | — | Payload / Secret | MongoDB URI |
| `GLENS_MONGODB_DB` | `mongodb_db` | `ugc-dropship` | Payload | Database name |
| `GLENS_MONGODB_COLLECTION` | `mongodb_collection` | `scraped-posts` | Payload | Collection name |
| `GLENS_MONGODB_LIMIT` | `mongodb_limit` | `20` | Payload | Files to process per run |
| `GLENS_HF_TOKEN` | `hf_token` | — | Payload / Secret | HuggingFace read token |
| `GLENS_IMGBB_API_KEY` | `imgbb_api_key` | — | Payload / Secret | imgbb fallback key |
| `GLENS_IMAGE_URLS` | `image_urls` | — | Payload | JSON array of URLs (bypass MongoDB) |

**Advanced — edit workflow env block:**
`GLENS_MODE` (lens), `GLENS_BATCH_SIZE` (3), `GLENS_BATCH_DELAY_MS` (2000), `GLENS_SEARCH_DELAY_MS` (200), `GLENS_NAV_TIMEOUT` (30000), `GLENS_RESP_TIMEOUT` (30000), `GLENS_JSON_IDLE_MS` (800), `GLENS_UPLOAD_TIMEOUT` (10000), `GLENS_LITTERBOX_TIME` (1h), `GLENS_IMGBB_EXPIRATION_SECONDS` (600), `GLENS_UPLOAD_RETRIES` (2), `GLENS_NAV_RETRIES` (2), `GLENS_MAX_RETRIES` (1), `GLENS_BACKOFF_BASE_MS` (300), `GLENS_BACKOFF_MAX_MS` (3000), `GLENS_MAX_DIM` (1024), `GLENS_QUALITY` (85), `GLENS_SCREENSHOTS` (false), `GLENS_SCREENSHOTS_ERROR_ONLY` (true), `GLENS_RECORDING` (true), `GLENS_RECORDING_FPS` (12), `GLENS_RECORDING_QUALITY` (60), `GLENS_RECORDING_RES` (1280x720), `GLENS_RECORDING_OVERLAY_COLOR` (#FF0000), `GLENS_RECORDING_OVERLAY_SIZE` (16), `GLENS_OUTPUT_DIR` (./output), `GLENS_SKIP_READY_CHECK` (true), `GLENS_FAST_CLOSE` (true), `GLENS_NAV_WAIT` (domcontentloaded), `GLENS_LOG_LEVEL` (info), `GLENS_MONGODB_LOCK_TTL_MS` (90000), `GLENS_MONGODB_HEARTBEAT_MS` (30000), `GLENS_RUN_ID` (auto).

---

## Launch Methods

### 1. GitHub UI
**Actions** → Select workflow → **Run workflow** → fill inputs.

### 2. GitHub CLI
```bash
# Orchestrator
gh workflow run orchestrator.yml -f batch_size=20 -f review_fetch_limit=30

# GLENS
gh workflow run glens.yml -f mongodb_limit=10
```

### 3. API / cron-job.org

Create a GitHub PAT with **`repo`** scope.

**Orchestrator** — every key from the Payload column above works in `client_payload`:
```bash
curl -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer YOUR_PAT" \
  https://api.github.com/repos/OWNER/REPO/dispatches \
  -d '{
    "event_type": "orchestrator-run",
    "client_payload": {
      "batch_size": "10",
      "downloader_concurrency": "3",
      "review_fetch_limit": "60",
      "review_enabled": "true",
      "gemini_api_keys": "key1,key2",
      "recording": "true"
    }
  }'
```

**GLENS** — same pattern:
```bash
curl -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer YOUR_PAT" \
  https://api.github.com/repos/OWNER/REPO/dispatches \
  -d '{
    "event_type": "glens-run",
    "client_payload": {
      "mongodb_limit": "20",
      "imgbb_api_key": "optional",
      "image_urls": "[\"https://i.imgur.com/abc.jpg\"]"
    }
  }'
```

**cron-job.org setup**
- **URL:** `https://api.github.com/repos/OWNER/REPO/dispatches`
- **Method:** `POST`
- **Headers:**
  - `Accept: application/vnd.github+json`
  - `Authorization: Bearer YOUR_PAT`
- **Body:** `{"event_type":"orchestrator-run","client_payload":{"batch_size":"10"}}`
- **Schedule:** e.g. every 6 hours

---

## How It Works

```
Instagram Post IDs (data.json)
        ↓
[Orchestrator] → Download → HuggingFace → Gemini Review → MongoDB
        ↓
[GLENS] ← Pull reviewed images from MongoDB
        ↓
Google Lens / AI → Product JSON → MongoDB + Artifacts
```

---

## Notes

- Place workflow files in `.github/workflows/orchestrator.yml` and `.github/workflows/glens.yml`.
- Both use Puppeteer via CloakBrowser on `ubuntu-latest`.
- Artifacts are retained for **1 day**.
- GLENS can run standalone without MongoDB by passing `image_urls` in the payload.
- Variables marked **Payload** can be passed via API/UI. Variables marked **Workflow env** require editing the `env:` block in the YAML (or fork) to change their defaults. 
