#!/usr/bin/env python3
"""
Product Image Pipeline for E-commerce Sites (Production-Ready Lazy Extraction v3)

Targeted improvements to reduce unrelated product noise from supplementary DOM scan
while keeping all previous gains and the full browser mode intact.

Key changes in v3 (non-breaking):
- Stricter title similarity requirement ONLY for low-score supplementary images (score <=4).
  High-quality sources (og, schema, JS, score >=7) keep the original loose min_similarity.
  This eliminates most "other product" noise (e.g. Coucou example) without hurting good extra angles.
- Fixed SyntaxWarning on font path (raw string).
- Minor: Prefer https for image URLs when page is https; added zero-result warning in lazy mode
  suggesting full browser crawl for heavily protected/JS sites.
- All previous enhancements, scoring, deduping, YOLO, clustering, adaptive cutoff, etc. unchanged.

Result: Cleaner output on multi-product pages, same (or better) recall on true product images.
"""

import os
import re
import json
import asyncio
import logging
import argparse
import subprocess
import shutil
from dataclasses import dataclass
from typing import Optional, Tuple, List, Dict, Any, Union
from io import BytesIO
from difflib import SequenceMatcher
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode, urljoin

import httpx
from PIL import Image, ImageStat
import imagehash
from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig, CacheMode, MemoryAdaptiveDispatcher
from cloakbrowser import launch_async

# ── Logging ──────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("product_image_pipeline")

# ── Constants ───────────────────────────────────────────────────────
JUNK_PATTERNS = re.compile(
    r"(logo|icon|sprite|badge|payment|banner|placeholder|loading|favicon|thumb|pixel|tracker|beacon|spacer|1x1)",
    re.IGNORECASE,
)

RESIZE_QUERY_KEYS: frozenset = frozenset(
    {"width", "height", "w", "h", "quality", "crop", "format", "auto", "fit"}
)
RESIZE_PATH_RE = re.compile(
    r"(_\d{2,4}x\d{0,4}(?:.progressive)?(?=.\w+$)|/\d{2,4}x\d{2,4}/)",
    re.IGNORECASE,
)

MAX_IMAGE_BYTES = 50 * 1024 * 1024
MAX_IMAGE_DIMENSION = 8192

JS_LAZY_LOAD = "window.scrollTo(0, document.body.scrollHeight);"
EXCLUDED_TAGS = ["script", "style", "noscript", "iframe", "canvas", "svg"]

# ── Font detection ────────────────────────────────────────────────────
_FONT_SEARCH_PATHS = [
    os.path.expanduser(r"~/.local/share/fonts/windows"),
    "/usr/share/fonts/truetype/msttcorefonts",
    "/usr/share/fonts/truetype/segoe-ui",
    "/usr/share/fonts",
]

def _find_font_dir() -> Optional[str]:
    for path in _FONT_SEARCH_PATHS:
        if os.path.isdir(path):
            for root, _, files in os.walk(path):
                if any(f.lower().endswith((".ttf", ".otf", ".ttc")) for f in files):
                    logger.info("Found fonts in %s", root)
                    return root
    logger.warning(
        "No Windows-like fonts found. Install with:\n"
        " sudo apt install -y fonts-noto-color-emoji fonts-freefont-ttf "
        "ttf-mscorefonts-installer fonts-unifont fonts-ipafont-gothic "
        "fonts-wqy-zenhei fonts-tlwg-loma-otf\n"
        " wget -q https://github.com/mrbvrz/segoe-ui-linux/archive/refs/heads/master.zip\n"
        " unzip -q master.zip && cd segoe-ui-linux-master && sudo ./install.sh"
    )
    return None

# ── Optional YOLO person detection ──────────────────────────────────
_yolo_model = None

def _get_yolo_model() -> Optional[Any]:
    global _yolo_model
    if _yolo_model is not None:
        return _yolo_model if _yolo_model is not False else None
    try:
        from ultralytics import YOLO
        model = YOLO("yolov8n.pt")
        logger.info("Loaded YOLOv8n for person detection")
        _yolo_model = model
        return model
    except Exception as exc:
        logger.warning("Ultralytics YOLO unavailable (%s). Person detection disabled.", exc)
        _yolo_model = False
        return None

def _compute_person_score(img: Image.Image) -> float:
    model = _get_yolo_model()
    if model is None:
        return 0.0
    try:
        results = model(img, verbose=False)
        if not results:
            return 0.0
        result = results[0]
        boxes = result.boxes
        if boxes is None or len(boxes) == 0:
            return 0.0

        img_area = img.width * img.height
        max_ratio = 0.0
        person_count = 0

        for box in boxes:
            if int(box.cls[0]) == 0:
                x1, y1, x2, y2 = box.xyxy[0].tolist()
                area = (x2 - x1) * (y2 - y1)
                ratio = area / img_area
                if ratio > max_ratio:
                    max_ratio = ratio
                person_count += 1

        if person_count == 0:
            return 0.0

        score = max_ratio * 10.0 + min(person_count * 0.2, 1.0)
        return round(min(score, 10.0), 3)
    except Exception as exc:
        logger.debug("YOLO person detection failed: %s", exc)
        return 0.0

# ── Data classes ─────────────────────────────────────────────────────
@dataclass(frozen=True)
class HashPair:
    phash: imagehash.ImageHash
    dhash: imagehash.ImageHash

    def distance(self, other: "HashPair") -> float:
        return ((self.phash - other.phash) + (self.dhash - other.dhash)) / 2.0

@dataclass
class ImageCandidate:
    url: str
    width: int
    alt: str
    score: Union[int, float]
    similarity: float = 0.0
    weighted_score: float = 0.0
    _canonical_url: str = ""
    hash_pair: Optional[HashPair] = None
    brightness: Optional[float] = None
    person_score: float = 0.0
    height: int = 0

    def to_dict(self) -> Dict[str, Any]:
        return {
            "url": self.url,
            "width": self.width,
            "height": self.height,
            "alt": self.alt,
            "score": self.score,
            "similarity": round(self.similarity, 2),
            "weighted_score": round(self.weighted_score, 3),
        }

