// Olostep Amazon Products Scraper: a Druve agent ported by hand from the n8n
// template "Extract Amazon Product Data to Sheets with Olostep API" by Yasser
// Sami (https://n8n.io/workflows/11158). Draft for Yasser to check. Nothing is
// published.
//
// What it keeps, unchanged: the Olostep request body word for word
// (url_to_scrape with the search query and page number, formats json,
// wait_before_scraping 6000, remove_css_selectors default, the llm_extract
// schema for title + url, the desktop screen size), the 10-page loop, the
// parsedInfo clean-up (strip backslashes, then parse), and the "Edit Fields1"
// rule that prefixes https://www.amazon.com to relative product links.
// What changes: instead of inserting rows into an n8n Data Table, it returns
// the products as JSON (and CSV) for the buyer to paste into a sheet.
//
// Input (JSON):
//   {"query": "wireless bluetooth headphones", "olostep_api_key": "...", "pages": 10}
// or plain text: the search query (then the key must be in providerConfig as
// olostepApiKey). "pages" is optional, 1 to 10, default 10 like the template.
//
// Data-fetch host to declare when publishing: api.olostep.com
//
// To publish it under your name on druve.ai:
//   1. Put this file in a GitHub repo (private is fine) and copy the file's link.
//   2. Go to druve.ai/build/new and sign up. Fill in the short steps (name, what it
//      does, price or free), paste the link into "Agent code", declare
//      api.olostep.com as the data host, and publish.
//   Each buyer uses their own Olostep key, so it costs you nothing to run.

const ENDPOINT = 'https://api.olostep.com/v1/scrapes';
const MAX_PAGES = 10; // Edit Fields: counter = [1..10]

// Author's request body, verbatim (n8n node "scrape amazon products").
function body(query, page) {
  return {
    url_to_scrape: `https://www.amazon.com/s?k=${query}&page=${page}`,
    formats: ['json'],
    wait_before_scraping: 6000,
    remove_css_selectors: 'default',
    llm_extract: {
      schema: {
        type: 'array',
        description: 'A list of products listed on Amazon.',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'The title of the product.' },
            url: { type: 'string', description: 'The full url for the product.' },
          },
          required: ['title', 'url'],
        },
      },
    },
    screen_size: { screen_type: 'desktop', screen_width: 1920, screen_height: 1080 },
  };
}

function readInput(input, providerConfig) {
  const raw = String(input || '').trim();
  let p = null;
  try { p = JSON.parse(raw); } catch { /* plain text */ }
  const query = (p && typeof p === 'object' ? p.query : raw) || '';
  const key = (p && p.olostep_api_key) || providerConfig?.olostepApiKey || '';
  let pages = Number((p && p.pages) || MAX_PAGES);
  if (!Number.isFinite(pages) || pages < 1) pages = 1;
  return { query: String(query).trim(), key: String(key).trim(), pages: Math.min(MAX_PAGES, Math.floor(pages)) };
}

// parsedInfo: $json.result.json_content.replace(/\\/g, '') then parse.
function parseProducts(resp) {
  const content = resp?.result?.json_content;
  if (content == null) return [];
  let arr = content;
  if (typeof content === 'string') {
    try { arr = JSON.parse(content.replace(/\\/g, '')); } catch { return []; }
  }
  return Array.isArray(arr) ? arr : [];
}

// If + Edit Fields1: relative links get the amazon.com prefix.
function normalise(item) {
  const title = String(item?.title || '').trim();
  let url = String(item?.url || '').trim();
  if (url && !url.startsWith('https://www.amazon.com')) url = `https://www.amazon.com${url}`;
  return { title, url };
}

const csvCell = (s) => `"${String(s).replace(/"/g, '""')}"`;

export async function handleMessage(input, providerConfig) {
  const { query, key, pages } = readInput(input, providerConfig);
  if (!query) return JSON.stringify({ error: 'Send a search query, for example "wireless bluetooth headphones".' });
  if (!key) return JSON.stringify({ error: 'An Olostep API key is needed: pass "olostep_api_key" in the input.' });

  const seen = new Set();
  const products = [];
  const errors = [];
  for (let page = 1; page <= pages; page++) {
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body(encodeURIComponent(query), page)),
      });
      if (!res.ok) { errors.push(`page ${page}: HTTP ${res.status}`); continue; }
      for (const item of parseProducts(await res.json())) {
        const p = normalise(item);
        if (p.title && p.url && !seen.has(p.url)) { seen.add(p.url); products.push(p); }
      }
    } catch (e) {
      errors.push(`page ${page}: ${e.message}`); // the template's note: on a 504, run again
    }
  }

  const csv = ['title,url', ...products.map((p) => `${csvCell(p.title)},${csvCell(p.url)}`)].join('\n');
  return JSON.stringify({ query, pages, count: products.length, products, csv, errors });
}
