#!/usr/bin/env python3
"""
E-Commerce Product Text Extractor (Production-Ready v1.6 - Ultra-Fast Fallbacks)

Dual-mode extraction tool for scraping structured product data from
e-commerce product pages. Designed for integration with the UGC dropship
pipeline and review server.

Upgrades (v1.6):
  - SPEED: Removed the 429 sleep delay in Tier 1. 429s now instantly fail fast to trigger the Tier 2 Classic Fallback with zero wait time.
  - SPEED: Disabled Full Browser retries by default (max_crawl_retries=0). Retrying heavy headless crawls (or 404s) was causing massive snail-paced bottlenecks.
  - BUGFIX: Bumped crawl_timeout from 45s to 60s to prevent near-miss timeouts on heavy SPAs.

Upgrades (v1.5):
  - NEW: Tiered Lazy Fallback. Advanced lazy mode -> Classic lazy mode -> Full browser.

Usage:
  python ecom-text-extractor.py -u urls.json -o results.json --lazy-extraction
  python ecom-text-extractor.py -u urls.json -o results.json --no-lazy-extraction --include-screenshots
"""

import os
import re
import json
import copy
import asyncio
import logging
import argparse
import subprocess
import shutil
import base64
import hashlib
import time
import random
from contextlib import AsyncExitStack
from dataclasses import dataclass, field, asdict
from typing import Optional, Tuple, List, Dict, Any, Union, Set
from io import BytesIO
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode, urljoin
from datetime import datetime, timezone

import httpx
from bs4 import BeautifulSoup, NavigableString
from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig, CacheMode, MemoryAdaptiveDispatcher
from cloakbrowser import launch_async

# Optional TLS Impersonation dependency for 2026 Anti-Bot Bypassing
try:
    from curl_cffi import requests as cffi_requests
    HAS_CURL_CFFI = True
except ImportError:
    HAS_CURL_CFFI = False

# Optional lxml for faster HTML parsing (3-5x speedup over html.parser)
try:
    import lxml  # noqa: F401
    BS4_PARSER = "lxml"
except ImportError:
    BS4_PARSER = "html.parser"

# -- Logging -----------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("ecom_text_extractor")

if not HAS_CURL_CFFI:
    logger.warning(
        "curl_cffi not installed. Falling back to standard httpx for advanced lazy extraction. "
        "Recommend: pip install curl_cffi"
    )

if BS4_PARSER == "html.parser":
    logger.warning(
        "lxml not installed. Using slower html.parser. Recommend: pip install lxml"
    )

# -- Constants --------------------------------------------------------
EXCLUDED_TAGS = [
    "script", "style", "noscript", "iframe", "canvas", "svg",
    "nav", "footer", "aside", "header", "form"
]

# Advanced 2026 Chrome 124 header fingerprint for httpx advanced lazy path.
CHROME_HEADERS_2026 = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "max-age=0",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "Sec-Ch-Ua": '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    "Sec-Ch-Ua-Mobile": "?0",
    "Sec-Ch-Ua-Platform": '"Windows"',
    "DNT": "1",
    "Connection": "keep-alive",
}

# Classic v1.1 Headers (Fallback if Advanced Mode hits a 429/403)
CLASSIC_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "DNT": "1",
    "Connection": "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
}

# Modal / popup / cookie banner blocking JS (injected before page load)
POPUP_BLOCKER_JS = """
(() => {
    const KILL_SELECTORS = [
        '#cookie-banner', '.cookie-banner', '.cookie-consent', '#onetrust-banner-sdk',
        '.cc-banner', '.js-cookie-banner', '[data-testid="cookie-banner"]',
        '#CybotCookiebotDialog', '.gdpr-banner', '#gdpr-consent',
        '.cookie-notice', '#cookie-notice', '.cookies-banner',
        '#cookies-policy', '.cookie-policy', '.privacy-banner',
        '#privacy-banner', '.consent-banner', '#consent-banner',
        '.gdpr-popup', '#gdpr-popup', '.cookie-popup', '#cookie-popup',
        '.cookie-overlay', '#cookie-overlay', '.cookie-dialog', '#cookie-dialog',
        '[class*="cookie"][class*="banner"]', '[id*="cookie"][id*="banner"]',
        '[class*="gdpr"]', '[id*="gdpr"]',
        '[class*="consent"]', '[id*="consent"]',
        '[class*="privacy"][class*="banner"]', '[id*="privacy"][id*="banner"]',
        '[aria-label*="cookie" i]', '[aria-label*="consent" i]',
        '[aria-label*="privacy" i]', '[aria-label*="gdpr" i]',

        '.newsletter-popup', '.email-capture', '#signup-modal', '.modal-newsletter',
        '.newsletter-modal', '#newsletter-modal', '.email-modal', '#email-modal',
        '.subscribe-popup', '#subscribe-popup', '.subscribe-modal', '#subscribe-modal',
        '.mailing-list', '#mailing-list', '.email-signup', '#email-signup',
        '[class*="newsletter"]', '[id*="newsletter"]',
        '[class*="subscribe"]', '[id*="subscribe"]',
        '[class*="mailing"]', '[id*="mailing"]',

        '.promo-banner', '.sale-banner', '.announcement-bar', '.promo-overlay',
        '#promo-banner', '#sale-banner', '#announcement-bar',
        '.promotion-banner', '#promotion-banner', '.discount-banner', '#discount-banner',
        '.flash-sale', '#flash-sale', '.limited-time', '#limited-time',
        '[class*="promo"]', '[id*="promo"]',
        '[class*="sale"][class*="banner"]', '[id*="sale"][id*="banner"]',
        '[class*="announcement"]', '[id*="announcement"]',
        '[class*="promotion"]', '[id*="promotion"]',

        '.intercom-lightweight-app', '#drift-widget', '.zendesk-chat',
        '[class*="chat-widget"]', '[id*="chat-widget"]',
        '.chat-widget', '#chat-widget', '.live-chat', '#live-chat',
        '.chat-button', '#chat-button', '.chat-bubble', '#chat-bubble',
        '.messenger-widget', '#messenger-widget', '.whatsapp-widget', '#whatsapp-widget',
        '[class*="intercom"]', '[id*="intercom"]',
        '[class*="drift"]', '[id*="drift"]',
        '[class*="zendesk"]', '[id*="zendesk"]',
        '[class*="tawk"]', '[id*="tawk"]',
        '[class*="crisp"]', '[id*="crisp"]',
        '[class*="livechat"]', '[id*="livechat"]',

        '.app-download-banner', '.smartbanner', '#smartbanner',
        '.app-banner', '#app-banner', '.mobile-app-banner', '#mobile-app-banner',
        '[class*="app-download"]', '[id*="app-download"]',
        '[class*="smartbanner"]', '[id*="smartbanner"]',

        '.social-widget', '#social-widget', '.share-widget', '#share-widget',
        '.social-bar', '#social-bar', '.share-bar', '#share-bar',

        '.feedback-widget', '#feedback-widget', '.survey-widget', '#survey-widget',
        '.nps-survey', '#nps-survey',

        '.back-to-top', '#back-to-top', '.scroll-top', '#scroll-top',
        '[class*="back-to-top"]', '[id*="back-to-top"]',

        '.sticky-header', '#sticky-header', '.fixed-header', '#fixed-header',
        '[class*="sticky"][class*="header"]', '[id*="sticky"][id*="header"]',
    ];

    const removeAll = () => {
        KILL_SELECTORS.forEach(sel => {
            try {
                document.querySelectorAll(sel).forEach(el => {
                    el.style.display = 'none';
                    el.remove();
                });
            } catch (e) {}
        });

        try {
            document.querySelectorAll('*').forEach(el => {
                const style = getComputedStyle(el);
                if (style.position === 'fixed' && parseInt(style.zIndex) > 500) {
                    const rect = el.getBoundingClientRect();
                    const vpArea = window.innerWidth * window.innerHeight;
                    const elArea = rect.width * rect.height;
                    if (elArea > vpArea * 0.25) {
                        el.style.display = 'none';
                        el.remove();
                    }
                }
            });
        } catch (e) {}

        try {
            document.querySelectorAll('*').forEach(el => {
                const style = getComputedStyle(el);
                if (style.backdropFilter && style.backdropFilter !== 'none') {
                    el.style.display = 'none';
                    el.remove();
                }
            });
        } catch (e) {}
    };

    removeAll();

    if (typeof MutationObserver !== 'undefined') {
        const obs = new MutationObserver((mutations) => {
            let shouldClean = false;
            for (const m of mutations) {
                if (m.addedNodes.length > 0) {
                    shouldClean = true;
                    break;
                }
            }
            if (shouldClean) removeAll();
        });
        if (document.body) {
            obs.observe(document.body, { childList: true, subtree: true });
        } else {
            document.addEventListener('DOMContentLoaded', () => {
                obs.observe(document.body, { childList: true, subtree: true });
            });
        }
    }

    setInterval(removeAll, 500);
})();
"""