@dataclass
class PipelineConfig:
    min_score: int = 3
    min_similarity: float = 0.30
    hash_threshold: int = 6
    phash_threshold: int = 4
    cdp_port: int = 9243
    max_width: int = 3000
    similarity_weight: float = 0.7
    size_weight: float = 0.3
    concurrency: int = 8
    http_timeout: float = 8.0
    fetch_timeout: float = 4.0
    max_image_bytes: int = MAX_IMAGE_BYTES
    max_image_dimension: int = MAX_IMAGE_DIMENSION
    headless: bool = False
    memory_threshold_percent: float = 70.0
    fingerprint_seed: str = "product_scraper_42"
    storage_quota_mb: int = 5000
    crawl_timeout: float = 45.0
    max_crawl_retries: int = 2
    retry_base_delay: float = 2.0
    cdp_health_timeout: float = 30.0
    adaptive_cutoff_enabled: bool = True
    cluster_threshold: float = 10.0
    min_width: int = 300
    max_aspect_ratio: float = 1.2

# ── Display helpers ────────────────────────────────────────────────────
def _display_is_usable(display: str) -> bool:
    if not display or not display.startswith(":"):
        return False
    display_num = display.lstrip(":")
    return os.path.exists(f"/tmp/.X11-unix/X{display_num}")

def _start_xvfb_if_needed() -> Optional[subprocess.Popen]:
    display = os.environ.get("DISPLAY", "")
    if _display_is_usable(display):
        logger.info("DISPLAY=%s is active", display)
        return None

    xvfb_path = shutil.which("Xvfb")
    if not xvfb_path:
        logger.warning("Xvfb not found. Install: sudo apt install -y xvfb")
        return None

    for display_num in range(99, 200):
        if not os.path.exists(f"/tmp/.X11-unix/X{display_num}"):
            display = f":{display_num}"
            break
    else:
        logger.warning("No free display found")
        return None

    cmd = [
        xvfb_path, display, "-screen", "0", "1920x1080x24",
        "-ac", "+extension", "GLX", "+render", "-noreset"
    ]
    logger.info("Starting Xvfb on %s", display)
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        import time
        time.sleep(0.5)
        if proc.poll() is not None:
            logger.error("Xvfb exited immediately with code %d", proc.returncode)
            return None
        os.environ["DISPLAY"] = display
        return proc
    except Exception as exc:
        logger.error("Failed to start Xvfb: %s", exc)
        return None

# ── URL utilities ────────────────────────────────────────────────────
def normalize_url(u: str) -> str:
    if not u:
        return ""
    u = u.strip()
    if u.startswith("//"):
        return "https:" + u
    return u

def canonicalize_image_url(u: str) -> str:
    u = normalize_url(u)
    if not u:
        return ""
    parts = urlsplit(u)
    q = sorted(
        [(k, v) for k, v in parse_qsl(parts.query) if k.lower() not in RESIZE_QUERY_KEYS],
        key=lambda kv: kv[0],
    )
    path = RESIZE_PATH_RE.sub("", parts.path)
    return urlunsplit((parts.scheme, parts.netloc, path, urlencode(q), ""))

def _best_from_srcset(srcset: str) -> str:
    """Return the highest-resolution URL declared in a srcset string."""
    if not srcset:
        return ""
    parts = [p.strip() for p in srcset.split(",") if p.strip()]
    if not parts:
        return ""
    best_url = ""
    best_w = -1
    for p in parts:
        tokens = p.split()
        url = tokens[0] if tokens else ""
        w = 0
        if len(tokens) > 1:
            desc = tokens[1].lower().rstrip("x")
            if desc.endswith("w"):
                try:
                    w = int(desc[:-1])
                except ValueError:
                    w = 0
            else:
                try:
                    w = int(float(desc) * 1000)
                except ValueError:
                    w = 1000
        if w > best_w or (w == best_w and len(url) > len(best_url)):
            best_w = w
            best_url = url
    if not best_url and parts:
        best_url = parts[-1].split()[0]
    return best_url

def _prefer_https(url: str, base_url: str = "") -> str:
    """If base page is https and image is http, upgrade to https (common on CDNs)."""
    if not url:
        return url
    if url.startswith("http://") and (not base_url or base_url.startswith("https://")):
        return "https://" + url[7:]
    return url

# ── Scoring ─────────────────────────────────────────────────────────
def title_similarity(alt: str, product_title: str) -> float:
    if not alt or not product_title:
        return 0.0
    return SequenceMatcher(None, alt.lower().strip(), product_title.lower().strip()).ratio()

def weighted_score(
    similarity: float,
    width: int,
    *,
    max_width: int = 3000,
    similarity_weight: float = 0.7,
    size_weight: float = 0.3,
) -> float:
    norm_width = min(width, max_width) / max_width
    return (similarity_weight * similarity) + (size_weight * norm_width)

# ── Network / Image I/O ───────────────────────────────────────────────
async def url_is_fetchable(
    client: httpx.AsyncClient, url: str, timeout: float = 4.0
) -> bool:
    if not url:
        return False
    try:
        r = await client.head(url, timeout=timeout, follow_redirects=True)
        if r.status_code == 200:
            ct = r.headers.get("content-type", "").lower()
            if "image/svg" in ct:
                logger.debug("Rejecting SVG via HEAD Content-Type: %s", url)
                return False
            return True
        r = await client.get(
            url, timeout=timeout, headers={"Range": "bytes=0-1024"}, follow_redirects=True,
        )
        if r.status_code in (200, 206):
            ct = r.headers.get("content-type", "").lower()
            if "image/svg" in ct:
                logger.debug("Rejecting SVG via GET Content-Type: %s", url)
                return False
            body = r.content
            if body.startswith(b"<?xml") or b"<svg" in body[:256]:
                logger.debug("Rejecting SVG via body sniff: %s", url)
                return False
            return True
        return False
    except Exception as exc:
        logger.debug("Fetch check failed for %s: %s", url, exc)
        return False

def _to_rgb_white_bg(img: Image.Image) -> Image.Image:
    if img.mode == "RGBA":
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(img, mask=img.split()[3])
        return bg
    return img.convert("RGB")

