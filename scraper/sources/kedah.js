const axios = require('axios');
const cheerio = require('cheerio');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 8;
const SOURCE_NAME = 'Kedah Gov';
const BASE_URL = 'https://www.kedah.gov.my/index.php/tender-sebut-harga-jabatan-negeri/';
const HOST = 'https://www.kedah.gov.my';

async function* scrape() {
  const now = nowIso();
  try {
    const { data } = await axios.get(BASE_URL, { timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9,ms;q=0.8' } });
    const $ = cheerio.load(data);
    $('table tr, .entry-content table tr').each((_, tr) => {
      if ($(tr).find('th').length && !$(tr).find('td').length) return;
      const tds = $(tr).find('td');
      if (!tds.length) return;
      const cells = tds.map((_, td) => $(td).text().trim()).get();
      const title = cells[0];
      if (!title) return;
      const link = $(tr).find('a[href]').attr('href');
      let url = link || BASE_URL;
      if (url.startsWith('/')) url = HOST + url;
      const deadline = parseDate(cells[1]);
      const openDate = parseDate(cells[2]);
      yield { source_id: SOURCE_ID, ref: null, title,
        deadline, open_date: openDate, status: inferStatus(openDate, deadline), url, scraped_at: now };
    });
  } catch (e) {
    console.error(`[${SOURCE_NAME}] fetch error: ${e.message}`);
  }
}

module.exports = { SOURCE_ID, SOURCE_NAME, scrape };
