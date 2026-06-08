const axios = require('axios');
const cheerio = require('cheerio');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 6;
const SOURCE_NAME = 'SPSB';
const BASE_URL = 'https://spsb.sarawak.gov.my/';

async function* scrape() {
  const now = nowIso();
  try {
    const { data } = await axios.get(BASE_URL + 'tender', { timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0' } });
    const $ = cheerio.load(data);
    $('table tr, .tender-row').each((_, tr) => {
      const tds = $(tr).find('td');
      if (!tds.length) return;
      const cells = tds.map((_, td) => $(td).text().trim()).get();
      const title = cells[1] || cells[0];
      if (!title || title.length < 15) return;
      const link = $(tr).find('a[href]').attr('href');
      const url = link ? (link.startsWith('http') ? link : BASE_URL + link.replace(/^\//, '')) : BASE_URL;
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
