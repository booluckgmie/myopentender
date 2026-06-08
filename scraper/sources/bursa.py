"""
Bursa Malaysia — Company Announcements filtered by keyword "tender".
URL: https://www.bursamalaysia.com/market_information/announcements/company_announcement

Playwright required (heavy JS).
Results stored separately in tenders table with source_id=13.
"""
import logging
from typing import Iterator

from scraper.utils import parse_date, infer_status, now_iso

SOURCE_ID = 13
SOURCE_NAME = "Bursa Malaysia"
BASE_URL = "https://www.bursamalaysia.com/market_information/announcements/company_announcement"
KEYWORD = "tender"

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
            page.goto(BASE_URL, timeout=45000, wait_until="networkidle")

            # Try to find a keyword/search field
            search_sel = 'input[placeholder*="search" i], input[placeholder*="keyword" i], input[name*="keyword" i]'
            search_box = page.query_selector(search_sel)
            if search_box:
                search_box.fill(KEYWORD)
                page.keyboard.press("Enter")
                page.wait_for_load_state("networkidle", timeout=15000)

            page.wait_for_selector("table tbody tr, .announcement-row", timeout=20000)

            for row in page.query_selector_all("table tbody tr, .announcement-row"):
                cells = [c.inner_text().strip() for c in row.query_selector_all("td, .cell")]
                if len(cells) < 2:
                    continue
                text = " ".join(cells).lower()
                if KEYWORD not in text:
                    continue

                link = row.query_selector("a")
                url = link.get_attribute("href") if link else BASE_URL
                if url and url.startswith("/"):
                    url = "https://www.bursamalaysia.com" + url

                company  = cells[0]
                title    = cells[1]
                date_str = parse_date(cells[2]) if len(cells) > 2 else None
                now = now_iso()
                yield {
                    "source_id": SOURCE_ID,
                    "ref":       None,
                    "title":     f"[{company}] {title}",
                    "ministry":  company,
                    "deadline":  None,
                    "open_date": date_str,
                    "category":  "Bursa Announcement",
                    "status":    "active",
                    "url":       url or BASE_URL,
                    "scraped_at": now,
                }
        except Exception as exc:
            logger.error("%s scrape error: %s", SOURCE_NAME, exc)
        finally:
            browser.close()
