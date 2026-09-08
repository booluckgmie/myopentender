'use strict';

// SESB (Sabah Electricity Sdn Bhd) — ASP.NET, Tender.aspx, table or repeater
const axios = require('axios');
const cheerio = require('cheerio');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 9;
const SOURCE_NAME = 'SESB';
const BASE_URL = 'https://www.sesb.com.my/Tender.aspx';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
  'Accept-Language': 'en-US,en;q=0.9,ms;q=0.8',
};

const SKIP = new Set(['no', 'no.', 'tender no', 'tender no.', 'no. tender',
  'description', 'title', 'closing date', 'tarikh tutup', 'status', 'action', 'tindakan']);

async function* scrape() {
  const now = nowIso();
  let totalYielded = 0;

  try {
    const { data } = await axios.get(BASE_URL, { headers: HEADERS, timeout: 30000 });
    const $ = cheerio.load(data);
    const items = [];

    // ASP.NET table: usually <table> inside UpdatePanel or ContentPlaceHolder
    $('table tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (!tds.length) return;
      const cells = tds.map((_, td) => $(td).text().trim()).get();
      if (cells.length < 2) return;
      if (cells.every(c => SKIP.has(c.toLowerCase()))) return;

      // Tender No is usually cells[0], Description is cells[1]
      const ref = cells[0] && !SKIP.has(cells[0].toLowerCase()) && cells[0].length < 50 ? cells[0] : null;
      const title = cells[1] && cells[1].length >= 15 ? cells[1]
                  : cells.find(c => c.length >= 15 && !SKIP.has(c.toLowerCase()) &&
                      !/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}$/.test(c));
      if (!title) return;

      const dates = cells.filter(c => /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/.test(c));
      const closeRaw = dates[dates.length - 1] || null;
      const link = $(tr).find('a').attr('href');
      const url  = link ? new URL(link, BASE_URL).href : BASE_URL;
      items.push({ ref, title, closeRaw, url });
    });

    // Also try list / card patterns (some SESB page versions use divs)
    $('[class*="tender"], [class*="Tender"], .procurement-item').each((_, el) => {
      const title = $(el).find('h2,h3,h4,strong,a,.title').first().text().trim();
      if (!title || title.length < 15) return;
      const text = $(el).text();
      const dates = text.match(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/g) || [];
      const closeRaw = dates[dates.length - 1] || null;
      const link = $(el).find('a').attr('href');
      const url  = link ? new URL(link, BASE_URL).href : BASE_URL;
      items.push({ ref: null, title, closeRaw, url });
    });

    console.log(`[${SOURCE_NAME}] ${items.length} items found`);
    for (const item of items) {
      const deadline = parseDate(item.closeRaw);
      yield {
        source_id: SOURCE_ID, ref: item.ref,
        title: item.title, category: null, ministry: 'SESB',
        open_date: null, deadline, status: inferStatus(null, deadline),
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
