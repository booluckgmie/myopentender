"""
Sabah PSU — Pejabat Setiausaha Kerajaan Sabah.
URL: http://www.psupsabah.gov.my/?page_id=14070

Plain WordPress page — requests + BeautifulSoup.
"""
import logging
from typing import Iterator

from scraper.utils import make_session, parse_date, infer_status, now_iso

SOURCE_ID = 5
SOURCE_NAME = "Sabah PSU"
BASE_URL = "http://www.psupsabah.gov.my/?page_id=14070"
HOST = "http://www.psupsabah.gov.my"

logger = logging.getLogger(__name__)


def scrape() -> Iterator[dict]:
    session = make_session()
    try:
        resp = session.get(BASE_URL, verify=False)
        resp.raise_for_status()
    except Exception as exc:
        logger.error("%s fetch failed: %s", SOURCE_NAME, exc)
        return

    from bs4 import BeautifulSoup
    soup = BeautifulSoup(resp.text, "lxml")
    now = now_iso()

    for link in soup.select(".entry-content a, .page-content a, article a"):
        href = link.get("href", "")
        title = link.get_text(strip=True)
        if not title or len(title) < 10:
            continue
        if href.startswith("/"):
            href = HOST + href
        yield {
            "source_id": SOURCE_ID,
            "ref":       None,
            "title":     title,
            "deadline":  None,
            "open_date": None,
            "status":    "active",
            "url":       href or BASE_URL,
            "scraped_at": now,
        }
