'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 14;
const SOURCE_NAME = 'Johor';
const BASE_URL = 'https://www.johor.gov.my/tender';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept-Language': 'ms-MY,ms;q=0.9,en;q=0.8',
};

async function* scrape() {
  const now = nowIso();
  let totalYielded = 0;

  try {
    let page = 1;
    while (true) {
      const url = page === 1 ? BASE_URL : `${BASE_URL}?page=${page}`;
      const { data, status } = await axios.get(url, { headers: HEADERS, timeout: 30000 });
      if (status !== 200) break;

      const $ = cheerio.load(data);
      const rows = [];

      // Try common Joomla/WordPress table patterns
      $('table tr, .tender-item, .views-row, article.tender').each((_, el) => {
        const cells = $(el).find('td');
        if (cells.length >= 3) {
          const title = $(cells[0]).text().trim() || $(el).find('.views-field-title, .tender-title, h2, h3').first().text().trim();
          const closeRaw = $(cells[cells.length - 1]).text().trim();
          const link = $(el).find('a').first().attr('href');
          if (title && title.length >= 15) {
            rows.push({ title, closeRaw, url: link ? new URL(link, BASE_URL).href : BASE_URL });
          }
        } else {
          const title = $(el).find('.views-field-title, .tender-title, h2, h3, a').first().text().trim();
          const closeRaw = $(el).find('.views-field-field-tarikh-tutup, .closing-date, time').first().text().trim();
          const link = $(el).find('a').first().attr('href');
          if (title && title.length >= 15) {
            rows.push({ title, closeRaw, url: link ? new URL(link, BASE_URL).href : BASE_URL });
          }
        }
      });

      console.log(`[${SOURCE_NAME}] page ${page}: ${rows.length} rows`);
      if (rows.length === 0) break;

      for (const r of rows) {
        const deadline = parseDate(r.closeRaw);
        yield {
          source_id: SOURCE_ID, ref: null,
          title: r.title, category: null, ministry: null,
          open_date: null, deadline,
          status: inferStatus(null, deadline),
          url: r.url || BASE_URL, scraped_at: now,
        };
        totalYielded++;
      }

      // Stop if no pagination link to next page
      const hasNext = $(`a[href*="page=${page + 1}"], .pager-next a, .next a`).length > 0;
      if (!hasNext) break;
      page++;
      if (page > 20) break;
    }
    console.log(`[${SOURCE_NAME}] done — ${totalYielded} records`);
  } catch (err) {
    console.error(`[${SOURCE_NAME}] fatal: ${err.message}`);
  }
}

module.exports = { SOURCE_ID, SOURCE_NAME, scrape };
