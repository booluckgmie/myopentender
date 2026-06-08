"""
Shared helpers: HTTP session, date parsing, status inference.
"""
import re
import logging
from datetime import date, datetime
from typing import Optional

import requests
from dateutil import parser as dateparser

logger = logging.getLogger(__name__)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/125.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9,ms;q=0.8",
}


def make_session(timeout: int = 20) -> requests.Session:
    s = requests.Session()
    s.headers.update(HEADERS)
    s.timeout = timeout
    return s


def parse_date(raw: Optional[str]) -> Optional[str]:
    """Return ISO-8601 date string (YYYY-MM-DD) or None."""
    if not raw:
        return None
    raw = raw.strip()
    # common MY date patterns: 31/12/2026, 31-12-2026, 31 Dec 2026
    raw = re.sub(r"(\d{2})/(\d{2})/(\d{4})", r"\3-\2-\1", raw)
    raw = re.sub(r"(\d{2})-(\d{2})-(\d{4})", r"\3-\2-\1", raw)
    try:
        return dateparser.parse(raw, dayfirst=True).strftime("%Y-%m-%d")
    except Exception:
        return None


def infer_status(open_date: Optional[str], deadline: Optional[str]) -> str:
    today = date.today()
    if deadline:
        dl = date.fromisoformat(deadline)
        if dl < today:
            return "overdue"
    if open_date:
        op = date.fromisoformat(open_date)
        if op > today:
            return "upcoming"
    return "active"


def now_iso() -> str:
    return datetime.utcnow().isoformat(timespec="seconds") + "Z"
