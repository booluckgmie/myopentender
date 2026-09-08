'use strict';

// TNB (Tenaga Nasional Berhad) — corporate Drupal site, tender listings page
// URL: https://www.tnb.com.my/listings/tender_notices/
const axios = require('axios');
const cheerio = require('cheerio');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 11;
const SOURCE_NAME = 'TNB';
const BASE_URL = 'https://www.tnb.com.my/listings/tender_notices/';
const HOST = 'https://www.tnb.com.my';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
  'Accept-Language': 'en-US,en;q=0.9,ms;q=0.8',
};

async function* scrape() {
  const now = nowIso();
  let totalYielded = 0;

  // Drupal listings — try page 0, 1, 2 ...
  for (let pg = 0; pg <= 30; pg++) {
    const url = pg === 0 ? BASE_URL : `${BASE_URL}?page=${pg}`;
    let data;
    try {
      const resp = await axios.get(url, { headers: HEADERS, timeout: 30000 });
      data = resp.data;
    } catch (e) {
      console.error(`[${SOURCE_NAME}] page ${pg}: ${e.message}`);
      break;
    }

    const $ = cheerio.load(data);
    const items = [];

    // Drupal listing: view rows with .views-row, h3.node-title > a, field--type-datetime
    $('.views-row, article.node--type-tender, .node--type-tender, .views-col').each((_, el) => {
      const titleEl = $(el).find('h2 a, h3 a, h4 a, .field--name-title a, .node__title a, a').first();
      const title = titleEl.text().trim();
      if (!title || title.length < 15) return;
      const text = $(el).text();
      const dates = text.match(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}|\d{4}-\d{2}-\d{2}/g) || [];
      const closeRaw = dates[dates.length - 1] || null;
      const href = titleEl.attr('href') || $(el).find('a').attr('href') || '';
      const url  = href.startsWith('http') ? href : `${HOST}${href}`;
      items.push({ title, closeRaw, url });
    });

    // Fallback: table rows
    if (items.length === 0) {
      $('table tbody tr').each((_, tr) => {
        const cells = $(tr).find('td').map((_, td) => $(td).text().trim()).get();
        if (cells.length < 2) return;
        const title = cells[1] || cells[0];
        if (!title || title.length < 15) return;
        const dates = cells.filter(c => /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/.test(c));
        const closeRaw = dates[dates.length - 1] || null;
        const link = $(tr).find('a').attr('href');
        const url  = link ? new URL(link, BASE_URL).href : BASE_URL;
        items.push({ title, closeRaw, url });
      });
    }

    if (items.length === 0) break;
    console.log(`[${SOURCE_NAME}] page ${pg}: ${items.length} items`);

    for (const item of items) {
      const deadline = parseDate(item.closeRaw);
      yield {
        source_id: SOURCE_ID, ref: null,
        title: item.title, category: null, ministry: 'TNB',
        open_date: null, deadline, status: inferStatus(null, deadline),
        url: item.url, scraped_at: now,
      };
      totalYielded++;
    }

    // Stop if no "next page" link
    const hasNext = $('a[href*="page="], .pager__item--next a, li.next a').length > 0;
    if (!hasNext) break;
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`[${SOURCE_NAME}] done — ${totalYielded} records`);
}

module.exports = { SOURCE_ID, SOURCE_NAME, scrape };
