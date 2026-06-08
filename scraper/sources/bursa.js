const axios = require('axios');
const cheerio = require('cheerio');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 13;
const SOURCE_NAME = 'Bursa Malaysia';
const BASE_URL = 'https://www.bursamalaysia.com/market_information/announcements/company_announcement';

async function* scrape() {
  const now = nowIso();
  try {
    const { data } = await axios.get(BASE_URL, { timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0' } });
    const $ = cheerio.load(data);
    $('table tbody tr, .announcement-row').each((_, el) => {
      const tds = $(el).find('td');
      if (!tds.length) return;
      const cells = tds.map((_, td) => $(td).text().trim()).get();
      const title = cells[1] || cells[0];
      if (!title || title.length < 15) return;
      if (!/tender|procurement|sebut harga|RFP|RFQ/i.test(title)) return;
      const link = $(el).find('a[href]').attr('href');
      let url = link || BASE_URL;
      if (url.startsWith('/')) url = 'https://www.bursamalaysia.com' + url;
      const deadline = parseDate(cells[3] || cells[2]);
      const openDate = parseDate(cells[2]);
      yield { source_id: SOURCE_ID, ref: cells[0] || null, title,
        deadline, open_date: openDate, status: inferStatus(openDate, deadline), url, scraped_at: now };
    });
  } catch (e) {
    console.error(`[${SOURCE_NAME}] fetch error: ${e.message}`);
  }
}

module.exports = { SOURCE_ID, SOURCE_NAME, scrape };
