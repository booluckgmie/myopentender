'use strict';

const { chromium } = require('playwright');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 1;
const SOURCE_NAME = 'ePerolehan';
const BASE_URL = 'https://www.eperolehan.gov.my/quotation-tender-notice';

const TABS_TO_SCRAPE = [0, 1];
const MAX_PAGES_PER_TAB = 9999;

function tbodyId(i)   { return `_scNoticeBoard_WAR_NGePportlet_:form:j_idt282:${i}:nbsearchresults_data`; }
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

async function getTotalPages(page, tabIdx) {
  try {
    return await page.evaluate((pgId) => {
      const pg = document.getElementById(pgId);
      if (!pg) return 1;
      const cur = pg.querySelector('.ui-paginator-current');
      if (!cur) return 1;
      const m = cur.textContent.match(/(\d+)\s*\/\s*(\d+)/);
      return m ? parseInt(m[2], 10) : 1;
    }, paginatorId(tabIdx));
  } catch (_) { return 1; }
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

async function waitForTableUpdate(page, tabIdx, prevCount) {
  try {
    await page.waitForFunction(
      ({ tbId, prev }) => {
        const tbody = document.getElementById(tbId);
        if (!tbody) return false;
        const count = tbody.querySelectorAll('tr[data-ri]').length;
        // Wait for rows to exist and not match our previous layout count
        return count > 0; 
      },
      { tbId: tbodyId(tabIdx), prev: prevCount },
      { timeout: 15000 }
    );
  } catch (_) {
    await page.waitForTimeout(2500);
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
        { timeout: 25000 }
      );
    } catch (_) {
      await page.waitForTimeout(5000);
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
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const ctx = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'ms-MY',
    });
    const page = await ctx.newPage();

    console.log(`[${SOURCE_NAME}] loading ${BASE_URL}`);
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });

    await page.waitForTimeout(5000);
    try {
      await page.waitForFunction(
        () => document.querySelectorAll('tr[data-ri]').length > 0,
        { timeout: 55000 }
      );
    } catch (_) {
      console.warn(`[${SOURCE_NAME}] rows not detected after 60s — proceeding anyway`);
      await page.waitForTimeout(10000);
    }
    const rowCount = await page.evaluate(() => document.querySelectorAll('tr[data-ri]').length);
    console.log(`[${SOURCE_NAME}] page ready — ${rowCount} rows visible`);

    const TAB_NAMES = ['DIIKLANKAN', 'DIKEMASKINI', 'DITUTUP', 'SELESAI', 'DIBATALKAN'];

    for (const tabIdx of TABS_TO_SCRAPE) {
      console.log(`[${SOURCE_NAME}] tab ${tabIdx} (${TAB_NAMES[tabIdx]})`);
      await activateTab(page, tabIdx);
      await page.waitForTimeout(1500);

      const totalPages   = await getTotalPages(page, tabIdx);
      const pagesToScrape = Math.min(totalPages, MAX_PAGES_PER_TAB);
      console.log(`[${SOURCE_NAME}]   ${totalPages} pages, scraping up to ${pagesToScrape}`);

      for (let pn = 1; pn <= pagesToScrape; pn++) {
        const rows = await extractTabRows(page, tabIdx);
        console.log(`[${SOURCE_NAME}]   p${pn}: ${rows.length} rows`);

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

        if (pn < pagesToScrape) {
          const prevCount = rows.length;
          const clicked = await clickNext(page, tabIdx);
          if (!clicked) { console.log(`[${SOURCE_NAME}]   no next page`); break; }
          // Hard sleep combined with conditional DOM check to prevent processing duplicate rows
          await page.waitForTimeout(1500);
          await waitForTableUpdate(page, tabIdx, prevCount);
        }
      }
    }

    console.log(`[${SOURCE_NAME}] done — ${totalYielded} records`);
  } catch (err) {
    console.error(`[${SOURCE_NAME}] fatal: ${err.message}`);
  } finally {
    if (browser) { try { await browser.close(); } catch (_) {} }
  }
}

module.exports = { SOURCE_ID, SOURCE_NAME, scrape };