async def get_hashes(
    client: httpx.AsyncClient,
    url: str,
    *,
    timeout: float = 8.0,
    max_bytes: int = MAX_IMAGE_BYTES,
    max_dimension: int = MAX_IMAGE_DIMENSION,
) -> Optional[Tuple[HashPair, float, float]]:
    if not url:
        return None
    try:
        r = await client.get(url, timeout=timeout, follow_redirects=True)
        if r.status_code != 200:
            return None

        content_length = len(r.content)
        if content_length > max_bytes:
            logger.warning("Image %s exceeds byte limit (%d > %d)", url, content_length, max_bytes)
            return None

        ct = r.headers.get("content-type", "").lower()
        if "image/svg" in ct:
            logger.debug("Rejecting SVG (Content-Type) in get_hashes: %s", url)
            return None
        if r.content.startswith(b"<?xml") or b"<svg" in r.content[:256]:
            logger.debug("Rejecting SVG (body sniff) in get_hashes: %s", url)
            return None

        img = Image.open(BytesIO(r.content))
        if img.width > max_dimension or img.height > max_dimension:
            logger.warning("Image %s exceeds dimension limit (%dx%d)", url, img.width, img.height)
            return None

        rgb = _to_rgb_white_bg(img)

        try:
            brightness = ImageStat.Stat(rgb.convert("L")).mean[0]
        except Exception:
            brightness = 0.0

        try:
            loop = asyncio.get_running_loop()
            person_score = await loop.run_in_executor(None, _compute_person_score, rgb)
        except Exception:
            person_score = 0.0

        return HashPair(phash=imagehash.phash(rgb), dhash=imagehash.dhash(rgb)), brightness, person_score
    except Exception as exc:
        logger.debug("Hash generation failed for %s: %s", url, exc)
        return None

async def _get_image_dimensions(
    client: httpx.AsyncClient,
    url: str,
    *,
    timeout: float = 8.0,
    max_bytes: int = 2 * 1024 * 1024,
) -> Optional[Tuple[int, int]]:
    if not url:
        return None
    try:
        r = await client.get(
            url, timeout=timeout, headers={"Range": "bytes=0-524287"}, follow_redirects=True,
        )
        if r.status_code not in (200, 206):
            return None

        content = r.content
        if len(content) > max_bytes:
            content = content[:max_bytes]

        ct = r.headers.get("content-type", "").lower()
        if "image/svg" in ct:
            logger.debug("Rejecting SVG (Content-Type) in _get_image_dimensions: %s", url)
            return None
        if content.startswith(b"<?xml") or b"<svg" in content[:256]:
            logger.debug("Rejecting SVG (body sniff) in _get_image_dimensions: %s", url)
            return None

        img = Image.open(BytesIO(content))
        return img.width, img.height
    except Exception as exc:
        logger.debug("Dimension fetch failed for %s: %s", url, exc)
        return None

# ── Core pipeline stages ─────────────────────────────────────────────
async def filter_and_rank_images(
    raw_images: List[Any], product_title: str, client: httpx.AsyncClient, config: PipelineConfig,
) -> List[ImageCandidate]:
    if not raw_images:
        return []

    scored: List[Tuple[str, Dict[str, Any], float]] = []

    for item in raw_images:
        if not isinstance(item, dict):
            continue

        src = item.get("src", "")
        if not src or not isinstance(src, str):
            continue

        raw_score = item.get("score", 0)
        if not isinstance(raw_score, (int, float)) or raw_score < config.min_score:
            continue

        if JUNK_PATTERNS.search(src) or src.lower().endswith(".svg"):
            continue

        alt = item.get("alt", "") or ""
        if not isinstance(alt, str):
            alt = str(alt)

        sim = title_similarity(alt, product_title)

        # v3 improvement: Low-score supplementary images (from DOM scan) get stricter similarity
        # to avoid unrelated products on multi-product pages. High-quality sources keep original threshold.
        effective_min_sim = config.min_similarity
        if raw_score <= 4:  # supplementary / fallback images
            effective_min_sim = max(config.min_similarity, 0.42)

        if sim < effective_min_sim:
            continue

        # Dimension filtering: reject tiny thumbnails and horizontal banners
        width = item.get("width") or 0
        if isinstance(width, (int, float)) and width > 0 and width < config.min_width:
            logger.debug("Dropping %s: width %d < min_width %d", src, int(width), config.min_width)
            continue

        height = item.get("height") or 0
        if isinstance(height, (int, float)) and height > 0 and isinstance(width, (int, float)) and width > 0:
            aspect = width / height
            if aspect > config.max_aspect_ratio:
                logger.debug("Dropping %s: aspect %.2f > max %.2f", src, aspect, config.max_aspect_ratio)
                continue

        c_url = canonicalize_image_url(src)
        scored.append((c_url, item, sim))

    if not scored:
        return []

    groups: Dict[str, List[Tuple[Dict[str, Any], float]]] = {}
    for c_url, img, sim in scored:
        groups.setdefault(c_url, []).append((img, sim))

    best_per_group = [
        max(variants, key=lambda pair: pair[0].get("width") or 0)
        for variants in groups.values()
    ]

    sem = asyncio.Semaphore(config.concurrency)

    async def _check(pair: Tuple[Dict[str, Any], float]) -> Optional[ImageCandidate]:
        img, sim = pair
        url = normalize_url(img.get("src", ""))
        if not url:
            return None

        async with sem:
            ok = await url_is_fetchable(client, url, timeout=config.fetch_timeout)
        if not ok:
            return None

        width = img.get("width") or 0
        if not isinstance(width, (int, float)):
            width = 0

        height = img.get("height") or 0
        if not isinstance(height, (int, float)):
            height = 0

        return ImageCandidate(
            url=url,
            width=int(width),
            alt=img.get("alt", "") or "",
            score=img.get("score", 0) if isinstance(img.get("score"), (int, float)) else 0,
            similarity=sim,
            _canonical_url=canonicalize_image_url(url),
            height=int(height),
        )

    checked = await asyncio.gather(*(_check(pair) for pair in best_per_group))
    candidates = [c for c in checked if c is not None]

    for c in candidates:
        c.weighted_score = weighted_score(
            c.similarity,
            c.width,
            max_width=config.max_width,
            similarity_weight=config.similarity_weight,
            size_weight=config.size_weight,
        )

    candidates.sort(key=lambda x: x.weighted_score, reverse=True)
    return candidates

