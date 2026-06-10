const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'tenders.sqlite');

let _conn = null;

function getConn() {
  if (!_conn) {
    _conn = new Database(DB_PATH);
    _conn.pragma('journal_mode = WAL');
    _conn.pragma('foreign_keys = ON');
  }
  return _conn;
}

function initDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id   INTEGER NOT NULL,
      ref         TEXT,
      title       TEXT NOT NULL,
      deadline    TEXT,
      open_date   TEXT,
      category    TEXT,
      ministry    TEXT,
      value       TEXT,
      notes       TEXT,
      status      TEXT DEFAULT 'active',
      url         TEXT,
      starred     INTEGER DEFAULT 0,
      notify      INTEGER DEFAULT 0,
      scraped_at  TEXT,
      created_at  TEXT DEFAULT (datetime('now')),
      UNIQUE(source_id, ref, title)
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      tender_id   INTEGER REFERENCES tenders(id),
      message     TEXT,
      read        INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS scrape_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id   INTEGER,
      source_name TEXT,
      scraped_at  TEXT,
      new_count   INTEGER DEFAULT 0,
      error       TEXT
    );
  `);

  // Add new columns to existing DBs that don't have them yet
  for (const col of ['category TEXT', 'ministry TEXT', 'value TEXT', 'notes TEXT']) {
    try {
      db.exec(`ALTER TABLE tenders ADD COLUMN ${col}`);
    } catch (e) {
      // Column already exists — ignore
    }
  }
}

function upsertTender(db, row) {
  const existing = db.prepare(
    'SELECT id FROM tenders WHERE source_id=? AND title=?'
  ).get(row.source_id, row.title);

  if (existing) {
    db.prepare(`
      UPDATE tenders SET ref=?, deadline=?, open_date=?, category=?, ministry=?, status=?, url=?, scraped_at=?
      WHERE id=?
    `).run(row.ref || null, row.deadline || null, row.open_date || null,
           row.category || null, row.ministry || null,
           row.status || 'active', row.url || null, row.scraped_at, existing.id);
    return false;
  } else {
    db.prepare(`
      INSERT INTO tenders (source_id, ref, title, deadline, open_date, category, ministry, status, url, scraped_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(row.source_id, row.ref || null, row.title, row.deadline || null,
           row.open_date || null, row.category || null, row.ministry || null,
           row.status || 'active', row.url || null, row.scraped_at);
    return true;
  }
}

module.exports = { getConn, initDb, upsertTender };
