'use strict';

// Johor Port Berhad — Tenders
// https://www.johorport.com.my/Resources-Center/Tenders
const axios = require('axios');
const cheerio = require('cheerio');
const { parseDate, inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 14;
const SOURCE_NAME = 'Johor Port';
const BASE_URL = 'https://www.johorport.com.my/Resources-Center/Tenders';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,*/*;q=0.9',
  'Accept-Language': 'en-US,en;q=0.9,ms;q=0.8',
};

async function* scrape() {
  const now = nowIso();
  let totalYielded = 0;

  try {
    const { data } = await axios.get(BASE_URL, { headers: HEADERS, timeout: 30000 });
    const $ = cheerio.load(data);

    // Each tender is a section under an h4 heading with the tender ref (e.g. JPB/20/2026)
    // followed by a strong/p containing the title and key dates
    const items = [];

    $('h4').each((_, h4) => {
      const refText = $(h4).text().trim();
      if (!/^[A-Z]{2,}\/\d+\/\d{4}/.test(refText)) return;
      const ref = refText.replace(/\*/g, '').trim();

      // Collect sibling text until next h4 or hr
      let titleParts = [];
      let closingRaw = null;
      let ittRaw = null;

      let el = $(h4).next();
      while (el.length && !['H4', 'HR'].includes(el[0].tagName?.toUpperCase())) {
        const text = el.text().trim();
        if (/^Closing Date:/i.test(text)) {
          closingRaw = text.replace(/^Closing Date:\s*/i, '').trim();
        } else if (/^ITT Date:/i.test(text)) {
          ittRaw = text.replace(/^ITT Date:\s*/i, '').trim();
        } else if (/^TENDER NO\./i.test(text)) {
          // skip — just the ref repeated
        } else if (text.length > 20 && !text.startsWith('Sale of Documents') && !text.startsWith('Tender Briefing') && !text.startsWith('Venue') && !text.startsWith('Tender Fee') && !text.startsWith('Tender Security') && !text.startsWith('Requirement') && !text.startsWith('Financial') && !text.startsWith('Please') && !text.startsWith('Kindly') && !text.startsWith('Bank') && !text.startsWith('A non-refundable')) {
          titleParts.push(text);
        }
        el = el.next();
      }

      const title = titleParts[0] || `Tender ${ref}`;
      const deadline = parseDate(closingRaw);
      const open_date = parseDate(ittRaw);

      items.push({ ref, title, deadline, open_date });
    });

    for (const item of items) {
      yield {
        source_id: SOURCE_ID, ref: item.ref,
        title: item.title, category: null, ministry: 'Johor Port',
        open_date: item.open_date, deadline: item.deadline,
        status: inferStatus(item.open_date, item.deadline),
        url: BASE_URL, scraped_at: now,
      };
      totalYielded++;
    }

    console.log(`[${SOURCE_NAME}] done — ${totalYielded} records`);
  } catch (err) {
    console.error(`[${SOURCE_NAME}] fatal: ${err.message}`);
  }
}

module.exports = { SOURCE_ID, SOURCE_NAME, scrape };
