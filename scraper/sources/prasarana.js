'use strict';

// Prasarana — Corporate site, tenders page
// Tries JSON API first, falls back to HTML scrape, then Playwright
const axios = require('axios');
const cheerio = require('cheerio');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 10;
const SOURCE_NAME = 'Prasarana';
const BASE_URL = 'https://www.prasarana.com.my/tenders/';
const HOST = 'https://www.prasarana.com.my';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
  'Accept-Language': 'en-US,en;q=0.9,ms;q=0.8',
};

const SKIP = new Set(['no', 'no.', 'bil', 'tajuk', 'title', 'tarikh', 'date', 'status',
  'tindakan', 'action', 'closing date', 'open date', 'category', 'kategori']);

async function* scrape() {
  const now = nowIso();
  let totalYielded = 0;

  // Try multiple known Prasarana URL patterns
  const urls = [
    BASE_URL,
    `${HOST}/procurement/tenders/`,
    `${HOST}/procurement/open-tenders`,
    `${HOST}/en/tenders/`,
  ];

  let data = null;
  let usedUrl = BASE_URL;
  for (const url of urls) {
    try {
      const resp = await axios.get(url, { headers: HEADERS, timeout: 30000 });
      if (resp.status === 200 && resp.data && resp.data.length > 500) {
        data = resp.data;
        usedUrl = url;
        break;
      }
    } catch (_) {}
  }

  if (!data) {
    console.error(`[${SOURCE_NAME}] all URLs failed`);
    return;
  }

  try {
    const $ = cheerio.load(data);
    const items = [];

    // Try table rows
    $('table tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (!tds.length) return;
      const cells = tds.map((_, td) => $(td).text().trim()).get();
      if (cells.length < 2) return;
      if (cells.every(c => SKIP.has(c.toLowerCase()))) return;
      const title = cells.find(c => c.length >= 15 && !SKIP.has(c.toLowerCase()) &&
        !/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}$/.test(c) && !/^\d+$/.test(c));
      if (!title) return;
      const dates = cells.filter(c => /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/.test(c));
      const closeRaw = dates[dates.length - 1] || null;
      const link = $(tr).find('a').attr('href');
      const url  = link ? new URL(link, usedUrl).href : usedUrl;
      items.push({ title, closeRaw, url });
    });

    // Try card / article patterns
    $('article, .tender-card, .tender-item, [class*="tender"], [class*="procurement"]').each((_, el) => {
      const title = $(el).find('h2,h3,h4,a,.title,.name').first().text().trim();
      if (!title || title.length < 15) return;
      const text = $(el).text();
      const dates = text.match(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/g) || [];
      const closeRaw = dates[dates.length - 1] || null;
      const link = $(el).find('a').attr('href');
      const url  = link ? new URL(link, usedUrl).href : usedUrl;
      items.push({ title, closeRaw, url });
    });

    // Try any paragraph/li with date-like pattern
    if (items.length === 0) {
      $('li, p').each((_, el) => {
        const text = $(el).text().trim();
        if (text.length < 20) return;
        const dates = text.match(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/g) || [];
        if (!dates.length) return;
        const link = $(el).find('a').attr('href');
        if (!link) return;
        const title = $(el).find('a').text().trim() || text.split('\n')[0].trim();
        if (title.length < 15) return;
        const closeRaw = dates[dates.length - 1];
        const url = new URL(link, usedUrl).href;
        items.push({ title, closeRaw, url });
      });
    }

    console.log(`[${SOURCE_NAME}] ${items.length} items from ${usedUrl}`);
    for (const item of items) {
      const deadline = parseDate(item.closeRaw);
      yield {
        source_id: SOURCE_ID, ref: null,
        title: item.title, category: null, ministry: 'Prasarana',
        open_date: null, deadline, status: inferStatus(null, deadline),
        url: item.url, scraped_at: now,
      };
      totalYielded++;
    }

    console.log(`[${SOURCE_NAME}] done — ${totalYielded} records`);
  } catch (err) {
    console.error(`[${SOURCE_NAME}] fatal: ${err.message}`);
  }
}

module.exports = { SOURCE_ID, SOURCE_NAME, scrape };
