'use strict';

const { chromium } = require('playwright');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 1;
const SOURCE_NAME = 'ePerolehan';
const BASE_URL = 'https://www.eperolehan.gov.my/quotation-tender-notice';
const MAX_PAGES = 50;

/**
 * Try to extract rows from whatever table selector is present on the page.
 * Returns an array of raw cell-text arrays plus the detail href for each row.
 */
async function extractRows(page) {
  // Multiple selector fallbacks — we cannot verify the real DOM offline
  const tableSelectors = [
    'table tbody tr',
    '.table tbody tr',
    'table tr',
    'tr[role="row"]',
    '[class*="table"] tr',
  ];

  for (const sel of tableSelectors) {
    try {
      const rows = await page.$$(sel);
      if (!rows.length) continue;

      const results = [];
      for (const row of rows) {
        // Skip header rows (th-only rows)
        const tds = await row.$$('td');
        if (!tds.length) continue;

        const cells = await Promise.all(tds.map(td => td.innerText().then(t => t.trim())));

        // Skip rows that look like empty spacers
        if (cells.every(c => !c)) continue;

        // Grab first anchor href in the row
        let href = null;
        try {
          const anchor = await row.$('a[href]');
          if (anchor) {
            href = await anchor.getAttribute('href');
          }
        } catch (_) { /* no link in row */ }

        results.push({ cells, href });
      }

      if (results.length) return results;
    } catch (_) {
      // selector threw — try next
    }
  }

  return [];
}

/**
 * Build an absolute URL from a (possibly relative) href.
 */
function absoluteUrl(href) {
  if (!href) return BASE_URL;
  if (/^https?:\/\//i.test(href)) return href;
  return 'https://www.eperolehan.gov.my' + (href.startsWith('/') ? href : '/' + href);
}

/**
 * Map a row's cells to a tender record.
 * Column order based on known ePerolehan structure:
 *   0: No. Rujukan (ref)
 *   1: Tajuk (title)
 *   2: Kategori (category)
 *   3: Kementerian (ministry)
 *   4: Tarikh Tutup (deadline)
 *   5: Tarikh Buka (open date)
 * If fewer columns are present we fall back gracefully.
 */
function rowToRecord(cells, href, now) {
  const get = i => (cells[i] || '').trim() || null;

  // Detect short rows (e.g. only ref + title + deadline)
  const ref      = get(0);
  const title    = get(1) || get(0);
  const category = cells.length > 4 ? get(2) : null;
  const ministry = cells.length > 4 ? get(3) : null;
  const deadlineRaw  = cells.length > 4 ? get(4) : get(2);
  const openDateRaw  = cells.length > 5 ? get(5) : get(3);

  const deadline  = parseDate(deadlineRaw);
  const open_date = parseDate(openDateRaw);

  return {
    source_id:  SOURCE_ID,
    ref,
    title,
    category,
    ministry,
    deadline,
    open_date,
    status:     inferStatus(open_date, deadline),
    url:        absoluteUrl(href),
    scraped_at: now,
  };
}

/**
 * Attempt to click the "Next page" control.
 * Returns true if a next-page action was triggered, false if we are on the last page.
 */
async function clickNextPage(page) {
  // Ordered list of selectors / strategies to find the "next" control.
  // We check for disabled state before clicking.
  const candidates = [
    // Text-based buttons / links
    'button:has-text("Seterusnya")',
    'a:has-text("Seterusnya")',
    'button:has-text("Next")',
    'a:has-text("Next")',
    '[aria-label*="next" i]',
    '[aria-label*="seterusnya" i]',
    // Common pagination ">" glyphs
    'button:has-text(">")',
    'a:has-text(">")',
    // Generic next-page patterns
    '.pagination .next a',
    '.pagination li.next a',
    'li.next a',
    'a[rel="next"]',
    '.page-next',
    '[class*="next"]:not([disabled])',
  ];

  for (const sel of candidates) {
    try {
      const el = await page.$(sel);
      if (!el) continue;

      // Check disabled state via attribute or aria
      const disabled = await el.evaluate(node => {
        return (
          node.disabled === true ||
          node.getAttribute('disabled') !== null ||
          node.getAttribute('aria-disabled') === 'true' ||
          node.classList.contains('disabled') ||
          (node.parentElement && node.parentElement.classList.contains('disabled'))
        );
      });
      if (disabled) return false;

      await el.click();
      return true;
    } catch (_) {
      // selector not present or click failed — try next
    }
  }

  return false; // no next button found
}

/**
 * Wait for the results area to be ready.
 * Tries several indicators; resolves when any one is found.
 */
async function waitForContent(page) {
  const indicators = [
    'table tbody tr',
    '.table tbody tr',
    'table tr',
    '[class*="no-result"]',
    '[class*="no-data"]',
    '[class*="empty"]',
    'text=Tiada rekod',
    'text=No record',
    'text=No results',
  ];

  await page.waitForFunction(
    (sels) => sels.some(s => {
      try { return document.querySelector(s) !== null; } catch (_) { return false; }
    }),
    indicators,
    { timeout: 30000 }
  );
}

/**
 * Attempt to submit the search form with empty/default parameters so the site
 * returns all open tenders.  This is best-effort; if it fails we fall through
 * to whatever the page already shows.
 */
async function trySubmitForm(page) {
  const submitSelectors = [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Cari")',
    'button:has-text("Search")',
    'button:has-text("Semak")',
    'a:has-text("Cari")',
  ];

  for (const sel of submitSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        // Wait briefly for results to update
        await page.waitForTimeout(2000);
        return true;
      }
    } catch (_) { /* selector absent — continue */ }
  }
  return false;
}

