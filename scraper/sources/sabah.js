'use strict';

// Sabah PSU — WordPress site
// New URL: https://www.psupsabah.gov.my/tender-sebutharga/
const axios = require('axios');
const cheerio = require('cheerio');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 5;
const SOURCE_NAME = 'Sabah';
const BASE_URL = 'https://www.psupsabah.gov.my/tender-sebutharga/';
const HOST = 'https://www.psupsabah.gov.my';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
  'Accept-Language': 'ms-MY,ms;q=0.9,en-US;q=0.8',
};

const NAV_SKIP = new Set(['utama', 'warga', 'media', 'hubungi kami', 'info korporat', 'soalan lazim',
  'peta laman', 'direktori', 'alamat pejabat', 'penerbitan', 'sejarah', 'profil jabatan']);

async function* scrape() {
  const now = nowIso();
  let totalYielded = 0;

  try {
    const { data } = await axios.get(BASE_URL, { headers: HEADERS, timeout: 30000 });
    const $ = cheerio.load(data);

    // WordPress page: content inside .entry-content or .page-content
    const content = $('.entry-content, .page-content, #content-area, article.page, main').first();
    const scope = content.length ? content : $('body');

    const seen = new Set();
    const links = [];

    // Gather links from the content area that look like tenders
    scope.find('a[href]').each((_, a) => {
      const title = $(a).text().trim();
      const href = $(a).attr('href') || '';
      if (title.length < 15) return;
      if (NAV_SKIP.has(title.toLowerCase())) return;
      if (/^(home|about|contact|menu|download|muat turun)$/i.test(title)) return;
      // Skip nav links that point to own anchors
      if (href === '#' || href.startsWith('#')) return;
      links.push({ title, href, el: a });
    });

    // Also scrape table rows for tender entries
    const tableItems = [];
    scope.find('table tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (!tds.length) return;
      const cells = tds.map((_, td) => $(td).text().trim()).get();
      const titleCell = cells.find(c => c.length >= 15 && !NAV_SKIP.has(c.toLowerCase()));
      if (!titleCell) return;
      const link = $(tr).find('a[href]').first();
      const href = link.attr('href') || BASE_URL;
      const dateStr = cells.join(' ').match(/\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4}/g);
      tableItems.push({
        title: titleCell,
        href,
        closeRaw: dateStr ? dateStr[dateStr.length - 1] : null,
      });
    });

    for (const { title, href, el } of links) {
      if (seen.has(title)) continue;
      seen.add(title);
      const parent = $(el).closest('tr, li, p, div');
      const text = parent.text();
      const dateM = text.match(/\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4}/g);
      const closeRaw = dateM ? dateM[dateM.length - 1] : null;
      const url = href.startsWith('http') ? href : `${HOST}${href.startsWith('/') ? '' : '/'}${href}`;
      const deadline = parseDate(closeRaw);
      yield {
        source_id: SOURCE_ID, ref: null, title, category: null, ministry: 'Sabah PSU',
        open_date: null, deadline, status: inferStatus(null, deadline),
        url, scraped_at: now,
      };
      totalYielded++;
    }

    for (const item of tableItems) {
      if (seen.has(item.title)) continue;
      seen.add(item.title);
      const url = item.href.startsWith('http') ? item.href : `${HOST}${item.href.startsWith('/') ? '' : '/'}${item.href}`;
      const deadline = parseDate(item.closeRaw);
      yield {
        source_id: SOURCE_ID, ref: null, title: item.title, category: null, ministry: 'Sabah PSU',
        open_date: null, deadline, status: inferStatus(null, deadline),
        url, scraped_at: now,
      };
      totalYielded++;
    }

    console.log(`[${SOURCE_NAME}] done — ${totalYielded} records`);
  } catch (err) {
    console.error(`[${SOURCE_NAME}] fatal: ${err.message}`);
  }
}

module.exports = { SOURCE_ID, SOURCE_NAME, scrape };
