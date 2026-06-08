"""
SQLite schema and helpers — matches the sql.js schema in index.html.
"""
import sqlite3
from pathlib import Path

DB_PATH = Path(__file__).parent.parent / "tenders.sqlite"


def get_conn(path: Path = DB_PATH) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS tenders (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            title       TEXT NOT NULL,
            ref         TEXT,
            source_id   INTEGER NOT NULL,
            open_date   TEXT,
            deadline    TEXT,
            value       REAL,
            category    TEXT,
            ministry    TEXT,
            status      TEXT DEFAULT 'active',
            url         TEXT,
            notes       TEXT,
            starred     INTEGER DEFAULT 0,
            notified    INTEGER DEFAULT 0,
            date_added  TEXT,
            scraped_at  TEXT
        );

        CREATE TABLE IF NOT EXISTS notifications (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            tender_id   INTEGER,
            type        TEXT,
            message     TEXT,
            created_at  TEXT,
            read        INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS scrape_log (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id   INTEGER,
            source_name TEXT,
            scraped_at  TEXT,
            new_count   INTEGER DEFAULT 0,
            error       TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_tenders_source   ON tenders(source_id);
        CREATE INDEX IF NOT EXISTS idx_tenders_status   ON tenders(status);
        CREATE INDEX IF NOT EXISTS idx_tenders_deadline ON tenders(deadline);
    """)
    conn.commit()


def upsert_tender(conn: sqlite3.Connection, row: dict) -> bool:
    """Insert if ref+source_id not seen before. Returns True if new."""
    existing = conn.execute(
        "SELECT id FROM tenders WHERE ref=? AND source_id=?",
        (row.get("ref"), row["source_id"])
    ).fetchone()
    if existing:
        conn.execute(
            """UPDATE tenders SET title=?, deadline=?, open_date=?, value=?,
               category=?, ministry=?, url=?, status=?, scraped_at=?
               WHERE id=?""",
            (row["title"], row.get("deadline"), row.get("open_date"),
             row.get("value"), row.get("category"), row.get("ministry"),
             row.get("url"), row.get("status", "active"), row["scraped_at"],
             existing["id"])
        )
        return False
    conn.execute(
        """INSERT INTO tenders
           (title,ref,source_id,open_date,deadline,value,category,ministry,
            status,url,notes,starred,notified,date_added,scraped_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,0,0,?,?)""",
        (row["title"], row.get("ref"), row["source_id"],
         row.get("open_date"), row.get("deadline"), row.get("value"),
         row.get("category"), row.get("ministry"),
         row.get("status", "active"), row.get("url"), row.get("notes", ""),
         row["scraped_at"], row["scraped_at"])
    )
    return True
