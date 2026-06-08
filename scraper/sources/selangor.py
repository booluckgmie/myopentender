"""
Selangor Tender Portal.
URL: https://tender.selangor.my/

HTML table — requests + BeautifulSoup sufficient.
"""
import logging
from typing import Iterator

from scraper.utils import make_session, parse_date, infer_status, now_iso

SOURCE_ID = 2
SOURCE_NAME = "Selangor Tender"
BASE_URL = "https://tender.selangor.my/"

logger = logging.getLogger(__name__)


def scrape() -> Iterator[dict]:
    session = make_session()
    try:
        resp = session.get(BASE_URL)
        resp.raise_for_status()
    except Exception as exc:
        logger.error("%s fetch failed: %s", SOURCE_NAME, exc)
        return

    from bs4 import BeautifulSoup
    soup = BeautifulSoup(resp.text, "lxml")

    for row in soup.select("table tbody tr, .tender-list tr"):
        cells = [td.get_text(" ", strip=True) for td in row.find_all("td")]
        if len(cells) < 3:
            continue
        link = row.find("a")
        url = link["href"] if link and link.get("href") else BASE_URL
        if url.startswith("/"):
            url = "https://tender.selangor.my" + url

        ref      = cells[0]
        title    = cells[1] if len(cells) > 1 else "Untitled"
        deadline = parse_date(cells[2]) if len(cells) > 2 else None
        open_d   = parse_date(cells[3]) if len(cells) > 3 else None
        now = now_iso()
        yield {
            "source_id": SOURCE_ID,
            "ref":       ref,
            "title":     title,
            "deadline":  deadline,
            "open_date": open_d,
            "status":    infer_status(open_d, deadline),
            "url":       url,
            "scraped_at": now,
        }
