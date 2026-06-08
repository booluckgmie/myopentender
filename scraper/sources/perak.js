const axios = require('axios');
const cheerio = require('cheerio');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 7;
const SOURCE_NAME = 'Perak S3PK';
const BASE_URL = 'https://s3pk.perak.gov.my/';
const TENDER_URL = 'https://s3pk.perak.gov.my/public/tender';
const HEADER_CELLS = new Set(['no', 'tajuk tender', 'tarikh mula', 'tarikh tutup',
  'status', 'tindakan', 'title', 'ref', 'open date', 'close date', 'action']);

async function* scrape() {
  const now = nowIso();
  const results = [];
  try {
    const { data } = await axios.get(TENDER_URL, { timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9,ms;q=0.8' } });
    const $ = cheerio.load(data);
    $('table tr').each((_, tr) => {
      if ($(tr).find('th').length && !$(tr).find('td').length) return;
      const tds = $(tr).find('td');
      if (!tds.length) return;
      const cells = tds.map((_, td) => $(td).text().trim()).get();
      const title = cells[1] || cells[0];
      if (!title || HEADER_CELLS.has(title.toLowerCase())) return;
      const link = $(tr).find('a[href]').attr('href');
      const url = link ? (link.startsWith('http') ? link : BASE_URL + link.replace(/^\//, '')) : TENDER_URL;
      const openDate = parseDate(cells[2]);
      const deadline = parseDate(cells[3]);
      results.push({ source_id: SOURCE_ID, ref: cells[0] || null, title,
        deadline, open_date: openDate, status: inferStatus(openDate, deadline), url, scraped_at: now });
    });
  } catch (e) {
    console.error(`[${SOURCE_NAME}] fetch error: ${e.message}`);
  }
  for (const r of results) yield r;
}

module.exports = { SOURCE_ID, SOURCE_NAME, scrape };
