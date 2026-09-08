'use strict';

// Kedah Gov — Joomla CMS, category blog, each article is a tender notice
const axios = require('axios');
const cheerio = require('cheerio');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 8;
const SOURCE_NAME = 'Kedah Gov';
const BASE_URL = 'https://www.kedah.gov.my/index.php/tender-sebut-harga-jabatan-negeri/';
const HOST = 'https://www.kedah.gov.my';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
  'Accept-Language': 'ms-MY,ms;q=0.9,en-US;q=0.8',
};

const SKIP = new Set(['home', 'utama', 'laman utama', 'baca lagi', 'read more', 'muat turun', 'download',
  'pdf', 'doc', 'docx', 'kembali', 'back', 'seterusnya', 'sebelumnya', 'next', 'previous',
  'hubungi kami', 'contact us', 'peta laman', 'sitemap']);

async function* scrape() {
  const now = nowIso();
  let totalYielded = 0;

  try {
    for (let start = 0; start <= 500; start += 10) {
      const url = start === 0 ? BASE_URL : `${BASE_URL}?start=${start}`;
      const { data } = await axios.get(url, { headers: HEADERS, timeout: 30000 });
      const $ = cheerio.load(data);

      const items = [];

      // Joomla category blog: articles in .items-leading, .items-row, .item
      // Each article title is in h2.article-title > a  or  .page-header h2 a
      $('h2.article-title a, h3.article-title a, .page-header h2 a, .item-title a, article h2 a, article h3 a').each((_, a) => {
        const title = $(a).text().trim();
        if (!title || title.length < 15) return;
        if (SKIP.has(title.toLowerCase())) return;
        const href = $(a).attr('href') || '';
        const url  = href.startsWith('http') ? href : `${HOST}${href.startsWith('/') ? '' : '/'}${href}`;

        // Find date inside the same article block
        const article = $(a).closest('article, .item, .items-leading, .items-row, div[class*="item"]');
        const articleText = article.text();
        const dates = articleText.match(/\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4}/g) || [];
        const closeRaw = dates[dates.length - 1] || null;
        items.push({ title, closeRaw, url });
      });

      // Fallback: table rows in entry-content (some Joomla configs render tables)
      if (items.length === 0) {
        $('table tr, .entry-content table tr').each((_, tr) => {
          const tds = $(tr).find('td');
          if (!tds.length) return;
          const cells = tds.map((_, td) => $(td).text().trim()).get();
          const title = cells.find(c => c.length >= 15 && !/^\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4}$/.test(c));
          if (!title) return;
          const dates = cells.filter(c => /\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4}/.test(c));
          const closeRaw = dates[dates.length - 1] || null;
          const link = $(tr).find('a').attr('href');
          const url  = link ? (link.startsWith('http') ? link : `${HOST}${link}`) : BASE_URL;
          items.push({ title, closeRaw, url });
        });
      }

      if (items.length === 0) {
        if (start === 0) console.warn(`[${SOURCE_NAME}] no items on page 1`);
        break;
      }
      console.log(`[${SOURCE_NAME}] start=${start}: ${items.length} items`);

      for (const item of items) {
        const deadline = parseDate(item.closeRaw);
        yield {
          source_id: SOURCE_ID, ref: null,
          title: item.title, category: null, ministry: 'Kedah',
          open_date: null, deadline, status: inferStatus(null, deadline),
          url: item.url, scraped_at: now,
        };
        totalYielded++;
      }

      // Detect end: if no "next" pagination link found
      const hasNext = $('a[href*="start="]').filter((_, a) => {
        const href = $(a).attr('href') || '';
        const m = href.match(/start=(\d+)/);
        return m && parseInt(m[1], 10) === start + 10;
      }).length > 0;
      if (!hasNext) break;

      await new Promise(r => setTimeout(r, 500));
    }

    console.log(`[${SOURCE_NAME}] done — ${totalYielded} records`);
  } catch (err) {
    console.error(`[${SOURCE_NAME}] fatal: ${err.message}`);
  }
}

module.exports = { SOURCE_ID, SOURCE_NAME, scrape };
