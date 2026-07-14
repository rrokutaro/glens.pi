#!/usr/bin/env python3
"""
E-Commerce Product Text Extractor (Production-Ready v2.1.3 - Merged/Exhaustive)

Dual-mode extraction tool for scraping structured product data from
e-commerce product pages. Designed for integration with the UGC dropship
pipeline and review server.

Upgrades (v2.1.3):
  - Always Merge: In fallback paths (when lazy extraction fails or is incomplete 
    but still yields partial data), successful browser data is now merged with 
    the partial lazy data rather than overwriting it, ensuring zero data loss.

Upgrades (v2.1.2):
  - Refined Exhaustive Merge logic: `_prefer_richer_dict` now uses canonical, 
    minified JSON string length (sorted keys, no spaces) to compare object sizes 
    deterministically, eliminating false positives caused by memory/insertion order.

Upgrades (v2.1.1):
  - Upgraded Exhaustive Merge logic: Framework data (Next.js, Vue, Shopify) 
    now uses a "Richer Dict" comparison to prevent partial-data overwrites.

Upgrades (v2.1.0):
  - Added Exhaustive Merge Mode (--exhaustive): Runs both Lazy and Full Browser 
    and intelligently merges data to avoid bloat while maximizing extraction.
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
from contextlib import AsyncExitStack, asynccontextmanager
from dataclasses import dataclass, field, asdict
from typing import Optional, Tuple, List, Dict, Any, Union, Set
from io import BytesIO
from urllib.parse import urlsplit, urlunsplit, parse_qsl, urlencode, urljoin
from datetime import datetime, timezone
from collections import defaultdict

import httpx
from bs4 import BeautifulSoup, NavigableString
from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig, CacheMode
from cloakbrowser import launch_async

# Optional TLS Impersonation dependency for Anti-Bot Bypassing
try:
    from curl_cffi import requests as cffi_requests
    HAS_CURL_CFFI = True
except ImportError:
    HAS_CURL_CFFI = False

# Optional lxml for faster HTML parsing
try:
    import lxml  # noqa: F401
    BS4_PARSER = "lxml"
except ImportError:
    BS4_PARSER = "html.parser"

# Robust JavaScript object literal extraction
try:
    import chompjs
    HAS_CHOMPJS = True
except ImportError:
    HAS_CHOMPJS = False
    logger.warning(
        "chompjs not installed. Falling back to regex for inline JS (may miss nested data). "
        "Recommend: pip install chompjs"
    )

# -- Logging -----------------------------------------------------------
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("ecom_text_extractor")

if not HAS_CURL_CFFI:
    logger.warning(
        "curl_cffi not installed. Falling back to standard httpx for advanced lazy extraction."
    )

# -- Constants --------------------------------------------------------
EXCLUDED_TAGS = [
    "script", "style", "noscript", "iframe", "canvas", "svg",
    "nav", "footer", "aside", "header", "form"
]

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

MAX_RESPONSE_SIZE = 5_000_000

# -- Font detection ---------------------------
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
    try:
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(0.5)
        if proc.poll() is not None:
            return None
        os.environ["DISPLAY"] = display
        return proc
    except Exception as exc:
        logger.error("Failed to start Xvfb: %s", exc)
        return None

# -- URL utilities -----------------------------------------------------
def normalize_url(u: str) -> str:
    if not u: return ""
    u = u.strip()
    return "https:" + u if u.startswith("//") else u

def canonicalize_url(u: str) -> str:
    if not u: return ""
    parts = urlsplit(u)
    q = [(k, v) for k, v in parse_qsl(parts.query)
         if k.lower() not in frozenset({
             "utm_source", "utm_medium", "utm_campaign",
             "utm_term", "utm_content", "fbclid", "gclid",
             "ref", "source", "mc_cid", "mc_eid",
         })]
    return urlunsplit((
        parts.scheme.lower(), parts.netloc.lower(), parts.path.rstrip("/"),
        urlencode(sorted(q, key=lambda kv: kv[0])), ""
    ))

# -- Shopify detection helpers -----------------------------------------
def _is_shopify_domain(url: str) -> bool:
    parts = urlsplit(url)
    host = parts.netloc.lower()
    if host.endswith(".myshopify.com"): return True
    if re.search(r"/products/[^/?#]+", parts.path): return True
    return False

def _shopify_json_url(url: str) -> Optional[str]:
    parts = urlsplit(url)
    match = re.match(r"(/products/[^/?#]+)", parts.path)
    if not match: return None
    product_path = match.group(1).rstrip("/")
    return urlunsplit((parts.scheme, parts.netloc, product_path + ".json", "", ""))

async def _try_shopify_json(client: Any, url: str, timeout: float) -> Optional[Dict[str, Any]]:
    json_url = _shopify_json_url(url)
    if not json_url: return None
    try:
        if HAS_CURL_CFFI and isinstance(client, cffi_requests.AsyncSession):
            r = await client.get(json_url, timeout=timeout, impersonate="chrome124")
        else:
            r = await client.get(json_url, timeout=timeout)
        if r.status_code == 200:
            data = r.json() if hasattr(r, "json") and callable(r.json) else json.loads(r.text)
            if isinstance(data, dict) and "product" in data:
                return data["product"]
    except Exception:
        pass
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
    sizing_guide_url: Optional[str] = None

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
class CompletenessAudit:
    has_title: bool = False
    has_price: bool = False
    has_availability: bool = False
    has_description: bool = False
    has_images: bool = False
    has_variants: bool = False
    has_sizing_guide: bool = False
    is_complete: bool = False
    missing: List[str] = field(default_factory=list)

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
    confidence: Dict[str, Any] = field(default_factory=dict)
    completeness: Dict[str, Any] = field(default_factory=dict)
    performance: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

@dataclass
class PipelineConfig:
    min_confidence: float = 0.3
    enforce_completeness: bool = True
    exhaustive_mode: bool = False
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
    crawl_timeout: float = 60.0
    max_crawl_retries: int = 0
    retry_base_delay: float = 2.0
    cdp_health_timeout: float = 30.0
    fetch_max_retries: int = 2
    per_domain_concurrency: int = 2

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
    if "ssl" in name or "ssl" in msg or "certificate" in msg: return FetchErrorType.SSL_ERROR
    if "timeout" in name or "timed out" in msg or "deadline" in msg: return FetchErrorType.TIMEOUT
    if "name or service not known" in msg or "nodename" in msg or "gaierror" in msg: return FetchErrorType.DNS_ERROR
    if "connect" in name or "connection" in msg: return FetchErrorType.NETWORK
    return FetchErrorType.UNKNOWN

async def _fetch_html(
    client: Any, url: str, timeout: float, max_retries: int = 2,
) -> Tuple[Optional[str], Optional[int], Optional[str]]:
    last_status, last_error = None, None

    for attempt in range(max_retries + 1):
        try:
            if HAS_CURL_CFFI and isinstance(client, cffi_requests.AsyncSession):
                r = await client.get(url, timeout=timeout, allow_redirects=True, impersonate="chrome124")
                if "text/html" not in r.headers.get("content-type", ""):
                    return None, r.status_code, FetchErrorType.HTTP_ERROR
                if len(r.text) > MAX_RESPONSE_SIZE:
                    return None, r.status_code, FetchErrorType.HTTP_ERROR
                last_status = r.status_code
                if r.status_code == 200: return r.text, r.status_code, None
            else:
                async with client.stream("GET", url, timeout=timeout, follow_redirects=True) as resp:
                    if "text/html" not in resp.headers.get("content-type", ""):
                        return None, resp.status_code, FetchErrorType.HTTP_ERROR
                    body_chunks, total = [], 0
                    async for chunk in resp.aiter_bytes(chunk_size=8192):
                        total += len(chunk)
                        if total > MAX_RESPONSE_SIZE:
                            return None, resp.status_code, FetchErrorType.HTTP_ERROR
                        body_chunks.append(chunk)
                    html = b"".join(body_chunks).decode(resp.encoding or "utf-8", errors="replace")
                    last_status = resp.status_code
                    if resp.status_code == 200: return html, resp.status_code, None

            if last_status == 429 and attempt < max_retries: return None, last_status, FetchErrorType.HTTP_ERROR
            if last_status in (500, 502, 503, 504) and attempt < max_retries:
                await asyncio.sleep(2.0 * (2 ** attempt))
                continue
            return None, last_status, FetchErrorType.HTTP_ERROR
        except Exception as exc:
            last_error = _classify_fetch_error(exc)
            if last_error in (FetchErrorType.DNS_ERROR, FetchErrorType.SSL_ERROR):
                return None, None, last_error
            if attempt < max_retries:
                await asyncio.sleep(1.5 * (2 ** attempt))
                continue
            return None, last_status, last_error

    return None, last_status, last_error or FetchErrorType.UNKNOWN

def _normalize_schema_type(t: str) -> str:
    return t.rsplit("/", 1)[-1] if isinstance(t, str) and "/" in t else str(t)

def _is_product_schema(obj: Dict[str, Any]) -> bool:
    if not isinstance(obj, dict): return False
    types = obj.get("@type", "")
    types = [types] if isinstance(types, str) else types
    return any(_normalize_schema_type(t) in {"Product", "IndividualProduct", "ProductGroup", "ProductModel", "SomeProducts"} for t in types)

def _collect_product_schemas(data: Any) -> List[Dict[str, Any]]:
    results = []
    if isinstance(data, list):
        for item in data: results.extend(_collect_product_schemas(item))
    elif isinstance(data, dict):
        if _is_product_schema(data): results.append(data)
        if "@graph" in data: results.extend(_collect_product_schemas(data["@graph"]))
    return results

def _extract_schema_org(soup: BeautifulSoup) -> List[Dict[str, Any]]:
    results, seen = [], set()
    for script in soup.find_all("script", type="application/ld+json"):
        if not script.string: continue
        try:
            for item in _collect_product_schemas(json.loads(script.string)):
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
        prop, content = meta.get("property", ""), meta.get("content", "")
        if prop and content:
            existing = og.get(prop)
            if existing: og[prop] = [existing, content] if isinstance(existing, str) else existing + [content]
            else: og[prop] = content
    return og

def _extract_twitter_card(soup: BeautifulSoup) -> Dict[str, str]:
    tw = {}
    for meta in soup.find_all("meta", attrs={"name": re.compile(r"^twitter:")}):
        tw[meta.get("name")] = meta.get("content", "")
    for meta in soup.find_all("meta", property=re.compile(r"^twitter:")):
        tw[meta.get("property")] = meta.get("content", "")
    return {k: v for k, v in tw.items() if k and v}

def _extract_meta_tags(soup: BeautifulSoup) -> Dict[str, str]:
    meta = {}
    if soup.title and soup.title.string: meta["title"] = soup.title.string.strip()
    tag_map = {
        "description": ["name", "description"], "keywords": ["name", "keywords"],
        "robots": ["name", "robots"], "canonical": ["rel", "canonical"],
    }
    for key, (attr, val) in tag_map.items():
        if attr == "rel":
            el = soup.find("link", rel=val)
            if el and el.get("href"): meta[key] = el["href"]
        else:
            el = soup.find("meta", attrs={attr: val})
            if el and el.get("content"): meta[key] = el["content"]

    for meta_tag in soup.find_all("meta"):
        name, prop, content = meta_tag.get("name", "").lower(), meta_tag.get("property", "").lower(), meta_tag.get("content", "")
        if any(name.startswith(p) for p in ["product:", "price", "currency", "availability", "sku", "brand"]): meta[name] = content
        if any(prop.startswith(p) for p in ["product:", "price", "currency", "availability", "sku", "brand"]): meta[prop] = content
    return meta

def _extract_page_canonical(soup: BeautifulSoup, fallback: str) -> str:
    tag = soup.find("link", rel="canonical")
    if tag and tag.get("href"):
        href = tag["href"].strip()
        if href.startswith("http"): return href
    return fallback

def _extract_next_data(soup: BeautifulSoup) -> Optional[Dict[str, Any]]:
    script = soup.find("script", id="__NEXT_DATA__")
    if script and script.string:
        try: return json.loads(script.string)
        except (json.JSONDecodeError, TypeError): pass
    return None

def _extract_nuxt_data(soup: BeautifulSoup) -> Optional[Dict[str, Any]]:
    script_n3 = soup.find("script", id="__NUXT_DATA__", type="application/json")
    if script_n3 and script_n3.string:
        try: return json.loads(script_n3.string)
        except Exception: pass
    return None

def _extract_vue_data(soup: BeautifulSoup) -> Optional[Dict[str, Any]]:
    for script in soup.find_all("script"):
        if script.string and "window.__INITIAL_STATE__" in script.string:
            match = re.search(r'window\.__INITIAL_STATE__\s*=\s*(\{.*?\});?\s*$', script.string, re.DOTALL)
            if match:
                try: return json.loads(match.group(1))
                except Exception: pass
    return None

def _extract_js_object(text: str, var_name: str) -> Optional[dict]:
    idx = text.find(var_name)
    if idx == -1: return None
    start = text.find("{", idx)
    if start == -1: return None
    brace_count = 0
    for i in range(start, len(text)):
        c = text[i]
        if c == "{": brace_count += 1
        elif c == "}":
            brace_count -= 1
            if brace_count == 0:
                chunk = text[start:i+1]
                try:
                    if HAS_CHOMPJS: return chompjs.parse_js_object(chunk)
                    return json.loads(chunk)
                except Exception: return None
    return None

def _extract_inline_js_product_data(soup: BeautifulSoup) -> Dict[str, Any]:
    results = {}
    var_names = [
        ("window.product", "window.product"), ("window.__PRODUCT__", "window.__PRODUCT__"),
        ("window.__PRODUCTS__", "window.__PRODUCTS__"), ("var product", "var product"),
        ("window.__APP_DATA__", "window.__APP_DATA__"), ("window.__STATE__", "window.__STATE__"),
        ("window.Shopify", "window.Shopify"), ("window.__INITIAL_STATE__.product", "initial_state.product")
    ]
    for script in soup.find_all("script"):
        if not script.string: continue
        for var, label in var_names:
            obj = _extract_js_object(script.string, var)
            if obj: results[label] = obj
    return results

def _extract_microdata(soup: BeautifulSoup) -> List[Dict[str, Any]]:
    results = []
    for scope in soup.find_all(attrs={"itemscope": True}):
        itemtype = scope.get("itemtype", "")
        if "schema.org/Product" in itemtype or "schema.org/Offer" in itemtype:
            props = {}
            for prop in scope.find_all(attrs={"itemprop": True}):
                name = prop.get("itemprop", "")
                if prop.get("content"): props[name] = prop["content"]
                elif prop.get("href"): props[name] = prop["href"]
                elif prop.string: props[name] = prop.string.strip()
            if props: results.append({"itemtype": itemtype, "properties": props})
    return results

def _extract_dom_text(soup: BeautifulSoup, include_body_text: bool = True) -> Dict[str, Any]:
    soup_copy = copy.copy(soup)
    for tag in soup_copy.find_all(EXCLUDED_TAGS): tag.decompose()
    for noise in soup_copy.find_all(class_=re.compile(r"(sidebar|cookie|newsletter|related|recommend|popup|modal|menu|promo)", re.I)): noise.decompose()

    result = {
        "title": soup_copy.title.string.strip() if soup_copy.title and soup_copy.title.string else "",
        "h1": [h.get_text(strip=True) for h in soup_copy.find_all("h1") if len(h.get_text(strip=True)) > 2],
        "h2": [h.get_text(strip=True) for h in soup_copy.find_all("h2") if len(h.get_text(strip=True)) > 2],
        "h3": [h.get_text(strip=True) for h in soup_copy.find_all("h3") if len(h.get_text(strip=True)) > 2],
        "h4": [h.get_text(strip=True) for h in soup_copy.find_all("h4") if len(h.get_text(strip=True)) > 2],
        "paragraphs": [p.get_text(strip=True) for p in soup_copy.find_all("p") if len(p.get_text(strip=True)) > 30],
        "body_text": soup_copy.body.get_text(separator="\n", strip=True)[:50000] if include_body_text and soup_copy.body else "",
    }
    return result

def _extract_tables(soup: BeautifulSoup) -> List[Dict[str, Any]]:
    tables = []
    for idx, table in enumerate(soup.find_all("table")):
        headers = [th.get_text(strip=True) for th in table.find_all(["th", "td"]) if table.find("thead") and th in table.find("thead")]
        rows = [[td.get_text(strip=True) for td in tr.find_all(["td", "th"])] for tr in table.find_all("tr") if any(td.get_text(strip=True) for td in tr.find_all(["td", "th"]))]
        if rows: tables.append({"index": idx, "headers": headers, "rows": rows})
    return tables

def _extract_lists(soup: BeautifulSoup) -> List[Dict[str, Any]]:
    lists = []
    for ul in soup.find_all("ul"):
        items = [li.get_text(strip=True) for li in ul.find_all("li") if len(li.get_text(strip=True)) > 5]
        if len(items) >= 2: lists.append({"type": "ul", "items": items})
    return lists

def _extract_breadcrumb(soup: BeautifulSoup) -> List[str]:
    crumbs = []
    for nav in soup.find_all(attrs={"aria-label": re.compile(r"breadcrumb", re.I)}):
        for item in nav.find_all(["a", "span", "li"]):
            if item.get_text(strip=True) and len(item.get_text(strip=True)) < 100:
                crumbs.append(item.get_text(strip=True))
        if crumbs: return crumbs
    return crumbs

def _extract_sizing_guide_link(soup: BeautifulSoup, base_url: str) -> Optional[str]:
    keywords = ["size chart", "size guide", "sizing guide", "measurement guide", "fit guide"]
    for a in soup.find_all("a", href=True):
        text = a.get_text(strip=True).lower()
        if any(k in text for k in keywords) and not a["href"].startswith("javascript:") and a["href"] != "#":
            return urljoin(base_url, a["href"])
    return None

async def _extract_preload_data(soup: BeautifulSoup, base_url: str, client: Any, timeout: float) -> List[Dict[str, Any]]:
    results, seen = [], set()
    for link in soup.find_all("link", rel="preload"):
        if link.get("as", "").lower() == "fetch" and link.get("href"):
            full_url = urljoin(base_url, link["href"])
            if full_url in seen: continue
            seen.add(full_url)
            try:
                r = await client.get(full_url, timeout=timeout)
                if r.status_code == 200: results.append({"url": full_url, "data": r.json()})
            except Exception: pass
    return results

# -- Core Completeness & Audit Engine (Hardened Checkers) --------------

def _has_valid_price(obj: Any) -> bool:
    if isinstance(obj, dict):
        for k, v in obj.items():
            k_lower = str(k).lower()
            if "price" in k_lower and not any(x in k_lower for x in ("compare", "currency", "range", "sort")):
                if isinstance(v, (int, float)) and v > 0: return True
                if isinstance(v, str) and any(c.isdigit() for c in v): return True
            if isinstance(v, (dict, list)):
                if _has_valid_price(v): return True
    elif isinstance(obj, list):
        for item in obj:
            if _has_valid_price(item): return True
    return False

def _has_valid_variants(obj: Any) -> bool:
    if isinstance(obj, dict):
        for k, v in obj.items():
            k_lower = str(k).lower()
            if k_lower in ("variants", "variant", "options", "variantdata", "productvariants"):
                if isinstance(v, list) and len(v) > 0: return True
                if isinstance(v, dict) and len(v.keys()) > 0: return True
            if isinstance(v, (dict, list)):
                if _has_valid_variants(v): return True
    elif isinstance(obj, list):
        for item in obj:
            if _has_valid_variants(item): return True
    return False

def _has_valid_availability(obj: Any) -> bool:
    if isinstance(obj, dict):
        for k, v in obj.items():
            k_lower = str(k).lower()
            if "availab" in k_lower or "inventory" in k_lower or "stock" in k_lower:
                if v is not None and v != "" and v != []: return True
            if isinstance(v, (dict, list)):
                if _has_valid_availability(v): return True
    elif isinstance(obj, list):
        for item in obj:
            if _has_valid_availability(item): return True
    return False

def _audit_completeness(sources: Dict[str, Any]) -> CompletenessAudit:
    audit = CompletenessAudit()
    missing: List[str] = []

    schema_org = sources.get("schema_org") or []
    schema_org = [schema_org] if not isinstance(schema_org, list) else schema_org
    og = sources.get("open_graph") or {}
    meta = sources.get("meta_tags") or {}
    dom = sources.get("dom_text") or {}
    inline = sources.get("inline_js") or {}
    shopify = sources.get("shopify_product") or {}
    tables = sources.get("tables") or []

    # Title
    audit.has_title = bool(meta.get("title") or dom.get("h1") or any(s.get("name") for s in schema_org if isinstance(s, dict)))
    if not audit.has_title: missing.append("title")

    # Price
    audit.has_price = (
        _has_valid_price(schema_org) or
        bool(og.get("og:price:amount") or meta.get("product:price:amount") or meta.get("price")) or
        _has_valid_price(shopify) or
        any(_has_valid_price(v) for v in inline.values())
    )
    if not audit.has_price: missing.append("price")

    # Availability
    audit.has_availability = (
        _has_valid_availability(schema_org) or
        bool(og.get("og:availability") or meta.get("product:availability") or meta.get("availability")) or
        _has_valid_availability(shopify) or
        any(_has_valid_availability(v) for v in inline.values())
    )
    if not audit.has_availability: missing.append("availability")

    # Description
    audit.has_description = bool(meta.get("description") or any(s.get("description") for s in schema_org if isinstance(s, dict)) or dom.get("paragraphs"))
    if not audit.has_description: missing.append("description")

    # Images
    audit.has_images = bool(
        any(s.get("image") for s in schema_org if isinstance(s, dict)) or og.get("og:image") or meta.get("image") or shopify.get("images")
    )
    if not audit.has_images: missing.append("images")

    # Variants
    variants_found = _has_valid_variants(shopify) or _has_valid_variants(schema_org) or any(_has_valid_variants(v) for v in inline.values())
    if not variants_found:
        for t in tables:
            if isinstance(t, dict):
                combined = " ".join(t.get("headers") or []).lower() + " ".join(" ".join(r) for r in (t.get("rows") or [])).lower()
                if any(k in combined for k in ["size", "cm", "inch", "chest", "waist", "length", "xs", "s", "m", "l", "xl"]):
                    variants_found = True
                    break
    audit.has_variants = variants_found
    if not audit.has_variants: missing.append("variants")

    # Sizing
    sizing_found = bool(sources.get("sizing_guide_url"))
    if not sizing_found:
        body = (dom.get("body_text") or "").lower() + " ".join(p.lower() for p in (dom.get("paragraphs") or []))
        if any(k in body for k in ["size chart", "sizing guide", "size guide", "measurement guide", "fit guide"]): sizing_found = True
    audit.has_sizing_guide = sizing_found
    if not audit.has_sizing_guide: missing.append("sizing_guide")

    critical = [m for m in missing if m in ("title", "price", "availability", "description", "images", "variants")]
    audit.is_complete = len(critical) == 0
    audit.missing = missing
    return audit

def _compute_confidence(sources: ExtractedSources) -> ConfidenceScore:
    c = ConfidenceScore()
    for s in sources.schema_org:
        c.has_schema_org = True
        if s.get("offers"):
            c.has_price = c.has_price or _has_valid_price(s.get("offers"))
            c.has_availability = c.has_availability or _has_valid_availability(s.get("offers"))
        c.has_sku = c.has_sku or bool(s.get("sku") or s.get("mpn"))
        c.has_brand = c.has_brand or bool(isinstance(s.get("brand"), dict) and s["brand"].get("name"))
        c.has_description = c.has_description or bool(s.get("description"))
        c.has_images = c.has_images or bool(s.get("image"))

    if sources.shopify_product:
        c.has_schema_org, c.has_price, c.has_sku, c.has_description, c.has_images, c.has_brand = True, True, True, True, True, True

    og = sources.open_graph
    c.has_open_graph = bool(og)
    c.has_price = c.has_price or bool(og.get("og:price:amount"))
    c.has_availability = c.has_availability or bool(og.get("og:availability"))
    
    c.has_twitter = bool(sources.twitter_card)
    c.has_meta_description = bool(sources.meta_tags.get("description"))
    c.has_breadcrumb = bool(sources.breadcrumb)

    score = 0.0
    weights = {"has_schema_org": 0.25, "has_open_graph": 0.10, "has_price": 0.15, "has_availability": 0.10, "has_description": 0.10, "has_images": 0.10, "has_sku": 0.05, "has_brand": 0.05, "has_reviews": 0.05, "has_breadcrumb": 0.05}
    for attr, weight in weights.items():
        if getattr(c, attr): score += weight
    c.score = round(min(score, 1.0), 2)
    return c

# -- Smart Exhaustive Merger -------------------------------------------

def _prefer_richer_dict(lazy_val: Any, browser_val: Any) -> Any:
    """
    Intelligently compares two objects (usually dicts) and returns the one with the most data.
    This prevents a scenario where a weak/empty object (e.g. `{"props": {}}`) overrides 
    a fully populated object simply because the weak object is truthy.
    """
    if not lazy_val: return browser_val
    if not browser_val: return lazy_val
    
    if isinstance(lazy_val, dict) and isinstance(browser_val, dict):
        try:
            # Canonical size: JSON with sorted keys, ignoring formatting whitespace
            lazy_size = len(json.dumps(lazy_val, sort_keys=True, default=str, separators=(',', ':')))
            browser_size = len(json.dumps(browser_val, sort_keys=True, default=str, separators=(',', ':')))
            if lazy_size >= browser_size:
                return lazy_val
            return browser_val
        except Exception:
            # Fallback for completely un-serializable objects (prevents crashing)
            if len(str(lazy_val)) >= len(str(browser_val)):
                return lazy_val
            return browser_val
            
    return lazy_val

def _merge_sources(lazy: Dict[str, Any], browser: Dict[str, Any]) -> ExtractedSources:
    """Intelligently merge Lazy and Browser payloads to avoid data duplication."""
    merged = ExtractedSources()

    def dedup_dicts(list_a, list_b):
        seen = set()
        out = []
        for item in (list_a or []) + (list_b or []):
            if not isinstance(item, dict): continue
            h = hashlib.md5(json.dumps(item, sort_keys=True, default=str).encode('utf-8')).hexdigest()
            if h not in seen:
                seen.add(h)
                out.append(item)
        return out

    def dedup_lists(list_a, list_b):
        seen = set()
        out = []
        for item in (list_a or []) + (list_b or []):
            k = str(item).strip()
            if k and k not in seen:
                seen.add(k)
                out.append(item)
        return out

    # Deduplicated Lists/Arrays
    merged.schema_org = dedup_dicts(lazy.get("schema_org"), browser.get("schema_org"))
    merged.microdata = dedup_dicts(lazy.get("microdata"), browser.get("microdata"))
    merged.tables = dedup_dicts(lazy.get("tables"), browser.get("tables"))
    merged.lists = dedup_dicts(lazy.get("lists"), browser.get("lists"))
    merged.preload_data = dedup_dicts(lazy.get("preload_data"), browser.get("preload_data"))
    merged.breadcrumb = dedup_lists(lazy.get("breadcrumb"), browser.get("breadcrumb"))

    # Dictionary overrrides (Browser Hydrated Data Wins)
    merged.open_graph = {**(lazy.get("open_graph") or {}), **(browser.get("open_graph") or {})}
    merged.twitter_card = {**(lazy.get("twitter_card") or {}), **(browser.get("twitter_card") or {})}
    merged.meta_tags = {**(lazy.get("meta_tags") or {}), **(browser.get("meta_tags") or {})}
    merged.inline_js = {**(lazy.get("inline_js") or {}), **(browser.get("inline_js") or {})}

    # Framework data (Safe Merge: Avoid overwriting good data with empty dicts)
    merged.next_data = _prefer_richer_dict(lazy.get("next_data"), browser.get("next_data"))
    merged.nuxt_data = _prefer_richer_dict(lazy.get("nuxt_data"), browser.get("nuxt_data"))
    merged.vue_data = _prefer_richer_dict(lazy.get("vue_data"), browser.get("vue_data"))
    merged.shopify_product = _prefer_richer_dict(lazy.get("shopify_product"), browser.get("shopify_product"))

    # Strings
    merged.sizing_guide_url = browser.get("sizing_guide_url") or lazy.get("sizing_guide_url")
    merged.markdown = browser.get("markdown") or lazy.get("markdown")

    # DOM Text Merge
    ldom = lazy.get("dom_text") or {}
    bdom = browser.get("dom_text") or {}
    merged.dom_text = {
        "title": bdom.get("title") or ldom.get("title") or "",
        "h1": dedup_lists(ldom.get("h1"), bdom.get("h1")),
        "h2": dedup_lists(ldom.get("h2"), bdom.get("h2")),
        "h3": dedup_lists(ldom.get("h3"), bdom.get("h3")),
        "h4": dedup_lists(ldom.get("h4"), bdom.get("h4")),
        "paragraphs": dedup_lists(ldom.get("paragraphs"), bdom.get("paragraphs")),
        # Prefer browser body text as it includes dynamic JS-rendered visual content
        "body_text": bdom.get("body_text") or ldom.get("body_text") or ""
    }

    return merged

# -- Core lazy extraction ----------------------------------------------
async def extract_lazy(client: Any, url: str, config: PipelineConfig, use_shopify_api: bool = True) -> ExtractionResult:
    start_time = time.time()
    result = ExtractionResult(url=url, canonical_url=canonicalize_url(url), extraction_mode="lazy", extracted_at=datetime.now(timezone.utc).isoformat())

    shopify_product = await _try_shopify_json(client, url, config.fetch_timeout) if use_shopify_api and _is_shopify_domain(url) else None
    html_text, status_code, error_type = await _fetch_html(client, url, config.http_timeout, max_retries=config.fetch_max_retries)
    result.status_code = status_code

    if not html_text:
        result.success = False
        result.error = f"Failed to fetch HTML (Status: {status_code}, ErrorType: {error_type})"
        result.performance = {"total_time_ms": int((time.time() - start_time) * 1000)}
        return result

    parse_start = time.time()
    try: soup = BeautifulSoup(html_text, BS4_PARSER)
    except Exception as exc:
        result.success = False
        result.error = f"BeautifulSoup parse error: {exc}"
        result.performance = {"total_time_ms": int((time.time() - start_time) * 1000)}
        return result

    result.canonical_url = _extract_page_canonical(soup, result.canonical_url)
    sources = ExtractedSources(
        schema_org=_extract_schema_org(soup), open_graph=_extract_open_graph(soup),
        twitter_card=_extract_twitter_card(soup), meta_tags=_extract_meta_tags(soup),
        next_data=_extract_next_data(soup), nuxt_data=_extract_nuxt_data(soup),
        vue_data=_extract_vue_data(soup), inline_js=_extract_inline_js_product_data(soup),
        microdata=_extract_microdata(soup), shopify_product=shopify_product,
        sizing_guide_url=_extract_sizing_guide_link(soup, url)
    )

    if config.include_tables: sources.tables = _extract_tables(soup)
    if config.include_lists: sources.lists = _extract_lists(soup)
    if config.include_breadcrumb: sources.breadcrumb = _extract_breadcrumb(soup)
    if config.include_dom_text: sources.dom_text = _extract_dom_text(soup)
    if use_shopify_api: sources.preload_data = await _extract_preload_data(soup, url, client, config.fetch_timeout)

    result.success = True
    result.sources = sources.to_dict()
    result.confidence = _compute_confidence(sources).to_dict()
    result.performance = {"fetch_time_ms": int((parse_start - start_time) * 1000), "parse_time_ms": int((time.time() - parse_start) * 1000), "total_time_ms": int((time.time() - start_time) * 1000)}
    return result

# -- CloakBrowser launch helpers ---------------------------------------
def _build_cloak_args(config: PipelineConfig) -> List[str]:
    args = [
        f"--remote-debugging-port={config.cdp_port}", "--remote-debugging-address=127.0.0.1",
        f"--fingerprint={config.fingerprint_seed}", f"--fingerprint-storage-quota={config.storage_quota_mb}",
        "--fingerprint-noise=false", "--fingerprint-windows-font-metrics", "--disable-http2",
        "--disable-gpu", "--no-sandbox", "--disable-dev-shm-usage", "--disable-site-isolation-trials", "--window-size=1280,800",
    ]
    font_dir = _find_font_dir()
    if font_dir: args.append(f"--fingerprint-fonts-dir={font_dir}")
    return args

async def _health_check_cdp(port: int, timeout: float = 30.0) -> None:
    deadline = asyncio.get_event_loop().time() + timeout
    async with httpx.AsyncClient() as client:
        while asyncio.get_event_loop().time() < deadline:
            try:
                if (await client.get(f"http://127.0.0.1:{port}/json/version", timeout=2.0)).status_code == 200: return
            except Exception: pass
            await asyncio.sleep(0.5)
    raise RuntimeError(f"CDP endpoint on port {port} did not become ready within {timeout}s")

# -- Full browser extraction -------------------------------------------
async def _extract_full_browser_core(crawler: AsyncWebCrawler, url: str, config: PipelineConfig, start_time: float) -> ExtractionResult:
    result = ExtractionResult(url=url, canonical_url=canonicalize_url(url), extraction_mode="full_browser", extracted_at=datetime.now(timezone.utc).isoformat())

    shopify_product = None
    if _is_shopify_domain(url):
        async with httpx.AsyncClient(timeout=10) as shopify_client:
            shopify_product = await _try_shopify_json(shopify_client, url, config.fetch_timeout)

    run_config = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS, stream=False,
        js_code="(async () => { window.scrollTo(0, document.body.scrollHeight); await new Promise(r => setTimeout(r, 1500)); })();",
        excluded_tags=EXCLUDED_TAGS, screenshot=False, remove_overlay_elements=True, remove_consent_popups=True,
    )

    try:
        last_exc = None
        for attempt in range(config.max_crawl_retries + 1):
            try:
                crawl_result = await asyncio.wait_for(crawler.arun(url=url, config=run_config), timeout=config.crawl_timeout)
                break
            except Exception as exc:
                last_exc = exc
                if attempt == config.max_crawl_retries: raise
                await asyncio.sleep(config.retry_base_delay * (2 ** attempt))

        if not crawl_result.success:
            result.success, result.error = False, crawl_result.error_message or "Crawl failed"
            result.performance = {"total_time_ms": int((time.time() - start_time) * 1000)}
            return result

        soup = BeautifulSoup(crawl_result.html or "", BS4_PARSER)
        result.canonical_url = _extract_page_canonical(soup, result.canonical_url)

        sources = ExtractedSources(shopify_product=shopify_product)
        if crawl_result.metadata and crawl_result.metadata.get("json_ld"):
            json_ld = crawl_result.metadata["json_ld"]
            if isinstance(json_ld, list): sources.schema_org = [item for item in json_ld if _is_product_schema(item)]
            elif _is_product_schema(json_ld): sources.schema_org = [json_ld]
        if not sources.schema_org: sources.schema_org = _extract_schema_org(soup)

        og = {k.replace("og_", "og:"): str(v) for k, v in crawl_result.metadata.items() if k.startswith("og:") or k.startswith("og_")} if crawl_result.metadata else {}
        sources.open_graph = og if og else _extract_open_graph(soup)
        sources.twitter_card = _extract_twitter_card(soup)
        sources.meta_tags = _extract_meta_tags(soup)
        if crawl_result.metadata: sources.meta_tags.update({k: str(v) for k, v in crawl_result.metadata.items() if k not in sources.meta_tags and v is not None})

        sources.next_data = _extract_next_data(soup)
        sources.nuxt_data = _extract_nuxt_data(soup)
        sources.vue_data = _extract_vue_data(soup)
        sources.inline_js = _extract_inline_js_product_data(soup)
        sources.microdata = _extract_microdata(soup)

        if config.include_tables: sources.tables = _extract_tables(soup)
        if config.include_lists: sources.lists = _extract_lists(soup)
        if config.include_breadcrumb: sources.breadcrumb = _extract_breadcrumb(soup)
        if config.include_dom_text: sources.dom_text = _extract_dom_text(soup)

        sources.sizing_guide_url = _extract_sizing_guide_link(soup, url)
        if config.include_markdown and crawl_result.markdown:
            sources.markdown = crawl_result.markdown.raw_markdown if hasattr(crawl_result.markdown, "raw_markdown") else str(crawl_result.markdown)

        result.success = True
        result.sources = sources.to_dict()
        result.confidence = _compute_confidence(sources).to_dict()

    except Exception as exc:
        err_msg = str(exc)
        if "navigating and changing the content" in err_msg or "Execution context was destroyed" in err_msg:
            logger.error("Full browser extraction failed for %s: Page navigated automatically.", url)
            result.error = "Page Navigation/Context Destroyed"
        else:
            result.error = f"{type(exc).__name__}: {err_msg}"
        result.success = False

    result.performance = {"total_time_ms": int((time.time() - start_time) * 1000)}
    return result

async def extract_full_browser(url: str, config: PipelineConfig, client: httpx.AsyncClient, crawler: Optional[AsyncWebCrawler] = None) -> ExtractionResult:
    start_time = time.time()
    try:
        if crawler is None:
            raise NotImplementedError("Crawler must be provided via the orchestrated pool")
        return await _extract_full_browser_core(crawler, url, config, start_time)
    except Exception as exc:
        return ExtractionResult(url=url, canonical_url=canonicalize_url(url), extraction_mode="full_browser", success=False, error=str(exc), extracted_at=datetime.now(timezone.utc).isoformat(), performance={"total_time_ms": int((time.time() - start_time) * 1000)})

# -- Batch orchestration -----------------------------------------------
@asynccontextmanager
async def _per_domain_limit(url: str, semaphores: Dict[str, asyncio.Semaphore], max_concurrency: int):
    sem = semaphores.setdefault(urlsplit(url).netloc, asyncio.Semaphore(max_concurrency))
    async with sem: yield

async def run_batch(
    urls: List[str], lazy_extraction: bool = True, include_dom_text: bool = True, include_tables: bool = True,
    include_lists: bool = True, include_markdown: bool = True, include_breadcrumb: bool = True, min_confidence: float = 0.3,
    cdp_port: int = 9243, concurrency: int = 8, browser_concurrency: int = 1, http_timeout: float = 10.0,
    crawl_timeout: float = 60.0, max_crawl_retries: int = 0, fetch_max_retries: int = 2, enforce_completeness: bool = True,
    exhaustive_mode: bool = False
) -> Dict[str, Any]:
    
    valid_urls = list(set([u.strip() for u in urls if isinstance(u, str) and u.strip().startswith(("http://", "https://"))]))
    if not valid_urls: return {}
    random.shuffle(valid_urls)

    config = PipelineConfig(
        min_confidence=min_confidence, enforce_completeness=enforce_completeness, exhaustive_mode=exhaustive_mode,
        include_dom_text=include_dom_text, include_tables=include_tables, include_lists=include_lists,
        include_markdown=include_markdown, include_breadcrumb=include_breadcrumb, cdp_port=cdp_port,
        concurrency=concurrency, browser_concurrency=browser_concurrency, http_timeout=http_timeout,
        crawl_timeout=crawl_timeout, max_crawl_retries=max_crawl_retries, fetch_max_retries=fetch_max_retries
    )

    results: Dict[str, Any] = {}
    domain_semaphores: Dict[str, asyncio.Semaphore] = {}

    if lazy_extraction:
        logger.info("=== Phase 1: Tiered Lazy extraction for %d URL(s) ===", len(valid_urls))
        async with AsyncExitStack() as stack:
            limits = httpx.Limits(max_connections=50, max_keepalive_connections=20)
            timeout = httpx.Timeout(http_timeout, connect=5.0)

            client_advanced = await stack.enter_async_context(cffi_requests.AsyncSession() if HAS_CURL_CFFI else httpx.AsyncClient(limits=limits, timeout=timeout, headers=CHROME_HEADERS_2026))
            client_classic = await stack.enter_async_context(httpx.AsyncClient(limits=limits, timeout=timeout, headers=CLASSIC_HEADERS))
            global_sem = asyncio.Semaphore(config.concurrency)

            async def _process_lazy(url: str):
                async with _per_domain_limit(url, domain_semaphores, config.per_domain_concurrency):
                    async with global_sem:
                        try:
                            res = await extract_lazy(client_advanced, url, config, use_shopify_api=True)
                            if not res.success or res.status_code in (403, 429, 503) or res.confidence.get("score", 0) < min_confidence:
                                res_classic = await extract_lazy(client_classic, url, config, use_shopify_api=False)
                                if not res.success or (res_classic.success and res_classic.confidence.get("score", 0) > res.confidence.get("score", 0) + 0.05):
                                    return url, res_classic
                            return url, res
                        except Exception as exc:
                            return url, ExtractionResult(url=url, extraction_mode="lazy", success=False, error=str(exc))

            for url, res in await asyncio.gather(*(_process_lazy(url) for url in valid_urls)):
                if config.enforce_completeness: res.completeness = _audit_completeness(res.sources).to_dict()
                results[url] = res.to_dict()
                if res.success: logger.info("Lazy success %s (confidence=%.2f)", url, res.confidence.get("score", 0))

        failed_urls = []
        for url, res in results.items():
            if res.get("status_code") in (404, 410, 400): continue
            if not res["success"] and isinstance(res.get("error"), str) and any(k in res["error"].lower() for k in ("ssl_error", "dns_error")): continue
            
            if config.exhaustive_mode and res["success"]:
                logger.info("Exhaustive mode: Queuing %s for Phase 2 Browser Merge", url)
                failed_urls.append(url)
            elif not res["success"] or res.get("confidence", {}).get("score", 0) < min_confidence:
                failed_urls.append(url)
            elif config.enforce_completeness and not res.get("completeness", {}).get("is_complete", True):
                failed_urls.append(url)

        if not failed_urls:
            return results
        logger.info("=== Phase 2: Full browser extraction for %d URL(s) ===", len(failed_urls))
    else:
        failed_urls = valid_urls

    async with httpx.AsyncClient(limits=httpx.Limits(max_connections=50), timeout=httpx.Timeout(http_timeout)) as client:
        cb_browser = xvfb_proc = None
        try:
            effective_headless = config.headless
            if not config.headless:
                xvfb_proc = _start_xvfb_if_needed()
                if not _display_is_usable(os.environ.get("DISPLAY", "")): effective_headless = True

            cb_browser = await asyncio.wait_for(launch_async(headless=effective_headless, args=_build_cloak_args(config)), timeout=config.cdp_health_timeout)
            await _health_check_cdp(config.cdp_port, timeout=config.cdp_health_timeout)

            async with AsyncWebCrawler(config=BrowserConfig(browser_mode="cdp", cdp_url=f"http://127.0.0.1:{config.cdp_port}")) as crawler:
                sem_browser = asyncio.Semaphore(max(1, config.browser_concurrency))

                async def _process_full(url: str):
                    async with _per_domain_limit(url, domain_semaphores, config.per_domain_concurrency):
                        async with sem_browser:
                            try: return url, await extract_full_browser(url, config, client, crawler=crawler)
                            except Exception as exc: return url, ExtractionResult(url=url, extraction_mode="full_browser", success=False, error=str(exc))

                for url, res in await asyncio.gather(*(_process_full(url) for url in failed_urls)):
                    existing_lazy_res = results.get(url)
                    is_lazy_success = existing_lazy_res and existing_lazy_res.get("success")

                    if res.success and existing_lazy_res is not None:
                        merge_mode = "exhaustive_merged" if config.exhaustive_mode and is_lazy_success else "fallback_merged"
                        logger.info("Merging Lazy and Browser Data for %s (%s)", url, merge_mode)
                        
                        merged_obj = _merge_sources(existing_lazy_res["sources"], res.sources)
                        res.sources = merged_obj.to_dict()
                        res.confidence = _compute_confidence(merged_obj).to_dict()
                        
                        if config.enforce_completeness: 
                            res.completeness = _audit_completeness(res.sources).to_dict()
                        
                        res.extraction_mode = merge_mode
                        results[url] = res.to_dict()
                        
                    elif res.success or not is_lazy_success:
                        # If browser succeeded (but no lazy history existed at all) 
                        # OR if both failed (overwrite with the latest browser failure)
                        if config.enforce_completeness: 
                            res.completeness = _audit_completeness(res.sources).to_dict()
                        results[url] = res.to_dict()
                    
                    # Note: If browser fails, but lazy was a TRUE success (e.g. sent here just for --exhaustive mode), 
                    # we do nothing, safely preserving the original successful lazy payload.

        finally:
            if cb_browser:
                try: await cb_browser.close()
                except Exception: pass
            if xvfb_proc:
                try:
                    xvfb_proc.terminate()
                    xvfb_proc.wait(timeout=2)
                except Exception: pass

    return results

# -- Example usage -----------------------------------------------------
if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="E-Commerce Product Text Extractor", formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("-u", "--urls", required=True, help="Path to JSON file containing URLs")
    parser.add_argument("-o", "--output", required=True, help="Path to output JSON")
    parser.add_argument("--exhaustive", action=argparse.BooleanOptionalAction, default=False, help="Run BOTH Lazy and Browser and merge the results.")
    parser.add_argument("--lazy-extraction", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--enforce-completeness", action=argparse.BooleanOptionalAction, default=True)
    parser.add_argument("--min-confidence", type=float, default=0.3)
    parser.add_argument("--cdp-port", type=int, default=9243)
    parser.add_argument("--concurrency", type=int, default=8)
    parser.add_argument("--browser-concurrency", type=int, default=1)
    parser.add_argument("--http-timeout", type=float, default=10.0)
    parser.add_argument("--crawl-timeout", type=float, default=60.0)
    parser.add_argument("--max-crawl-retries", type=int, default=0)
    parser.add_argument("--fetch-max-retries", type=int, default=2)
    parser.add_argument("--no-dom-text", dest="include_dom_text", action="store_false", default=True)
    parser.add_argument("--no-tables", dest="include_tables", action="store_false", default=True)
    parser.add_argument("--no-lists", dest="include_lists", action="store_false", default=True)
    parser.add_argument("--no-markdown", dest="include_markdown", action="store_false", default=True)
    parser.add_argument("--no-breadcrumb", dest="include_breadcrumb", action="store_false", default=True)

    args = parser.parse_args()

    with open(args.urls, "r", encoding="utf-8") as f:
        urls = json.load(f)

    results = asyncio.run(run_batch(
        urls=urls, lazy_extraction=args.lazy_extraction, exhaustive_mode=args.exhaustive,
        include_dom_text=args.include_dom_text, include_tables=args.include_tables,
        include_lists=args.include_lists, include_markdown=args.include_markdown,
        include_breadcrumb=args.include_breadcrumb, min_confidence=args.min_confidence,
        cdp_port=args.cdp_port, concurrency=args.concurrency, browser_concurrency=args.browser_concurrency,
        http_timeout=args.http_timeout, crawl_timeout=args.crawl_timeout,
        max_crawl_retries=args.max_crawl_retries, fetch_max_retries=args.fetch_max_retries,
        enforce_completeness=args.enforce_completeness,
    ))

    out_dir = os.path.dirname(args.output)
    if out_dir: os.makedirs(out_dir, exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)

    successes = sum(1 for r in results.values() if r.get("success"))
    logger.info("=" * 60)
    logger.info("EXTRACTION COMPLETE | Total: %d | Success: %d", len(results), successes)
    logger.info("=" * 60)