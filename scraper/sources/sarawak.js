'use strict';

// Sarawak eTender Notice — JSP public listing, plain HTML table, no JS required
const axios = require('axios');
const cheerio = require('cheerio');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 4;
const SOURCE_NAME = 'Sarawak';
const BASE_URL = 'https://etendernotice.sarawak.gov.my/etender/public/public_tender_list.jsp';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
  'Accept-Language': 'ms-MY,ms;q=0.9,en-US;q=0.8',
};

const SKIP_HEADERS = new Set(['no.', 'no', 'tajuk tender', 'tajuk', 'tarikh iklan', 'tarikh tutup',
  'tarikh mula', 'status', 'tindakan', 'title', 'closing date', 'open date', 'action', 'ref no', 'no. rujukan']);

async function* scrape() {
  const now = nowIso();
  let totalYielded = 0;

  try {
    for (let page = 1; page <= 50; page++) {
      const url = page === 1 ? BASE_URL : `${BASE_URL}?page=${page}`;
      const { data } = await axios.get(url, { headers: HEADERS, timeout: 30000 });
      const $ = cheerio.load(data);

      const rows = [];
      $('table tr').each((_, tr) => {
        const tds = $(tr).find('td');
        if (!tds.length) return;
        const cells = tds.map((_, td) => $(td).text().trim()).get();
        if (cells.length < 2) return;

        // Skip header rows
        const firstCell = cells[0].toLowerCase().replace(/[.\s]+/g, ' ').trim();
        if (SKIP_HEADERS.has(firstCell)) return;

        // Title is usually the longest non-date cell; try col 1 then col 0
        let title = cells[1] || cells[0];
        if (!title || title.length < 10) return;

        // Detect date-like columns (dd/mm/yyyy or yyyy-mm-dd)
        const dates = cells.filter(c => /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}|\d{4}[\/\-]\d{2}[\/\-]\d{2}/.test(c));
        const closeRaw = dates[dates.length - 1] || null;
        const openRaw  = dates.length > 1 ? dates[0] : null;

        const link = $(tds[1] || tds[0]).find('a').attr('href') || $(tds[0]).find('a').attr('href');
        rows.push({ title, closeRaw, openRaw, link });
      });

      if (rows.length === 0) break;
      console.log(`[${SOURCE_NAME}] page ${page}: ${rows.length} rows`);

      for (const r of rows) {
        const open_date = parseDate(r.openRaw);
        const deadline  = parseDate(r.closeRaw);
        yield {
          source_id: SOURCE_ID, ref: null,
          title: r.title, category: null, ministry: null,
          open_date, deadline, status: inferStatus(open_date, deadline),
          url: r.link ? new URL(r.link, BASE_URL).href : BASE_URL,
          scraped_at: now,
        };
        totalYielded++;
      }

      // Stop if no next-page link
      const hasNext = $('a[href*="page="]').filter((_, a) => {
        const href = $(a).attr('href') || '';
        const m = href.match(/page=(\d+)/);
        return m && parseInt(m[1], 10) === page + 1;
      }).length > 0;
      if (!hasNext && page > 1) break;
    }

    console.log(`[${SOURCE_NAME}] done — ${totalYielded} records`);
  } catch (err) {
    console.error(`[${SOURCE_NAME}] fatal: ${err.message}`);
  }
}

module.exports = { SOURCE_ID, SOURCE_NAME, scrape };
