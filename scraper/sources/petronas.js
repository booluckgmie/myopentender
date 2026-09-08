'use strict';

// PETRONAS — Vendor Announcements page
// Note: PETRONAS tenders require vendor registration; only general announcements are public
const axios = require('axios');
const cheerio = require('cheerio');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 16;
const SOURCE_NAME = 'PETRONAS';
const BASE_URL = 'https://www.petronas.com/partner-us/vendor-announcements';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
  'Accept-Language': 'en-US,en;q=0.9',
};

async function* scrape() {
  const now = nowIso();
  let totalYielded = 0;

  try {
    const { data, status } = await axios.get(BASE_URL, { headers: HEADERS, timeout: 30000 });
    if (status !== 200) {
      console.log(`[${SOURCE_NAME}] HTTP ${status} — skipping`);
      return;
    }
    const $ = cheerio.load(data);
    const items = [];

    // Try generic patterns for Drupal-based PETRONAS site
    $('.views-row, article, .announcement-item, table tr').each((_, el) => {
      const title =
        $(el).find('h2, h3, .title, a.title, .field-content a').first().text().trim() ||
        $(el).find('td').first().text().trim();
      if (!title || title.length < 15) return;

      const dateRaw = $(el).find('time, .date, .field-date, td:last-child').first().text().trim();
      const link = $(el).find('a[href]').first().attr('href');
      const deadline = parseDate(dateRaw);
      items.push({ title, deadline, link: link ? new URL(link, 'https://www.petronas.com').href : BASE_URL });
    });

    for (const item of items) {
      yield {
        source_id: SOURCE_ID, ref: null,
        title: item.title, category: null, ministry: 'PETRONAS',
        open_date: null, deadline: item.deadline,
        status: inferStatus(null, item.deadline),
        url: item.link, scraped_at: now,
      };
      totalYielded++;
    }

    console.log(`[${SOURCE_NAME}] done — ${totalYielded} records`);
  } catch (err) {
    console.error(`[${SOURCE_NAME}] ${err.message}`);
  }
}

module.exports = { SOURCE_ID, SOURCE_NAME, scrape };