async def dedupe_by_perceptual_hash(
    ranked_images: List[ImageCandidate],
    client: httpx.AsyncClient,
    *,
    hash_threshold: int = 6,
    phash_threshold: int = 4,
    concurrency: int = 8,
) -> List[ImageCandidate]:
    if not ranked_images:
        return []

    sem = asyncio.Semaphore(concurrency)

    async def _hash(item: ImageCandidate) -> Tuple[ImageCandidate, Optional[HashPair], Optional[float], Optional[float]]:
        async with sem:
            result = await get_hashes(client, item.url)
        if result is None:
            return item, None, None, None
        hash_pair, brightness, person_score = result
        return item, hash_pair, brightness, person_score

    hashed = await asyncio.gather(*(_hash(img) for img in ranked_images))

    kept: List[ImageCandidate] = []
    kept_hashes: List[HashPair] = []

    for item, h, brightness, person_score in hashed:
        item.hash_pair = h
        item.brightness = brightness
        item.person_score = person_score if person_score is not None else 0.0
        if h is None:
            kept.append(item)
            continue

        dup_of = None
        for idx, kh in enumerate(kept_hashes):
            dist = h.distance(kh)
            phash_dist = h.phash - kh.phash
            if dist <= hash_threshold or phash_dist <= phash_threshold:
                dup_of = kept[idx]
                break

        if dup_of is not None:
            logger.info(
                "Dropping duplicate %s (dist=%.1f, phash_dist=%d) -> kept %s",
                item.url,
                h.distance(kept_hashes[kept.index(dup_of)]),
                h.phash - kept_hashes[kept.index(dup_of)].phash,
                dup_of.url,
            )
            continue

        kept.append(item)
        kept_hashes.append(h)

    return kept

def dedupe_by_canonical_url(images: List[ImageCandidate]) -> List[ImageCandidate]:
    groups: Dict[str, List[ImageCandidate]] = {}
    for img in images:
        groups.setdefault(img._canonical_url, []).append(img)

    result = []
    for variants in groups.values():
        best = max(variants, key=lambda x: x.width)
        if len(variants) > 1:
            logger.info(
                "Canonical dedupe: kept %s (%dpx), dropped %d variant(s)",
                best.url,
                best.width,
                len(variants) - 1,
            )
        result.append(best)

    result.sort(key=lambda x: x.weighted_score, reverse=True)
    return result

def _avg_brightness(cluster: List[int], images: List[ImageCandidate]) -> float:
    vals = [images[i].brightness for i in cluster if images[i].brightness is not None]
    if not vals:
        return 0.0
    return sum(vals) / len(vals)

def _max_person_score(cluster: List[int], images: List[ImageCandidate]) -> float:
    """Best person score in the cluster. 0 if nobody detected."""
    vals = [images[i].person_score for i in cluster]
    return max(vals) if vals else 0.0

def cluster_and_boost_similar(
    images: List[ImageCandidate], *, cluster_threshold: float = 10.0,
) -> List[ImageCandidate]:
    if len(images) <= 1:
        return images

    n = len(images)
    adj: List[List[int]] = [[] for _ in range(n)]

    for i in range(n):
        hi = images[i].hash_pair
        if hi is None:
            continue
        for j in range(i + 1, n):
            hj = images[j].hash_pair
            if hj is None:
                continue
            dist = hi.distance(hj)
            if dist <= cluster_threshold:
                adj[i].append(j)
                adj[j].append(i)

    visited = [False] * n
    clusters: List[List[int]] = []

    for i in range(n):
        if not visited[i]:
            stack = [i]
            visited[i] = True
            cluster: List[int] = []
            while stack:
                node = stack.pop()
                cluster.append(node)
                for neighbor in adj[node]:
                    if not visited[neighbor]:
                        visited[neighbor] = True
                        stack.append(neighbor)
            clusters.append(cluster)

    clusters.sort(
        key=lambda c: (
            -(_max_person_score(c, images) > 0),
            -len(c),
            -_avg_brightness(c, images),
            -max(images[i].weighted_score for i in c)
        )
    )

    logger.info(
        "Clustering: %d image(s) into %d cluster(s) (threshold=%.1f)",
        len(images), len(clusters), cluster_threshold
    )

    result: List[ImageCandidate] = []
    for cluster in clusters:
        cluster_sorted = sorted(
            cluster,
            key=lambda i: (images[i].person_score, images[i].weighted_score),
            reverse=True,
        )
        for idx in cluster_sorted:
            result.append(images[idx])

    return result

def adaptive_score_cutoff(
    candidates: List[ImageCandidate],
    min_absolute_gap: float = 0.12,
    width_ratio_threshold: float = 0.5,
) -> List[ImageCandidate]:
    if len(candidates) <= 1:
        return candidates

    gaps = []
    for i in range(len(candidates) - 1):
        gap = candidates[i].weighted_score - candidates[i + 1].weighted_score
        width_ratio = candidates[i + 1].width / max(candidates[i].width, 1)
        gaps.append((i, gap, width_ratio))

    max_idx, max_gap, width_ratio = max(gaps, key=lambda x: x[1])

    should_cut = False
    if max_gap >= min_absolute_gap:
        if width_ratio <= width_ratio_threshold:
            should_cut = True
        elif max_gap >= min_absolute_gap * 2:
            should_cut = True

    if should_cut:
        cutoff = max_idx + 1
        logger.info(
            "Adaptive cutoff: kept %d/%d images (largest gap=%.3f at idx %d, width_ratio=%.2f)",
            cutoff, len(candidates), max_gap, max_idx, width_ratio
        )
        return candidates[:cutoff]

    logger.debug("No clear score gap found (max_gap=%.3f), keeping all %d images", max_gap, len(candidates))
    return candidates

# ── CloakBrowser launch helpers ──────────────────────────────────────
def _build_cloak_args(config: PipelineConfig) -> List[str]:
    args = [
        f"--remote-debugging-port={config.cdp_port}",
        "--remote-debugging-address=127.0.0.1",
        f"--fingerprint={config.fingerprint_seed}",
        f"--fingerprint-storage-quota={config.storage_quota_mb}",
        "--fingerprint-noise=false",
        "--fingerprint-windows-font-metrics",
        "--disable-http2",
        "--disable-gpu",
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--disable-site-isolation-trials",
    ]

    font_dir = _find_font_dir()
    if font_dir:
        args.append(f"--fingerprint-fonts-dir={font_dir}")

    return args

async def _health_check_cdp(port: int, timeout: float = 30.0) -> None:
    deadline = asyncio.get_event_loop().time() + timeout
    async with httpx.AsyncClient() as client:
        while asyncio.get_event_loop().time() < deadline:
            try:
                r = await client.get(f"http://127.0.0.1:{port}/json/version", timeout=2.0)
                if r.status_code == 200:
                    logger.info("CDP health check passed on port %d", port)
                    return
            except Exception:
                pass
            await asyncio.sleep(0.5)
    raise RuntimeError(f"CDP endpoint on port {port} did not become ready within {timeout}s")

