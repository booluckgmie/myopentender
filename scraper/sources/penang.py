"""
Penang eProcurement.
URL: https://ep.penang.gov.my/

Playwright required (Angular/JS portal).
Detects login-redirect and aborts cleanly.
"""
import logging
from typing import Iterator

from scraper.utils import parse_date, infer_status, now_iso

SOURCE_ID = 3
SOURCE_NAME = "Penang eProcure"
BASE_URL = "https://ep.penang.gov.my/"
TENDER_URL = "https://ep.penang.gov.my/eprocurement/public/tenderlist"

logger = logging.getLogger(__name__)

_LOGIN_SIGNALS = {"log masuk", "login", "sign in", "kata laluan", "password"}


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
            # Try the public tender list endpoint first
            page.goto(TENDER_URL, timeout=30000, wait_until="networkidle")

            # Detect redirect to login page
            body_text = page.inner_text("body").lower()
            if any(sig in body_text[:500] for sig in _LOGIN_SIGNALS):
                logger.warning("%s redirected to login page — skipping", SOURCE_NAME)
                return

            page.wait_for_selector("table tbody tr, .list-row", timeout=15000)
            rows = page.query_selector_all("table tbody tr")
            for row in rows:
                cells = [c.inner_text().strip() for c in row.query_selector_all("td")]
                if len(cells) < 2:
                    continue
                link = row.query_selector("a")
                url = link.get_attribute("href") if link else BASE_URL
                if url and url.startswith("/"):
                    url = "https://ep.penang.gov.my" + url

                ref      = cells[0]
                title    = cells[1]
                deadline = parse_date(cells[3]) if len(cells) > 3 else None
                open_d   = parse_date(cells[2]) if len(cells) > 2 else None
                now = now_iso()
                yield {
                    "source_id": SOURCE_ID,
                    "ref":       ref,
                    "title":     title,
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
