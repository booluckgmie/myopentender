"""
ePerolehan — Federal procurement portal.
URL: https://www.eperolehan.gov.my/quotation-tender-notice

The site's WAF blocks cloud/CI IPs (Azure, GitHub Actions).
Strategy:
  1. Try Chromium with anti-detection flags
  2. Fall back to Firefox (different TLS fingerprint, sometimes not blocked)
  3. Both respect EPEROLEHAN_PROXY_URL env var for a residential proxy

Pagination: watch paginator "X / Y" text, not row count (every page ~20 rows).
"""
import json
import logging
import os
import re
from typing import Iterator

from scraper.utils import parse_date, infer_status, now_iso

SOURCE_ID = 1
SOURCE_NAME = "ePerolehan"
BASE_URL = "https://www.eperolehan.gov.my/quotation-tender-notice"
TABS_TO_SCRAPE = [0, 1]
TAB_NAMES = ["DIIKLANKAN", "DIKEMASKINI", "DITUTUP", "SELESAI", "DIBATALKAN"]

# Set EPEROLEHAN_PROXY_URL as a GitHub Secret to bypass WAF IP blocks
# e.g. "http://user:pass@proxy.host:port" or "socks5://host:port"
PROXY_URL = os.environ.get("EPEROLEHAN_PROXY_URL")

logger = logging.getLogger(__name__)


def _tbody_id(i):    return f"_scNoticeBoard_WAR_NGePportlet_:form:j_idt282:{i}:nbsearchresults_data"
def _paginator_id(i):return f"_scNoticeBoard_WAR_NGePportlet_:form:j_idt282:{i}:nbsearchresults_paginator_bottom"
def _tab_href(i):    return f"#_scNoticeBoard_WAR_NGePportlet_:form:j_idt282:{i}:nbresultTabs"


def _parse_date_str(raw: str):
    if not raw:
        return None
    m = re.match(r'^(\d{2})/(\d{2})/(\d{4})', raw.strip())
    if m:
        return f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
    return parse_date(raw)


def _infer_category(title: str):
    if not title:
        return None
    t = title.upper()
    if re.match(r'^TENDER\b', t):                          return 'Tender'
    if re.match(r'^SEBUT\s*HARGA\b|^SEBUTHARGA\b', t):    return 'Sebut Harga'
    if re.match(r'^MEMBEKAL\b|^BEKALAN\b', t):             return 'Bekalan'
    if re.match(r'^PERKHIDMATAN\b', t):                    return 'Perkhidmatan'
    if re.match(r'^KERJA[\s\-]', t):                       return 'Kerja'
    if re.match(r'^CADANGAN\b', t):                        return 'Cadangan'
    return None


def _extract_rows(page, tab_idx: int) -> list:
    return page.evaluate("""(tbId) => {
        const tbody = document.getElementById(tbId);
        if (!tbody) return [];
        const rows = [];
        tbody.querySelectorAll('tr[data-ri]').forEach(tr => {
            const tds = tr.querySelectorAll('td');
            if (tds.length < 4) return;
            const linkEl = tds[0].querySelector('a.ui-commandlink');
            rows.push({
                title:    (linkEl ? linkEl.textContent : tds[0].textContent).trim(),
                ministry: tds[1] ? tds[1].textContent.trim() : null,
                openRaw:  tds[2] ? tds[2].textContent.trim() : null,
                closeRaw: tds[3] ? tds[3].textContent.trim() : null,
            });
        });
        return rows;
    }""", _tbody_id(tab_idx))


def _get_paginator_state(page, tab_idx: int) -> dict:
    try:
        return page.evaluate("""(pgId) => {
            const pg = document.getElementById(pgId);
            if (!pg) return {current:1,total:1};
            const cur = pg.querySelector('.ui-paginator-current');
            if (!cur) return {current:1,total:1};
            const m = cur.textContent.match(/(\\d+)\\s*\\/\\s*(\\d+)/);
            return m ? {current:parseInt(m[1],10),total:parseInt(m[2],10)} : {current:1,total:1};
        }""", _paginator_id(tab_idx))
    except Exception:
        return {"current": 1, "total": 1}


