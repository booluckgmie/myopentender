"""
Kedah State Government — Tender & Sebut Harga.
URL: https://www.kedah.gov.my/index.php/tender-sebut-harga-jabatan-negeri/

WordPress site — requests + BeautifulSoup.
"""
import logging
from typing import Iterator

from scraper.utils import make_session, parse_date, infer_status, now_iso

SOURCE_ID = 8
SOURCE_NAME = "Kedah Gov"
BASE_URL = "https://www.kedah.gov.my/index.php/tender-sebut-harga-jabatan-negeri/"
HOST = "https://www.kedah.gov.my"

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

    for row in soup.select("table tr, .entry-content table tr"):
        cells = [td.get_text(" ", strip=True) for td in row.find_all("td")]
        if len(cells) < 2:
            continue
        link = row.find("a")
        url = link["href"] if link and link.get("href") else BASE_URL
        if url.startswith("/"):
            url = HOST + url

        title    = cells[0]
        deadline = parse_date(cells[1]) if len(cells) > 1 else None
        open_d   = parse_date(cells[2]) if len(cells) > 2 else None

        yield {
            "source_id": SOURCE_ID,
            "ref":       None,
            "title":     title,
            "deadline":  deadline,
            "open_date": open_d,
            "status":    infer_status(open_d, deadline),
            "url":       url,
            "scraped_at": now,
        }
