"""
TNB — Tenaga Nasional Berhad Tender Notices.
URL: https://www.tnb.com.my/listings/tender_notices/

Playwright required (JS CMS).
"""
import logging
from typing import Iterator

from scraper.utils import parse_date, infer_status, now_iso

SOURCE_ID = 11
SOURCE_NAME = "TNB"
BASE_URL = "https://www.tnb.com.my/listings/tender_notices/"
HOST = "https://www.tnb.com.my"

logger = logging.getLogger(__name__)


def scrape() -> Iterator[dict]:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        logger.warning("Playwright not installed — skipping %s", SOURCE_NAME)
        return

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page()
        try:
            page.goto(BASE_URL, timeout=30000, wait_until="networkidle")
            page.wait_for_selector(".listing-item, table tr, article", timeout=15000)

            for item in page.query_selector_all(".listing-item, table tbody tr, article"):
                title_el = item.query_selector("h2, h3, .title, .listing-title, td:nth-child(2)")
                if not title_el:
                    continue
                title = title_el.inner_text().strip()
                if not title:
                    continue
                link = item.query_selector("a")
                url = link.get_attribute("href") if link else BASE_URL
                if url and url.startswith("/"):
                    url = HOST + url

                cells = [c.inner_text().strip() for c in item.query_selector_all("td, .meta")]
                deadline = parse_date(cells[2]) if len(cells) > 2 else None
                open_d   = parse_date(cells[1]) if len(cells) > 1 else None
                now = now_iso()
                yield {
                    "source_id": SOURCE_ID,
                    "ref":       cells[0] if cells else None,
                    "title":     title,
                    "deadline":  deadline,
                    "open_date": open_d,
                    "category":  "Electrical",
                    "ministry":  "Tenaga Nasional Berhad",
                    "status":    infer_status(open_d, deadline),
                    "url":       url or BASE_URL,
                    "scraped_at": now,
                }
        except Exception as exc:
            logger.error("%s scrape error: %s", SOURCE_NAME, exc)
        finally:
            browser.close()
