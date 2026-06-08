"""
Prasarana Malaysia Berhad — Tenders.
URL: https://www.prasarana.com.my/tenders/

Playwright required (JS-rendered content).
"""
import logging
from typing import Iterator

from scraper.utils import parse_date, infer_status, now_iso

SOURCE_ID = 10
SOURCE_NAME = "Prasarana"
BASE_URL = "https://www.prasarana.com.my/tenders/"

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
            page.wait_for_selector(".tender-item, table tbody tr, article", timeout=15000)

            # Try table rows first, then article/card layout
            rows = page.query_selector_all("table tbody tr")
            if not rows:
                rows = page.query_selector_all(".tender-item, article.tender, .card")

            for row in rows:
                cells = [c.inner_text().strip() for c in row.query_selector_all("td, .field")]
                title_el = row.query_selector("h2, h3, .title, td:nth-child(2), a")
                title = title_el.inner_text().strip() if title_el else (cells[1] if len(cells) > 1 else "")
                if not title:
                    continue
                link = row.query_selector("a")
                url = link.get_attribute("href") if link else BASE_URL
                if url and url.startswith("/"):
                    url = "https://www.prasarana.com.my" + url
                deadline = parse_date(cells[2]) if len(cells) > 2 else None
                open_d   = parse_date(cells[1]) if len(cells) > 1 else None
                now = now_iso()
                yield {
                    "source_id": SOURCE_ID,
                    "ref":       cells[0] if cells else None,
                    "title":     title,
                    "deadline":  deadline,
                    "open_date": open_d,
                    "category":  "Transport",
                    "ministry":  "Prasarana Malaysia Berhad",
                    "status":    infer_status(open_d, deadline),
                    "url":       url or BASE_URL,
                    "scraped_at": now,
                }
        except Exception as exc:
            logger.error("%s scrape error: %s", SOURCE_NAME, exc)
        finally:
            browser.close()