async function* scrape() {
  const now = nowIso();
  let browser = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      locale: 'ms-MY',
      extraHTTPHeaders: {
        'Accept-Language': 'ms-MY,ms;q=0.9,en;q=0.8',
      },
    });

    const page = await context.newPage();

    // Suppress non-critical console noise from the SPA
    page.on('console', () => {});
    page.on('pageerror', () => {});

    console.log(`[${SOURCE_NAME}] navigating to ${BASE_URL}`);
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 60000 });

    // Wait for any content to appear
    try {
      await waitForContent(page);
    } catch (waitErr) {
      console.error(`[${SOURCE_NAME}] timeout waiting for content: ${waitErr.message}`);
      // Continue anyway — maybe something is still there
    }

    // Best-effort: submit the form with empty params to get all results
    const submitted = await trySubmitForm(page);
    if (submitted) {
      console.log(`[${SOURCE_NAME}] submitted search form`);
      try {
        await waitForContent(page);
      } catch (_) { /* carry on */ }
    }

    let pageNum = 0;
    let totalYielded = 0;

    while (pageNum < MAX_PAGES) {
      pageNum++;
      console.log(`[${SOURCE_NAME}] scraping page ${pageNum}`);

      // Small stabilisation pause — the SPA may still be rendering
      await page.waitForTimeout(500);

      const rows = await extractRows(page);

      if (!rows.length) {
        console.log(`[${SOURCE_NAME}] no rows found on page ${pageNum}, stopping`);
        break;
      }

      for (const { cells, href } of rows) {
        const record = rowToRecord(cells, href, now);
        // Skip rows that have no meaningful title
        if (!record.title) continue;
        totalYielded++;
        yield record;
      }

      // Attempt to navigate to the next page
      const advanced = await clickNextPage(page);
      if (!advanced) {
        console.log(`[${SOURCE_NAME}] no next page found after page ${pageNum}`);
        break;
      }

      // Wait for the table to re-render after pagination click
      try {
        await page.waitForFunction(
          () => {
            const sels = ['table tbody tr', '.table tbody tr', 'table tr'];
            return sels.some(s => {
              try { return document.querySelector(s) !== null; } catch (_) { return false; }
            });
          },
          { timeout: 15000 }
        );
      } catch (_) {
        // Table may have momentarily disappeared during load — give it an extra second
        await page.waitForTimeout(1000);
      }
    }

    console.log(`[${SOURCE_NAME}] done — yielded ${totalYielded} records across ${pageNum} page(s)`);
  } catch (err) {
    console.error(`[${SOURCE_NAME}] fatal error: ${err.message}`);
  } finally {
    if (browser) {
      try { await browser.close(); } catch (_) { /* ignore close errors */ }
    }
  }
}

module.exports = { SOURCE_ID, SOURCE_NAME, scrape };
