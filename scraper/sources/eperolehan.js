'use strict';

const axios = require('axios');
const cheerio = require('cheerio');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { chromium, firefox } = require('playwright');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 1;
const SOURCE_NAME = 'ePerolehan';
const BASE_URL = 'https://www.eperolehan.gov.my/quotation-tender-notice';
const TABS_TO_SCRAPE = [0, 1];
const TAB_NAMES = ['DIIKLANKAN', 'DIKEMASKINI', 'DITUTUP', 'SELESAI', 'DIBATALKAN'];

const PROXY_URL = process.env.EPEROLEHAN_PROXY_URL || 'socks5://127.0.0.1:9050';
const TOR_URL   = 'socks5://127.0.0.1:9050';

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const HTTP_HEADERS = {
  'User-Agent': BROWSER_UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'ms-MY,ms;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
};

// ---------- helpers ----------

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

function makeAxios(proxyUrl) {
  const isSOCKS = proxyUrl && proxyUrl.startsWith('socks');
  if (isSOCKS) {
    const agent = new SocksProxyAgent(proxyUrl);
    return axios.create({ httpAgent: agent, httpsAgent: agent, timeout: 45000, headers: HTTP_HEADERS });
  }
  if (proxyUrl) {
    return axios.create({ proxy: false, timeout: 45000, headers: HTTP_HEADERS });
  }
  return axios.create({ timeout: 45000, headers: HTTP_HEADERS });
}

function extractViewState(html) {
  const m = html.match(/id="javax\.faces\.ViewState"[^>]*value="([^"]+)"/);
  return m ? m[1] : null;
}

