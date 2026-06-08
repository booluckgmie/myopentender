"""
Sarawak eTender public tender list.
URL: https://etendernotice.sarawak.gov.my/etender/public/public_tender_list.jsp

Plain HTML table — requests + BeautifulSoup.
Skips header rows (th elements) and nav/search text.
"""
import logging
from typing import Iterator

from scraper.utils import make_session, parse_date, infer_status, now_iso

SOURCE_ID = 4
SOURCE_NAME = "Sarawak eTender"
BASE_URL = "https://etendernotice.sarawak.gov.my/etender/public/public_tender_list.jsp"
HOST = "https://etendernotice.sarawak.gov.my"

logger = logging.getLogger(__name__)

# Known header/nav cell text to skip
_SKIP_CELLS = {
    "no", "title", "tajuk", "agency", "agensi", "posted date", "closing date",
    "tarikh tutup", "tarikh iklan", "status", "action", "tindakan",
    "* search for title or agency",
}


def scrape() -> Iterator[dict]:
    session = make_session()
    try:
        import urllib3
        urllib3.disable_warnings()
        resp = session.get(BASE_URL, verify=False)
        resp.raise_for_status()
    except Exception as exc:
        logger.error("%s fetch failed: %s", SOURCE_NAME, exc)
        return

    from bs4 import BeautifulSoup
    soup = BeautifulSoup(resp.text, "lxml")

    for row in soup.select("table tr"):
        # Skip rows that only have <th> cells (header rows)
        if row.find("th") and not row.find("td"):
            continue
        cells = [td.get_text(" ", strip=True) for td in row.find_all("td")]
        if len(cells) < 3:
            continue
        # Skip if first two cells look like headers
        if cells[0].lower().strip() in _SKIP_CELLS or cells[1].lower().strip() in _SKIP_CELLS:
            continue

        link = row.find("a")
        url = HOST + link["href"] if link and link.get("href", "").startswith("/") else BASE_URL

        ref      = cells[0].strip()
        title    = cells[1].strip()
        ministry = cells[2].strip() if len(cells) > 2 else None
        deadline = parse_date(cells[3]) if len(cells) > 3 else None
        open_d   = parse_date(cells[4]) if len(cells) > 4 else None
        now = now_iso()
        yield {
            "source_id": SOURCE_ID,
            "ref":       ref or None,
            "title":     title,
            "ministry":  ministry,
            "deadline":  deadline,
            "open_date": open_d,
            "status":    infer_status(open_d, deadline),
            "url":       url,
            "scraped_at": now,
        }
