'use strict';

// SPSB eProcurement (Sarawak Pay & Salary Board) — PHP CodeIgniter on port 8443
const axios = require('axios');
const cheerio = require('cheerio');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 6;
const SOURCE_NAME = 'SPSB';
const BASE_HOST = 'https://eprocurement.spsb.com.my:8443/E-procurement';
const BASE_URL  = `${BASE_HOST}/index.php/home`;
// Also try public tender list paths
const TENDER_PATHS = [
  '/index.php/home',
  '/index.php/public/tender',
  '/index.php/tender',
  '/index.php/public',
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
  'Accept-Language': 'ms-MY,ms;q=0.9,en-US;q=0.8',
};

const SKIP = new Set(['no', 'no.', 'bil', 'tajuk', 'title', 'tarikh', 'date', 'status', 'tindakan', 'action',
  'rujukan', 'ref', 'no. iklan', 'tarikh mula', 'tarikh tutup', 'closing date', 'open date']);

async function* scrape() {
  const now = nowIso();
  let totalYielded = 0;
  let data = null;
  let usedUrl = BASE_URL;

  for (const path of TENDER_PATHS) {
    try {
      const url = `${BASE_HOST}${path}`;
      const resp = await axios.get(url, { headers: HEADERS, timeout: 30000 });
      if (resp.status === 200 && resp.data) {
        data = resp.data;
        usedUrl = url;
        console.log(`[${SOURCE_NAME}] fetched ${url}`);
        break;
      }
    } catch (_) {}
  }

  if (!data) {
    console.error(`[${SOURCE_NAME}] all paths failed`);
    return;
  }

  try {
    const $ = cheerio.load(data);

    // Try table rows
    $('table tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (!tds.length) return;
      const cells = tds.map((_, td) => $(td).text().trim()).get();
      if (cells.length < 2) return;

      // Skip header rows
      if (cells.every(c => SKIP.has(c.toLowerCase()))) return;

      const title = cells.find(c => c.length >= 15 && !SKIP.has(c.toLowerCase()) &&
        !/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}$/.test(c) && !/^\d+$/.test(c));
      if (!title) return;

      const dates = cells.filter(c => /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/.test(c));
      const closeRaw = dates[dates.length - 1] || null;
      const openRaw  = dates.length > 1 ? dates[0] : null;
      const link = $(tr).find('a').attr('href');
      const url  = link ? (link.startsWith('http') ? link : `${BASE_HOST}${link}`) : usedUrl;

      const open_date = parseDate(openRaw);
      const deadline  = parseDate(closeRaw);
      // Will be yielded below
      cells._title = title;
      cells._open = open_date;
      cells._deadline = deadline;
      cells._url = url;
    });

    // Redo as generator (can't yield in .each)
    const items = [];
    $('table tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (!tds.length) return;
      const cells = tds.map((_, td) => $(td).text().trim()).get();
      if (cells.length < 2) return;
      if (cells.every(c => SKIP.has(c.toLowerCase()))) return;
      const title = cells.find(c => c.length >= 15 && !SKIP.has(c.toLowerCase()) &&
        !/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}$/.test(c) && !/^\d+$/.test(c));
      if (!title) return;
      const dates = cells.filter(c => /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/.test(c));
      const closeRaw = dates[dates.length - 1] || null;
      const openRaw  = dates.length > 1 ? dates[0] : null;
      const link = $(tr).find('a').attr('href');
      const url  = link ? (link.startsWith('http') ? link : `${BASE_HOST}${link}`) : usedUrl;
      items.push({ title, openRaw, closeRaw, url });
    });

    // Also try card / list patterns
    $('[class*="tender"], [class*="procurement"], [class*="iklan"]').each((_, el) => {
      const title = $(el).find('h2,h3,h4,a,.title').first().text().trim();
      if (!title || title.length < 15) return;
      const text  = $(el).text();
      const dates = text.match(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/g) || [];
      const closeRaw = dates[dates.length - 1] || null;
      const link = $(el).find('a').attr('href');
      const url  = link ? (link.startsWith('http') ? link : `${BASE_HOST}${link}`) : usedUrl;
      items.push({ title, openRaw: null, closeRaw, url });
    });

    for (const item of items) {
      const open_date = parseDate(item.openRaw);
      const deadline  = parseDate(item.closeRaw);
      yield {
        source_id: SOURCE_ID, ref: null,
        title: item.title, category: null, ministry: null,
        open_date, deadline, status: inferStatus(open_date, deadline),
        url: item.url, scraped_at: now,
      };
      totalYielded++;
    }

    console.log(`[${SOURCE_NAME}] done — ${totalYielded} records`);
  } catch (err) {
    console.error(`[${SOURCE_NAME}] fatal: ${err.message}`);
  }
}

module.exports = { SOURCE_ID, SOURCE_NAME, scrape };
