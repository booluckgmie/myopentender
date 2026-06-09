#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const { getConn, initDb } = require('./db');
const { nowIso } = require('./utils');
const { scrapeAll, SOURCES } = require('./runner-lib');

async function exportJson(db, outPath) {
  const tenders = db.prepare('SELECT * FROM tenders ORDER BY deadline ASC').all();
  const notifications = db.prepare('SELECT * FROM notifications ORDER BY created_at DESC').all();
  const data = { exported_at: nowIso(), tenders, notifications };
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
  console.log(`Exported ${tenders.length} tenders → ${outPath}`);
}

async function main() {
  const args = process.argv.slice(2);
  const exportOnly = args.includes('--export-only');
  const doExport = args.includes('--export') || exportOnly || args.includes('--export-only');
  const sourcesArg = args.find(a => a.startsWith('--sources='));

  const db = getConn();
  initDb(db);

  if (!exportOnly) {
    let ids;
    if (sourcesArg) {
      ids = sourcesArg.replace('--sources=', '').split(',').map(Number);
    } else {
      ids = Object.keys(SOURCES).map(Number);
    }
    const summary = await scrapeAll(db, ids);
    const totalNew = Object.values(summary).reduce((a, v) => a + v.new, 0);
    const errors = Object.entries(summary).filter(([, v]) => v.error).map(([k]) => k);
    console.log(`Done — ${totalNew} new tenders, ${errors.length} errors: ${errors.join(',') || 'none'}`);
  }

  if (doExport || args.includes('--export')) {
    const rootPath = path.join(__dirname, '..', 'tenders.json');
    const publicPath = path.join(__dirname, '..', 'public', 'tenders.json');
    await exportJson(db, rootPath);
    // Also copy to public/ for Express static serving
    const fs2 = require('fs');
    fs2.copyFileSync(rootPath, publicPath);
    console.log(`Also copied → ${publicPath}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
