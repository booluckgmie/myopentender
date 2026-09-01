'use strict';

// PETRONAS Supplier & Procurement Portal
// https://www.petronas.com/procurement

const axios = require('axios');
const cheerio = require('cheerio');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 16;
const SOURCE_NAME = 'PETRONAS';
const BASE_URL = 'https://www.petronas.com/procurement';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function* scrape() {
  const now = nowIso();
  let totalYielded = 0;

  try {
    const { data } = await axios.get(BASE_URL, { headers: HEADERS, timeout: 30000 });
    const $ = cheerio.load(data);
    const items = [];

    // Generic scraping — collect all plausible tender title/link pairs
    $('table tr').each((_, tr) => {
      const cells = $(tr).find('td');
      if (cells.length < 2) return;
      const title = $(cells[0]).text().trim();
      if (!title || title.length < 15) return;
      const closeRaw = $(cells[cells.length - 1]).text().trim();
      const link = $(tr).find('a').first().attr('href');
      items.push({ title, closeRaw, link });
    });

    // Also try card/list patterns
    $('.procurement-item, .tender-card, .bid-item, article.tender, .views-row').each((_, el) => {
      const title = $(el).find('h2, h3, .title, a').first().text().trim();
      if (!title || title.length < 15) return;
      const closeRaw = $(el).find('.close-date, .deadline, time, td:last-child').first().text().trim();
      const link = $(el).find('a').first().attr('href');
      items.push({ title, closeRaw, link });
    });

    for (const item of items) {
      const deadline = parseDate(item.closeRaw);
      yield {
        source_id: SOURCE_ID, ref: null,
        title: item.title, category: null, ministry: 'PETRONAS',
        open_date: null, deadline,
        status: inferStatus(null, deadline),
        url: item.link ? new URL(item.link, BASE_URL).href : BASE_URL,
        scraped_at: now,
      };
      totalYielded++;
    }

    console.log(`[${SOURCE_NAME}] done — ${totalYielded} records`);
  } catch (err) {
    console.error(`[${SOURCE_NAME}] fatal: ${err.message}`);
  }
}

module.exports = { SOURCE_ID, SOURCE_NAME, scrape };
