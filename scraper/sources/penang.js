'use strict';

// Penang eProcure — public tender list, tries direct HTTP first then Playwright
const axios = require('axios');
const cheerio = require('cheerio');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 3;
const SOURCE_NAME = 'Penang eProcure';
const HOST = 'https://ep.penang.gov.my';

// Known public-access URLs to try
const TENDER_URLS = [
  'https://ep.penang.gov.my/eprocurement/public/tenderlist',
  'https://ep.penang.gov.my/eprocurement/public/tender',
  'https://ep.penang.gov.my/eprocurement/tender/publicList',
  'https://ep.penang.gov.my/',
];

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
  'Accept-Language': 'ms-MY,ms;q=0.9,en-US;q=0.8',
};

const LOGIN_SIGNALS = ['log masuk', 'login', 'sign in', 'kata laluan', 'password', 'sila log masuk'];
const SKIP = new Set(['no', 'no.', 'bil', 'no. rujukan', 'rujukan', 'tajuk tender', 'tajuk', 'title',
  'tarikh iklan', 'tarikh mula', 'tarikh tutup', 'status', 'tindakan', 'action', 'closing date']);

function parseRows($, baseUrl) {
  const items = [];
  $('table tbody tr, table tr').each((_, tr) => {
    if ($(tr).find('th').length) return;
    const tds = $(tr).find('td');
    if (!tds.length) return;
    const cells = tds.map((_, td) => $(td).text().trim()).get();
    if (cells.length < 2) return;
    if (cells.every(c => SKIP.has(c.toLowerCase()))) return;

    // Col 0: ref/no, Col 1: title (usually), last 2: open+close dates
    const ref   = cells[0] && cells[0].length < 50 && !/^\d{1,2}[\/\-]/.test(cells[0]) ? cells[0] : null;
    const title = cells[1] && cells[1].length >= 15 ? cells[1]
                : cells.find(c => c.length >= 15 && !SKIP.has(c.toLowerCase()) &&
                    !/^\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}$/.test(c));
    if (!title) return;
    const dates = cells.filter(c => /\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}/.test(c));
    const openRaw  = dates[0] || null;
    const closeRaw = dates[dates.length - 1] || null;
    const link = $(tr).find('a').first().attr('href');
    const url  = link ? (link.startsWith('http') ? link : `${HOST}${link}`) : baseUrl;
    items.push({ ref, title, openRaw, closeRaw, url });
  });
  return items;
}

async function* scrape() {
  const now = nowIso();
  let totalYielded = 0;

  // Tier 1: direct HTTP
  let data = null;
  let usedUrl = TENDER_URLS[0];
  for (const url of TENDER_URLS) {
    try {
      const resp = await axios.get(url, { headers: HEADERS, timeout: 30000 });
      const bodyLow = resp.data?.slice?.(0, 1000)?.toLowerCase() || '';
      if (LOGIN_SIGNALS.some(s => bodyLow.includes(s))) {
        console.warn(`[${SOURCE_NAME}] ${url} → login wall`);
        continue;
      }
      if (resp.status === 200 && resp.data?.length > 500) {
        data = resp.data;
        usedUrl = url;
        break;
      }
    } catch (_) {}
  }

  if (data) {
    const $ = cheerio.load(data);
    const items = parseRows($, usedUrl);
    console.log(`[${SOURCE_NAME}] HTTP: ${items.length} rows from ${usedUrl}`);
    for (const item of items) {
      const open_date = parseDate(item.openRaw);
      const deadline  = parseDate(item.closeRaw);
      yield { source_id: SOURCE_ID, ref: item.ref, title: item.title, category: null, ministry: 'Penang',
               open_date, deadline, status: inferStatus(open_date, deadline), url: item.url, scraped_at: now };
      totalYielded++;
    }
    if (totalYielded > 0) {
      console.log(`[${SOURCE_NAME}] done — ${totalYielded} records`);
      return;
    }
  }

  // Tier 2: Playwright
  console.log(`[${SOURCE_NAME}] trying Playwright`);
  let browser = null;
  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
    const ctx = await browser.newContext({ userAgent: HEADERS['User-Agent'], locale: 'ms-MY' });
    const page = await ctx.newPage();
    await page.route('**/*', (route) => {
      if (['image', 'media', 'font'].includes(route.request().resourceType())) route.abort();
      else route.continue();
    });

    for (const url of TENDER_URLS) {
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
        const bodyText = (await page.innerText('body').catch(() => '')).toLowerCase().slice(0, 800);
        if (LOGIN_SIGNALS.some(s => bodyText.includes(s))) continue;
        try { await page.waitForSelector('table tbody tr', { timeout: 10000 }); } catch (_) {}
        const html = await page.content();
        const $ = cheerio.load(html);
        const items = parseRows($, url);
        if (items.length === 0) continue;
        console.log(`[${SOURCE_NAME}] Playwright: ${items.length} rows from ${url}`);
        for (const item of items) {
          const open_date = parseDate(item.openRaw);
          const deadline  = parseDate(item.closeRaw);
          yield { source_id: SOURCE_ID, ref: item.ref, title: item.title, category: null, ministry: 'Penang',
                   open_date, deadline, status: inferStatus(open_date, deadline), url: item.url, scraped_at: now };
          totalYielded++;
        }
        break;
      } catch (_) {}
    }
  } catch (e) {
    console.error(`[${SOURCE_NAME}] Playwright: ${e.message}`);
  } finally {
    try { if (browser) await browser.close(); } catch (_) {}
  }

  console.log(`[${SOURCE_NAME}] done — ${totalYielded} records`);
}

module.exports = { SOURCE_ID, SOURCE_NAME, scrape };
