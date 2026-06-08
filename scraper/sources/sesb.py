"""
SESB — Sabah Electricity Sdn Bhd Tender Notices.
URL: https://www.sesb.com.my/Tender.aspx

ASP.NET page — requests + BeautifulSoup.
"""
import logging
from typing import Iterator

from scraper.utils import make_session, parse_date, infer_status, now_iso

SOURCE_ID = 9
SOURCE_NAME = "SESB"
BASE_URL = "https://www.sesb.com.my/Tender.aspx"
HOST = "https://www.sesb.com.my"

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
    now = now_iso()

    for row in soup.select("table tbody tr"):
        cells = [td.get_text(" ", strip=True) for td in row.find_all("td")]
        if len(cells) < 2:
            continue
        link = row.find("a")
        url = HOST + link["href"] if link and link.get("href","").startswith("/") else BASE_URL

        ref      = cells[0]
        title    = cells[1]
        deadline = parse_date(cells[2]) if len(cells) > 2 else None
        open_d   = parse_date(cells[3]) if len(cells) > 3 else None

        yield {
            "source_id": SOURCE_ID,
            "ref":       ref,
            "title":     title,
            "deadline":  deadline,
            "open_date": open_d,
            "category":  "Electrical",
            "ministry":  "Sabah Electricity Sdn Bhd",
            "status":    infer_status(open_d, deadline),
            "url":       url,
            "scraped_at": now,
        }
