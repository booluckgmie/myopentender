'use strict';

const { chromium } = require('playwright');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 2;
const SOURCE_NAME = 'Selangor';
const BASE_URL = 'https://tender.selangor.my/';

// Parse "10 Jun 2026" style Malay dates
function parseMalayDate(raw) {
  if (!raw) return null;
  const months = { jan:'01',feb:'02',mac:'03',apr:'04',mei:'05',jun:'06',
                   jul:'07',ogos:'08',sep:'09',okt:'10',nov:'11',dis:'12' };
  const m = raw.trim().match(/(\d{1,2})\s+([a-zA-Z]+)\s+(\d{4})/);
  if (!m) return parseDate(raw);
  const mo = months[m[2].toLowerCase().slice(0,3)] || months[m[2].toLowerCase()];
  if (!mo) return parseDate(raw);
  return `${m[3]}-${mo}-${m[1].padStart(2,'0')}`;
}

async function extractPageRows(page) {
  return page.evaluate(() => {
    const rows = [];
    document.querySelectorAll('#DataTables_Table_0 tbody tr').forEach(tr => {
      const tds = tr.querySelectorAll('td');
      if (tds.length < 4) return;

      const td0 = tds[0];
      // Ministry: first <strong><u>
      const ministryEl = td0.querySelector('strong u');
      const ministry = ministryEl ? ministryEl.textContent.trim() : null;

      // Ref: inside <small><strong>
      const refEl = td0.querySelector('small strong');
      const ref = refEl ? refEl.textContent.trim() : null;

      // Title + URL: <a class="table-tender-title">
      const linkEl = td0.querySelector('a.table-tender-title');
      const title = linkEl ? linkEl.textContent.trim() : td0.textContent.trim();
      const url = linkEl ? linkEl.href : null;

      // Category (Kod Bidang): td[1] — grab all text, clean up
      const td1 = tds[1];
      // Extract category type label (MOF / Gred CIDB / CIDB)
      const catLabel = td1.querySelector('strong u') ? td1.querySelector('strong u').textContent.trim() : null;
      // Extract category codes from <small>
      const catCodes = Array.from(td1.querySelectorAll('small')).map(s => s.textContent.trim()).filter(Boolean).join(' / ');
      const category = [catLabel, catCodes].filter(Boolean).join(': ') || null;

      // Tarikh Jual (open date): td[2]
      const openRaw = tds[2] ? tds[2].textContent.trim() : null;
      // Tarikh Tutup (deadline): td[3]
      const closeRaw = tds[3] ? tds[3].textContent.trim() : null;
      // Harga Dokumen (value): td[4]
      const value = tds[4] ? tds[4].textContent.trim() : null;

      rows.push({ ministry, ref, title, url, category, openRaw, closeRaw, value });
    });
    return rows;
  });
}

async function getTotalPages(page) {
  // Info text: "Paparan dari 1 hingga 10 dari 161 rekod"
  try {
    const info = await page.$eval('#DataTables_Table_0_info', el => el.textContent.trim());
    const m = info.match(/dari\s+(\d+)\s+rekod/i);
    if (m) {
      // We set page size to 100, so ceil(total/100)
      const total = parseInt(m[1], 10);
      return Math.ceil(total / 100);
    }
  } catch (_) {}
  return 1;
}

async function* scrape() {
  const now = nowIso();
  let browser = null;
  let totalYielded = 0;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'ms-MY',
    });
    const page = await ctx.newPage();

    console.log(`[${SOURCE_NAME}] navigating to ${BASE_URL}`);
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 60000 });

    // Wait for DataTables to finish loading (info text appears when done)
    await page.waitForSelector('#DataTables_Table_0_info', { timeout: 30000 });

    // Set page size to 100 to minimise page turns
    try {
      await page.selectOption('select[name="DataTables_Table_0_length"]', '100');
      // Wait for table to re-render
      await page.waitForFunction(
        () => document.querySelector('#DataTables_Table_0_info')?.textContent.includes('hingga'),
        { timeout: 15000 }
      );
    } catch (_) {
      console.warn(`[${SOURCE_NAME}] could not set page size to 100, continuing with default`);
    }

    const totalPages = await getTotalPages(page);
    console.log(`[${SOURCE_NAME}] total pages: ${totalPages}`);

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      console.log(`[${SOURCE_NAME}] scraping page ${pageNum}/${totalPages}`);

      const rawRows = await extractPageRows(page);
      console.log(`[${SOURCE_NAME}] page ${pageNum}: ${rawRows.length} rows`);

      for (const r of rawRows) {
        if (!r.title || r.title.length < 15) continue;

        const open_date = parseMalayDate(r.openRaw);
        const deadline = parseMalayDate(r.closeRaw);

        yield {
          source_id: SOURCE_ID,
          ref: r.ref || null,
          title: r.title,
          category: r.category || null,
          ministry: r.ministry || null,
          open_date,
          deadline,
          status: inferStatus(open_date, deadline),
          url: r.url || BASE_URL,
          scraped_at: now,
        };
        totalYielded++;
      }

      // Click next page if not on last page
      if (pageNum < totalPages) {
        try {
          // Use JS click to bypass visibility check (paginator may be off-screen)
          const clicked = await page.evaluate(() => {
            const nextLi = document.querySelector('#DataTables_Table_0_paginate li.next');
            if (!nextLi || nextLi.classList.contains('disabled')) return false;
            const a = nextLi.querySelector('a');
            if (a) { a.click(); return true; }
            nextLi.click();
            return true;
          });
          if (!clicked) break;

          // Wait for DataTables to re-render rows
          await page.waitForFunction(
            () => {
              const info = document.querySelector('#DataTables_Table_0_info')?.textContent || '';
              return info.includes('rekod') && document.querySelectorAll('#DataTables_Table_0 tbody tr').length > 0;
            },
            { timeout: 20000 }
          );

          // Extra wait for DataTables animation
          await page.waitForTimeout(1200);
        } catch (e) {
          console.warn(`[${SOURCE_NAME}] pagination error on page ${pageNum}: ${e.message}`);
          break;
        }
      }
    }

    console.log(`[${SOURCE_NAME}] done — ${totalYielded} records scraped`);
  } catch (err) {
    console.error(`[${SOURCE_NAME}] fatal error: ${err.message}`);
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) {}
    }
  }
}

module.exports = { SOURCE_ID, SOURCE_NAME, scrape };
