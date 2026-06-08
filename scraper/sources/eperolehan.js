const axios = require('axios');
const cheerio = require('cheerio');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 1;
const SOURCE_NAME = 'ePerolehan';
const BASE_URL = 'https://www.eperolehan.gov.my/paparan/SenaraiTender.aspx';

async function* scrape() {
  const now = nowIso();
  const results = [];
  try {
    const { data } = await axios.get(BASE_URL, { timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' } });
    const $ = cheerio.load(data);
    $('table tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (!tds.length) return;
      const cells = tds.map((_, td) => $(td).text().trim()).get();
      const title = cells[1] || cells[0];
      if (!title) return;
      const link = $(tr).find('a[href]').attr('href');
      const url = link ? (link.startsWith('http') ? link : 'https://www.eperolehan.gov.my/' + link.replace(/^\//, '')) : BASE_URL;
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
