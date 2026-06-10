"""
ePerolehan — Federal procurement portal.
URL: https://www.eperolehan.gov.my/quotation-tender-notice

Uses Playwright to drive the PrimeFaces/JSF portlet.
Key implementation notes:
  - IDs contain ":" — must use getElementById, not CSS selectors
  - waitUntil='load' so PrimeFaces scripts execute before we poll
  - Anti-detection: remove webdriver flag, set realistic viewport/UA
  - Pagination: watch paginator "X / Y" text change, not row count
    (every page has ~20 rows so count-diff never fires)
"""
import json
import logging
import re
from typing import Iterator

from scraper.utils import parse_date, infer_status, now_iso

SOURCE_ID = 1
SOURCE_NAME = "ePerolehan"
BASE_URL = "https://www.eperolehan.gov.my/quotation-tender-notice"
TABS_TO_SCRAPE = [0, 1]
TAB_NAMES = ["DIIKLANKAN", "DIKEMASKINI", "DITUTUP", "SELESAI", "DIBATALKAN"]

logger = logging.getLogger(__name__)


def _tbody_id(i):
    return f"_scNoticeBoard_WAR_NGePportlet_:form:j_idt282:{i}:nbsearchresults_data"

def _paginator_id(i):
    return f"_scNoticeBoard_WAR_NGePportlet_:form:j_idt282:{i}:nbsearchresults_paginator_bottom"

def _tab_href(i):
    return f"#_scNoticeBoard_WAR_NGePportlet_:form:j_idt282:{i}:nbresultTabs"


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
            if (!pg) return {current: 1, total: 1};
            const cur = pg.querySelector('.ui-paginator-current');
            if (!cur) return {current: 1, total: 1};
            const m = cur.textContent.match(/(\\d+)\\s*\\/\\s*(\\d+)/);
            return m ? {current: parseInt(m[1],10), total: parseInt(m[2],10)}
                     : {current: 1, total: 1};
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
    """Wait until paginator 'X / Y' shows X != from_page."""
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


def scrape() -> Iterator[dict]:
    try:
        yield from _scrape_playwright()
    except Exception as exc:
        logger.error("[%s] fatal: %s", SOURCE_NAME, exc, exc_info=True)


def _scrape_playwright() -> Iterator[dict]:
    from playwright.sync_api import sync_playwright

    total_yielded = 0
    now = now_iso()

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            args=[
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--disable-blink-features=AutomationControlled",
                "--disable-features=IsolateOrigins,site-per-process",
                "--window-size=1366,768",
            ],
        )
        ctx = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            locale="ms-MY",
            viewport={"width": 1366, "height": 768},
            extra_http_headers={"Accept-Language": "ms-MY,ms;q=0.9,en-US;q=0.8,en;q=0.7"},
        )

        # Remove webdriver fingerprint before any page script runs
        ctx.add_init_script("""() => {
            Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
            delete navigator.__proto__.webdriver;
            window.chrome = {runtime: {}};
        }""")

        page = ctx.new_page()

        # Block images/fonts/media to speed up AJAX pagination round-trips
        def _route(route):
            if route.request.resource_type in ("image", "media", "font"):
                route.abort()
            else:
                route.continue_()
        page.route("**/*", _route)

        logger.info("[%s] loading %s", SOURCE_NAME, BASE_URL)

        # 'load' waits for all scripts — PrimeFaces must execute before we poll rows
        # 'networkidle' hangs because the portlet keeps polling the server
        page.goto(BASE_URL, wait_until="load", timeout=90000)
        page.wait_for_timeout(5000)

        # Poll until rows appear (up to 60s)
        try:
            page.wait_for_function(
                "() => document.querySelectorAll('tr[data-ri]').length > 0",
                timeout=60000,
            )
        except Exception:
            snippet = page.evaluate("() => document.body.innerHTML.slice(0, 2000)")
            logger.warning("[%s] rows not visible after 65s. Body snippet:\n%s", SOURCE_NAME, snippet)
            page.wait_for_timeout(8000)

        row_count = page.evaluate("() => document.querySelectorAll('tr[data-ri]').length")
        logger.info("[%s] page ready — %d rows visible", SOURCE_NAME, row_count)

        if row_count == 0:
            pg_debug = page.evaluate("""() => {
                const pg = document.querySelector('[id*="nbsearchresults_paginator"]');
                const tabs = document.querySelector('[id*="nbresultTabs"]');
                return {
                    hasPaginator: !!pg,
                    paginatorId: pg ? pg.id : null,
                    hasTabs: !!tabs,
                    allDataRi: document.querySelectorAll('[data-ri]').length,
                };
            }""")
            logger.warning("[%s] debug DOM state: %s", SOURCE_NAME, json.dumps(pg_debug))

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
        browser.close()
