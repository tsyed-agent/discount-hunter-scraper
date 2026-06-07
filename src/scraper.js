const axios = require('axios');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

// Inject stealth plugin to avoid anti-bot blocks
chromium.use(stealth);

// Session state — shared across all requests in this process
let sessionCookies = '';
let sessionHeaders = {};
let targetUrlInfo = null;

// Mutex: prevents concurrent handshakes. Multiple callers awaiting the same
// handshake all share the single in-flight Promise, so only one browser
// instance is ever launched at a time.
let _handshakePromise = null;

/**
 * Parses the HiBid Catalog URL to extract hostname, catalog ID, and slug.
 * Example URL: https://discounthunters.hibid.com/catalog/747454/-408--returns-and-unclaimed
 * @param {string} url - The catalog URL
 * @returns {Object} - { host, hostname, catalogId, slug }
 */
function parseCatalogUrl(url) {
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split('/').filter(Boolean);

    if (pathParts[0] !== 'catalog' || !pathParts[1]) {
      throw new Error('Invalid HiBid catalog URL structure. Expected /catalog/[id]/[slug]');
    }

    return {
      host: parsed.origin,       // "https://discounthunters.hibid.com"
      hostname: parsed.hostname, // "discounthunters.hibid.com"
      catalogId: pathParts[1],   // "747454"
      slug: pathParts[2] || ''   // "-408--returns-and-unclaimed"
    };
  } catch (error) {
    console.error('URL Parsing Error:', error.message);
    throw error;
  }
}

/**
 * Runs a headless Playwright browser to visit the catalog page,
 * bypass Cloudflare, and extract session cookies/headers.
 *
 * Thread-safe: if multiple async callers invoke this simultaneously
 * (e.g. concurrent page tasks all hitting SESSION_EXPIRED), only one
 * Playwright browser is launched; all other callers await that single run.
 *
 * @param {string} url - The catalog URL to visit
 */
async function runHandshake(url) {
  // If a handshake is already in flight, piggy-back on it
  if (_handshakePromise) {
    console.log('Handshake already in progress — waiting for it to complete...');
    return _handshakePromise;
  }

  _handshakePromise = _doHandshake(url).finally(() => {
    _handshakePromise = null;
  });

  return _handshakePromise;
}

async function _doHandshake(url) {
  console.log(`Starting Playwright stealth handshake for: ${url}`);
  targetUrlInfo = parseCatalogUrl(url);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 720 },
    locale: 'en-US',
  });

  const page = await context.newPage();

  // Intercept API requests to capture any custom auth headers
  page.on('request', request => {
    const reqUrl = request.url();
    if (reqUrl.includes('/api/') || reqUrl.includes('/catalog/')) {
      const headers = request.headers();
      if (headers['x-request-token'] || headers['x-xsrf-token'] || headers['requestverificationtoken']) {
        sessionHeaders = { ...sessionHeaders, ...headers };
      }
    }
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000);

    const cookies = await context.cookies(url);
    sessionCookies = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    sessionHeaders = {
      ...sessionHeaders,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cookie': sessionCookies,
      'Referer': url,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin'
    };

    console.log('Playwright stealth handshake complete. Session headers extracted.');
  } catch (error) {
    console.error('Playwright Handshake failed:', error);
    throw error;
  } finally {
    await browser.close();
  }
}

/**
 * Helper to fetch data via Axios with exponential backoff + jitter.
 * Throws SESSION_EXPIRED for 401/403 so the scheduler can renew.
 * @param {string} url
 * @param {number} retries
 * @param {number} delay - initial delay in ms
 */
