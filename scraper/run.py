"""
Main scraper entry point.

Usage:
    python -m scraper.run                  # scrape all sources
    python -m scraper.run --sources 1,4,7  # scrape specific source IDs
    python -m scraper.run --export         # scrape + export tenders.json for UI
    python -m scraper.run --export-only    # skip scraping, just re-export
"""
import argparse
import importlib
import json
import logging
import sys
from pathlib import Path

from scraper.db import get_conn, init_db, upsert_tender
from scraper.utils import now_iso

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s  %(name)s — %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("runner")

SOURCE_MODULES = {
    1:  "scraper.sources.eperolehan",
    2:  "scraper.sources.selangor",
    3:  "scraper.sources.penang",
    4:  "scraper.sources.sarawak",
    5:  "scraper.sources.sabah",
    6:  "scraper.sources.spsb",
    7:  "scraper.sources.perak",
    8:  "scraper.sources.kedah",
    9:  "scraper.sources.sesb",
    10: "scraper.sources.prasarana",
    11: "scraper.sources.tnb",
    12: "scraper.sources.tm",
    13: "scraper.sources.bursa",
}


def scrape_all(conn, source_ids: list[int]) -> dict:
    summary = {}
    for sid in source_ids:
        mod_path = SOURCE_MODULES.get(sid)
        if not mod_path:
            logger.warning("No module for source_id=%s", sid)
            continue
        try:
            mod = importlib.import_module(mod_path)
            new = 0
            error = None
            for row in mod.scrape():
                try:
                    if upsert_tender(conn, row):
                        new += 1
                except Exception as exc:
                    logger.error("upsert failed for %r: %s", row.get("title"), exc)
            conn.commit()
            logger.info("source_id=%s  new=%s", sid, new)
            summary[sid] = {"new": new, "error": None}
        except Exception as exc:
            logger.error("source_id=%s failed: %s", sid, exc)
            summary[sid] = {"new": 0, "error": str(exc)}
        finally:
            conn.execute(
                "INSERT INTO scrape_log (source_id,source_name,scraped_at,new_count,error) VALUES (?,?,?,?,?)",
                (sid, mod_path.split(".")[-1], now_iso(),
                 summary.get(sid, {}).get("new", 0),
                 summary.get(sid, {}).get("error"))
            )
            conn.commit()
    return summary


def export_json(conn, out_path: Path) -> None:
    """Export tenders + notifications to JSON so the UI can load them without sql.js."""
    rows = conn.execute("SELECT * FROM tenders ORDER BY deadline ASC").fetchall()
    notifs = conn.execute("SELECT * FROM notifications ORDER BY created_at DESC").fetchall()
    data = {
        "exported_at": now_iso(),
        "tenders": [dict(r) for r in rows],
        "notifications": [dict(n) for n in notifs],
    }
    out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info("Exported %d tenders → %s", len(rows), out_path)


def main():
    parser = argparse.ArgumentParser(description="TenderTrack MY scraper")
    parser.add_argument("--sources", help="Comma-separated source IDs (default: all)")
    parser.add_argument("--export", action="store_true", help="Export tenders.json after scraping")
    parser.add_argument("--export-only", action="store_true", help="Skip scraping, only export")
    args = parser.parse_args()

    conn = get_conn()
    init_db(conn)

    if not args.export_only:
        if args.sources:
            ids = [int(x.strip()) for x in args.sources.split(",")]
        else:
            ids = list(SOURCE_MODULES.keys())
        summary = scrape_all(conn, ids)
        total_new = sum(v["new"] for v in summary.values())
        errors = [sid for sid, v in summary.items() if v["error"]]
        logger.info("Done — %d new tenders, %d source errors: %s", total_new, len(errors), errors or "none")

    if args.export or args.export_only:
        out = Path(__file__).parent.parent / "tenders.json"
        export_json(conn, out)

    conn.close()


if __name__ == "__main__":
    main()
