"""
Sarawak eTender public tender list.
URL: https://etendernotice.sarawak.gov.my/etender/public/public_tender_list.jsp

Plain HTML table — requests + BeautifulSoup.
"""
import logging
from typing import Iterator

from scraper.utils import make_session, parse_date, infer_status, now_iso

SOURCE_ID = 4
SOURCE_NAME = "Sarawak eTender"
BASE_URL = "https://etendernotice.sarawak.gov.my/etender/public/public_tender_list.jsp"
HOST = "https://etendernotice.sarawak.gov.my"

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

    for row in soup.select("table tr"):
        cells = [td.get_text(" ", strip=True) for td in row.find_all("td")]
        if len(cells) < 4:
            continue
        link = row.find("a")
        url = HOST + link["href"] if link and link.get("href","").startswith("/") else BASE_URL

        ref      = cells[0]
        title    = cells[1]
        ministry = cells[2] if len(cells) > 2 else None
        deadline = parse_date(cells[3]) if len(cells) > 3 else None
        open_d   = parse_date(cells[4]) if len(cells) > 4 else None
        now = now_iso()
        yield {
            "source_id": SOURCE_ID,
            "ref":       ref,
            "title":     title,
            "ministry":  ministry,
            "deadline":  deadline,
            "open_date": open_d,
            "status":    infer_status(open_d, deadline),
            "url":       url,
            "scraped_at": now,
        }
