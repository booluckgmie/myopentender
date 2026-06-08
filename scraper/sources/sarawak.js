const axios = require('axios');
const cheerio = require('cheerio');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 4;
const SOURCE_NAME = 'Sarawak';
const BASE_URL = 'https://www.sarawak.gov.my/web/home/article_view/195/';
const SKIP_CELLS = new Set(['no', 'tajuk', 'tarikh', 'status', 'tindakan',
  'posted date', 'closing date', 'title', 'ref no', 'action', 'type']);

async function* scrape() {
  const now = nowIso();
  const results = [];
  try {
    const { data } = await axios.get(BASE_URL, { timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9,ms;q=0.8' } });
    const $ = cheerio.load(data);
    $('table tr').each((_, tr) => {
      if ($(tr).find('th').length && !$(tr).find('td').length) return;
      const tds = $(tr).find('td');
      if (!tds.length) return;
      const cells = tds.map((_, td) => $(td).text().trim()).get();
      const title = cells[1] || cells[0];
      if (!title || SKIP_CELLS.has(title.toLowerCase())) return;
      const link = $(tr).find('a[href]').attr('href');
      const url = link ? (link.startsWith('http') ? link : 'https://www.sarawak.gov.my' + link) : BASE_URL;
      const deadline = parseDate(cells[3] || cells[2]);
      const openDate = parseDate(cells[2]);
      results.push({ source_id: SOURCE_ID, ref: cells[0] || null, title,
        deadline, open_date: openDate, status: inferStatus(openDate, deadline), url, scraped_at: now });
    });
  } catch (e) {
    console.error(`[${SOURCE_NAME}] fetch error: ${e.message}`);
  }
  for (const r of results) yield r;
}

module.exports = { SOURCE_ID, SOURCE_NAME, scrape };