def _click_next(page, tab_idx: int) -> bool:
    try:
        return page.evaluate("""(pgId) => {
            const pg = document.getElementById(pgId);
            if (!pg) return false;
            const next = pg.querySelector('.ui-paginator-next');
            if (!next || next.classList.contains('ui-state-disabled')) return false;
            next.click();
            return true;
        }""", _paginator_id(tab_idx))
    except Exception:
        return False


def _wait_for_page_advance(page, tab_idx: int, from_page: int):
    try:
        page.wait_for_function(
            """({pgId, from}) => {
                const pg = document.getElementById(pgId);
                if (!pg) return false;
                const cur = pg.querySelector('.ui-paginator-current');
                if (!cur) return false;
                const m = cur.textContent.match(/(\\d+)\\s*\\/\\s*(\\d+)/);
                return m && parseInt(m[1], 10) !== from;
            }""",
            {"pgId": _paginator_id(tab_idx), "from": from_page},
            timeout=25000,
        )
    except Exception:
        page.wait_for_timeout(5000)


def _activate_tab(page, tab_idx: int):
    if tab_idx == 0:
        return
    try:
        href = _tab_href(tab_idx)
        page.evaluate("""(h) => {
            const link = document.querySelector(`.ui-tabs-nav a[href="${h}"]`);
            if (link) link.click();
        }""", href)
        try:
            page.wait_for_function(
                """(tbId) => {
                    const tbody = document.getElementById(tbId);
                    return tbody && tbody.querySelectorAll('tr[data-ri]').length > 0;
                }""",
                _tbody_id(tab_idx),
                timeout=30000,
            )
        except Exception:
            page.wait_for_timeout(6000)
    except Exception as e:
        logger.warning("[%s] tab %d activation: %s", SOURCE_NAME, tab_idx, e)


def _load_and_count_rows(page) -> int:
    """Navigate to BASE_URL and return the number of visible data rows."""
    def _route(route):
        if route.request.resource_type in ("image", "media", "font"):
            route.abort()
        else:
            route.continue_()
    page.route("**/*", _route)

    page.goto(BASE_URL, wait_until="load", timeout=90000)
    page.wait_for_timeout(5000)

    try:
        page.wait_for_function(
            "() => document.querySelectorAll('tr[data-ri]').length > 0",
            timeout=60000,
        )
    except Exception:
        pass

    return page.evaluate("() => document.querySelectorAll('tr[data-ri]').length")


