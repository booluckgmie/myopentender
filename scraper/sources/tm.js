const axios = require('axios');
const cheerio = require('cheerio');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 12;
const SOURCE_NAME = 'TM';
const BASE_URL = 'https://www.tm.com.my/en/business/procurement/open-tender/';

async function* scrape() {
  const now = nowIso();
  const results = [];
  try {
    const { data } = await axios.get(BASE_URL, { timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0' } });
    const $ = cheerio.load(data);
    $('table tbody tr').each((_, tr) => {
      const cells = $(tr).find('td').map((_, td) => $(td).text().trim()).get();
      if (cells.length < 2) return;
      const title = cells[1] || cells[0];
      if (!title || title.length < 15) return;
      const link = $(tr).find('a[href]').attr('href');
      let url = link || BASE_URL;
      if (url.startsWith('/')) url = 'https://www.tm.com.my' + url;
      const deadline = parseDate(cells[3] || cells[2]);
      const openDate = parseDate(cells[2]);
      results.push({ source_id: SOURCE_ID, ref: cells[0] || null, title,
        deadline, open_date: openDate, status: inferStatus(openDate, deadline), url, scraped_at: now });
    });
    $('article, .tender-item, .procurement-card').each((_, el) => {
      const title = $(el).find('h3, h4, .title, strong').first().text().trim();
      if (!title || title.length < 15) return;
      const link = $(el).find('a[href]').attr('href');
      let url = link || BASE_URL;
      if (url.startsWith('/')) url = 'https://www.tm.com.my' + url;
      const dateText = $(el).find('.date, time, .closing').first().text().trim();
      const deadline = parseDate(dateText);
      results.push({ source_id: SOURCE_ID, ref: null, title,
        deadline, open_date: null, status: inferStatus(null, deadline), url, scraped_at: now });
    });
  } catch (e) {
    console.error(`[${SOURCE_NAME}] fetch error: ${e.message}`);
  }
  for (const r of results) yield r;
}

module.exports = { SOURCE_ID, SOURCE_NAME, scrape };