async function fetchWithRetry(url, retries = 3, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(url, { headers: sessionHeaders, timeout: 15000 });
      return response;
    } catch (error) {
      const status = error.response?.status;
      console.warn(`Fetch attempt ${i + 1} failed for ${url}. Status: ${status || error.message}`);

      if (status === 401 || status === 403) {
        throw new Error('SESSION_EXPIRED');
      }

      if (i === retries - 1) throw error;

      const waitTime = delay * Math.pow(2, i) + Math.random() * 1000;
      console.log(`Waiting ${Math.round(waitTime)}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
}

/**
 * Returns the total number of pages in the catalog by scanning page 1.
 * Requires runHandshake() to have been called first.
 * @returns {number}
 */
async function getTotalPages() {
  if (!targetUrlInfo) {
    throw new Error('Scraper must be initialized with runHandshake() before getTotalPages().');
  }

  const pageUrl = `${targetUrlInfo.host}/catalog/${targetUrlInfo.catalogId}/${targetUrlInfo.slug}?apage=1`;
  const response = await fetchWithRetry(pageUrl);
  const html = response.data;

  // Find the highest ?apage=N value in pagination links
  const pageCountRegex = /[?&]apage=(\d+)/g;
  let match;
  let maxPage = 1;

  while ((match = pageCountRegex.exec(html)) !== null) {
    const n = parseInt(match[1], 10);
    if (n > maxPage) maxPage = n;
  }

  // Also check data-page-count attributes (HiBid sometimes embeds this)
  const dataPageMatch = /data-page-count="(\d+)"/i.exec(html);
  if (dataPageMatch) {
    const n = parseInt(dataPageMatch[1], 10);
    if (n > maxPage) maxPage = n;
  }

  console.log(`Determined total pages from catalog: ${maxPage}`);
  return maxPage;
}

/**
 * Fetches a single catalog page and returns parsed lot objects.
 * Requires runHandshake() to have been called first.
 * @param {number} pageNumber
 * @returns {Array<Object>}
 */
async function fetchCatalogPage(pageNumber) {
  if (!targetUrlInfo) {
    throw new Error('Scraper must be initialized with runHandshake() before fetchCatalogPage().');
  }

  const pageUrl = `${targetUrlInfo.host}/catalog/${targetUrlInfo.catalogId}/${targetUrlInfo.slug}?apage=${pageNumber}`;
  console.log(`Fetching catalog page ${pageNumber}...`);

  const response = await fetchWithRetry(pageUrl);
  return parsePageHtml(response.data, pageNumber);
}

/**
 * Parses raw HTML from a HiBid catalog page into lot objects.
 * Strategy 1: Extract embedded JSON state (fast, reliable when present).
 * Strategy 2: Fall back to DOM regex parsing.
 * @param {string} html
 * @param {number} pageNumber
 * @returns {Array<Object>}
 */
function parsePageHtml(html, pageNumber) {
  const lots = [];

  // --- Strategy 1: embedded JSON in script tags ---
  // HiBid pages embed catalog data in JS variables like:
  //   window.__NEXT_DATA__ = {...}  or  "items":[...], "pageNumber":N
  let itemsData = null;

  // Try window.__NEXT_DATA__ / React/Next.js SSR payload first (most reliable)
  const nextDataMatch = /<script[^>]*id="__NEXT_DATA__"[^>]*>([^<]+)<\/script>/i.exec(html);
  if (nextDataMatch) {
    try {
      const nextData = JSON.parse(nextDataMatch[1]);
      // Walk common key paths for HiBid's Next.js structure
      const props = nextData?.props?.pageProps;
      const candidates = [
        props?.items,
        props?.lots,
        props?.catalog?.items,
        props?.initialState?.catalog?.items
      ];
      for (const c of candidates) {
        if (Array.isArray(c) && c.length > 0) {
          itemsData = c;
          break;
        }
      }
    } catch (e) {
      // Not a Next.js page or parsing failed — continue to next strategy
    }
  }

  // Try generic "items":[...] JSON blob in any script tag
  if (!itemsData) {
    const itemsRegex = /"items"\s*:\s*(\[[\s\S]*?\])\s*,\s*"pageNumber"/g;
    const m = itemsRegex.exec(html);
    if (m) {
      try {
        itemsData = JSON.parse(m[1]);
      } catch (e) {
        console.warn(`[Page ${pageNumber}] JSON "items" parse failed:`, e.message);
      }
    }
  }

  if (itemsData && Array.isArray(itemsData) && itemsData.length > 0) {
    console.log(`[Page ${pageNumber}] Parsed ${itemsData.length} items from script JSON.`);
    for (const item of itemsData) {
      const id = String(item.id || item.lotId || item.lot_id || '');
      if (!id) continue;
      lots.push({
        id,
        lotNumber: String(item.lotNumber || item.lotNum || item.lot_number || ''),
        title: item.title || item.name || '',
        description: item.description || item.desc || '',
        currentPrice: Number(item.currentBid || item.currentPrice || item.price || 0),
        minBid: Number(item.nextBid || item.minimumBid || item.minBid || 0),
        bidCount: Number(item.bidCount || item.numBids || item.bids || 0),
        status: item.status || (item.closed ? 'Closed' : 'Open'),
        endTime: item.endTime || item.closes || item.end_time || null,
        images: Array.isArray(item.images) ? item.images
          : (item.imageUrl ? [item.imageUrl] : (item.image ? [item.image] : [])),
        url: item.url
          ? (item.url.startsWith('http') ? item.url : `${targetUrlInfo.host}${item.url}`)
          : `${targetUrlInfo.host}/lot/${id}`,
        isActive: !item.closed
      });
    }
    return lots;
  }

  // --- Strategy 2: DOM regex fallback ---
  console.log(`[Page ${pageNumber}] No JSON found — using HTML regex fallback.`);

  // HiBid lot tiles: <div class="lot-tile ..."> ... </div>
  // Use a non-greedy split on each tile container
  const tilePattern = /<div[^>]+class="[^"]*\blot-tile\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*(?=<div[^>]+class="[^"]*\blot-tile|$)/gi;
  let tileMatch;

  while ((tileMatch = tilePattern.exec(html)) !== null) {
    const tile = tileMatch[0];

    const idMatch = /(?:id="lot-(\d+)"|data-lot-id="(\d+)")/i.exec(tile);
    if (!idMatch) continue;

    const id = idMatch[1] || idMatch[2];
    const lotNumMatch = /class="[^"]*lot-number[^"]*"[^>]*>\s*([^<]+)/i.exec(tile);
    const titleMatch = /class="[^"]*lot-title[^"]*"[^>]*>\s*([^<]+)/i.exec(tile);
    const priceMatch = /class="[^"]*current-bid[^"]*"[^>]*>\s*([^<]+)/i.exec(tile);
    const bidCountMatch = /class="[^"]*bid-count[^"]*"[^>]*>\s*([^<]+)/i.exec(tile);
    const imgMatch = /<img[^>]+src="([^"]+)"/i.exec(tile);

    lots.push({
      id,
      lotNumber: lotNumMatch ? lotNumMatch[1].trim() : '',
      title: titleMatch ? titleMatch[1].trim() : '',
      description: '',
      currentPrice: priceMatch ? parseFloat(priceMatch[1].replace(/[^0-9.]/g, '')) || 0 : 0,
      minBid: 0,
      bidCount: bidCountMatch ? parseInt(bidCountMatch[1].replace(/\D/g, ''), 10) || 0 : 0,
      status: 'Open',
      endTime: null,
      images: imgMatch ? [imgMatch[1]] : [],
      url: `${targetUrlInfo.host}/lot/${id}`,
      isActive: true
    });
  }

  if (lots.length === 0) {
    console.warn(`[Page ${pageNumber}] Zero lots parsed — HiBid page structure may have changed.`);
  }

  return lots;
}

/**
 * Attempts to fetch current prices for all lots via HiBid's status API.
 * This is the fast path for price polls — avoids re-scraping every page.
 *
 * Throws if the API is unavailable so the caller can fall back to page scanning.
 * Requires runHandshake() to have been called first.
 *
 * @returns {Array<Object>} - Array of { id, currentPrice, minBid, bidCount, status }
 */
async function tryFetchPricesFromApi() {
  if (!targetUrlInfo) {
    throw new Error('Scraper must be initialized with runHandshake() before tryFetchPricesFromApi().');
  }

  // HiBid real-time status endpoint (best known candidate).
  // Throws SESSION_EXPIRED or a generic error if unavailable.
  const statusApiUrl = `${targetUrlInfo.host}/api/v1/catalog/${targetUrlInfo.catalogId}/status`;
  console.log(`[Price Poll] Trying status API: ${statusApiUrl}`);

  const response = await fetchWithRetry(statusApiUrl);

  // Expect { statuses: [...] } or a top-level array
  const data = response.data;
  const statuses = Array.isArray(data) ? data : data?.statuses;

  if (!Array.isArray(statuses) || statuses.length === 0) {
    throw new Error('Status API returned no usable data');
  }

  console.log(`[Price Poll] Status API returned ${statuses.length} lot updates.`);

  return statuses.map(item => ({
    id: String(item.lotId || item.id || item.lot_id || ''),
    currentPrice: Number(item.currentBid || item.price || item.currentPrice || 0),
    minBid: Number(item.nextBid || item.minimumBid || item.minBid || 0),
    bidCount: Number(item.bidCount || item.numBids || item.bids || 0),
    status: item.closed ? 'Closed' : 'Open'
  })).filter(u => u.id);
}

module.exports = {
  runHandshake,
  getTotalPages,
  fetchCatalogPage,
  tryFetchPricesFromApi
};
