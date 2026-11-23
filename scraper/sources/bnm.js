'use strict';

// Bank Negara Malaysia (BNM) — public notices and policy documents
// Data via the unofficial BNM release API: https://bnm-release.vercel.app
// Covers: notices, policy documents, press releases, FMC statements
// Updated ~daily by the bnm-release GitHub Actions scraper.

const axios = require('axios');
const { inferStatus, nowIso } = require('../utils');

const SOURCE_ID = 17;
const SOURCE_NAME = 'BNM';
const API_BASE = 'https://bnm-release.vercel.app';

// Categories to ingest — notices and policy docs are most procurement-relevant
const CATEGORIES = ['notice', 'policy', 'press', 'fmc'];

// Only pull records from the last 180 days to keep the feed current
const LOOKBACK_DAYS = 180;

const HEADERS = {
  'User-Agent': 'myopentender/1.0 (+https://github.com/booluckgmie/myopentender)',
  'Accept': 'application/json',
};

function categoryLabel(cat) {
  const MAP = {
    notice: 'BNM Notice',
    policy: 'BNM Policy',
    press:  'BNM Press Release',
    fmc:    'BNM FMC Statement',
  };
  return MAP[cat] || 'BNM';
}

async function* scrape() {
  const now = nowIso();
  let totalYielded = 0;

  const dateFrom = new Date();
  dateFrom.setDate(dateFrom.getDate() - LOOKBACK_DAYS);
  const dateFromStr = dateFrom.toISOString().slice(0, 10);

  for (const category of CATEGORIES) {
    let offset = 0;
    const limit = 200;

    while (true) {
      let resp;
      try {
        resp = await axios.get(`${API_BASE}/notices`, {
          headers: HEADERS,
          timeout: 20000,
          params: { category, date_from: dateFromStr, limit, offset },
        });
      } catch (err) {
        console.error(`[${SOURCE_NAME}] ${category} offset=${offset}: ${err.message}`);
        break;
      }

      const { data: items, total } = resp.data;
      if (!items || items.length === 0) break;

      for (const item of items) {
        const pub = item.published_date || item.release_date || null;

        yield {
          source_id: SOURCE_ID,
          ref: item.id || null,
          title: item.title,
          category: categoryLabel(item.category),
          ministry: 'Bank Negara Malaysia',
          open_date: pub,
          deadline: null,
          status: 'active',
          url: item.link_url,
          scraped_at: now,
        };
        totalYielded++;
      }

      offset += items.length;
      if (offset >= total) break;
    }

    console.log(`[${SOURCE_NAME}] ${category}: fetched up to offset ${offset}`);
  }

  console.log(`[${SOURCE_NAME}] done — ${totalYielded} records`);
}

module.exports = { SOURCE_ID, SOURCE_NAME, scrape };
