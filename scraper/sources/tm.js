'use strict';

// TM (Telekom Malaysia) — React SPA, uses Playwright to render tender notices page
// URL: https://www.tm.com.my/business-with-tm/tender-notices
const { chromium } = require('playwright');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 12;
const SOURCE_NAME = 'TM';
const BASE_URL = 'https://www.tm.com.my/business-with-tm/tender-notices';
const HOST = 'https://www.tm.com.my';

async function* scrape() {
  const now = nowIso();
  let totalYielded = 0;
  let browser = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-MY',
      viewport: { width: 1366, height: 768 },
    });
    const page = await ctx.newPage();
    await page.route('**/*', (route) => {
      if (['image', 'media', 'font'].includes(route.request().resourceType())) route.abort();
      else route.continue();
    });

    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    // Wait for tender content to appear
    try {
      await page.waitForSelector('table tr td, .tender-list, article, [class*="tender"]', { timeout: 20000 });
    } catch (_) {}

    const html = await page.content();
    const cheerio = require('cheerio');
    const $ = cheerio.load(html);
    const items = [];

    // Table approach
    $('table tr').each((_, tr) => {
      const cells = $(tr).find('td').map((_, td) => $(td).text().trim()).get();
      if (cells.length < 2) return;
      const title = cells[1] || cells[0];
      if (!title || title.length < 15) return;
      const dates = cells.filter(c => /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/.test(c));
      const closeRaw = dates[dates.length - 1] || null;
      const link = $(tr).find('a').attr('href');
      const url  = link ? new URL(link, BASE_URL).href : BASE_URL;
      items.push({ title, closeRaw, url });
    });

    // Card / list approach
    $('article, [class*="tender"], [class*="notice"], li').each((_, el) => {
      const title = $(el).find('h2,h3,h4,a,.title').first().text().trim();
      if (!title || title.length < 15) return;
      const text = $(el).text();
      const dates = text.match(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/g) || [];
      const closeRaw = dates[dates.length - 1] || null;
      const link = $(el).find('a').attr('href');
      const url  = link ? new URL(link, BASE_URL).href : BASE_URL;
      items.push({ title, closeRaw, url });
    });

    console.log(`[${SOURCE_NAME}] ${items.length} items`);
    for (const item of items) {
      const deadline = parseDate(item.closeRaw);
      yield {
        source_id: SOURCE_ID, ref: null,
        title: item.title, category: null, ministry: 'TM',
        open_date: null, deadline, status: inferStatus(null, deadline),
        url: item.url, scraped_at: now,
      };
      totalYielded++;
    }

    console.log(`[${SOURCE_NAME}] done — ${totalYielded} records`);
  } catch (err) {
    console.error(`[${SOURCE_NAME}] fatal: ${err.message}`);
  } finally {
    try { if (browser) await browser.close(); } catch (_) {}
  }
}

module.exports = { SOURCE_ID, SOURCE_NAME, scrape };
