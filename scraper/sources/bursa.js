'use strict';

// Bursa Malaysia — Company Announcements filtered by keyword "tender"
// The page uses a REST/DataTables JSON API endpoint
const axios = require('axios');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 13;
const SOURCE_NAME = 'Bursa Malaysia';
const PAGE_URL = 'https://www.bursamalaysia.com/market_information/announcements/company_announcement';
const HOST = 'https://www.bursamalaysia.com';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': PAGE_URL,
  'X-Requested-With': 'XMLHttpRequest',
};

// Bursa's company announcement API (DataTables server-side)
// Endpoint discovered from browser DevTools network tab
const API_ENDPOINTS = [
  '/api/v1/market_information/company_announcement/list.json',
  '/market_information/announcements/company_announcement/company_announcements',
  '/market_information/company_announcement/get_announcements',
];

async function fetchViaApi(now) {
  const results = [];
  for (const endpoint of API_ENDPOINTS) {
    try {
      const url = `${HOST}${endpoint}`;
      const params = { keyword: 'tender', per_page: 50, page: 1 };
      const resp = await axios.get(url, { params, headers: HEADERS, timeout: 30000 });
      if (resp.status !== 200 || !resp.data) continue;

      const d = resp.data;
      // Try common JSON shapes
      const list = d.data || d.announcements || d.items || d.results || (Array.isArray(d) ? d : null);
      if (!list) continue;

      console.log(`[Bursa] API ${endpoint}: ${list.length} items`);
      for (const item of list) {
        const title = item.announcement_title || item.title || item.subject || item.headline || '';
        if (!title || title.length < 10) continue;
        const dateRaw = item.date || item.announcement_date || item.created_at || item.datetime || '';
        const company = item.company_name || item.company || item.issuer || '';
        const fullTitle = company ? `[${company}] ${title}` : title;
        const deadline = parseDate(dateRaw);
        const detailUrl = item.url || item.link || item.href
          ? new URL(item.url || item.link || item.href, HOST).href
          : PAGE_URL;
        results.push({
          source_id: SOURCE_ID, ref: item.announcement_id || item.id || null,
          title: fullTitle, category: 'Announcement', ministry: company || null,
          open_date: deadline, deadline: null, status: 'ACTIVE',
          url: detailUrl, scraped_at: now,
        });
      }
      if (results.length) return results;
    } catch (_) {}
  }
  return results;
}

async function fetchViaPlaywright(now) {
  const results = [];
  let browser = null;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    });

    // Intercept the DataTables/API request that fires when the page loads
    let apiData = null;
    ctx.on('response', async (response) => {
      const url = response.url();
      if ((url.includes('announcement') || url.includes('company_announcement')) &&
          (url.includes('.json') || url.includes('api') || response.headers()['content-type']?.includes('json'))) {
        try {
          const body = await response.json();
          if (!apiData && (body.data || body.announcements || Array.isArray(body))) {
            apiData = body;
          }
        } catch (_) {}
      }
    });

    const page = await ctx.newPage();
    await page.route('**/*', (route) => {
      if (['image', 'media', 'font'].includes(route.request().resourceType())) route.abort();
      else route.continue();
    });

    // Type "tender" in the search box then wait for results
    await page.goto(PAGE_URL, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(3000);

    // Try to find search box and type "tender"
    try {
      const searchBox = await page.$('input[placeholder*="search" i], input[type="search"], input[name*="search"], input[id*="search"], #keyword, input[placeholder*="keyword" i]');
      if (searchBox) {
        await searchBox.fill('tender');
        await searchBox.press('Enter');
        await page.waitForTimeout(3000);
      }
    } catch (_) {}

    // If we captured API data, use it
    if (apiData) {
      const list = apiData.data || apiData.announcements || (Array.isArray(apiData) ? apiData : []);
      for (const item of list) {
        const title = item.announcement_title || item.title || item.subject || '';
        if (!title || title.length < 10) continue;
        const lower = title.toLowerCase();
        if (!lower.includes('tender')) continue;
        const dateRaw = item.date || item.announcement_date || '';
        const company = item.company_name || item.company || '';
        const fullTitle = company ? `[${company}] ${title}` : title;
        results.push({
          source_id: SOURCE_ID, ref: item.id || null,
          title: fullTitle, category: 'Announcement', ministry: company || null,
          open_date: parseDate(dateRaw), deadline: null, status: 'ACTIVE',
          url: item.url ? new URL(item.url, HOST).href : PAGE_URL,
          scraped_at: now,
        });
      }
    }

    // Fallback: parse rendered HTML table
    if (results.length === 0) {
      const html = await page.content();
      const cheerio = require('cheerio');
      const $ = cheerio.load(html);
      $('table tbody tr').each((_, tr) => {
        const cells = $(tr).find('td').map((_, td) => $(td).text().trim()).get();
        if (cells.length < 2) return;
        // Bursa table: Date | Company | Type | Title
        const title = cells[3] || cells[1] || cells[0];
        if (!title || title.length < 10) return;
        if (!title.toLowerCase().includes('tender')) return;
        const dateRaw = cells[0];
        const company = cells[1] || '';
        const fullTitle = company ? `[${company}] ${title}` : title;
        const link = $(tr).find('a').attr('href');
        const url  = link ? new URL(link, HOST).href : PAGE_URL;
        results.push({
          source_id: SOURCE_ID, ref: null,
          title: fullTitle, category: 'Announcement', ministry: company || null,
          open_date: parseDate(dateRaw), deadline: null, status: 'ACTIVE',
          url, scraped_at: now,
        });
      });
    }
  } catch (e) {
    console.error(`[Bursa] Playwright: ${e.message}`);
  } finally {
    try { if (browser) await browser.close(); } catch (_) {}
  }
  return results;
}

async function* scrape() {
  const now = nowIso();
  let totalYielded = 0;

  // Tier 1: direct JSON API
  let items = await fetchViaApi(now);

  // Tier 2: Playwright (intercept API + HTML fallback)
  if (items.length === 0) {
    console.log(`[${SOURCE_NAME}] API tiers failed, trying Playwright`);
    items = await fetchViaPlaywright(now);
  }

  for (const item of items) {
    yield item;
    totalYielded++;
  }

  console.log(`[${SOURCE_NAME}] done — ${totalYielded} records`);
}

module.exports = { SOURCE_ID, SOURCE_NAME, scrape };
