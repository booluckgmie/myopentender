const axios = require('axios');
const cheerio = require('cheerio');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 9;
const SOURCE_NAME = 'SESB';
const BASE_URL = 'https://www.sesb.com.my/en/procurement/tender-notices/';

async function* scrape() {
  const now = nowIso();
  try {
    const { data } = await axios.get(BASE_URL, { timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0' } });
    const $ = cheerio.load(data);
    $('table tr, .tender-list li, article.tender').each((_, el) => {
      const tds = $(el).find('td');
      let title, link, deadline, openDate;
      if (tds.length) {
        const cells = tds.map((_, td) => $(td).text().trim()).get();
        title = cells[1] || cells[0];
        link = $(el).find('a[href]').attr('href');
        deadline = parseDate(cells[3] || cells[2]);
        openDate = parseDate(cells[2]);
      } else {
        title = $(el).find('h3, h4, .title, strong').first().text().trim();
        link = $(el).find('a[href]').attr('href');
        const dateText = $(el).find('.date, time, .deadline').first().text().trim();
        deadline = parseDate(dateText);
      }
      if (!title || title.length < 15) return;
      let url = link || BASE_URL;
      if (url.startsWith('/')) url = 'https://www.sesb.com.my' + url;
      yield { source_id: SOURCE_ID, ref: null, title,
        deadline, open_date: openDate || null, status: inferStatus(openDate, deadline), url, scraped_at: now };
    });
  } catch (e) {
    console.error(`[${SOURCE_NAME}] fetch error: ${e.message}`);
  }
}

module.exports = { SOURCE_ID, SOURCE_NAME, scrape };
