'use strict';

// Malaysia Airports Holdings Berhad — tender notices
// https://www.malaysiaairports.com.my/procurement/tenders

const axios = require('axios');
const cheerio = require('cheerio');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 15;
const SOURCE_NAME = 'MAHB';
const BASE_URL = 'https://www.malaysiaairports.com.my/procurement/tenders';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
};

async function* scrape() {
  const now = nowIso();
  let totalYielded = 0;

  try {
    const { data } = await axios.get(BASE_URL, { headers: HEADERS, timeout: 30000 });
    const $ = cheerio.load(data);

    $('table tr, .tender-item, .procurement-item, article, .views-row').each((_, el) => {
      const title =
        $(el).find('td:first-child, .title, h2, h3, a.tender-title').first().text().trim() ||
        $(el).find('a').first().text().trim();
      if (!title || title.length < 15) return;

      const cells = $(el).find('td');
      const closeRaw = cells.length >= 3
        ? $(cells[cells.length - 1]).text().trim()
        : $(el).find('.closing-date, .deadline, time').first().text().trim();
      const openRaw = cells.length >= 2 ? $(cells[1]).text().trim() : null;
      const link = $(el).find('a').first().attr('href');

      const open_date = parseDate(openRaw);
      const deadline = parseDate(closeRaw);

      if (title && title.length >= 15) {
        totalYielded++;
        // (yielded inline below)
      }
    });

    // Reset and yield properly
    totalYielded = 0;
    $('table tr, .tender-item, .procurement-item, article, .views-row').each((_, el) => {
      const title =
        $(el).find('td:first-child, .title, h2, h3').first().text().trim() ||
        $(el).find('a').first().text().trim();
      if (!title || title.length < 15) return;

      const cells = $(el).find('td');
      const closeRaw = cells.length >= 3
        ? $(cells[cells.length - 1]).text().trim()
        : $(el).find('.closing-date, .deadline, time').first().text().trim();
      const openRaw = cells.length >= 2 ? $(cells[1]).text().trim() : null;
      const link = $(el).find('a').first().attr('href');
      const open_date = parseDate(openRaw);
      const deadline = parseDate(closeRaw);
      totalYielded++;
    });

    console.log(`[${SOURCE_NAME}] done — ${totalYielded} records`);
  } catch (err) {
    console.error(`[${SOURCE_NAME}] fatal: ${err.message}`);
  }
}

// Proper generator version
async function* scrapeGen() {
  const now = nowIso();
  let totalYielded = 0;

  try {
    const { data } = await axios.get(BASE_URL, { headers: HEADERS, timeout: 30000 });
    const $ = cheerio.load(data);
    const seen = new Set();

    $('table tr, .tender-item, .procurement-item, article, .views-row, li.tender').each((_, el) => {
      const title =
        $(el).find('td:first-child, .title, h2, h3').first().text().trim() ||
        $(el).find('a').first().text().trim();
      if (!title || title.length < 15 || seen.has(title)) return;
      seen.add(title);

      const cells = $(el).find('td');
      const closeRaw = cells.length >= 2
        ? $(cells[cells.length - 1]).text().trim()
        : $(el).find('.closing-date, .deadline, time').first().text().trim();
      const link = $(el).find('a[href]').first().attr('href');
      const deadline = parseDate(closeRaw);

      // Store for yielding
      el._parsed = {
        title, deadline, link: link ? new URL(link, BASE_URL).href : BASE_URL,
      };
    });

    // We can't yield inside .each() so collect then yield
    const items = [];
    $('table tr, .tender-item, .procurement-item, article, .views-row, li.tender').each((_, el) => {
      if (el._parsed) items.push(el._parsed);
    });

    for (const item of items) {
      yield {
        source_id: SOURCE_ID, ref: null,
        title: item.title, category: null, ministry: 'MAHB',
        open_date: null, deadline: item.deadline,
        status: inferStatus(null, item.deadline),
        url: item.link, scraped_at: now,
      };
      totalYielded++;
    }

    console.log(`[${SOURCE_NAME}] done — ${totalYielded} records`);
  } catch (err) {
    console.error(`[${SOURCE_NAME}] fatal: ${err.message}`);
  }
}

module.exports = { SOURCE_ID, SOURCE_NAME, scrape: scrapeGen };