function extractPAuth(html) {
  const m = html.match(/p_auth=([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

// PrimeFaces component IDs (colon-separated Liferay portlet IDs)
const PORTLET_NS = '_scNoticeBoard_WAR_NGePportlet_';
const TABLE_COMP = `${PORTLET_NS}:form:j_idt282`;

function tabTableId(i)    { return `${TABLE_COMP}:${i}:nbsearchresults`; }
function tabPaginatorId(i){ return `${TABLE_COMP}:${i}:nbsearchresults_paginator_bottom`; }
function tabHrefId(i)     { return `${TABLE_COMP}:${i}:nbresultTabs`; }

// Parse rows from a PrimeFaces DataTable tbody in XML or HTML
function parseRows($, tabIdx) {
  const tbodyId = `${tabTableId(tabIdx)}_data`;
  const tbody = $(`[id="${tbodyId}"]`);

  const rows = [];
  tbody.find('tr[data-ri]').each((_, tr) => {
    const tds = cheerio.load(tr)('td');
    if (tds.length < 4) return;
    const title    = tds.eq(0).text().trim();
    const ministry = tds.eq(1).text().trim() || null;
    const openRaw  = tds.eq(2).text().trim() || null;
    const closeRaw = tds.eq(3).text().trim() || null;
    if (title && title.length >= 15) rows.push({ title, ministry, openRaw, closeRaw });
  });
  return rows;
}

// ---------- Tier 1: direct HTTP (through Tor or proxy) ----------

async function* scrapeViaHttp(proxyUrl) {
  console.log(`[${SOURCE_NAME}] Tier1: direct HTTP via ${proxyUrl}`);
  const client = makeAxios(proxyUrl);
  let totalYielded = 0;
  const now = nowIso();

  let resp;
  try {
    resp = await client.get(BASE_URL);
  } catch (e) {
    console.warn(`[${SOURCE_NAME}] Tier1 GET failed: ${e.message}`);
    return;
  }

  const html = resp.data;
  const viewState = extractViewState(html);
  const pAuth    = extractPAuth(html);
  console.log(`[${SOURCE_NAME}] Tier1 viewState=${viewState ? viewState.slice(0, 20) + '…' : 'MISSING'} pAuth=${pAuth || 'MISSING'}`);

  if (!viewState) {
    const snippet = typeof html === 'string' ? html.slice(0, 400).replace(/\s+/g, ' ') : '(not string)';
    console.warn(`[${SOURCE_NAME}] Tier1: no ViewState — WAF or JS-only page. Snippet: ${snippet}`);
    return;
  }

  // Build action URL for JSF AJAX POSTs
  const portletUrl = `https://www.eperolehan.gov.my/web/guest/semak-sebutharga-tender${pAuth ? `?p_auth=${pAuth}` : ''}`;
  const ajaxHeaders = {
    ...HTTP_HEADERS,
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'Faces-Request': 'partial/ajax',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': 'https://www.eperolehan.gov.my',
    'Referer': BASE_URL,
  };

  for (const tabIdx of TABS_TO_SCRAPE) {
    console.log(`[${SOURCE_NAME}] Tier1 tab ${tabIdx} (${TAB_NAMES[tabIdx]})`);

    // First do an AJAX call to get page count for this tab
    // For tab 0 we already have the HTML; for others we POST to switch tabs
    let tabHtml = html;
    if (tabIdx > 0) {
      const switchPayload = new URLSearchParams({
        'javax.faces.partial.ajax': 'true',
        'javax.faces.source': tabHrefId(tabIdx),
        'javax.faces.partial.execute': tabHrefId(tabIdx),
        'javax.faces.partial.render': tabHrefId(tabIdx),
        [tabHrefId(tabIdx)]: tabHrefId(tabIdx),
        [`${PORTLET_NS}form`]: `${PORTLET_NS}form`,
        'javax.faces.ViewState': viewState,
      });
      try {
        const swResp = await client.post(portletUrl, switchPayload.toString(), { headers: ajaxHeaders });
        tabHtml = swResp.data;
      } catch (e) {
        console.warn(`[${SOURCE_NAME}] Tier1 tab-switch ${tabIdx}: ${e.message}`);
        continue;
      }
    }

    // Parse what we have on page 1
    const $ = cheerio.load(tabHtml);
    let rows = parseRows($, tabIdx);
    console.log(`[${SOURCE_NAME}] Tier1 tab${tabIdx} p1: ${rows.length} rows`);

    // Detect total pages from paginator
    let totalPages = 1;
    const pgEl = $(`[id="${tabPaginatorId(tabIdx)}"]`);
    const pgText = pgEl.find('.ui-paginator-current').text();
    const pgMatch = pgText.match(/(\d+)\s*\/\s*(\d+)/);
    if (pgMatch) totalPages = parseInt(pgMatch[2], 10);
    console.log(`[${SOURCE_NAME}] Tier1 tab${tabIdx} totalPages=${totalPages}`);

    for (const r of rows) {
      const open_date = parseDateStr(r.openRaw);
      const deadline  = parseDateStr(r.closeRaw);
      yield { source_id: SOURCE_ID, ref: null, title: r.title, category: inferCategory(r.title), ministry: r.ministry, open_date, deadline, status: inferStatus(open_date, deadline), url: BASE_URL, scraped_at: now };
      totalYielded++;
    }

    // Paginate via AJAX POST
    for (let pn = 2; pn <= totalPages; pn++) {
      const first = (pn - 1) * 20;
      const pagePayload = new URLSearchParams({
        'javax.faces.partial.ajax': 'true',
        'javax.faces.source': tabTableId(tabIdx),
        'javax.faces.partial.execute': tabTableId(tabIdx),
        'javax.faces.partial.render': tabTableId(tabIdx),
        [`${tabTableId(tabIdx)}_pagination`]: 'true',
        [`${tabTableId(tabIdx)}_first`]: String(first),
        [`${tabTableId(tabIdx)}_rows`]: '20',
        [`${tabTableId(tabIdx)}_encodeFeature`]: 'true',
        [`${PORTLET_NS}form`]: `${PORTLET_NS}form`,
        'javax.faces.ViewState': viewState,
      });

      try {
        const pgResp = await client.post(portletUrl, pagePayload.toString(), { headers: ajaxHeaders });
        const $pg = cheerio.load(pgResp.data);
        rows = parseRows($pg, tabIdx);
        console.log(`[${SOURCE_NAME}] Tier1 tab${tabIdx} p${pn}/${totalPages}: ${rows.length} rows`);

        for (const r of rows) {
          const open_date = parseDateStr(r.openRaw);
          const deadline  = parseDateStr(r.closeRaw);
          yield { source_id: SOURCE_ID, ref: null, title: r.title, category: inferCategory(r.title), ministry: r.ministry, open_date, deadline, status: inferStatus(open_date, deadline), url: BASE_URL, scraped_at: now };
          totalYielded++;
        }
      } catch (e) {
        console.warn(`[${SOURCE_NAME}] Tier1 tab${tabIdx} p${pn}: ${e.message}`);
        break;
      }

      await new Promise(r => setTimeout(r, 500));
    }
  }

  console.log(`[${SOURCE_NAME}] Tier1 done — ${totalYielded} records`);
}

// ---------- Tier 2/3: Playwright (Chromium / Firefox) ----------

function parseProxyOpt(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const opt = { server: `${u.protocol}//${u.hostname}:${u.port}` };
    if (u.username) opt.username = decodeURIComponent(u.username);
    if (u.password) opt.password = decodeURIComponent(u.password);
    return opt;
  } catch (_) { return { server: url }; }
}

function tbodyId(i)    { return `_scNoticeBoard_WAR_NGePportlet_:form:j_idt282:${i}:nbsearchresults_data`; }
function paginatorId(i){ return `_scNoticeBoard_WAR_NGePportlet_:form:j_idt282:${i}:nbsearchresults_paginator_bottom`; }
function tabHref(i)    { return `#_scNoticeBoard_WAR_NGePportlet_:form:j_idt282:${i}:nbresultTabs`; }

async function extractTabRowsBrowser(page, tabIdx) {
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
      return m ? { current: parseInt(m[1], 10), total: parseInt(m[2], 10) } : { current: 1, total: 1 };
    }, paginatorId(tabIdx));
  } catch (_) { return { current: 1, total: 1 }; }
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
  } catch (_) { await page.waitForTimeout(5000); }
}