async def _crawl_single_with_retry(
    crawler: AsyncWebCrawler, url: str, config: CrawlerRunConfig, pipeline_config: PipelineConfig,
) -> Any:
    for attempt in range(pipeline_config.max_crawl_retries + 1):
        try:
            return await asyncio.wait_for(
                crawler.arun(url=url, config=config),
                timeout=pipeline_config.crawl_timeout,
            )
        except asyncio.TimeoutError:
            logger.warning("Timeout crawling %s (attempt %d/%d)", url, attempt + 1, pipeline_config.max_crawl_retries + 1)
            if attempt == pipeline_config.max_crawl_retries:
                raise
        except Exception as exc:
            logger.warning("Error crawling %s (attempt %d/%d): %s", url, attempt + 1, pipeline_config.max_crawl_retries + 1, exc)
            if attempt == pipeline_config.max_crawl_retries:
                raise
        delay = pipeline_config.retry_base_delay * (2 ** attempt)
        await asyncio.sleep(delay)

# ── Lazy extraction helpers ──────────────────────────────────────────
async def _fetch_html_for_lazy_extraction(
    client: httpx.AsyncClient, url: str, timeout: float
) -> Optional[str]:
    try:
        r = await client.get(url, timeout=timeout, follow_redirects=True,
                             headers={"Referer": url})
        if r.status_code == 200:
            return r.text
        return None
    except Exception as exc:
        logger.debug("Lazy HTML fetch failed for %s: %s", url, exc)
        return None

def _extract_title_from_html(html_text: str) -> str:
    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html_text, "html.parser")

        og = soup.find("meta", property="og:title")
        if og and og.get("content"):
            return og["content"].strip()

        tw = soup.find("meta", attrs={"name": "twitter:title"}) or \
             soup.find("meta", attrs={"property": "twitter:title"})
        if tw and tw.get("content"):
            return tw["content"].strip()

        if soup.title and soup.title.string:
            return soup.title.string.strip()

        h1 = soup.find("h1")
        if h1 and h1.get_text(strip=True):
            return h1.get_text(strip=True)[:200]

        return ""
    except Exception:
        m = re.search(
            r'<meta[^>]+property=["\']og:title["\'][^>]+content=["\']([^"\']+)["\']',
            html_text, re.IGNORECASE
        )
        if m:
            return m.group(1).strip()
        m = re.search(r'<title>([^<]+)</title>', html_text, re.IGNORECASE)
        return m.group(1).strip() if m else ""

