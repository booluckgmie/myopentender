const { isValidTitle, nowIso } = require('./utils');
const { upsertTender } = require('./db');

const SOURCES = {
  1:  require('./sources/eperolehan'),
  2:  require('./sources/selangor'),
  3:  require('./sources/penang'),
  4:  require('./sources/sarawak'),
  5:  require('./sources/sabah'),
  6:  require('./sources/spsb'),
  7:  require('./sources/perak'),
  8:  require('./sources/kedah'),
  9:  require('./sources/sesb'),
  10: require('./sources/prasarana'),
  11: require('./sources/tnb'),
  12: require('./sources/tm'),
  13: require('./sources/bursa'),
};

async function scrapeAll(db, sourceIds) {
  const summary = {};
  for (const sid of sourceIds) {
    const mod = SOURCES[sid];
    if (!mod) continue;
    let newCount = 0;
    let error = null;
    try {
      for await (const row of mod.scrape()) {
        if (!isValidTitle(row.title)) continue;
        try { if (upsertTender(db, row)) newCount++; } catch {}
      }
      summary[sid] = { new: newCount, error: null };
    } catch (e) {
      error = e.message;
      summary[sid] = { new: 0, error };
    }
    db.prepare(
      'INSERT INTO scrape_log (source_id,source_name,scraped_at,new_count,error) VALUES (?,?,?,?,?)'
    ).run(sid, mod.SOURCE_NAME, nowIso(), newCount, error);
  }
  return summary;
}

module.exports = { scrapeAll, SOURCES };
