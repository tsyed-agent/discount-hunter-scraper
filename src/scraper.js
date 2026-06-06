const axios = require('axios');
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

// Inject stealth plugin to avoid anti-bot blocks
chromium.use(stealth);

// Global configuration variables for session
let sessionCookies = '';
let sessionHeaders = {};
let targetUrlInfo = null;

/**
 * Parses the HiBid Catalog URL to extract hostname, catalog ID, and slug.
 * Example URL: https://discounthunters.hibid.com/catalog/747454/-408--returns-and-unclaimed
 * @param {string} url - The catalog URL
 * @returns {Object} - Parsed info { host, catalogId, slug }
 */
function parseCatalogUrl(url) {
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.split('/').filter(Boolean); // ['catalog', '747454', '-408--returns-and-unclaimed']
    
    if (pathParts[0] !== 'catalog' || !pathParts[1]) {
      throw new Error('Invalid HiBid catalog URL structure. Expected /catalog/[id]/[slug]');
    }

    return {
      host: parsed.origin,          // "https://discounthunters.hibid.com"
      hostname: parsed.hostname,    // "discounthunters.hibid.com"
      catalogId: pathParts[1],      // "747454"
      slug: pathParts[2] || ''      // "-408--returns-and-unclaimed"
    };
  } catch (error) {
    console.error('URL Parsing Error:', error.message);
    throw error;
  }
}

/**
 * Runs a headless Playwright browser to visit the catalog page,
 * bypass Cloudflare, and extract session cookies/headers.
 * @param {string} url - The catalog URL to visit
 */