def _parse_lazy_images_from_html(html_text: str, base_url: str = "") -> List[Dict[str, Any]]:
    candidates: List[Dict[str, Any]] = []
    seen: set = set()

    def _add(src: str, score: int, alt: str = "", width: int = 1200):
        if not src or src in seen:
            return
        src = normalize_url(src)
        src = _prefer_https(src, base_url)
        if src and not src.startswith(("http://", "https://")) and base_url:
            src = urljoin(base_url, src)
        if not src or not src.startswith(("http://", "https://")):
            return
        if JUNK_PATTERNS.search(src) or src.lower().endswith(".svg"):
            return
        seen.add(src)
        candidates.append({"src": src, "score": score, "alt": alt, "width": width})

    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html_text, "html.parser")

        # 1. Open Graph
        for og in soup.find_all("meta", property="og:image"):
            if og and og.get("content"):
                _add(og["content"], 10, "og:image")
        for og_secure in soup.find_all("meta", property="og:image:secure_url"):
            if og_secure and og_secure.get("content"):
                _add(og_secure["content"], 10, "og:image:secure_url")
        og_width = soup.find("meta", property="og:image:width")
        if og_width and og_width.get("content"):
            try:
                w = int(og_width["content"])
                for c in candidates:
                    if c.get("alt", "").startswith("og:"):
                        c["width"] = w
            except ValueError:
                pass

        # 2. Twitter Cards
        for tw in soup.find_all("meta", attrs={"name": "twitter:image"}):
            if tw and tw.get("content"):
                _add(tw["content"], 9, "twitter:image")
        for tw in soup.find_all("meta", attrs={"property": "twitter:image"}):
            if tw and tw.get("content"):
                _add(tw["content"], 9, "twitter:image")
        for tw_src in soup.find_all("meta", attrs={"name": "twitter:image:src"}):
            if tw_src and tw_src.get("content"):
                _add(tw_src["content"], 9, "twitter:image:src")

        # 3. Schema.org JSON-LD (deep recursive)
        def _extract_images_from_json(obj, depth=0):
            if depth > 10:
                return
            if isinstance(obj, dict):
                for key in ("image", "images", "photo", "photos", "picture", "pictures",
                            "thumbnail", "thumbnailUrl", "gallery", "productImages"):
                    val = obj.get(key)
                    if not val:
                        continue
                    if isinstance(val, str) and val.startswith(("http", "//")):
                        _add(val, 8, f"schema.org:{key}")
                    elif isinstance(val, dict):
                        url = val.get("url") or val.get("contentUrl") or val.get("thumbnailUrl") or val.get("@id")
                        if url and isinstance(url, str) and url.startswith(("http", "//")):
                            _add(url, 8, f"schema.org:{key}")
                    elif isinstance(val, list):
                        for item in val:
                            if isinstance(item, str) and item.startswith(("http", "//")):
                                _add(item, 8, f"schema.org:{key}")
                            elif isinstance(item, dict):
                                url = item.get("url") or item.get("contentUrl") or item.get("thumbnailUrl") or item.get("@id")
                                if url and isinstance(url, str) and url.startswith(("http", "//")):
                                    _add(url, 8, f"schema.org:{key}")
                                _extract_images_from_json(item, depth + 1)
                for key in ("logo", "brand"):
                    val = obj.get(key)
                    if isinstance(val, str) and val.startswith(("http", "//")):
                        _add(val, 5, f"schema.org:{key}")
                    elif isinstance(val, dict):
                        url = val.get("url") or val.get("contentUrl") or val.get("logo")
                        if url and isinstance(url, str) and url.startswith(("http", "//")):
                            _add(url, 5, f"schema.org:{key}")
                for v in obj.values():
                    if isinstance(v, (dict, list)):
                        _extract_images_from_json(v, depth + 1)
            elif isinstance(obj, list):
                for item in obj:
                    _extract_images_from_json(item, depth + 1)

        for script in soup.find_all("script", type="application/ld+json"):
            try:
                data = json.loads(script.string or "")
                if isinstance(data, list):
                    for item in data:
                        _extract_images_from_json(item)
                else:
                    _extract_images_from_json(data)
            except Exception:
                continue

        # 3b. Modern framework data (__NEXT_DATA__ + application/json)
        for script in soup.find_all("script", id="__NEXT_DATA__"):
            if script.string:
                try:
                    data = json.loads(script.string)
                    _extract_images_from_json(data)
                except Exception:
                    continue

        for script in soup.find_all("script", type="application/json"):
            if script.string:
                try:
                    data = json.loads(script.string)
                    _extract_images_from_json(data)
                except Exception:
                    continue

        # 4. link[rel="image_src"]
        for link in soup.find_all("link", rel="image_src"):
            if link and link.get("href"):
                _add(link["href"], 7, "image_src")

        # 5. Microdata
        for tag in soup.find_all(attrs={"itemprop": "image"}):
            src = tag.get("src") or tag.get("content") or tag.get("href")
            if src:
                _add(src, 7, "microdata:image")
            for img in tag.find_all("img"):
                s = img.get("src") or img.get("data-src") or img.get("data-original")
                if s:
                    _add(s, 7, "microdata:img")

        # 6. E-commerce meta tags
        for meta in soup.find_all("meta"):
            prop = meta.get("property", "").lower()
            name = meta.get("name", "").lower()
            content = meta.get("content", "")
            if prop in ("product:image", "product:image:link") or name in ("product-image", "product_image"):
                if content:
                    _add(content, 9, "product:meta")

        # 7. JavaScript-embedded product data (extended patterns)
        for script in soup.find_all("script"):
            if not script.string:
                continue
            text = script.string
            for match in re.finditer(r'"images"\s*:\s*\[(.*?)\]', text, re.DOTALL):
                arr_text = match.group(1)
                for url_match in re.finditer(
                    r'"(https?://[^"]+\.(?:jpg|jpeg|png|webp|avif))"', arr_text, re.IGNORECASE
                ):
                    _add(url_match.group(1), 6, "js:product-images")
            for match in re.finditer(
                r'"featured_image"\s*:\s*"(https?://[^"]+)"', text, re.IGNORECASE
            ):
                _add(match.group(1), 6, "js:featured-image")
            for match in re.finditer(
                r'"image"\s*:\s*"(https?://[^"]+)"', text, re.IGNORECASE
            ):
                _add(match.group(1), 6, "js:product-image")

            for match in re.finditer(
                r'"(?:main_image|hero_image|gallery_images|product_images|image_url|img_src|imageSrc|productImage|featuredImage|src)"\s*:\s*"(https?://[^"]+\.(?:jpg|jpeg|png|webp|avif))"',
                text, re.IGNORECASE
            ):
                _add(match.group(1), 6, "js:enhanced-product-image")
            for match in re.finditer(
                r'"(?:images|gallery|productImages|imageGallery|galleryImages)"\s*:\s*\[(.*?)\]',
                text, re.DOTALL
            ):
                arr_text = match.group(1)
                for url_match in re.finditer(
                    r'"(https?://[^"]+\.(?:jpg|jpeg|png|webp|avif))"', arr_text, re.IGNORECASE
                ):
                    _add(url_match.group(1), 6, "js:gallery-array")

        # 8. Supplementary DOM gallery scan (score=3) — always runs but now filtered more strictly
        seen_canonicals = {canonicalize_image_url(c["src"]) for c in candidates}

        for tag in soup.find_all(["img", "source", "picture"], limit=60):
            possible_srcs = []
            for attr in ("src", "data-src", "data-original", "data-lazy-src", "data-bg",
                         "data-lazy", "data-image", "data-src-large", "data-original-src"):
                val = tag.get(attr)
                if val:
                    possible_srcs.append(val)

            srcset = (
                tag.get("srcset", "")
                or tag.get("data-srcset", "")
                or tag.get("data-lazy-srcset", "")
            )
            if srcset:
                best = _best_from_srcset(srcset)
                if best:
                    possible_srcs.append(best)
                else:
                    possible_srcs.append(srcset.split(",")[0].split()[0].strip())

            for src in possible_srcs:
                if not src:
                    continue
                c_url = canonicalize_image_url(normalize_url(src))
                if c_url in seen_canonicals:
                    continue
                if JUNK_PATTERNS.search(src) or src.lower().endswith(".svg"):
                    continue

                w = tag.get("width") or 0
                try:
                    w = int(w)
                except (ValueError, TypeError):
                    w = 0

                if w >= 300 or tag.name in ("source", "picture"):
                    _add(src, 3, tag.get("alt", "") or "", w)
                    seen_canonicals.add(c_url)

    except ImportError:
        logger.debug("BeautifulSoup unavailable; using regex fallback for lazy extraction")
        for og in re.finditer(
            r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']',
            html_text, re.IGNORECASE
        ):
            _add(og.group(1), 10, "og:image")
        for og_secure in re.finditer(
            r'<meta[^>]+property=["\']og:image:secure_url["\'][^>]+content=["\']([^"\']+)["\']',
            html_text, re.IGNORECASE
        ):
            _add(og_secure.group(1), 10, "og:image:secure_url")
        for tw in re.finditer(
            r'<meta[^>]+(?:name|property)=["\']twitter:image["\'][^>]+content=["\']([^"\']+)["\']',
            html_text, re.IGNORECASE
        ):
            _add(tw.group(1), 9, "twitter:image")
        for tw_src in re.finditer(
            r'<meta[^>]+name=["\']twitter:image:src["\'][^>]+content=["\']([^"\']+)["\']',
            html_text, re.IGNORECASE
        ):
            _add(tw_src.group(1), 9, "twitter:image:src")
        for m in re.finditer(
            r'"image"\s*:\s*(?:\[\s*)?{?\s*(?:"url"\s*:\s*"?([^"}\]\n]+)"?|"?([^"}\]\n]+)"?)',
            html_text
        ):
            url = (m.group(1) or m.group(2) or "").strip()
            if url.startswith(("http", "//")):
                _add(url, 8, "schema.org:image")
        for link in re.finditer(
            r'<link[^>]+rel=["\']image_src["\'][^>]+href=["\']([^"\']+)["\']',
            html_text, re.IGNORECASE
        ):
            _add(link.group(1), 7, "image_src")
        for m in re.finditer(
            r'<[^>]+itemprop=["\']image["\'][^>]+(?:src|content|href)=["\']([^"\']+)["\']',
            html_text, re.IGNORECASE
        ):
            _add(m.group(1), 7, "microdata:image")
        for m in re.finditer(
            r'"(?:featured_image|image|main_image|hero_image|image_url|img_src)"\s*:\s*"(https?://[^"]+\.(?:jpg|jpeg|png|webp|avif)[^"]*)"',
            html_text, re.IGNORECASE
        ):
            url = m.group(1)
            if url.startswith(("http", "//")):
                _add(url, 6, "js:embedded-enhanced")
        for match in re.finditer(
            r'"(?:images|gallery|productImages)"\s*:\s*\[(.*?)\]',
            html_text, re.DOTALL
        ):
            arr_text = match.group(1)
            for url_match in re.finditer(
                r'"(https?://[^"]+\.(?:jpg|jpeg|png|webp|avif))"', arr_text, re.IGNORECASE
            ):
                _add(url_match.group(1), 6, "js:gallery-regex-fallback")

    return candidates