def _scrape_with_browser(pw, browser_type_name: str, now: str) -> Iterator[dict]:
    """Try scraping with the named browser type. Yields rows or returns empty."""
    proxy_args = {}
    if PROXY_URL:
        proxy_args["proxy"] = {"server": PROXY_URL}

    if browser_type_name == "chromium":
        btype = pw.chromium
        launch_args = {
            "headless": True,
            "args": [
                "--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage",
                "--disable-blink-features=AutomationControlled",
                "--window-size=1366,768",
            ],
            **proxy_args,
        }
        ctx_args = {
            "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            "locale": "ms-MY",
            "viewport": {"width": 1366, "height": 768},
            "extra_http_headers": {"Accept-Language": "ms-MY,ms;q=0.9,en-US;q=0.8,en;q=0.7"},
            **proxy_args,
        }
        init_script = """() => {
            Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
            delete navigator.__proto__.webdriver;
            window.chrome = {runtime: {}};
        }"""
    else:
        btype = pw.firefox
        launch_args = {"headless": True, **proxy_args}
        ctx_args = {
            "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
            "locale": "ms-MY",
            "viewport": {"width": 1366, "height": 768},
            "extra_http_headers": {"Accept-Language": "ms-MY,ms;q=0.9,en-US;q=0.8,en;q=0.7"},
            **proxy_args,
        }
        init_script = None

    browser = btype.launch(**launch_args)
    total_yielded = 0
    try:
        ctx = browser.new_context(**ctx_args)
        if init_script:
            ctx.add_init_script(init_script)
        page = ctx.new_page()

        row_count = _load_and_count_rows(page)
        logger.info("[%s] [%s] page ready — %d rows visible", SOURCE_NAME, browser_type_name, row_count)

        if row_count == 0:
            snippet = page.evaluate("() => document.body.innerText.slice(0, 300)").replace("\n", " ")
            logger.warning("[%s] [%s] 0 rows. Page text: %s", SOURCE_NAME, browser_type_name, snippet)
            return

        for tab_idx in TABS_TO_SCRAPE:
            tab_name = TAB_NAMES[tab_idx] if tab_idx < len(TAB_NAMES) else str(tab_idx)
            logger.info("[%s] ── tab %d (%s)", SOURCE_NAME, tab_idx, tab_name)

            _activate_tab(page, tab_idx)
            page.wait_for_timeout(1000)

            state = _get_paginator_state(page, tab_idx)
            total_pages = state["total"]
            logger.info("[%s]   total pages: %d", SOURCE_NAME, total_pages)

            for pn in range(1, total_pages + 1):
                rows = _extract_rows(page, tab_idx)
                logger.info("[%s]   p%d/%d: %d rows", SOURCE_NAME, pn, total_pages, len(rows))

                for r in rows:
                    title = r.get("title", "")
                    if not title or len(title) < 15:
                        continue
                    open_date = _parse_date_str(r.get("openRaw"))
                    deadline  = _parse_date_str(r.get("closeRaw"))
                    yield {
                        "source_id": SOURCE_ID,
                        "ref": None,
                        "title": title,
                        "category": _infer_category(title),
                        "ministry": r.get("ministry") or None,
                        "open_date": open_date,
                        "deadline": deadline,
                        "status": infer_status(open_date, deadline),
                        "url": BASE_URL,
                        "scraped_at": now,
                    }
                    total_yielded += 1

                if pn < total_pages:
                    clicked = _click_next(page, tab_idx)
                    if not clicked:
                        logger.info("[%s]   next disabled — stopping at p%d", SOURCE_NAME, pn)
                        break
                    _wait_for_page_advance(page, tab_idx, pn)
                    page.wait_for_timeout(400)

        logger.info("[%s] done — %d records", SOURCE_NAME, total_yielded)
    finally:
        try:
            browser.close()
        except Exception:
            pass


def scrape() -> Iterator[dict]:
    logger.info("[%s] loading %s", SOURCE_NAME, BASE_URL)
    if PROXY_URL:
        masked = re.sub(r':([^:@]+)@', ':***@', PROXY_URL)
        logger.info("[%s] using proxy: %s", SOURCE_NAME, masked)

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        logger.error("[%s] playwright not installed", SOURCE_NAME)
        return

    with sync_playwright() as pw:
        # Attempt 1: Chromium
        got_rows = False
        try:
            for row in _scrape_with_browser(pw, "chromium", now_iso()):
                got_rows = True
                yield row
        except Exception as e:
            logger.warning("[%s] Chromium attempt failed: %s", SOURCE_NAME, e)

        if got_rows:
            return

        # Attempt 2: Firefox (different TLS fingerprint)
        logger.warning("[%s] Chromium yielded 0 rows — trying Firefox", SOURCE_NAME)
        try:
            for row in _scrape_with_browser(pw, "firefox", now_iso()):
                yield row
        except Exception as e:
            logger.error("[%s] Firefox also failed: %s", SOURCE_NAME, e)
            logger.error(
                "[%s] Both browsers blocked by WAF. "
                "Add EPEROLEHAN_PROXY_URL secret (residential proxy) to GitHub Actions.",
                SOURCE_NAME,
            )
