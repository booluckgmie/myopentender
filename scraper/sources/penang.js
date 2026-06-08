const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 3;
const SOURCE_NAME = 'Penang eProcure';
const BASE_URL = 'https://ep.penang.gov.my/';
const TENDER_URL = 'https://ep.penang.gov.my/eprocurement/public/tenderlist';
const LOGIN_SIGNALS = ['log masuk', 'login', 'sign in', 'kata laluan', 'password'];

async function* scrape() {
  let playwright;
  try {
    playwright = require('playwright');
  } catch {
    console.warn(`[${SOURCE_NAME}] playwright not installed — skipping`);
    return;
  }
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(TENDER_URL, { timeout: 30000, waitUntil: 'networkidle' });
    const bodyText = (await page.innerText('body')).toLowerCase().slice(0, 500);
    if (LOGIN_SIGNALS.some(s => bodyText.includes(s))) {
      console.warn(`[${SOURCE_NAME}] redirected to login — skipping`);
      return;
    }
    await page.waitForSelector('table tbody tr, .list-row', { timeout: 15000 });
    const rows = await page.$$('table tbody tr');
    const now = nowIso();
    for (const row of rows) {
      const cells = await row.$$eval('td', tds => tds.map(td => td.innerText.trim()));
      if (cells.length < 2) continue;
      const link = await row.$eval('a', a => a.href).catch(() => BASE_URL);
      const url = link.startsWith('/') ? 'https://ep.penang.gov.my' + link : link;
      const title = cells[1];
      const openDate = parseDate(cells[2]);
      const deadline = parseDate(cells[3]);
      yield { source_id: SOURCE_ID, ref: cells[0] || null, title,
        deadline, open_date: openDate, status: inferStatus(openDate, deadline), url, scraped_at: now };
    }
  } catch (e) {
    console.error(`[${SOURCE_NAME}] error: ${e.message}`);
  } finally {
    await browser.close();
  }
}

module.exports = { SOURCE_ID, SOURCE_NAME, scrape };