async def extract_lazy_images(
    client: httpx.AsyncClient, url: str, config: PipelineConfig,
) -> Tuple[str, List[ImageCandidate]]:
    html_text = await _fetch_html_for_lazy_extraction(client, url, config.http_timeout)
    if not html_text:
        return "", []

    title = _extract_title_from_html(html_text)
    raw_images = _parse_lazy_images_from_html(html_text, base_url=url)

    for img in raw_images:
        if img.get("alt", "").startswith((
            "og:", "twitter:", "schema.org:", "image_src", "microdata:",
            "product:", "js:"
        )):
            img["alt"] = title

    if not raw_images:
        return title, []

    sem = asyncio.Semaphore(config.concurrency)

    async def _enrich(img: Dict[str, Any]) -> Dict[str, Any]:
        src = img.get("src", "")
        if not src:
            return img
        async with sem:
            dims = await _get_image_dimensions(client, src, timeout=config.http_timeout)
        if dims:
            real_width, real_height = dims
            old_width = img.get("width")
            img["width"] = real_width
            img["height"] = real_height
            logger.debug(
                "Lazy enriched %s: metadata width %s -> real width %d, height %d",
                src, old_width, real_width, real_height
            )
        return img

    raw_images = await asyncio.gather(*(_enrich(img) for img in raw_images))
    raw_images = [img for img in raw_images if img.get("src")]

    ranked = await filter_and_rank_images(raw_images, title, client, config)
    deduped = await dedupe_by_perceptual_hash(
        ranked,
        client,
        hash_threshold=config.hash_threshold,
        phash_threshold=config.phash_threshold,
        concurrency=config.concurrency,
    )
    deduped = dedupe_by_canonical_url(deduped)
    if config.adaptive_cutoff_enabled:
        deduped = adaptive_score_cutoff(deduped)
    deduped = cluster_and_boost_similar(deduped, cluster_threshold=config.cluster_threshold)

    if len(deduped) == 0:
        logger.warning(
            "Lazy extraction returned 0 images for %s. Site may be heavily JS-rendered, "
            "Cloudflare-protected, or images are loaded via client-side only. "
            "Consider calling run_batch(..., lazy_extraction=False) for full browser mode.",
            url
        )

    return title, deduped

