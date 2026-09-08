'use strict';

// Perak S3PK — ASP.NET WebForms, GridView table, __doPostBack pagination
const axios = require('axios');
const cheerio = require('cheerio');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 7;
const SOURCE_NAME = 'Perak S3PK';
const BASE_URL = 'https://s3pk.perak.gov.my/IklanList.aspx';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
  'Accept-Language': 'ms-MY,ms;q=0.9,en-US;q=0.8',
  'Content-Type': 'application/x-www-form-urlencoded',
};

const SKIP = new Set(['no', 'no.', 'bil', 'no. iklan', 'no iklan', 'rujukan', 'no. rujukan',
  'tajuk tender', 'tajuk', 'title', 'tarikh iklan', 'tarikh mula', 'tarikh tutup', 'tarikh tamat',
  'status', 'tindakan', 'action', 'closing date', 'open date', 'date']);

function extractRows($) {
  const rows = [];
  // GridView renders as table with id containing "GridView" or "gvIklan" or "gv"
  const table = $('table[id*="Grid"], table[id*="gv"], table[id*="Iklan"], table.gridview, table').first();
  table.find('tr').each((_, tr) => {
    const tds = $(tr).find('td');
    if (!tds.length) return;
    const cells = tds.map((_, td) => $(td).text().trim()).get();
    if (cells.length < 2) return;
    if (cells.every(c => SKIP.has(c.toLowerCase().trim()))) return;

    // Find title: longest cell that's not a date or number
    const title = cells.find(c =>
      c.length >= 15 &&
      !SKIP.has(c.toLowerCase().trim()) &&
      !/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}$/.test(c) &&
      !/^\d+$/.test(c)
    );
    if (!title) return;

    const dates = cells.filter(c => /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/.test(c));
    const openRaw  = dates[0] || null;
    const closeRaw = dates[dates.length - 1] || null;
    const link = $(tds[0]).find('a').attr('href') || $(tds[1]).find('a').attr('href');
    const url  = link ? new URL(link, BASE_URL).href : BASE_URL;
    rows.push({ title, openRaw, closeRaw, url });
  });
  return rows;
}

function extractAspState($) {
  return {
    viewstate:          $('input[name="__VIEWSTATE"]').val() || '',
    viewstategenerator: $('input[name="__VIEWSTATEGENERATOR"]').val() || '',
    eventvalidation:    $('input[name="__EVENTVALIDATION"]').val() || '',
  };
}

function detectPageCount($) {
  // Pager row: last row of GridView contains page links
  let total = 1;
  $('table tr:last-child td a, .pager a, tfoot a').each((_, a) => {
    const n = parseInt($(a).text().trim(), 10);
    if (!isNaN(n) && n > total) total = n;
  });
  return total;
}

async function* scrape() {
  const now = nowIso();
  let totalYielded = 0;

  try {
    // Page 1
    const resp1 = await axios.get(BASE_URL, { headers: HEADERS, timeout: 30000 });
    let $ = cheerio.load(resp1.data);
    let state = extractAspState($);
    const totalPages = detectPageCount($);
    console.log(`[${SOURCE_NAME}] totalPages=${totalPages}`);

    const allRows = extractRows($);
    for (const r of allRows) {
      const open_date = parseDate(r.openRaw);
      const deadline  = parseDate(r.closeRaw);
      yield { source_id: SOURCE_ID, ref: null, title: r.title, category: null, ministry: null,
               open_date, deadline, status: inferStatus(open_date, deadline), url: r.url, scraped_at: now };
      totalYielded++;
    }
    console.log(`[${SOURCE_NAME}] p1/${totalPages}: ${allRows.length} rows`);

    // Subsequent pages via __doPostBack
    for (let pg = 2; pg <= Math.min(totalPages, 50); pg++) {
      const postBody = new URLSearchParams({
        '__EVENTTARGET':          'ctl00$MainContent$GridView1', // adjust if grid id differs
        '__EVENTARGUMENT':        `Page$${pg}`,
        '__VIEWSTATE':            state.viewstate,
        '__VIEWSTATEGENERATOR':   state.viewstategenerator,
        '__EVENTVALIDATION':      state.eventvalidation,
      });
      const resp = await axios.post(BASE_URL, postBody.toString(), {
        headers: { ...HEADERS, Referer: BASE_URL },
        timeout: 30000,
      });
      $ = cheerio.load(resp.data);
      state = extractAspState($);
      const rows = extractRows($);
      console.log(`[${SOURCE_NAME}] p${pg}/${totalPages}: ${rows.length} rows`);
      for (const r of rows) {
        const open_date = parseDate(r.openRaw);
        const deadline  = parseDate(r.closeRaw);
        yield { source_id: SOURCE_ID, ref: null, title: r.title, category: null, ministry: null,
                 open_date, deadline, status: inferStatus(open_date, deadline), url: r.url, scraped_at: now };
        totalYielded++;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    console.log(`[${SOURCE_NAME}] done — ${totalYielded} records`);
  } catch (err) {
    console.error(`[${SOURCE_NAME}] fatal: ${err.message}`);
  }
}

module.exports = { SOURCE_ID, SOURCE_NAME, scrape };
