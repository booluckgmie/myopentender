const express = require('express');
const path = require('path');
const { getConn, initDb, upsertTender } = require('./scraper/db');
const { inferStatus, nowIso } = require('./scraper/utils');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const db = getConn();
initDb(db);

// ── Tenders ──────────────────────────────────────────────────────────────────

app.get('/api/tenders', (req, res) => {
  const { q, source_id, status, starred, page = 1, limit = 50 } = req.query;
  let sql = 'SELECT * FROM tenders WHERE 1=1';
  const params = [];
  if (q) { sql += ' AND title LIKE ?'; params.push(`%${q}%`); }
  if (source_id) { sql += ' AND source_id=?'; params.push(Number(source_id)); }
  if (status) { sql += ' AND status=?'; params.push(status); }
  if (starred === '1') { sql += ' AND starred=1'; }
  sql += ' ORDER BY deadline ASC NULLS LAST, scraped_at DESC';
  const offset = (Number(page) - 1) * Number(limit);
  const total = db.prepare(sql.replace('SELECT *', 'SELECT COUNT(*)')).get(...params)['COUNT(*)'];
  sql += ` LIMIT ? OFFSET ?`;
  params.push(Number(limit), offset);
  const rows = db.prepare(sql).all(...params);
  res.json({ total, page: Number(page), limit: Number(limit), data: rows });
});

app.get('/api/tenders/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM tenders WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  res.json(row);
});

app.post('/api/tenders', (req, res) => {
  const { source_id = 0, ref, title, deadline, open_date, url } = req.body;
  if (!title) return res.status(400).json({ error: 'title required' });
  const status = inferStatus(open_date, deadline);
  const now = nowIso();
  const info = db.prepare(
    'INSERT INTO tenders (source_id,ref,title,deadline,open_date,status,url,scraped_at) VALUES (?,?,?,?,?,?,?,?)'
  ).run(source_id, ref || null, title, deadline || null, open_date || null, status, url || null, now);
  res.status(201).json({ id: info.lastInsertRowid });
});

app.put('/api/tenders/:id', (req, res) => {
  const { title, deadline, open_date, url, ref } = req.body;
  const status = inferStatus(open_date, deadline);
  db.prepare(
    'UPDATE tenders SET title=COALESCE(?,title), deadline=?, open_date=?, url=COALESCE(?,url), ref=COALESCE(?,ref), status=? WHERE id=?'
  ).run(title || null, deadline || null, open_date || null, url || null, ref || null, status, req.params.id);
  res.json({ ok: true });
});

app.delete('/api/tenders/:id', (req, res) => {
  db.prepare('DELETE FROM tenders WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.patch('/api/tenders/:id/star', (req, res) => {
  const row = db.prepare('SELECT starred FROM tenders WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  db.prepare('UPDATE tenders SET starred=? WHERE id=?').run(row.starred ? 0 : 1, req.params.id);
  res.json({ starred: !row.starred });
});

app.patch('/api/tenders/:id/notify', (req, res) => {
  const row = db.prepare('SELECT notify, title FROM tenders WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  const newNotify = row.notify ? 0 : 1;
  db.prepare('UPDATE tenders SET notify=? WHERE id=?').run(newNotify, req.params.id);
  if (newNotify) {
    db.prepare('INSERT INTO notifications (tender_id, message) VALUES (?,?)').run(
      req.params.id, `Notification enabled for: ${row.title}`);
  }
  res.json({ notify: !!newNotify });
});

// ── Stats ─────────────────────────────────────────────────────────────────────

app.get('/api/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as n FROM tenders').get().n;
  const active = db.prepare("SELECT COUNT(*) as n FROM tenders WHERE status='active'").get().n;
  const upcoming = db.prepare("SELECT COUNT(*) as n FROM tenders WHERE status='upcoming'").get().n;
  const overdue = db.prepare("SELECT COUNT(*) as n FROM tenders WHERE status='overdue'").get().n;
  const starred = db.prepare('SELECT COUNT(*) as n FROM tenders WHERE starred=1').get().n;
  const bySrc = db.prepare('SELECT source_id, COUNT(*) as n FROM tenders GROUP BY source_id').all();
  const lastScrape = db.prepare('SELECT scraped_at FROM scrape_log ORDER BY id DESC LIMIT 1').get();
  res.json({ total, active, upcoming, overdue, starred, by_source: bySrc,
             last_scrape: lastScrape?.scraped_at || null });
});

// ── Sources ───────────────────────────────────────────────────────────────────

app.get('/api/sources', (req, res) => {
  const rows = db.prepare(`
    SELECT sl.source_id, sl.source_name, sl.scraped_at, sl.new_count, sl.error,
           COUNT(t.id) as tender_count
    FROM scrape_log sl
    LEFT JOIN tenders t ON t.source_id = sl.source_id
    WHERE sl.id IN (SELECT MAX(id) FROM scrape_log GROUP BY source_id)
    GROUP BY sl.source_id
  `).all();
  res.json(rows);
});

// ── Notifications ─────────────────────────────────────────────────────────────

app.get('/api/notifications', (req, res) => {
  const rows = db.prepare(`
    SELECT n.*, t.title as tender_title, t.deadline
    FROM notifications n
    LEFT JOIN tenders t ON t.id = n.tender_id
    ORDER BY n.created_at DESC LIMIT 50
  `).all();
  res.json(rows);
});

app.patch('/api/notifications/:id/read', (req, res) => {
  db.prepare('UPDATE notifications SET read=1 WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ── On-demand scrape ──────────────────────────────────────────────────────────

const { scrapeAll, SOURCES: ALL_SOURCES } = require('./scraper/runner-lib');

app.post('/api/scrape', async (req, res) => {
  const { source_ids } = req.body;
  try {
    const ids = source_ids || Object.keys(ALL_SOURCES).map(Number);
    const summary = await scrapeAll(db, ids);
    res.json({ ok: true, summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Serve SPA for all non-API routes ─────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`TenderTrack MY running at http://localhost:${PORT}`);
});
