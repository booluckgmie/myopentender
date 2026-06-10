'use strict';

const { chromium } = require('playwright');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 1;
const SOURCE_NAME = 'ePerolehan';
const BASE_URL = 'https://www.eperolehan.gov.my/quotation-tender-notice';

const TABS_TO_SCRAPE = [0, 1];

function tbodyId(i)    { return `_scNoticeBoard_WAR_NGePportlet_:form:j_idt282:${i}:nbsearchresults_data`; }
function paginatorId(i){ return `_scNoticeBoard_WAR_NGePportlet_:form:j_idt282:${i}:nbsearchresults_paginator_bottom`; }
function tabHref(i)    { return `#_scNoticeBoard_WAR_NGePportlet_:form:j_idt282:${i}:nbresultTabs`; }

function parseDateStr(raw) {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return parseDate(raw);
}

function inferCategory(title) {
  if (!title) return null;
  const t = title.toUpperCase();
  if (/^TENDER\b/.test(t))                      return 'Tender';
  if (/^SEBUT\s*HARGA\b|^SEBUTHARGA\b/.test(t)) return 'Sebut Harga';
  if (/^MEMBEKAL\b|^BEKALAN\b/.test(t))         return 'Bekalan';
  if (/^PERKHIDMATAN\b/.test(t))                return 'Perkhidmatan';
  if (/^KERJA[\s-]/.test(t))                    return 'Kerja';
  if (/^CADANGAN\b/.test(t))                    return 'Cadangan';
  return null;
}

async function extractTabRows(page, tabIdx) {
  return page.evaluate((tbId) => {
    const tbody = document.getElementById(tbId);
    if (!tbody) return [];
    const rows = [];
    tbody.querySelectorAll('tr[data-ri]').forEach(tr => {
      const tds = tr.querySelectorAll('td');
      if (tds.length < 4) return;
      const linkEl = tds[0].querySelector('a.ui-commandlink');
      const title    = (linkEl ? linkEl.textContent : tds[0].textContent).trim();
      const ministry = tds[1] ? tds[1].textContent.trim() : null;
      const openRaw  = tds[2] ? tds[2].textContent.trim() : null;
      const closeRaw = tds[3] ? tds[3].textContent.trim() : null;
      rows.push({ title, ministry, openRaw, closeRaw });
    });
    return rows;
  }, tbodyId(tabIdx));
}

async function getPaginatorState(page, tabIdx) {
  try {
    return await page.evaluate((pgId) => {
      const pg = document.getElementById(pgId);
      if (!pg) return { current: 1, total: 1 };
      const cur = pg.querySelector('.ui-paginator-current');
      if (!cur) return { current: 1, total: 1 };
      const m = cur.textContent.match(/(\d+)\s*\/\s*(\d+)/);
      return m
        ? { current: parseInt(m[1], 10), total: parseInt(m[2], 10) }
        : { current: 1, total: 1 };
    }, paginatorId(tabIdx));
  } catch (_) {
    return { current: 1, total: 1 };
  }
}

async function clickNext(page, tabIdx) {
  try {
    return await page.evaluate((pgId) => {
      const pg = document.getElementById(pgId);
      if (!pg) return false;
      const next = pg.querySelector('.ui-paginator-next');
      if (!next || next.classList.contains('ui-state-disabled')) return false;
      next.click();
      return true;
    }, paginatorId(tabIdx));
  } catch (_) { return false; }
}

async function waitForPageAdvance(page, tabIdx, fromPage) {
  try {
    await page.waitForFunction(
      ({ pgId, from }) => {
        const pg = document.getElementById(pgId);
        if (!pg) return false;
        const cur = pg.querySelector('.ui-paginator-current');
        if (!cur) return false;
        const m = cur.textContent.match(/(\d+)\s*\/\s*(\d+)/);
        return m && parseInt(m[1], 10) !== from;
      },
      { pgId: paginatorId(tabIdx), from: fromPage },
      { timeout: 25000 }
    );
  } catch (_) {
    await page.waitForTimeout(5000);
  }
}

async function activateTab(page, tabIdx) {
  if (tabIdx === 0) return;
  try {
    const href = tabHref(tabIdx);
    await page.evaluate((h) => {
      const link = document.querySelector(`.ui-tabs-nav a[href="${h}"]`);
      if (link) link.click();
    }, href);
    try {
      await page.waitForFunction(
        (tbId) => {
          const tbody = document.getElementById(tbId);
          return tbody && tbody.querySelectorAll('tr[data-ri]').length > 0;
        },
        tbodyId(tabIdx),
        { timeout: 30000 }
      );
    } catch (_) {
      await page.waitForTimeout(6000);
    }
  } catch (e) {
    console.warn(`[${SOURCE_NAME}] tab ${tabIdx} activation: ${e.message}`);
  }
}