PRE_SCREENSHOT_JS = """
(() => {
    window.scrollTo(0, 0);
    const images = document.querySelectorAll('img');
    images.forEach(img => {
        if (img.dataset.src) img.src = img.dataset.src;
        if (img.dataset.lazySrc) img.src = img.dataset.lazySrc;
    });
    window.dispatchEvent(new Event('scroll'));
    window.dispatchEvent(new Event('resize'));
    setTimeout(() => window.scrollTo(0, 0), 300);
})();
"""

JS_SCREENSHOT_PREP = "(async () => { window.scrollTo(0, 0); await new Promise(r => setTimeout(r, 500)); })();"
JS_LAZY_LOAD = "window.scrollTo(0, document.body.scrollHeight);"

# -- Font detection (same as image extractor) ---------------------------
_FONT_SEARCH_PATHS = [
    os.path.expanduser("~/.local/share/fonts/windows"),
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
    return None

# -- Display helpers ---------------------------------------------------
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

# -- URL utilities -----------------------------------------------------
def normalize_url(u: str) -> str:
    if not u:
        return ""
    u = u.strip()
    if u.startswith("//"):
        return "https:" + u
    return u

def canonicalize_url(u: str) -> str:
    if not u:
        return ""
    parts = urlsplit(u)
    q = [(k, v) for k, v in parse_qsl(parts.query)
         if k.lower() not in frozenset({
             "utm_source", "utm_medium", "utm_campaign",
             "utm_term", "utm_content", "fbclid", "gclid",
             "ref", "source", "mc_cid", "mc_eid",
         })]
    return urlunsplit((
        parts.scheme.lower(),
        parts.netloc.lower(),
        parts.path.rstrip("/"),
        urlencode(sorted(q, key=lambda kv: kv[0])),
        ""
    ))

def url_hash(u: str) -> str:
    return hashlib.sha256(u.encode()).hexdigest()[:16]

# -- Shopify detection helpers -----------------------------------------
def _is_shopify_domain(url: str) -> bool:
    parts = urlsplit(url)
    host = parts.netloc.lower()
    if host.endswith(".myshopify.com"):
        return True
    if re.search(r"/products/[^/?#]+", parts.path):
        return True
    return False

def _shopify_json_url(url: str) -> Optional[str]:
    parts = urlsplit(url)
    match = re.match(r"(/products/[^/?#]+)", parts.path)
    if not match:
        return None
    product_path = match.group(1).rstrip("/")
    return urlunsplit((parts.scheme, parts.netloc, product_path + ".json", "", ""))

async def _try_shopify_json(
    client: Any,
    url: str,
    timeout: float,
) -> Optional[Dict[str, Any]]:
    json_url = _shopify_json_url(url)
    if not json_url:
        return None
    try:
        if HAS_CURL_CFFI and isinstance(client, cffi_requests.AsyncSession):
            r = await client.get(json_url, timeout=timeout, impersonate="chrome124")
        else:
            r = await client.get(json_url, timeout=timeout)
        if r.status_code == 200:
            data = r.json() if hasattr(r, "json") and callable(r.json) else json.loads(r.text)
            if isinstance(data, dict) and "product" in data:
                logger.info("Shopify JSON API hit: %s", json_url)
                return data["product"]
    except Exception as exc:
        logger.debug("Shopify JSON fetch failed for %s: %s", json_url, exc)
    return None

# -- Data classes ------------------------------------------------------
@dataclass
class ExtractedSources:
    schema_org: List[Dict[str, Any]] = field(default_factory=list)
    open_graph: Dict[str, str] = field(default_factory=dict)
    twitter_card: Dict[str, str] = field(default_factory=dict)
    meta_tags: Dict[str, str] = field(default_factory=dict)
    next_data: Optional[Dict[str, Any]] = None
    nuxt_data: Optional[Dict[str, Any]] = None
    vue_data: Optional[Dict[str, Any]] = None
    inline_js: Dict[str, Any] = field(default_factory=dict)
    microdata: List[Dict[str, Any]] = field(default_factory=list)
    dom_text: Dict[str, Any] = field(default_factory=dict)
    tables: List[Dict[str, Any]] = field(default_factory=list)
    lists: List[Dict[str, Any]] = field(default_factory=list)
    breadcrumb: List[str] = field(default_factory=list)
    markdown: Optional[str] = None
    shopify_product: Optional[Dict[str, Any]] = None
    preload_data: List[Dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

@dataclass
class ScreenshotData:
    base64: Optional[str] = None
    width: int = 0
    height: int = 0
    format: str = "png"
    path: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

@dataclass
class ConfidenceScore:
    has_schema_org: bool = False
    has_open_graph: bool = False
    has_twitter: bool = False
    has_meta_description: bool = False
    has_price: bool = False
    has_availability: bool = False
    has_description: bool = False
    has_images: bool = False
    has_sku: bool = False
    has_brand: bool = False
    has_reviews: bool = False
    has_breadcrumb: bool = False
    score: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

@dataclass
class ExtractionResult:
    url: str = ""
    canonical_url: str = ""
    extraction_mode: str = "lazy"
    success: bool = False
    status_code: Optional[int] = None
    error: Optional[str] = None
    extracted_at: str = ""
    sources: Dict[str, Any] = field(default_factory=dict)
    screenshot: Dict[str, Any] = field(default_factory=dict)
    confidence: Dict[str, Any] = field(default_factory=dict)
    performance: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

@dataclass
class PipelineConfig:
    min_confidence: float = 0.3
    include_screenshots: bool = False
    screenshot_width: int = 1280
    screenshot_height: int = 800
    screenshot_format: str = "png"
    screenshot_quality: int = 85
    modal_blocking: str = "aggressive"
    include_dom_text: bool = True
    include_tables: bool = True
    include_lists: bool = True
    include_markdown: bool = True
    include_breadcrumb: bool = True
    cdp_port: int = 9243
    concurrency: int = 8
    browser_concurrency: int = 1
    http_timeout: float = 10.0
    fetch_timeout: float = 5.0
    headless: bool = True
    memory_threshold_percent: float = 70.0
    fingerprint_seed: str = "product_scraper_42"
    storage_quota_mb: int = 5000
    crawl_timeout: float = 60.0  # v1.6: Increased to 60s
    max_crawl_retries: int = 0   # v1.6: Default to 0 for fast failure instead of snail-paced retries
    retry_base_delay: float = 2.0
    cdp_health_timeout: float = 30.0
    lazy_screenshot: bool = False
    lazy_screenshot_width: int = 1280
    lazy_screenshot_height: int = 800
    save_screenshots_to_file: bool = False
    screenshots_dir: str = ""
    fetch_max_retries: int = 2

# -- Lazy extraction helpers -------------------------------------------

class FetchErrorType:
    HTTP_ERROR = "http_error"
    SSL_ERROR = "ssl_error"
    DNS_ERROR = "dns_error"
    TIMEOUT = "timeout"
    NETWORK = "network"
    UNKNOWN = "unknown"

def _classify_fetch_error(exc: Exception) -> str:
    name = type(exc).__name__.lower()
    msg = str(exc).lower()
    if "ssl" in name or "ssl" in msg or "certificate" in msg:
        return FetchErrorType.SSL_ERROR
    if "timeout" in name or "timed out" in msg or "deadline" in msg:
        return FetchErrorType.TIMEOUT
    if "name or service not known" in msg or "nodename" in msg or "gaierror" in msg:
        return FetchErrorType.DNS_ERROR
    if "connect" in name or "connection" in msg:
        return FetchErrorType.NETWORK
    return FetchErrorType.UNKNOWN

async def _fetch_html(
    client: Any,
    url: str,
    timeout: float,
    max_retries: int = 2,
) -> Tuple[Optional[str], Optional[int], Optional[str]]:
    last_status: Optional[int] = None
    last_error_type: Optional[str] = None

    for attempt in range(max_retries + 1):
        try:
            if HAS_CURL_CFFI and isinstance(client, cffi_requests.AsyncSession):
                r = await client.get(
                    url, timeout=timeout, allow_redirects=True, impersonate="chrome124"
                )
            else:
                r = await client.get(
                    url,
                    timeout=timeout,
                    follow_redirects=True,
                )

            last_status = r.status_code

            if r.status_code in (200, 201, 202):
                return r.text, r.status_code, None

            # v1.6: 429 Instant Fail. No sleep. Fail fast to trigger Tier 2 Classic Fallback instantly.
            if r.status_code == 429 and attempt < max_retries:
                logger.warning("HTTP 429 for %s - failing fast to trigger Fallback.", url)
                return None, r.status_code, FetchErrorType.HTTP_ERROR

            if r.status_code in (500, 502, 503, 504) and attempt < max_retries:
                delay = 2.0 * (2 ** attempt)
                logger.warning(
                    "HTTP %d for %s — retrying in %.1fs (%d/%d)",
                    r.status_code, url, delay, attempt + 1, max_retries,
                )
                await asyncio.sleep(delay)
                continue

            logger.warning("HTTP %d for %s", r.status_code, url)
            return None, r.status_code, FetchErrorType.HTTP_ERROR

        except Exception as exc:
            last_error_type = _classify_fetch_error(exc)
            logger.debug("HTML fetch failed for %s (attempt %d): [%s] %s",
                         url, attempt + 1, last_error_type, exc)

            if last_error_type in (FetchErrorType.DNS_ERROR, FetchErrorType.SSL_ERROR):
                return None, None, last_error_type

            if attempt < max_retries:
                await asyncio.sleep(1.5 * (2 ** attempt))
                continue

            return None, last_status, last_error_type

    return None, last_status, last_error_type or FetchErrorType.UNKNOWN

def _normalize_schema_type(t: str) -> str:
    if not isinstance(t, str):
        return ""
    return t.rsplit("/", 1)[-1] if "/" in t else t

def _is_product_schema(obj: Dict[str, Any]) -> bool:
    if not isinstance(obj, dict):
        return False
    types = obj.get("@type", "")
    if isinstance(types, str):
        types = [types]
    product_types = {"Product", "IndividualProduct", "ProductGroup", "ProductModel",
                     "SomeProducts", "Vehicle", "Offer", "AggregateOffer"}
    return any(_normalize_schema_type(t) in product_types for t in types)

def _collect_product_schemas(data: Any) -> List[Dict[str, Any]]:
    results: List[Dict[str, Any]] = []
    if isinstance(data, list):
        for item in data:
            results.extend(_collect_product_schemas(item))
    elif isinstance(data, dict):
        if _is_product_schema(data):
            results.append(data)
        if "@graph" in data:
            results.extend(_collect_product_schemas(data["@graph"]))
        for key in ("offers", "Offer", "aggregateOffer"):
            if key in data:
                results.extend(_collect_product_schemas(data[key]))
    return results

def _extract_schema_org(soup: BeautifulSoup) -> List[Dict[str, Any]]:
    results: List[Dict[str, Any]] = []
    for script in soup.find_all("script", type="application/ld+json"):
        if not script.string:
            continue
        try:
            data = json.loads(script.string)
            collected = _collect_product_schemas(data)
            seen = set()
            for item in collected:
                key = json.dumps(item, sort_keys=True, default=str)[:200]
                if key not in seen:
                    seen.add(key)
                    results.append(item)
        except (json.JSONDecodeError, TypeError):
            continue
    return results

def _extract_open_graph(soup: BeautifulSoup) -> Dict[str, str]:
    og = {}
    for meta in soup.find_all("meta", property=re.compile(r"^og:")):
        prop = meta.get("property", "")
        content = meta.get("content", "")
        if prop and content:
            og[prop] = content
    return og

def _extract_twitter_card(soup: BeautifulSoup) -> Dict[str, str]:
    tw = {}
    for meta in soup.find_all("meta", attrs={"name": re.compile(r"^twitter:")}):
        name = meta.get("name", "")
        content = meta.get("content", "")
        if name and content:
            tw[name] = content
    for meta in soup.find_all("meta", property=re.compile(r"^twitter:")):
        prop = meta.get("property", "")
        content = meta.get("content", "")
        if prop and content:
            tw[prop] = content
    return tw

def _extract_meta_tags(soup: BeautifulSoup) -> Dict[str, str]:
    meta = {}
    if soup.title and soup.title.string:
        meta["title"] = soup.title.string.strip()

    tag_map = {
        "description": ["name", "description"],
        "keywords": ["name", "keywords"],
        "robots": ["name", "robots"],
        "canonical": ["rel", "canonical"],
        "author": ["name", "author"],
        "viewport": ["name", "viewport"],
    }

    for key, (attr, val) in tag_map.items():
        if attr == "rel":
            el = soup.find("link", rel=val)
            if el and el.get("href"):
                meta[key] = el["href"]
        else:
            el = soup.find("meta", attrs={attr: val})
            if el and el.get("content"):
                meta[key] = el["content"]

    for meta_tag in soup.find_all("meta"):
        name = meta_tag.get("name", "").lower()
        prop = meta_tag.get("property", "").lower()
        content = meta_tag.get("content", "")

        if any(k in name for k in ["product", "price", "currency", "availability", "sku", "brand"]):
            meta[name] = content
        if any(k in prop for k in ["product", "price", "currency", "availability", "sku", "brand"]):
            meta[prop] = content

    return meta

def _extract_page_canonical(soup: BeautifulSoup, fallback: str) -> str:
    tag = soup.find("link", rel="canonical")
    if tag and tag.get("href"):
        href = tag["href"].strip()
        if href.startswith("http"):
            return href
    return fallback

def _extract_next_data(soup: BeautifulSoup) -> Optional[Dict[str, Any]]:
    script = soup.find("script", id="__NEXT_DATA__")
    if script and script.string:
        try:
            return json.loads(script.string)
        except (json.JSONDecodeError, TypeError):
            pass
    return None

def _extract_nuxt_data(soup: BeautifulSoup) -> Optional[Dict[str, Any]]:
    script_n3 = soup.find("script", id="__NUXT_DATA__", type="application/json")
    if script_n3 and script_n3.string:
        try:
            return json.loads(script_n3.string)
        except (json.JSONDecodeError, TypeError):
            pass

    for script in soup.find_all("script"):
        if script.string and "window.__NUXT__" in script.string:
            match = re.search(r'window\.__NUXT__\s*=\s*(\{.*?\});?\s*$', script.string, re.DOTALL)
            if match:
                try:
                    return json.loads(match.group(1))
                except (json.JSONDecodeError, TypeError):
                    pass
    return None

def _extract_vue_data(soup: BeautifulSoup) -> Optional[Dict[str, Any]]:
    patterns = [
        (r'window\.__INITIAL_STATE__\s*=\s*(\{.*?\});?\s*$', "initial_state"),
        (r'window\.__DATA__\s*=\s*(\{.*?\});?\s*$', "data"),
        (r'window\.__APP__\s*=\s*(\{.*?\});?\s*$', "app"),
        (r'window\.__INITIAL_STATE__\s*=\s*JSON\.parse\("(.*?)"\)', "json_parse"),
    ]
    for script in soup.find_all("script"):
        if not script.string:
            continue
        for pattern, label in patterns:
            match = re.search(pattern, script.string, re.DOTALL)
            if match:
                try:
                    data = match.group(1)
                    if label == "json_parse":
                        data = json.loads('"' + data + '"')
                    return json.loads(data)
                except (json.JSONDecodeError, TypeError):
                    pass
    return None

def _extract_inline_js_product_data(soup: BeautifulSoup) -> Dict[str, Any]:
    results = {}
    patterns = [
        (r'window\.(product|Product)\s*=\s*(\{.*?\});?', "window.product"),
        (r'window\.__PRODUCT__\s*=\s*(\{.*?\});?', "window.__PRODUCT__"),
        (r'window\.__PRODUCT_DATA__\s*=\s*(\{.*?\});?', "window.__PRODUCT_DATA__"),
        (r'window\.__PRODUCTS__\s*=\s*(\[.*?\]);?', "window.__PRODUCTS__"),
        (r'var\s+product\s*=\s*(\{.*?\});?', "var product"),
        (r'const\s+product\s*=\s*(\{.*?\});?', "const product"),
        (r'window\.__APP_DATA__\s*=\s*(\{.*?\});?', "window.__APP_DATA__"),
        (r'window\.__BOOTSTRAP__\s*=\s*(\{.*?\});?', "window.__BOOTSTRAP__"),
        (r'window\.__STATE__\s*=\s*(\{.*?\});?', "window.__STATE__"),
        (r'window\.__PRELOADED_STATE__\s*=\s*(\{.*?\});?', "window.__PRELOADED_STATE__"),
        (r'window\.__APOLLO_STATE__\s*=\s*(\{.*?\});?', "window.__APOLLO_STATE__"),
        (r'window\.__REACT_QUERY_STATE__\s*=\s*(\{.*?\});?', "window.__REACT_QUERY_STATE__"),
        (r'window\.Shopify\s*=\s*(\{.*?\});?', "window.Shopify"),
        (r'window\.ShopifyAnalytics\.meta\s*=\s*(\{.*?\});?', "ShopifyAnalytics.meta"),
        (r'window\.__SHOPIFY__\s*=\s*(\{.*?\});?', "window.__SHOPIFY__"),
        (r'window\.__remixContext\s*=\s*(\{.*?\});?', "remixContext"),
        (r'window\.meta\s*=\s*(\{.*?\});?', "window.meta"),
        (r'window\.__INITIAL_STATE__\.product\s*=\s*(\{.*?\});?', "initial_state.product"),
        (r'window\.wc_add_to_cart_params\s*=\s*(\{.*?\});?', "wc_add_to_cart_params"),
    ]

    for script in soup.find_all("script"):
        if not script.string:
            continue
        for pattern, label in patterns:
            for match in re.finditer(pattern, script.string, re.DOTALL):
                try:
                    group_idx = 2 if label == "window.product" else 1
                    data = json.loads(match.group(group_idx))
                    results[label] = data
                    if label == "remixContext" and isinstance(data, dict):
                        loader = _deep_get(data, "state", "loaderData")
                        if loader:
                            results["remixContext.loaderData"] = loader
                except (json.JSONDecodeError, TypeError, IndexError):
                    pass

    for script in soup.find_all("script", type="text/json"):
        if script.get("data-product-json") or script.get("id", "").startswith("ProductJson-"):
            try:
                data = json.loads(script.string)
                results["shopify_product_json"] = data
            except (json.JSONDecodeError, TypeError):
                pass

    return results

def _extract_microdata(soup: BeautifulSoup) -> List[Dict[str, Any]]:
    results = []
    for scope in soup.find_all(attrs={"itemscope": True}):
        itemtype = scope.get("itemtype", "")
        if "schema.org/Product" in itemtype or "schema.org/Offer" in itemtype:
            props = {}
            for prop in scope.find_all(attrs={"itemprop": True}):
                name = prop.get("itemprop", "")
                if prop.get("content"):
                    props[name] = prop["content"]
                elif prop.get("href"):
                    props[name] = prop["href"]
                elif prop.string:
                    props[name] = prop.string.strip()
            if props:
                results.append({"itemtype": itemtype, "properties": props})
    return results

def _extract_dom_text(soup: BeautifulSoup, include_body_text: bool = True) -> Dict[str, Any]:
    soup_copy = copy.copy(soup)

    for tag in soup_copy.find_all(EXCLUDED_TAGS):
        try:
            tag.decompose()
        except Exception:
            pass

    noise_pattern = re.compile(r"(sidebar|cookie|newsletter|related|recommend|popup|modal|menu|promo)", re.I)
    for noise in soup_copy.find_all(class_=noise_pattern):
        try:
            noise.decompose()
        except Exception:
            pass
    for noise in soup_copy.find_all(id=noise_pattern):
        try:
            noise.decompose()
        except Exception:
            pass

    result = {
        "title": soup_copy.title.string.strip() if soup_copy.title and soup_copy.title.string else "",
        "h1": [],
        "h2": [],
        "h3": [],
        "h4": [],
        "paragraphs": [],
        "body_text": "",
    }

    for h in soup_copy.find_all("h1"):
        text = h.get_text(strip=True)
        if text and len(text) > 2:
            result["h1"].append(text)

    for h in soup_copy.find_all("h2"):
        text = h.get_text(strip=True)
        if text and len(text) > 2:
            result["h2"].append(text)

    for h in soup_copy.find_all("h3"):
        text = h.get_text(strip=True)
        if text and len(text) > 2:
            result["h3"].append(text)

    for h in soup_copy.find_all("h4"):
        text = h.get_text(strip=True)
        if text and len(text) > 2:
            result["h4"].append(text)

    for p in soup_copy.find_all("p"):
        text = p.get_text(strip=True)
        if text and len(text) > 30:
            result["paragraphs"].append(text)

    if include_body_text and soup_copy.body:
        body_text = soup_copy.body.get_text(separator="\n", strip=True)
        result["body_text"] = body_text[:50000]

    return result

def _extract_tables(soup: BeautifulSoup) -> List[Dict[str, Any]]:
    tables = []
    for idx, table in enumerate(soup.find_all("table")):
        rows = []
        headers = []

        thead = table.find("thead")
        if thead:
            for th in thead.find_all(["th", "td"]):
                headers.append(th.get_text(strip=True))

        for tr in table.find_all("tr"):
            cells = []
            for td in tr.find_all(["td", "th"]):
                cells.append(td.get_text(strip=True))
            if cells and any(cells):
                rows.append(cells)

        if rows:
            tables.append({
                "index": idx,
                "headers": headers,
                "rows": rows,
                "caption": table.find("caption").get_text(strip=True) if table.find("caption") else "",
            })

    return tables

def _extract_lists(soup: BeautifulSoup) -> List[Dict[str, Any]]:
    lists = []
    for ul in soup.find_all("ul"):
        items = [li.get_text(strip=True) for li in ul.find_all("li")
                 if li.get_text(strip=True) and len(li.get_text(strip=True)) > 5]
        if len(items) >= 2:
            lists.append({"type": "ul", "items": items})

    for ol in soup.find_all("ol"):
        items = [li.get_text(strip=True) for li in ol.find_all("li")
                 if li.get_text(strip=True) and len(li.get_text(strip=True)) > 5]
        if len(items) >= 2:
            lists.append({"type": "ol", "items": items})

    return lists

def _extract_breadcrumb(soup: BeautifulSoup) -> List[str]:
    crumbs = []

    for script in soup.find_all("script", type="application/ld+json"):
        if not script.string:
            continue
        try:
            data = json.loads(script.string)
            candidates: List[Dict[str, Any]] = []
            if isinstance(data, list):
                candidates.extend(data)
            elif isinstance(data, dict):
                candidates.append(data)
                if "@graph" in data and isinstance(data["@graph"], list):
                    candidates.extend(data["@graph"])

            for candidate in candidates:
                if not isinstance(candidate, dict):
                    continue
                types = candidate.get("@type", "")
                if isinstance(types, str):
                    types = [types]
                if any(_normalize_schema_type(t) == "BreadcrumbList" for t in types):
                    items = candidate.get("itemListElement", [])
                    for item in items:
                        name = (
                            item.get("name", "")
                            or (item.get("item") or {}).get("name", "")
                        )
                        if name:
                            crumbs.append(name)
                    if crumbs:
                        return crumbs

        except (json.JSONDecodeError, TypeError):
            pass

    for nav in soup.find_all(attrs={"aria-label": re.compile(r"breadcrumb", re.I)}):
        for item in nav.find_all(["a", "span", "li"]):
            text = item.get_text(strip=True)
            if text and len(text) < 100:
                crumbs.append(text)
        if crumbs:
            return crumbs

    for sel in [".breadcrumb", "#breadcrumb", ".breadcrumbs", "#breadcrumbs",
                '[class*="breadcrumb"]', '[class*="breadcrumbs"]']:
        el = soup.select_one(sel)
        if el:
            for item in el.find_all(["a", "span", "li"]):
                text = item.get_text(strip=True)
                if text and len(text) < 100 and text not in crumbs:
                    crumbs.append(text)
            if crumbs:
                return crumbs

    return crumbs

async def _extract_preload_data(
    soup: BeautifulSoup,
    base_url: str,
    client: Any,
    timeout: float,
) -> List[Dict[str, Any]]:
    results = []
    seen: Set[str] = set()

    for link in soup.find_all("link", rel="preload"):
        as_attr = link.get("as", "").lower()
        href = link.get("href", "").strip()
        if as_attr != "fetch" or not href:
            continue

        full_url = urljoin(base_url, href)
        if full_url in seen:
            continue
        seen.add(full_url)

        try:
            if HAS_CURL_CFFI and isinstance(client, cffi_requests.AsyncSession):
                r = await client.get(full_url, timeout=timeout, impersonate="chrome124")
            else:
                req_headers = dict(client.headers) if hasattr(client, 'headers') else {}
                req_headers["Accept"] = "application/json, */*;q=0.8"
                r = await client.get(
                    full_url,
                    timeout=timeout,
                    headers=req_headers,
                )

            if r.status_code == 200:
                text = r.text
                try:
                    data = json.loads(text)
                    results.append({"url": full_url, "data": data})
                    logger.debug("Preload JSON fetched: %s", full_url)
                except (json.JSONDecodeError, TypeError):
                    pass
        except Exception as exc:
            logger.debug("Preload fetch failed for %s: %s", full_url, exc)

    return results

def _compute_confidence(sources: ExtractedSources) -> ConfidenceScore:
    c = ConfidenceScore()

    for s in sources.schema_org:
        c.has_schema_org = True
        if s.get("offers") or any("Offer" in str(v) for v in [s.get("@type", "")]):
            c.has_price = c.has_price or bool(
                _deep_get(s, "offers", "price") or
                _deep_get(s, "offers", "lowPrice")
            )
            c.has_availability = c.has_availability or bool(_deep_get(s, "offers", "availability"))
        c.has_sku = c.has_sku or bool(s.get("sku") or s.get("gtin13") or s.get("gtin14") or s.get("mpn"))
        c.has_brand = c.has_brand or bool(_deep_get(s, "brand", "name"))
        c.has_description = c.has_description or bool(s.get("description"))
        c.has_images = c.has_images or bool(s.get("image"))
        c.has_reviews = c.has_reviews or bool(
            s.get("aggregateRating") or s.get("review")
        )

    if sources.shopify_product:
        sp = sources.shopify_product
        c.has_schema_org = c.has_schema_org or True
        c.has_price = c.has_price or bool(
            sp.get("variants") and sp["variants"][0].get("price")
        )
        c.has_sku = c.has_sku or bool(sp.get("variants") and sp["variants"][0].get("sku"))
        c.has_description = c.has_description or bool(sp.get("body_html") or sp.get("description"))
        c.has_images = c.has_images or bool(sp.get("images"))
        c.has_brand = c.has_brand or bool(sp.get("vendor"))

    og = sources.open_graph
    c.has_open_graph = bool(og)
    c.has_price = c.has_price or bool(og.get("og:price:amount"))
    c.has_availability = c.has_availability or bool(og.get("og:availability"))
    c.has_description = c.has_description or bool(og.get("og:description"))
    c.has_images = c.has_images or bool(og.get("og:image"))

    c.has_twitter = bool(sources.twitter_card)

    meta = sources.meta_tags
    c.has_meta_description = bool(meta.get("description"))
    c.has_description = c.has_description or bool(meta.get("description"))

    c.has_breadcrumb = bool(sources.breadcrumb)

    score = 0.0
    weights = {
        "has_schema_org": 0.25,
        "has_open_graph": 0.10,
        "has_price": 0.15,
        "has_availability": 0.10,
        "has_description": 0.10,
        "has_images": 0.10,
        "has_sku": 0.05,
        "has_brand": 0.05,
        "has_reviews": 0.05,
        "has_breadcrumb": 0.05,
    }

    for attr, weight in weights.items():
        if getattr(c, attr):
            score += weight

    c.score = round(min(score, 1.0), 2)
    return c

def _deep_get(d: Any, *keys: str) -> Any:
    for key in keys:
        if isinstance(d, dict):
            d = d.get(key)
        else:
            return None
    return d

async def _take_lazy_screenshot(
    url: str,
    playwright_browser: Any,
    width: int = 1280,
    height: int = 800,
    timeout: float = 15.0
) -> Optional[ScreenshotData]:
    if not playwright_browser:
        return None

    page = None
    try:
        page = await playwright_browser.new_page(viewport={"width": width, "height": height})
        await page.goto(url, wait_until="networkidle", timeout=timeout * 1000)

        await page.evaluate(POPUP_BLOCKER_JS)
        await page.evaluate(PRE_SCREENSHOT_JS)
        await asyncio.sleep(0.5)

        screenshot = await page.screenshot(type="png", full_page=False)

        return ScreenshotData(
            base64=base64.b64encode(screenshot).decode(),
            width=width,
            height=height,
            format="png",
        )
    except Exception as exc:
        logger.warning("Lazy screenshot failed for %s: %s", url, exc)
        return None
    finally:
        if page is not None:
            try:
                await page.close()
            except Exception as close_exc:
                logger.debug("Page close error (non-fatal): %s", close_exc)

# -- Core lazy extraction ----------------------------------------------
async def extract_lazy(
    client: Any,
    url: str,
    config: PipelineConfig,
    playwright_browser: Optional[Any] = None,
    use_shopify_api: bool = True
) -> ExtractionResult:
    start_time = time.time()
    result = ExtractionResult(
        url=url,
        canonical_url=canonicalize_url(url),
        extraction_mode="lazy",
        extracted_at=datetime.now(timezone.utc).isoformat(),
    )

    shopify_product: Optional[Dict[str, Any]] = None
    if use_shopify_api and _is_shopify_domain(url):
        shopify_product = await _try_shopify_json(client, url, config.fetch_timeout)

    html_text, status_code, error_type = await _fetch_html(
        client, url, config.http_timeout, max_retries=config.fetch_max_retries
    )
    result.status_code = status_code

    if not html_text:
        result.success = False
        result.error = (
            f"Failed to fetch HTML (Status: {status_code}, ErrorType: {error_type})"
        )
        result.performance = {"total_time_ms": int((time.time() - start_time) * 1000)}
        return result

    parse_start = time.time()

    try:
        soup = BeautifulSoup(html_text, BS4_PARSER)
    except Exception as exc:
        result.success = False
        result.error = f"BeautifulSoup parse error: {exc}"
        result.performance = {"total_time_ms": int((time.time() - start_time) * 1000)}
        return result

    page_canonical = _extract_page_canonical(soup, result.canonical_url)
    result.canonical_url = page_canonical

    sources = ExtractedSources()
    sources.schema_org = _extract_schema_org(soup)
    sources.open_graph = _extract_open_graph(soup)
    sources.twitter_card = _extract_twitter_card(soup)
    sources.meta_tags = _extract_meta_tags(soup)
    sources.next_data = _extract_next_data(soup)
    sources.nuxt_data = _extract_nuxt_data(soup)
    sources.vue_data = _extract_vue_data(soup)
    sources.inline_js = _extract_inline_js_product_data(soup)
    sources.microdata = _extract_microdata(soup)
    sources.shopify_product = shopify_product

    if config.include_tables:
        sources.tables = _extract_tables(soup)
    if config.include_lists:
        sources.lists = _extract_lists(soup)
    if config.include_breadcrumb:
        sources.breadcrumb = _extract_breadcrumb(soup)
    if config.include_dom_text:
        sources.dom_text = _extract_dom_text(soup)

    if use_shopify_api:
        sources.preload_data = await _extract_preload_data(
            soup, url, client, config.fetch_timeout
        )

    screenshot = None
    if config.lazy_screenshot and config.include_screenshots and playwright_browser:
        screenshot = await _take_lazy_screenshot(
            url, playwright_browser, config.lazy_screenshot_width, config.lazy_screenshot_height
        )

    confidence = _compute_confidence(sources)

    result.success = True
    result.sources = sources.to_dict()
    result.confidence = confidence.to_dict()
    if screenshot:
        result.screenshot = screenshot.to_dict()

    elapsed = time.time() - start_time
    result.performance = {
        "fetch_time_ms": int((parse_start - start_time) * 1000),
        "parse_time_ms": int((time.time() - parse_start) * 1000),
        "total_time_ms": int(elapsed * 1000),
    }

    return result

# -- CloakBrowser launch helpers (same as image extractor) -------------
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
        f"--window-size={config.screenshot_width},{config.screenshot_height}",
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
            crawl_task = asyncio.create_task(crawler.arun(url=url, config=config))
            return await asyncio.wait_for(
                asyncio.shield(crawl_task),
                timeout=pipeline_config.crawl_timeout,
            )
        except asyncio.TimeoutError:
            logger.warning(
                "Timeout crawling %s (attempt %d/%d) - letting orphaned task finish gracefully in background",
                url, attempt + 1, pipeline_config.max_crawl_retries + 1
            )
            if attempt == pipeline_config.max_crawl_retries:
                raise
        except Exception as exc:
            logger.warning(
                "Error crawling %s (attempt %d/%d): %s",
                url, attempt + 1, pipeline_config.max_crawl_retries + 1, exc
            )
            if attempt == pipeline_config.max_crawl_retries:
                raise

        delay = pipeline_config.retry_base_delay * (2 ** attempt)
        await asyncio.sleep(delay)

# -- Full browser extraction -------------------------------------------
async def _extract_full_browser_core(
    crawler: AsyncWebCrawler,
    url: str,
    config: PipelineConfig,
    start_time: float,
) -> ExtractionResult:
    result = ExtractionResult(
        url=url,
        canonical_url=canonicalize_url(url),
        extraction_mode="full_browser",
        extracted_at=datetime.now(timezone.utc).isoformat(),
    )

    run_config = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        stream=False,
        js_code=JS_SCREENSHOT_PREP if config.include_screenshots else JS_LAZY_LOAD,
        excluded_tags=EXCLUDED_TAGS,
        screenshot=config.include_screenshots,
        screenshot_wait_for=1.0 if config.include_screenshots else None,
        force_viewport_screenshot=True if config.include_screenshots else False,
        remove_overlay_elements=True,
        remove_consent_popups=True,
    )

    try:
        crawl_result = await _crawl_single_with_retry(crawler, url, run_config, config)

        if not crawl_result.success:
            result.success = False
            result.error = crawl_result.error_message or "Crawl failed"
            result.performance = {"total_time_ms": int((time.time() - start_time) * 1000)}
            return result

        html_text = crawl_result.html or ""
        soup = BeautifulSoup(html_text, BS4_PARSER)

        page_canonical = _extract_page_canonical(soup, result.canonical_url)
        result.canonical_url = page_canonical

        sources = ExtractedSources()

        if crawl_result.metadata and crawl_result.metadata.get("json_ld"):
            try:
                json_ld = crawl_result.metadata["json_ld"]
                if isinstance(json_ld, list):
                    sources.schema_org = [item for item in json_ld if _is_product_schema(item)]
                elif _is_product_schema(json_ld):
                    sources.schema_org = [json_ld]
            except Exception:
                pass
        if not sources.schema_org:
            sources.schema_org = _extract_schema_org(soup)

        if crawl_result.metadata:
            og = {}
            for key, val in crawl_result.metadata.items():
                if key.startswith("og:") or key.startswith("og_"):
                    og[key.replace("og_", "og:")] = str(val)
            sources.open_graph = og if og else _extract_open_graph(soup)
        else:
            sources.open_graph = _extract_open_graph(soup)

        sources.twitter_card = _extract_twitter_card(soup)
        sources.meta_tags = _extract_meta_tags(soup)
        if crawl_result.metadata:
            sources.meta_tags.update({
                k: str(v) for k, v in crawl_result.metadata.items()
                if k not in sources.meta_tags and v is not None
            })

        sources.next_data = _extract_next_data(soup)
        sources.nuxt_data = _extract_nuxt_data(soup)
        sources.vue_data = _extract_vue_data(soup)
        sources.inline_js = _extract_inline_js_product_data(soup)
        sources.microdata = _extract_microdata(soup)

        if config.include_tables:
            sources.tables = _extract_tables(soup)
        if config.include_lists:
            sources.lists = _extract_lists(soup)
        if config.include_breadcrumb:
            sources.breadcrumb = _extract_breadcrumb(soup)
        if config.include_dom_text:
            sources.dom_text = _extract_dom_text(soup)
        if config.include_markdown and crawl_result.markdown:
            sources.markdown = (
                crawl_result.markdown.raw_markdown
                if hasattr(crawl_result.markdown, "raw_markdown")
                else str(crawl_result.markdown)
            )

        screenshot = None
        if config.include_screenshots:
            if crawl_result.screenshot:
                screenshot_data = crawl_result.screenshot
                if isinstance(screenshot_data, str):
                    screenshot = ScreenshotData(
                        base64=screenshot_data,
                        width=config.screenshot_width,
                        height=config.screenshot_height,
                        format="png",
                    )
                elif isinstance(screenshot_data, bytes):
                    screenshot = ScreenshotData(
                        base64=base64.b64encode(screenshot_data).decode(),
                        width=config.screenshot_width,
                        height=config.screenshot_height,
                        format="png",
                    )

            if config.save_screenshots_to_file and screenshot and screenshot.base64:
                os.makedirs(config.screenshots_dir, exist_ok=True)
                filename = f"{url_hash(url)}_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.png"
                filepath = os.path.join(config.screenshots_dir, filename)
                with open(filepath, "wb") as f:
                    f.write(base64.b64decode(screenshot.base64))
                screenshot.path = filepath
                screenshot.base64 = None

        confidence = _compute_confidence(sources)

        result.success = True
        result.sources = sources.to_dict()
        result.confidence = confidence.to_dict()
        if screenshot:
            result.screenshot = screenshot.to_dict()

    except Exception as exc:
        logger.exception("Full browser extraction failed for %s", url)
        result.success = False
        result.error = f"{type(exc).__name__}: {str(exc)}"

    elapsed = time.time() - start_time
    result.performance = {"total_time_ms": int(elapsed * 1000)}
    return result

async def extract_full_browser(
    url: str,
    config: PipelineConfig,
    client: httpx.AsyncClient,
    crawler: Optional[AsyncWebCrawler] = None,
) -> ExtractionResult:
    start_time = time.time()
    cb_browser = None
    xvfb_proc = None
    own_crawler = crawler is None

    try:
        if own_crawler:
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

            async with AsyncWebCrawler(config=browser_config) as crawler:
                return await _extract_full_browser_core(crawler, url, config, start_time)
        else:
            return await _extract_full_browser_core(crawler, url, config, start_time)

    except Exception as exc:
        logger.exception("Full browser extraction failed for %s", url)
        result = ExtractionResult(
            url=url,
            canonical_url=canonicalize_url(url),
            extraction_mode="full_browser",
            success=False,
            error=f"{type(exc).__name__}: {str(exc)}",
            extracted_at=datetime.now(timezone.utc).isoformat(),
        )
        elapsed = time.time() - start_time
        result.performance = {"total_time_ms": int(elapsed * 1000)}
        return result

    finally:
        if own_crawler:
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

# -- Batch orchestration -----------------------------------------------
async def run_batch(
    urls: List[str],
    lazy_extraction: bool = True,
    include_screenshots: bool = False,
    include_dom_text: bool = True,
    include_tables: bool = True,
    include_lists: bool = True,
    include_markdown: bool = True,
    include_breadcrumb: bool = True,
    lazy_screenshot: bool = False,
    modal_blocking: str = "aggressive",
    min_confidence: float = 0.3,
    cdp_port: int = 9243,
    concurrency: int = 8,
    browser_concurrency: int = 1,
    http_timeout: float = 10.0,
    crawl_timeout: float = 60.0,
    max_crawl_retries: int = 0,
    save_screenshots_to_file: bool = False,
    screenshots_dir: str = "",
    fetch_max_retries: int = 2,
) -> Dict[str, Any]:
    if not urls:
        return {}

    valid_urls = []
    seen_urls: Set[str] = set()
    for u in urls:
        if not isinstance(u, str):
            logger.warning("Skipping non-string URL: %r", u)
            continue
        u = u.strip()
        if not u.startswith(("http://", "https://")):
            logger.warning("Skipping malformed URL: %s", u)
            continue
        if u in seen_urls:
            continue
        seen_urls.add(u)
        valid_urls.append(u)

    if not valid_urls:
        return {}

    random.shuffle(valid_urls)

    config = PipelineConfig(
        min_confidence=min_confidence,
        include_screenshots=include_screenshots,
        modal_blocking=modal_blocking,
        include_dom_text=include_dom_text,
        include_tables=include_tables,
        include_lists=include_lists,
        include_markdown=include_markdown,
        include_breadcrumb=include_breadcrumb,
        lazy_screenshot=lazy_screenshot,
        cdp_port=cdp_port,
        concurrency=concurrency,
        browser_concurrency=browser_concurrency,
        http_timeout=http_timeout,
        crawl_timeout=crawl_timeout,
        max_crawl_retries=max_crawl_retries,
        save_screenshots_to_file=save_screenshots_to_file,
        screenshots_dir=screenshots_dir,
        fetch_max_retries=fetch_max_retries,
    )

    results: Dict[str, Any] = {}

    if lazy_extraction:
        logger.info("=== Phase 1: Tiered Lazy extraction for %d URL(s) ===", len(valid_urls))

        async with AsyncExitStack() as stack:
            limits = httpx.Limits(max_connections=50, max_keepalive_connections=20)
            timeout = httpx.Timeout(http_timeout, connect=5.0)

            if HAS_CURL_CFFI:
                client_advanced = await stack.enter_async_context(cffi_requests.AsyncSession())
            else:
                client_advanced = await stack.enter_async_context(
                    httpx.AsyncClient(limits=limits, timeout=timeout, headers=CHROME_HEADERS_2026)
                )

            client_classic = await stack.enter_async_context(
                httpx.AsyncClient(limits=limits, timeout=timeout, headers=CLASSIC_HEADERS)
            )

            pw_browser = None
            if config.lazy_screenshot and config.include_screenshots:
                try:
                    from playwright.async_api import async_playwright
                    playwright = await stack.enter_async_context(async_playwright())
                    pw_browser = await playwright.chromium.launch(headless=True)
                except ImportError:
                    pass
                except Exception as exc:
                    logger.warning("Could not launch Playwright browser: %s", exc)

            sem = asyncio.Semaphore(config.concurrency)

            async def _process_lazy(url: str) -> Tuple[str, ExtractionResult]:
                async with sem:
                    try:
                        res = await extract_lazy(client_advanced, url, config, pw_browser, use_shopify_api=True)

                        needs_fallback = False
                        if not res.success:
                            needs_fallback = True
                        elif res.status_code in (403, 429, 503):
                            needs_fallback = True
                        elif res.confidence.get("score", 0) < min_confidence:
                            needs_fallback = True

                        if needs_fallback:
                            logger.info(
                                "Advanced lazy mode insufficient for %s (status=%s, score=%.2f). Falling back to Classic lazy mode...",
                                url, res.status_code, res.confidence.get("score", 0)
                            )
                            try:
                                res_classic = await extract_lazy(client_classic, url, config, pw_browser, use_shopify_api=False)

                                if res_classic.success and (res_classic.confidence.get("score", 0) >= res.confidence.get("score", 0) or not res.success):
                                    logger.info("Classic lazy fallback succeeded for %s", url)
                                    return url, res_classic
                            except Exception as fallback_exc:
                                logger.warning("Classic lazy fallback crashed for %s: %s", url, fallback_exc)

                        return url, res
                    except Exception as exc:
                        logger.exception("Lazy extraction crashed for %s", url)
                        err = ExtractionResult(
                            url=url,
                            extraction_mode="lazy",
                            success=False,
                            error=f"{type(exc).__name__}: {str(exc)}",
                            extracted_at=datetime.now(timezone.utc).isoformat(),
                        )
                        return url, err

            lazy_results = await asyncio.gather(*(_process_lazy(url) for url in valid_urls))
            for url, res in lazy_results:
                results[url] = res.to_dict()
                if res.success:
                    logger.info(
                        "Lazy extraction success %s (confidence=%.2f)", url,
                        res.confidence.get("score", 0)
                    )
                else:
                    logger.warning("Lazy extraction failed %s: %s", url, res.error)

        failed_urls = []
        for url, res in results.items():
            if res.get("status_code") in (404, 410, 400):
                logger.info(
                    "Skipping Full Browser Phase for %s due to permanent HTTP %s",
                    url, res.get("status_code")
                )
                continue

            if not res["success"] or res.get("confidence", {}).get("score", 0) < min_confidence:
                failed_urls.append(url)

        if failed_urls:
            logger.info(
                "=== Phase 2: Full browser extraction for %d failed URL(s) ===",
                len(failed_urls)
            )
        else:
            logger.info("All URLs succeeded in lazy mode or permanently failed -- skipping full browser.")
            return results
    else:
        failed_urls = valid_urls
        logger.info(
            "=== Full browser extraction for %d URL(s) (lazy disabled) ===",
            len(failed_urls)
        )

    if failed_urls:
        limits = httpx.Limits(max_connections=50, max_keepalive_connections=20)
        timeout = httpx.Timeout(http_timeout, connect=5.0)
        async with httpx.AsyncClient(limits=limits, timeout=timeout, follow_redirects=True) as client:
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

                logger.info(
                    "Launching CloakBrowser on port %d (headless=%s, concurrency=%d)",
                    config.cdp_port, effective_headless, config.browser_concurrency
                )
                cb_browser = await asyncio.wait_for(
                    launch_async(headless=effective_headless, args=_build_cloak_args(config)),
                    timeout=config.cdp_health_timeout,
                )
                await _health_check_cdp(config.cdp_port, timeout=config.cdp_health_timeout)

                browser_config = BrowserConfig(
                    browser_mode="cdp",
                    cdp_url=f"http://127.0.0.1:{config.cdp_port}",
                )

                async with AsyncWebCrawler(config=browser_config) as crawler:
                    sem_browser = asyncio.Semaphore(max(1, config.browser_concurrency))

                    async def _process_full(url: str) -> Tuple[str, ExtractionResult]:
                        async with sem_browser:
                            try:
                                res = await extract_full_browser(url, config, client, crawler=crawler)
                                return url, res
                            except Exception as exc:
                                logger.exception("Full browser extraction crashed for %s", url)
                                err = ExtractionResult(
                                    url=url,
                                    extraction_mode="full_browser",
                                    success=False,
                                    error=f"{type(exc).__name__}: {str(exc)}",
                                    extracted_at=datetime.now(timezone.utc).isoformat(),
                                )
                                return url, err

                    full_results = await asyncio.gather(*(_process_full(url) for url in failed_urls))
                    for url, res in full_results:
                        results[url] = res.to_dict()
                        if res.success:
                            logger.info(
                                "Full browser success %s (confidence=%.2f)", url,
                                res.confidence.get("score", 0)
                            )
                        else:
                            logger.error("Full browser failed %s: %s", url, res.error)

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


# -- Example usage -----------------------------------------------------
if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="E-Commerce Product Text Extractor",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python ecom-text-extractor.py -u urls.json -o results.json --lazy-extraction
  python ecom-text-extractor.py -u urls.json -o results.json --no-lazy-extraction --include-screenshots --modal-blocking aggressive
  python ecom-text-extractor.py -u urls.json -o results.json --lazy-extraction --lazy-screenshot --save-screenshots-to-file --screenshots-dir ./screenshots
        """,
    )
    parser.add_argument(
        "-u", "--urls",
        required=True,
        help="Path to a JSON file containing a list of URLs (e.g. [url, url])",
    )
    parser.add_argument(
        "-o", "--output",
        required=True,
        help="Path to write the output JSON results",
    )
    parser.add_argument(
        "--lazy-extraction",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="Use lightweight HTTP-only extraction first (default: --lazy-extraction)",
    )
    parser.add_argument(
        "--include-screenshots",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="Capture screenshots (default: --no-include-screenshots)",
    )
    parser.add_argument(
        "--lazy-screenshot",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="Capture screenshots even in lazy mode via Playwright (default: --no-lazy-screenshot)",
    )
    parser.add_argument(
        "--modal-blocking",
        choices=["none", "conservative", "aggressive"],
        default="aggressive",
        help="Modal/popup/cookie banner blocking aggressiveness (default: aggressive)",
    )
    parser.add_argument(
        "--min-confidence",
        type=float,
        default=0.3,
        help="Minimum confidence score to consider lazy extraction successful (default: 0.3)",
    )
    parser.add_argument(
        "--cdp-port",
        type=int,
        default=9243,
        help="Chrome DevTools Protocol port for full-browser mode (default: 9243)",
    )
    parser.add_argument(
        "--concurrency",
        type=int,
        default=8,
        help="Max concurrent lazy extractions (default: 8)",
    )
    parser.add_argument(
        "--browser-concurrency",
        type=int,
        default=1,
        help="Max concurrent full browser extractions (default: 1 for stability)",
    )
    parser.add_argument(
        "--http-timeout",
        type=float,
        default=10.0,
        help="HTTP timeout in seconds (default: 10.0)",
    )
    parser.add_argument(
        "--crawl-timeout",
        type=float,
        default=60.0,
        help="Browser crawl timeout in seconds (default: 60.0)",
    )
    parser.add_argument(
        "--max-crawl-retries",
        type=int,
        default=0,
        help="Max retries for browser crawl (default: 0 to fail fast)",
    )
    parser.add_argument(
        "--fetch-max-retries",
        type=int,
        default=2,
        help="Max retries for HTTP fetch (5xx) in lazy mode (default: 2)",
    )
    parser.add_argument(
        "--save-screenshots-to-file",
        action=argparse.BooleanOptionalAction,
        default=False,
        help="Save screenshots to files instead of base64 in JSON (default: --no-save-screenshots-to-file)",
    )
    parser.add_argument(
        "--screenshots-dir",
        type=str,
        default="",
        help="Directory to save screenshots (default: current directory)",
    )
    parser.add_argument(
        "--no-dom-text",
        dest="include_dom_text",
        action="store_false",
        default=True,
        help="Skip DOM text extraction",
    )
    parser.add_argument(
        "--no-tables",
        dest="include_tables",
        action="store_false",
        default=True,
        help="Skip table extraction",
    )
    parser.add_argument(
        "--no-lists",
        dest="include_lists",
        action="store_false",
        default=True,
        help="Skip list extraction",
    )
    parser.add_argument(
        "--no-markdown",
        dest="include_markdown",
        action="store_false",
        default=True,
        help="Skip markdown generation in full browser mode",
    )
    parser.add_argument(
        "--no-breadcrumb",
        dest="include_breadcrumb",
        action="store_false",
        default=True,
        help="Skip breadcrumb extraction",
    )

    args = parser.parse_args()

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

    results = asyncio.run(
        run_batch(
            urls=urls,
            lazy_extraction=args.lazy_extraction,
            include_screenshots=args.include_screenshots,
            include_dom_text=args.include_dom_text,
            include_tables=args.include_tables,
            include_lists=args.include_lists,
            include_markdown=args.include_markdown,
            include_breadcrumb=args.include_breadcrumb,
            lazy_screenshot=args.lazy_screenshot,
            modal_blocking=args.modal_blocking,
            min_confidence=args.min_confidence,
            cdp_port=args.cdp_port,
            concurrency=args.concurrency,
            browser_concurrency=args.browser_concurrency,
            http_timeout=args.http_timeout,
            crawl_timeout=args.crawl_timeout,
            max_crawl_retries=args.max_crawl_retries,
            save_screenshots_to_file=args.save_screenshots_to_file,
            screenshots_dir=args.screenshots_dir,
            fetch_max_retries=args.fetch_max_retries,
        )
    )

    out_dir = os.path.dirname(args.output)
    if out_dir and not os.path.exists(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

    total = len(results)
    successes = sum(1 for r in results.values() if r.get("success"))
    failures = total - successes
    lazy_success = sum(1 for r in results.values() if r.get("success") and r.get("extraction_mode") == "lazy")
    full_success = sum(1 for r in results.values() if r.get("success") and r.get("extraction_mode") == "full_browser")

    logger.info("=" * 60)
    logger.info("EXTRACTION COMPLETE")
    logger.info("  Total URLs:    %d", total)
    logger.info("  Successes:     %d", successes)
    logger.info("    - Lazy mode: %d", lazy_success)
    logger.info("    - Full mode: %d", full_success)
    logger.info("  Failures:      %d", failures)
    logger.info("  Output:        %s", args.output)
    logger.info("=" * 60)

    if failures > 0:
        logger.warning("Failed URLs:")
        for url, res in results.items():
            if not res.get("success"):
                logger.warning("  %s -> %s", url, res.get("error", "unknown"))
