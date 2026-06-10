"""
ePerolehan — Federal procurement portal.
URL: https://www.eperolehan.gov.my/quotation-tender-notice

Requires Playwright (JS-rendered tables parsing).
"""
import logging
import re
import time
from typing import Iterator

from scraper.utils import parse_date, infer_status, now_iso

SOURCE_ID = 1
SOURCE_NAME = "ePerolehan"
BASE_URL = "https://www.eperolehan.gov.my/quotation-tender-notice"

logger = logging.getLogger(__name__)


def scrape() -> Iterator[dict]:
    """Yields normalised tender dicts."""
    try:
        yield from _scrape_playwright()
    except Exception as exc:
        logger.error("%s Playwright scraping process failed: %s", SOURCE_NAME, exc)


def _scrape_playwright() -> Iterator[dict]:
    from playwright.sync_api import sync_playwright

    # Precise structural IDs mapped dynamically from ePerolehan DOM
    def get_tbody_selector(tab_idx):
        return f"#_scNoticeBoard_WAR_NGePportlet_\\:form\\:j_idt282\\:{tab_idx}\\:nbsearchresults_data"

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=['--no-sandbox', '--disable-setuid-sandbox'])
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            locale="ms-MY"
        )
        page = context.new_page()
        
        logger.info(f"[{SOURCE_NAME}] Navigating to {BASE_URL}")
        page.goto(BASE_URL, timeout=90000, wait_until="domcontentloaded")
        
        # PrimeFaces takes time to boot up structural datasets
        page.wait_for_timeout(5000)
        
        # We process Tab 0 (Diiklankan) and Tab 1 (Notis Telah Dikemaskini)
        for tab_idx in [0, 1]:
            logger.info(f"[{SOURCE_NAME}] Scraping tab index {tab_idx}")
            
            if tab_idx != 0:
                # Click the active navigation node via dynamic client-side link execution
                tab_href = f"#_scNoticeBoard_WAR_NGePportlet_:form:j_idt282:{tab_idx}:nbresultTabs"
                tab_selector = f"text=Notis Telah Dikemaskini" # Fallback safe selector mapping
                try:
                    page.click(f".ui-tabs-nav a[href='{tab_href}']", timeout=10000)
                except Exception:
                    page.click(tab_selector, timeout=10000)
                page.wait_for_timeout(2000)

            tbody_sel = get_tbody_selector(tab_idx)
            try:
                page.wait_for_selector(f"{tbody_sel} tr[data-ri]", timeout=30000)
            except Exception:
                logger.warning(f"[{SOURCE_NAME}] Grid elements timed out for tab {tab_idx}")
                continue

            # Process visible page rows
            rows = page.query_selector_all(f"{tbody_sel} tr[data-ri]")
            logger.info(f"[{SOURCE_NAME}] Extracting {len(rows)} data components from tab grid")
            
            for row in rows:
                cells = row.query_selector_all("td")
                if len(cells) < 4:
                    continue
                
                # ePerolehan structures columns as: 
                # 0: Title, 1: Ministry, 2: Opening Date, 3: Closing Date
                texts = [c.inner_text().strip() for c in cells]
                
                title = texts[0]
                if not title or len(title) < 15:
                    continue

                yield _build(texts)

        browser.close()


def infer_category(title: str) -> str:
    if not title:
        return None
    t = title.upper()
    if re.search(r'^TENDER\b', t): return 'Tender'
    if re.search(r'^SEBUT\s*HARGA\b|^SEBUTHARGA\b', t): return 'Sebut Harga'
    if re.search(r'^MEMBEKAL\b|^BEKALAN\b', t): return 'Bekalan'
    if re.search(r'^PERKHIDMATAN\b', t): return 'Perkhidmatan'
    if re.search(r'^KERJA[\s-]', t): return 'Kerja'
    if re.search(r'^CADANGAN\b', t): return 'Cadangan'
    return None


def _build(cells: list) -> dict:
    title = cells[0] if len(cells) > 0 else "Untitled"
    ministry = cells[1] if len(cells) > 1 else None
    
    # Parse incoming raw Malay/UK date strings format: "DD/MM/YYYY hh:mm AM/PM"
    open_d = parse_date(cells[2].split()[0]) if len(cells) > 2 and cells[2] else None
    deadline = parse_date(cells[3].split()[0]) if len(cells) > 3 and cells[3] else None
    
    return {
        "source_id": SOURCE_ID,
        "ref": None,
        "title": title,
        "category": infer_category(title),
        "ministry": ministry,
        "open_date": open_d,
        "deadline": deadline,
        "status": infer_status(open_d, deadline),
        "url": BASE_URL,
        "scraped_at": now_iso(),
    }
