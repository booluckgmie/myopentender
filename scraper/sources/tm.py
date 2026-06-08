"""
TM — Telekom Malaysia Tender Notices.
URL: https://www.tm.com.my/business-with-tm/tender-notices

Playwright required.
"""
import logging
from typing import Iterator

from scraper.utils import parse_date, infer_status, now_iso

SOURCE_ID = 12
SOURCE_NAME = "TM"
BASE_URL = "https://www.tm.com.my/business-with-tm/tender-notices"
HOST = "https://www.tm.com.my"

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
            page.wait_for_selector("table tbody tr, .tender-list li, article", timeout=15000)

            for row in page.query_selector_all("table tbody tr, .tender-list li"):
                cells = [c.inner_text().strip() for c in row.query_selector_all("td, span")]
                if len(cells) < 2:
                    continue
                link = row.query_selector("a")
                url = link.get_attribute("href") if link else BASE_URL
                if url and url.startswith("/"):
                    url = HOST + url

                deadline = parse_date(cells[2]) if len(cells) > 2 else None
                open_d   = parse_date(cells[3]) if len(cells) > 3 else None
                now = now_iso()
                yield {
                    "source_id": SOURCE_ID,
                    "ref":       cells[0],
                    "title":     cells[1],
                    "deadline":  deadline,
                    "open_date": open_d,
                    "category":  "Telecommunications",
                    "ministry":  "Telekom Malaysia Berhad",
                    "status":    infer_status(open_d, deadline),
                    "url":       url or BASE_URL,
                    "scraped_at": now,
                }
        except Exception as exc:
            logger.error("%s scrape error: %s", SOURCE_NAME, exc)
        finally:
            browser.close()