# ── Public orchestrator ──────────────────────────────────────────────
async def run_batch(
    urls: List[str],
    min_score: int = 3,
    hash_threshold: int = 6,
    cdp_port: int = 9243,
    adaptive_cutoff: bool = True,
    lazy_extraction: bool = False,
) -> Dict[str, Any]:
    if not urls:
        return {}

    valid_urls: List[str] = []
    for u in urls:
        if not isinstance(u, str):
            logger.warning("Skipping non-string URL: %r", u)
            continue
        u = u.strip()
        if not u.startswith(("http://", "https://")):
            logger.warning("Skipping malformed URL: %s", u)
            continue
        valid_urls.append(u)

    if not valid_urls:
        return {}

    config = PipelineConfig(
        min_score=min_score,
        hash_threshold=hash_threshold,
        cdp_port=cdp_port,
        adaptive_cutoff_enabled=adaptive_cutoff,
    )

    limits = httpx.Limits(max_connections=50, max_keepalive_connections=20)
    timeout = httpx.Timeout(10.0, connect=5.0)
    results: Dict[str, Any] = {}

    if lazy_extraction:
        browser_headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,"
                      "image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate, br",
            "DNT": "1",
            "Connection": "keep-alive",
            "Upgrade-Insecure-Requests": "1",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
        }
        async with httpx.AsyncClient(
            limits=limits, timeout=timeout, follow_redirects=True, headers=browser_headers
        ) as client:
            sem = asyncio.Semaphore(config.concurrency)

            async def _process_lazy(url: str) -> Tuple[str, Any]:
                async with sem:
                    try:
                        title, deduped = await extract_lazy_images(client, url, config)
                        return url, [img.to_dict() for img in deduped]
                    except Exception as exc:
                        return url, {"error": str(exc)}

            lazy_results = await asyncio.gather(*(_process_lazy(url) for url in valid_urls))
            for url, res in lazy_results:
                results[url] = res
                if isinstance(res, list):
                    logger.info("Lazy extraction success %s -> %d images", url, len(res))
                else:
                    logger.error("Lazy extraction failed %s: %s", url, res.get("error"))
        return results

    # Full browser mode (unchanged)
    cb_browser = None
    xvfb_proc = None

    try:
        effective_headless = config.headless
        if not config.headless:
            xvfb_proc = _start_xvfb_if_needed()
            if not _display_is_usable(os.environ.get("DISPLAY", "")):
                logger.warning("No working X display available, falling back to headless mode")
                effective_headless = True
                if "DISPLAY" in os.environ:
                    del os.environ["DISPLAY"]

        logger.info("Launching CloakBrowser on port %d (headless=%s)", config.cdp_port, effective_headless)
        cb_browser = await asyncio.wait_for(
            launch_async(headless=effective_headless, args=_build_cloak_args(config)),
            timeout=config.cdp_health_timeout,
        )

        await _health_check_cdp(config.cdp_port, timeout=config.cdp_health_timeout)

        browser_config = BrowserConfig(
            browser_mode="cdp",
            cdp_url=f"http://127.0.0.1:{config.cdp_port}",
        )

        run_config = CrawlerRunConfig(
            cache_mode=CacheMode.BYPASS,
            stream=True,
            js_code=JS_LAZY_LOAD,
            excluded_tags=EXCLUDED_TAGS,
        )

        dispatcher = MemoryAdaptiveDispatcher(
            memory_threshold_percent=config.memory_threshold_percent,
            max_session_permit=min(len(valid_urls), 10),
        )

        async with AsyncWebCrawler(config=browser_config) as crawler, \
                   httpx.AsyncClient(limits=limits, timeout=timeout, follow_redirects=True) as client:

            stream = await crawler.arun_many(
                urls=valid_urls,
                config=run_config,
                dispatcher=dispatcher,
            )

            failed_urls: List[str] = []

            async for res in stream:
                key_url = res.url
                if not res.success:
                    results[key_url] = {"error": res.error_message}
                    logger.error("Batch failed %s: %s", key_url, res.error_message)
                    failed_urls.append(key_url)
                    continue

                title = res.metadata.get("og:title") or res.metadata.get("title", "") or ""
                raw_images = res.media.get("images", []) if res.media else []
                if not isinstance(raw_images, list):
                    raw_images = []

                ranked = await filter_and_rank_images(raw_images, title, client, config)
                deduped = await dedupe_by_perceptual_hash(
                    ranked,
                    client,
                    hash_threshold=config.hash_threshold,
                    phash_threshold=config.phash_threshold,
                    concurrency=config.concurrency,
                )
                deduped = dedupe_by_canonical_url(deduped)
                if config.adaptive_cutoff_enabled:
                    deduped = adaptive_score_cutoff(deduped)
                deduped = cluster_and_boost_similar(deduped, cluster_threshold=config.cluster_threshold)

                results[key_url] = [img.to_dict() for img in deduped]
                logger.info("Batch success %s (title: '%s') -> %d images", key_url, title, len(deduped))

            if failed_urls:
                logger.info("Retrying %d failed URL(s)", len(failed_urls))
                retry_config = CrawlerRunConfig(
                    cache_mode=CacheMode.BYPASS,
                    stream=False,
                    js_code=JS_LAZY_LOAD,
                    excluded_tags=EXCLUDED_TAGS,
                )

                for url in failed_urls:
                    try:
                        res = await _crawl_single_with_retry(crawler, url, retry_config, config)
                        if not res.success:
                            results[url] = {"error": res.error_message}
                            logger.error("Retry failed %s: %s", url, res.error_message)
                            continue

                        title = res.metadata.get("og:title") or res.metadata.get("title", "") or ""
                        raw_images = res.media.get("images", []) if res.media else []
                        if not isinstance(raw_images, list):
                            raw_images = []

                        ranked = await filter_and_rank_images(raw_images, title, client, config)
                        deduped = await dedupe_by_perceptual_hash(
                            ranked,
                            client,
                            hash_threshold=config.hash_threshold,
                            phash_threshold=config.phash_threshold,
                            concurrency=config.concurrency,
                        )
                        deduped = dedupe_by_canonical_url(deduped)
                        if config.adaptive_cutoff_enabled:
                            deduped = adaptive_score_cutoff(deduped)
                        deduped = cluster_and_boost_similar(deduped, cluster_threshold=config.cluster_threshold)

                        results[url] = [img.to_dict() for img in deduped]
                        logger.info("Retry success %s (title: '%s') -> %d images", url, title, len(deduped))

                    except Exception as exc:
                        results[url] = {"error": str(exc)}
                        logger.error("Retry exhausted %s: %s", url, exc)

    except Exception:
        logger.exception("Fatal error in run_batch")
        raise
    finally:
        if cb_browser is not None:
            try:
                await cb_browser.close()
                logger.info("Browser closed")
            except Exception as exc:
                logger.warning("Error closing browser: %s", exc)

        if xvfb_proc is not None:
            try:
                xvfb_proc.terminate()
                xvfb_proc.wait(timeout=2)
                logger.info("Xvfb terminated")
            except Exception as exc:
                logger.warning("Error terminating Xvfb: %s", exc)
                try:
                    xvfb_proc.kill()
                except Exception:
                    pass

    return results

# ── Example usage ─────────────────────────────────────────────────────
if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Product Image Pipeline for E-commerce Sites",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python ecom-image-extractor.py -u urls.json -o results.json --lazy-extraction
  python ecom-image-extractor.py -u urls.json -o results.json --no-lazy-extraction --no-adaptive-cutoff
        """,
    )
    parser.add_argument(
        "-u", "--urls",
        required=True,
        help="Path to a JSON file containing a list of URLs (e.g. ["https://...", "https://..."])",
    )
    parser.add_argument(
        "-o", "--output",
        required=True,
        help="Path to write the output JSON results",
    )
    parser.add_argument(
        "--min-score",
        type=int,
        default=3,
        help="Minimum score threshold for image candidates (default: 3)",
    )
    parser.add_argument(
        "--hash-threshold",
        type=int,
        default=6,
        help="Perceptual hash distance threshold for deduplication (default: 6)",
    )
    parser.add_argument(
        "--cdp-port",
        type=int,
        default=9243,
        help="Chrome DevTools Protocol port for full-browser mode (default: 9243)",
    )
    parser.add_argument(
        "--adaptive-cutoff",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Enable adaptive score cutoff to drop low-quality tail images (default: --adaptive-cutoff)",
    )
    parser.add_argument(
        "--lazy-extraction",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Use lightweight HTTP-only extraction instead of full browser (default: --no-lazy-extraction)",
    )

    args = parser.parse_args()

    # Load URLs
    if not os.path.isfile(args.urls):
        parser.error(f"URLs file not found: {args.urls}")

    with open(args.urls, "r", encoding="utf-8") as f:
        try:
            urls = json.load(f)
        except json.JSONDecodeError as exc:
            parser.error(f"Invalid JSON in URLs file: {exc}")

    if not isinstance(urls, list):
        parser.error(f"URLs file must contain a JSON array of strings, got {type(urls).__name__}")
    if not urls:
        parser.error("URLs file is empty.")

    # Run pipeline
    results = asyncio.run(
        run_batch(
            urls=urls,
            min_score=args.min_score,
            hash_threshold=args.hash_threshold,
            cdp_port=args.cdp_port,
            adaptive_cutoff=args.adaptive_cutoff,
            lazy_extraction=args.lazy_extraction,
        )
    )

    # Write output
    out_dir = os.path.dirname(args.output)
    if out_dir and not os.path.exists(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

    logger.info("Wrote results for %d URL(s) to %s", len(results), args.output)
