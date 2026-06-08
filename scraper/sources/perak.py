"""
Perak S3PK — Sistem Sebut Harga dan Tender Negeri Perak.
URL: https://s3pk.perak.gov.my/IklanList.aspx

Plain ASP.NET HTML table — requests + BeautifulSoup.
Skips header rows and rows where title cell looks like a column label.
"""
import logging
from typing import Iterator

from scraper.utils import make_session, parse_date, infer_status, now_iso

SOURCE_ID = 7
SOURCE_NAME = "Perak S3PK"
BASE_URL = "https://s3pk.perak.gov.my/IklanList.aspx"
HOST = "https://s3pk.perak.gov.my"

logger = logging.getLogger(__name__)

_HEADER_CELLS = {
    "no", "no.", "tajuk sebutharga", "tajuk tender", "title",
    "tarikh tutup", "closing date", "gred", "pengkhususan",
    "lawatan tapak", "tindakan",
}


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

    for row in soup.select("table tr"):
        if row.find("th") and not row.find("td"):
            continue
        cells = [td.get_text(" ", strip=True) for td in row.find_all("td")]
        if len(cells) < 2:
            continue
        # The title is usually in cells[1]; cells[0] is a row number
        title_candidate = cells[1] if len(cells) > 1 else cells[0]
        if title_candidate.lower().strip() in _HEADER_CELLS:
            continue
        # Skip rows where the entire first merged cell is a multi-column header blob
        if len(cells) == 1 and len(cells[0]) < 80:
            continue

        link = row.find("a")
        url = HOST + link["href"] if link and link.get("href", "").startswith("/") else BASE_URL

        ref      = cells[0].strip() or None
        title    = cells[1].strip() if len(cells) > 1 else cells[0].strip()
        deadline = parse_date(cells[2]) if len(cells) > 2 else None
        open_d   = parse_date(cells[3]) if len(cells) > 3 else None
        ministry = cells[4].strip() if len(cells) > 4 else None

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
