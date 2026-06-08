"""
SPSB eProcurement.
URL: https://eprocurement.spsb.com.my:8443/E-procurement/index.php/home

Playwright required — React/JS portal with self-signed cert.
"""
import logging
from typing import Iterator

from scraper.utils import parse_date, infer_status, now_iso

SOURCE_ID = 6
SOURCE_NAME = "SPSB"
BASE_URL = "https://eprocurement.spsb.com.my:8443/E-procurement/index.php/home"

logger = logging.getLogger(__name__)


def scrape() -> Iterator[dict]:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        logger.warning("Playwright not installed — skipping %s", SOURCE_NAME)
        return

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            args=["--ignore-certificate-errors"]
        )
        context = browser.new_context(ignore_https_errors=True)
        page = context.new_page()
        try:
            page.goto(BASE_URL, timeout=30000, wait_until="networkidle")
            page.wait_for_selector("table tbody tr, .tender-row", timeout=15000)
            for row in page.query_selector_all("table tbody tr"):
                cells = [c.inner_text().strip() for c in row.query_selector_all("td")]
                if len(cells) < 2:
                    continue
                link = row.query_selector("a")
                url = link.get_attribute("href") if link else BASE_URL
                deadline = parse_date(cells[3]) if len(cells) > 3 else None
                open_d   = parse_date(cells[2]) if len(cells) > 2 else None
                now = now_iso()
                yield {
                    "source_id": SOURCE_ID,
                    "ref":       cells[0],
                    "title":     cells[1],
                    "deadline":  deadline,
                    "open_date": open_d,
                    "status":    infer_status(open_d, deadline),
                    "url":       url or BASE_URL,
                    "scraped_at": now,
                }
        except Exception as exc:
            logger.error("%s scrape error: %s", SOURCE_NAME, exc)
        finally:
            browser.close()