async function* scrape() {
  const now = nowIso();
  let browser = null;
  let totalYielded = 0;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--window-size=1366,768',
      ],
    });

    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'ms-MY',
      viewport: { width: 1366, height: 768 },
      extraHTTPHeaders: {
        'Accept-Language': 'ms-MY,ms;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });

    // Remove webdriver fingerprint before any script runs
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      delete navigator.__proto__.webdriver;
      window.chrome = { runtime: {} };
    });

    const page = await ctx.newPage();

    // Block images/fonts/media to speed up AJAX pagination
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font'].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    console.log(`[${SOURCE_NAME}] loading ${BASE_URL}`);

    // Use 'load' (not 'domcontentloaded') so PrimeFaces scripts fully execute
    // before we start polling for rows.  'networkidle' hangs on portlet polling.
    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 90000 });

    // Extra boot time for PrimeFaces XHR data load
    await page.waitForTimeout(5000);

    // Poll for rows up to 60s
    try {
      await page.waitForFunction(
        () => document.querySelectorAll('tr[data-ri]').length > 0,
        { timeout: 60000 }
      );
    } catch (_) {
      // Dump some debug HTML to understand what the page looks like in CI
      const snippet = await page.evaluate(() => document.body.innerHTML.slice(0, 2000));
      console.warn(`[${SOURCE_NAME}] rows not visible after 65s. Body snippet:\n${snippet}`);
      await page.waitForTimeout(8000);
    }

    const rowCount = await page.evaluate(() => document.querySelectorAll('tr[data-ri]').length);
    console.log(`[${SOURCE_NAME}] page ready — ${rowCount} rows visible`);

    if (rowCount === 0) {
      // Log paginator presence for debugging
      const pgDebug = await page.evaluate(() => {
        const pg = document.querySelector('[id*="nbsearchresults_paginator"]');
        const tabs = document.querySelector('[id*="nbresultTabs"]');
        return {
          hasPaginator: !!pg,
          paginatorId: pg ? pg.id : null,
          hasTabs: !!tabs,
          tabsId: tabs ? tabs.id : null,
          allDataRi: document.querySelectorAll('[data-ri]').length,
        };
      });
      console.warn(`[${SOURCE_NAME}] debug DOM state:`, JSON.stringify(pgDebug));
    }

    const TAB_NAMES = ['DIIKLANKAN', 'DIKEMASKINI', 'DITUTUP', 'SELESAI', 'DIBATALKAN'];

    for (const tabIdx of TABS_TO_SCRAPE) {
      console.log(`[${SOURCE_NAME}] ── tab ${tabIdx} (${TAB_NAMES[tabIdx] || tabIdx})`);
      await activateTab(page, tabIdx);
      await page.waitForTimeout(1000);

      const { total: totalPages } = await getPaginatorState(page, tabIdx);
      console.log(`[${SOURCE_NAME}]   total pages: ${totalPages}`);

      for (let pn = 1; pn <= totalPages; pn++) {
        const rows = await extractTabRows(page, tabIdx);
        console.log(`[${SOURCE_NAME}]   p${pn}/${totalPages}: ${rows.length} rows`);

        for (const r of rows) {
          if (!r.title || r.title.length < 15) continue;
          const open_date = parseDateStr(r.openRaw);
          const deadline  = parseDateStr(r.closeRaw);
          yield {
            source_id: SOURCE_ID,
            ref: null,
            title: r.title,
            category: inferCategory(r.title),
            ministry: r.ministry || null,
            open_date,
            deadline,
            status: inferStatus(open_date, deadline),
            url: BASE_URL,
            scraped_at: now,
          };
          totalYielded++;
        }

        if (pn < totalPages) {
          const clicked = await clickNext(page, tabIdx);
          if (!clicked) {
            console.log(`[${SOURCE_NAME}]   next disabled — stopping at p${pn}`);
            break;
          }
          await waitForPageAdvance(page, tabIdx, pn);
          await page.waitForTimeout(400);
        }
      }
    }

    console.log(`[${SOURCE_NAME}] done — ${totalYielded} records`);
  } catch (err) {
    console.error(`[${SOURCE_NAME}] fatal: ${err.message}`);
    console.error(err.stack);
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
  }
}

module.exports = { SOURCE_ID, SOURCE_NAME, scrape };
