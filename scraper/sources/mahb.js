'use strict';

// Malaysia Airports Holdings Berhad — domain mahb.com.my is currently unresolvable
// Tenders are at corporate.malaysiaairports.com.my but specific procurement URL is dynamic/not public
const axios = require('axios');
const cheerio = require('cheerio');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 15;
const SOURCE_NAME = 'MAHB';
const BASE_URL = 'https://corporate.malaysiaairports.com.my/en/procurement/tenders';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
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

    // Try common patterns for Next.js/React tender listing
    const items = [];
    $('article, .tender-item, .procurement-item, table tr, li.tender').each((_, el) => {
      const title =
        $(el).find('h2, h3, h4, .title, a').first().text().trim() ||
        $(el).find('td').first().text().trim();
      if (!title || title.length < 15) return;
      const cells = $(el).find('td');
      const closeRaw = cells.length >= 2 ? $(cells.last()).text().trim() : $(el).find('time, .date').first().text().trim();
      const link = $(el).find('a[href]').first().attr('href');
      const deadline = parseDate(closeRaw);
      items.push({ title, deadline, link: link ? new URL(link, BASE_URL).href : BASE_URL });
    });

    for (const item of items) {
      yield {
        source_id: SOURCE_ID, ref: null,
        title: item.title, category: null, ministry: 'MAHB',
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
