'use strict';

// Sabah PSU — WordPress page, tender list in .entry-content table or linked PDFs
const axios = require('axios');
const cheerio = require('cheerio');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 5;
const SOURCE_NAME = 'Sabah';
const BASE_URL = 'http://www.psupsabah.gov.my/?page_id=14070';
const HOST = 'http://www.psupsabah.gov.my';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
  'Accept-Language': 'ms-MY,ms;q=0.9,en-US;q=0.8',
};

const SKIP = new Set(['no', 'no.', 'bil', 'tajuk', 'title', 'tarikh', 'date', 'status', 'tindakan', 'action', 'rujukan', 'ref']);

async function* scrape() {
  const now = nowIso();
  let totalYielded = 0;

  try {
    const { data } = await axios.get(BASE_URL, { headers: HEADERS, timeout: 30000 });
    const $ = cheerio.load(data);

    // WordPress: tender content in .entry-content
    const content = $('.entry-content, .page-content, #content, article.page').first();
    const scope = content.length ? content : $('body');

    // Strategy 1: links to tender documents / detail pages
    const seen = new Set();
    scope.find('a').each((_, a) => {
      const title = $(a).text().trim();
      const href  = $(a).attr('href') || '';
      if (title.length < 15 || seen.has(title)) return;
      const titleLow = title.toLowerCase();
      if (SKIP.has(titleLow)) return;
      // Skip navigation / non-tender links
      if (/^(home|about|contact|menu|download|muat turun)$/i.test(title)) return;
      seen.add(title);

      // Try to find adjacent date in parent row/li
      const parent = $(a).closest('tr, li, p, div');
      const text = parent.text();
      const dateM = text.match(/\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4}/g);
      const closeRaw = dateM ? dateM[dateM.length - 1] : null;

      const url = href.startsWith('http') ? href : `${HOST}${href.startsWith('/') ? '' : '/'}${href}`;
      const deadline = parseDate(closeRaw);
      totalYielded++;
      return { source_id: SOURCE_ID, ref: null, title, category: null, ministry: 'Sabah PSU',
               open_date: null, deadline, status: inferStatus(null, deadline),
               url, scraped_at: now };
    }).each((_, a) => {
      const title = $(a).text().trim();
      const href  = $(a).attr('href') || '';
      if (title.length < 15 || SKIP.has(title.toLowerCase())) return;
      if (/^(home|about|contact|menu|download|muat turun)$/i.test(title)) return;
      if (seen.has(`yielded:${title}`)) return;
      seen.add(`yielded:${title}`);

      const parent = $(a).closest('tr, li, p, div');
      const text = parent.text();
      const dateM = text.match(/\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4}/g);
      const closeRaw = dateM ? dateM[dateM.length - 1] : null;
      const url = href.startsWith('http') ? href : `${HOST}${href.startsWith('/') ? '' : '/'}${href}`;
      const deadline = parseDate(closeRaw);
      // (generator can't return in forEach — use separate loop below)
    });

    // Better: iterate links as generator yields
    const links = [];
    scope.find('a[href]').each((_, a) => {
      const title = $(a).text().trim();
      const href  = $(a).attr('href') || '';
      if (title.length < 15) return;
      if (SKIP.has(title.toLowerCase())) return;
      if (/^(home|about|contact|menu|laman|utama)$/i.test(title)) return;
      links.push({ title, href, el: a });
    });

    const seenT = new Set();
    for (const { title, href, el } of links) {
      if (seenT.has(title)) continue;
      seenT.add(title);
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

    // Strategy 2: table rows
    if (totalYielded === 0) {
      scope.find('table tr').each((_, tr) => {
        const tds = $(tr).find('td');
        if (!tds.length) return;
        const cells = tds.map((_, td) => $(td).text().trim()).get();
        const title = cells.find(c => c.length >= 15 && !SKIP.has(c.toLowerCase()));
        if (!title) return;
        const dateM = cells.join(' ').match(/\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{4}/g);
        const closeRaw = dateM ? dateM[dateM.length - 1] : null;
        const deadline = parseDate(closeRaw);
        // yielded via links above — skip duplicates handled by seenT
      });
    }

    console.log(`[${SOURCE_NAME}] done — ${totalYielded} records`);
  } catch (err) {
    console.error(`[${SOURCE_NAME}] fatal: ${err.message}`);
  }
}

module.exports = { SOURCE_ID, SOURCE_NAME, scrape };
