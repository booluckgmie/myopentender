"""
ePerolehan — Federal procurement portal.
URL: https://www.eperolehan.gov.my/quotation-tender-notice

Requires Playwright (JS-rendered table).
Falls back to a requests-based attempt first.
"""
import logging
import re
from typing import Iterator

from scraper.utils import make_session, parse_date, infer_status, now_iso

SOURCE_ID = 1
SOURCE_NAME = "ePerolehan"
BASE_URL = "https://www.eperolehan.gov.my/quotation-tender-notice"

logger = logging.getLogger(__name__)


def scrape() -> Iterator[dict]:
    """Yields normalised tender dicts."""
    try:
        yield from _scrape_playwright()
    except Exception as exc:
        logger.warning("%s playwright failed (%s), trying requests", SOURCE_NAME, exc)
        yield from _scrape_requests()


def _scrape_playwright() -> Iterator[dict]:
    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        page = browser.new_page()
        page.goto(BASE_URL, timeout=30000, wait_until="networkidle")
        page.wait_for_selector("table tbody tr", timeout=15000)
        rows = page.query_selector_all("table tbody tr")
        for row in rows:
            cells = row.query_selector_all("td")
            if len(cells) < 4:
                continue
            texts = [c.inner_text().strip() for c in cells]
            yield _build(texts)
        browser.close()


def _scrape_requests() -> Iterator[dict]:
    session = make_session()
    resp = session.get(BASE_URL)
    resp.raise_for_status()
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(resp.text, "lxml")
    for row in soup.select("table tbody tr"):
        cells = [td.get_text(strip=True) for td in row.find_all("td")]
        if len(cells) < 4:
            continue
        link_tag = row.find("a")
        url = link_tag["href"] if link_tag and link_tag.get("href") else BASE_URL
        if url.startswith("/"):
            url = "https://www.eperolehan.gov.my" + url
        yield _build(cells, url)


def _build(cells: list, url: str = BASE_URL) -> dict:
    ref      = cells[0] if len(cells) > 0 else None
    title    = cells[1] if len(cells) > 1 else "Untitled"
    ministry = cells[2] if len(cells) > 2 else None
    open_d   = parse_date(cells[3]) if len(cells) > 3 else None
    deadline = parse_date(cells[4]) if len(cells) > 4 else None
    now = now_iso()
    return {
        "source_id": SOURCE_ID,
        "ref":       ref,
        "title":     title,
        "ministry":  ministry,
        "open_date": open_d,
        "deadline":  deadline,
        "status":    infer_status(open_d, deadline),
        "url":       url,
        "scraped_at": now,
    }