async function* scrapeWithBrowser(browserType, launchOpts, contextOpts) {
  const now = nowIso();
  let browser = null;
  let totalYielded = 0;

  browser = await browserType.launch(launchOpts);
  try {
    const ctx = await browser.newContext(contextOpts);
    if (browserType === chromium) {
      await ctx.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        delete navigator.__proto__.webdriver;
        window.chrome = { runtime: {} };
      });
    }

    const page = await ctx.newPage();
    await page.route('**/*', (route) => {
      if (['image', 'media', 'font'].includes(route.request().resourceType())) route.abort();
      else route.continue();
    });

    await page.goto(BASE_URL, { waitUntil: 'load', timeout: 90000 });
    await page.waitForTimeout(5000);
    try { await page.waitForFunction(() => document.querySelectorAll('tr[data-ri]').length > 0, { timeout: 60000 }); } catch (_) {}

    const rowCount = await page.evaluate(() => document.querySelectorAll('tr[data-ri]').length);
    console.log(`[${SOURCE_NAME}] browser page ready — ${rowCount} rows visible`);

    if (rowCount === 0) {
      const bodySnippet = await page.evaluate(() => document.body.innerText.slice(0, 300));
      console.warn(`[${SOURCE_NAME}] 0 rows. Page text: ${bodySnippet.replace(/\n/g, ' ')}`);
      return;
    }

    for (const tabIdx of TABS_TO_SCRAPE) {
      console.log(`[${SOURCE_NAME}] browser tab ${tabIdx} (${TAB_NAMES[tabIdx] || tabIdx})`);
      if (tabIdx > 0) {
        try {
          const href = tabHref(tabIdx);
          await page.evaluate((h) => {
            const link = document.querySelector(`.ui-tabs-nav a[href="${h}"]`);
            if (link) link.click();
          }, href);
          try {
            await page.waitForFunction(
              (tbId) => { const tbody = document.getElementById(tbId); return tbody && tbody.querySelectorAll('tr[data-ri]').length > 0; },
              tbodyId(tabIdx), { timeout: 30000 }
            );
          } catch (_) { await page.waitForTimeout(6000); }
        } catch (e) { console.warn(`[${SOURCE_NAME}] tab ${tabIdx} activation: ${e.message}`); }
      }
      await page.waitForTimeout(1000);

      const { total: totalPages } = await getPaginatorState(page, tabIdx);
      console.log(`[${SOURCE_NAME}] browser tab${tabIdx} total pages: ${totalPages}`);

      for (let pn = 1; pn <= totalPages; pn++) {
        const rows = await extractTabRowsBrowser(page, tabIdx);
        console.log(`[${SOURCE_NAME}] browser tab${tabIdx} p${pn}/${totalPages}: ${rows.length} rows`);

        for (const r of rows) {
          if (!r.title || r.title.length < 15) continue;
          const open_date = parseDateStr(r.openRaw);
          const deadline  = parseDateStr(r.closeRaw);
          yield { source_id: SOURCE_ID, ref: null, title: r.title, category: inferCategory(r.title), ministry: r.ministry || null, open_date, deadline, status: inferStatus(open_date, deadline), url: BASE_URL, scraped_at: now };
          totalYielded++;
        }

        if (pn < totalPages) {
          const clicked = await clickNext(page, tabIdx);
          if (!clicked) { console.log(`[${SOURCE_NAME}] next disabled at p${pn}`); break; }
          await waitForPageAdvance(page, tabIdx, pn);
          await page.waitForTimeout(400);
        }
      }
    }
    console.log(`[${SOURCE_NAME}] browser done — ${totalYielded} records`);
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