async function runHandshake(url) {
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

  // Setup response interception to capture API headers if any specific requests occur
  page.on('request', request => {
    const reqUrl = request.url();
    if (reqUrl.includes('/api/') || reqUrl.includes('/catalog/')) {
      const headers = request.headers();
      // Keep headers that look like Auth or custom headers for future requests
      if (headers['x-request-token'] || headers['x-xsrf-token'] || headers['requestverificationtoken']) {
        sessionHeaders = { ...sessionHeaders, ...headers };
      }
    }
  });

  try {
    // Go to catalog URL and wait for DOM load
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    
    // Give it a brief moment to execute scripts/cookies
    await page.waitForTimeout(3000);

    // Extract cookies
    const cookies = await context.cookies(url);
    sessionCookies = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    
    // Build request headers
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
 * Helper to fetch data via Axios with retries and backoff.
 * @param {string} url - Target URL to request
 * @param {number} retries - Number of retries
 * @param {number} delay - Initial delay in ms
 */
async function fetchWithRetry(url, retries = 3, delay = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      const response = await axios.get(url, { headers: sessionHeaders, timeout: 15000 });
      return response;
    } catch (error) {
      const isRateLimit = error.response && error.response.status === 429;
      const isAuthError = error.response && (error.response.status === 401 || error.response.status === 403);
      
      console.warn(`Fetch attempt ${i + 1} failed for ${url}. Status: ${error.response?.status || error.message}`);
      
      if (isAuthError) {
        throw new Error('SESSION_EXPIRED'); // Let the scheduler trigger a new handshake
      }

      if (i === retries - 1) throw error;
      
      // Calculate delay with backoff + jitter
      const waitTime = delay * Math.pow(2, i) + Math.random() * 1000;
      console.log(`Waiting ${Math.round(waitTime)}ms before retry...`);
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
  }
}

/**
 * Fetches a single catalog page using direct HTTP requests.
 * Parses the HTML contents of the page for lot details.
 * @param {number} pageNumber - The page number to fetch (starts at 1)
 * @returns {Array<Object>} - List of lot objects parsed from the page
 */
async function fetchCatalogPage(pageNumber) {
  if (!targetUrlInfo) {
    throw new Error('Scraper must be initialized with runHandshake() before fetching pages.');
  }

  // Construct page URL
  // HiBid uses query parameter apage=X for page numbering
  const pageUrl = `${targetUrlInfo.host}/catalog/${targetUrlInfo.catalogId}/${targetUrlInfo.slug}?apage=${pageNumber}`;
  console.log(`Fetching page ${pageNumber}...`);

  const response = await fetchWithRetry(pageUrl);
  return parsePageHtml(response.data, pageNumber);
}

/**
 * Parses the raw HTML content of a HiBid catalog page to extract lots.
 * Uses string parsing / regex to keep it lightweight and zero-dependency.
 * @param {string} html - Raw HTML string
 * @param {number} pageNumber - Current page number (for logs)
 * @returns {Array<Object>} - Parsed lot objects
 */
function parsePageHtml(html, pageNumber) {
  const lots = [];
  
  // We look for the JSON payload initialized on the page for listings.
  // HiBid pages embed their items list in the HTML source code within a script tag,
  // typically inside a window variable, or a JSON script block like:
  // "eventItems": [...] or similar.
  // Let's perform a regex lookup for JSON arrays that represent the items.
  
  let itemsData = null;

  // Pattern 1: Look for "items": [ ... ] or similar serialized state in scripts
  const itemsRegex = /"items"\s*:\s*(\[[^]*?\])\s*,\s*"pageNumber"/g;
  const match = itemsRegex.exec(html);
  
  if (match && match[1]) {
    try {
      // Parse the JSON representation of items directly from the HTML scripts!
      // This is extremely robust and avoids fragile HTML DOM selectors.
      itemsData = JSON.parse(match[1]);
    } catch (e) {
      console.warn('JSON regex match failed to parse:', e.message);
    }
  }

  // If script regex fails, we fall back to manual HTML parsing using regex for selectors
  if (itemsData && Array.isArray(itemsData)) {
    console.log(`Parsed ${itemsData.length} items from script JSON on page ${pageNumber}.`);
    
    for (const item of itemsData) {
      lots.push({
        id: String(item.id || item.lotId),
        lotNumber: String(item.lotNumber || item.lotNum || ''),
        title: item.title || item.name || '',
        description: item.description || item.desc || '',
        currentPrice: Number(item.currentBid || item.price || 0),
        minBid: Number(item.nextBid || item.minimumBid || 0),
        bidCount: Number(item.bidCount || item.numBids || 0),
        status: item.status || (item.closed ? 'Closed' : 'Open'),
        endTime: item.endTime || item.closes || null,
        images: Array.isArray(item.images) ? item.images : (item.imageUrl ? [item.imageUrl] : []),
        url: item.url ? `${targetUrlInfo.host}${item.url}` : `${targetUrlInfo.host}/lot/${item.id}`,
        isActive: !item.closed
      });
    }
  } else {
    // Fallback: Parse via regular expression selector templates
    // HiBid lists lots in standard divs, let's extract them by identifying key classes.
    // Typical selectors:
    // lot-title, lot-description, current-bid
    console.log(`No direct JSON array found in page ${pageNumber} script tags. Using HTML regex parser...`);
    
    // Splitting by lot-tile containers (often class="lot-tile" or similar)
    const lotTileRegex = /<div[^>]*class="[^"]*lot-tile[^"]*"[^]*?<\/div>\s*<\/div>/g;
    let lotMatch;
    
    while ((lotMatch = lotTileRegex.exec(html)) !== null) {
      const lotHtml = lotMatch[0];
      
      const idMatch = /id="lot-(\d+)"|data-lot-id="(\d+)"/i.exec(lotHtml);
      const lotNumMatch = /class="lot-number"[^>]*>([^<]+)/i.exec(lotHtml);
      const titleMatch = /class="lot-title"[^>]*>([^<]+)/i.exec(lotHtml);
      const priceMatch = /class="current-bid"[^>]*>([^<]+)/i.exec(lotHtml);
      
      if (idMatch) {
        const id = idMatch[1] || idMatch[2];
        lots.push({
          id,
          lotNumber: lotNumMatch ? lotNumMatch[1].trim() : '',
          title: titleMatch ? titleMatch[1].trim() : '',
          description: '', // Desc is often truncated on main page, full sync handles this
          currentPrice: priceMatch ? parseFloat(priceMatch[1].replace(/[^0-9.]/g, '')) || 0 : 0,
          minBid: 0,
          bidCount: 0,
          status: 'Open',
          endTime: null,
          images: [],
          url: `${targetUrlInfo.host}/lot/${id}`,
          isActive: true
        });
      }
    }
  }

  return lots;
}

/**
 * Fetches the pricing updates directly for all active lots.
 * In HiBid, dynamic price/bid updates are fetched via an internal endpoint
 * or by querying the first page. Let's design a quick-poll query.
 * @param {Array<string>} lotIds - List of active lot IDs to refresh
 * @returns {Array<Object>} - Updated lot price objects
 */
async function fetchPricesOnly(lotIds) {
  if (!targetUrlInfo) {
    throw new Error('Scraper must be initialized with runHandshake() before fetching prices.');
  }

  // To fetch prices in near real-time, we can query HiBid's auction status updates API endpoint.
  // HiBid uses a real-time status update endpoint for active auctions:
  // https://discounthunters.hibid.com/api/v1/event/lots/status
  // Let's construct a status query request.
  
  const statusApiUrl = `${targetUrlInfo.host}/api/v1/catalog/${targetUrlInfo.catalogId}/status`;
  console.log(`Polling real-time prices from status API...`);

  try {
    const response = await fetchWithRetry(statusApiUrl);
    
    if (response.data && Array.isArray(response.data.statuses)) {
      return response.data.statuses.map(item => ({
        id: String(item.lotId || item.id),
        currentPrice: Number(item.currentBid || item.price || 0),
        minBid: Number(item.nextBid || item.minimumBid || 0),
        bidCount: Number(item.bidCount || item.numBids || 0),
        status: item.closed ? 'Closed' : 'Open'
      }));
    }
  } catch (error) {
    console.warn('Status API failed, falling back to scraping page 1 for quick update:', error.message);
  }

  // Fallback: If status endpoint is blocked or missing, scrape page 1 prices (often covers active/ending lots)
  const p1Lots = await fetchCatalogPage(1);
  return p1Lots.map(lot => ({
    id: lot.id,
    currentPrice: lot.currentPrice,
    minBid: lot.minBid,
    bidCount: lot.bidCount,
    status: lot.status
  }));
}

/**
 * Extract the total number of pages in the catalog by scanning the first page's HTML.
 * @param {string} url - The catalog URL
 * @returns {number} - Total pages count
 */
async function getTotalPages(url) {
  await runHandshake(url);
  
  const pageUrl = `${targetUrlInfo.host}/catalog/${targetUrlInfo.catalogId}/${targetUrlInfo.slug}?apage=1`;
  const response = await fetchWithRetry(pageUrl);
  const html = response.data;

  // Regex to look for pagination links / total page elements
  // HiBid pagination often contains links like "?apage=75" or data-page-count="75"
  const pageCountRegex = /apage=(\d+)/g;
  let match;
  let maxPage = 1;

  while ((match = pageCountRegex.exec(html)) !== null) {
    const pageNum = parseInt(match[1], 10);
    if (pageNum > maxPage) {
      maxPage = pageNum;
    }
  }

  console.log(`Determined total pages from catalog: ${maxPage}`);
  return maxPage;
}

module.exports = {
  runHandshake,
  fetchCatalogPage,
  fetchPricesOnly,
  getTotalPages
};