// ---------- main scrape() ----------

async function* scrape() {
  console.log(`[${SOURCE_NAME}] loading ${BASE_URL}`);

  // Tier 1a: direct HTTP through EPEROLEHAN_PROXY_URL (if set and not Tor)
  if (PROXY_URL && PROXY_URL !== TOR_URL) {
    console.log(`[${SOURCE_NAME}] Tier1a: proxy ${PROXY_URL.replace(/:[^:@]+@/, ':***@')}`);
    let got = false;
    try {
      for await (const row of scrapeViaHttp(PROXY_URL)) { got = true; yield row; }
    } catch (e) { console.warn(`[${SOURCE_NAME}] Tier1a failed: ${e.message}`); }
    if (got) return;
  }

  // Tier 1b: direct HTTP through Tor
  console.log(`[${SOURCE_NAME}] Tier1b: direct HTTP via Tor socks5://127.0.0.1:9050`);
  let gotTor = false;
  try {
    for await (const row of scrapeViaHttp(TOR_URL)) { gotTor = true; yield row; }
  } catch (e) { console.warn(`[${SOURCE_NAME}] Tier1b failed: ${e.message}`); }
  if (gotTor) return;

  // Tier 2: Playwright Chromium through Tor
  console.log(`[${SOURCE_NAME}] Tier2: Playwright Chromium via Tor`);
  const torProxy = parseProxyOpt(TOR_URL);
  const proxyOpt = torProxy ? { proxy: torProxy } : {};
  const chromiumLaunch = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--window-size=1366,768'],
    ...proxyOpt,
  };
  const chromiumCtx = {
    userAgent: BROWSER_UA,
    locale: 'ms-MY',
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: { 'Accept-Language': 'ms-MY,ms;q=0.9,en-US;q=0.8,en;q=0.7' },
    ...proxyOpt,
  };

  let gotChromium = false;
  try {
    for await (const row of scrapeWithBrowser(chromium, chromiumLaunch, chromiumCtx)) { gotChromium = true; yield row; }
  } catch (e) { console.warn(`[${SOURCE_NAME}] Tier2 Chromium failed: ${e.message}`); }
  if (gotChromium) return;

  // Tier 3: Playwright Firefox through Tor
  console.log(`[${SOURCE_NAME}] Tier3: Playwright Firefox via Tor`);
  const ffLaunch = { headless: true, args: [], ...proxyOpt };
  const ffCtx = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
    locale: 'ms-MY',
    viewport: { width: 1366, height: 768 },
    extraHTTPHeaders: { 'Accept-Language': 'ms-MY,ms;q=0.9,en-US;q=0.8,en;q=0.7' },
    ...proxyOpt,
  };
  try {
    for await (const row of scrapeWithBrowser(firefox, ffLaunch, ffCtx)) { yield row; }
  } catch (e) {
    console.error(`[${SOURCE_NAME}] Tier3 Firefox failed: ${e.message}`);
    console.error(`[${SOURCE_NAME}] All tiers exhausted — ePerolehan blocked. Set EPEROLEHAN_PROXY_URL to a residential proxy.`);
  }
}

module.exports = { SOURCE_ID, SOURCE_NAME, scrape };
