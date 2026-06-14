const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();

// Inject stealth plugin to avoid anti-bot blocks
chromium.use(stealth);

// ---------------------------------------------------------------------------
// HiBid is an Angular single-page app fronted by Cloudflare. Lot data is NOT
// embedded in the server-rendered HTML — it is loaded by the browser via a
// GraphQL API (POST {host}/graphql). Plain HTTP scraping of the catalog page
// therefore returns an empty app shell with zero lots.
//
// Strategy:
//   1. Launch a stealth Chromium browser and navigate to the catalog page so
//      Cloudflare issues a clearance cookie and the GraphQL origin is primed.
//   2. Keep that browser/page open and issue GraphQL POSTs *from inside the
//      page context* (page.evaluate + fetch). This reuses the browser's exact
//      cookies and TLS fingerprint, so Cloudflare lets the requests through.
// ---------------------------------------------------------------------------

// Persistent session state for the current process.
let session = null; // { browser, context, page, host, catalogId, slug }

// Mutex: ensures only one handshake/browser launch happens at a time.
let _handshakePromise = null;

// Minimal GraphQL query — requests only the fields the scraper needs.
const LOT_SEARCH_QUERY = `query LotSearch($auctionId: Int!, $pageNumber: Int!, $pageLength: Int!) {
  lotSearch(
    input: {auctionId: $auctionId, status: ALL, sortOrder: LOT_NUMBER, filter: ALL, isArchive: false, countAsView: false}
    pageNumber: $pageNumber
    pageLength: $pageLength
    sortDirection: ASC
  ) {
    pagedResults {
      totalCount
      results {
        id
        lotNumber
        lead
        description
        quantity
        pictures { fullSizeLocation }
        lotState {
          highBid
          minBid
          bidCount
          status
          isClosed
          timeLeftTitle
        }
      }
    }
  }
}`;

/**
 * Parses the HiBid Catalog URL to extract hostname, catalog (auction) ID, and slug.
 * Example: https://discounthunters.hibid.com/catalog/749490/-410--returns-and-unclaimed-packages
 * @param {string} url - The catalog URL
 * @returns {Object} - { host, hostname, catalogId, slug }
 */
function parseCatalogUrl(url) {
  const parsed = new URL(url);
  const pathParts = parsed.pathname.split('/').filter(Boolean);

  // Accept both /catalog/<id>/<slug> and /auction/<id>/<slug>
  if ((pathParts[0] !== 'catalog' && pathParts[0] !== 'auction') || !pathParts[1]) {
    throw new Error('Invalid HiBid catalog URL. Expected /catalog/<id>/<slug> or /auction/<id>/<slug>');
  }

  const catalogId = parseInt(pathParts[1], 10);
  if (!Number.isFinite(catalogId)) {
    throw new Error(`Could not parse numeric auction ID from URL: ${url}`);
  }

  return {
    host: parsed.origin,        // "https://discounthunters.hibid.com"
    hostname: parsed.hostname,  // "discounthunters.hibid.com"
    catalogId,                  // 749490
    slug: pathParts[2] || ''    // "-410--returns-and-unclaimed-packages"
  };
}

/**
 * Launches a stealth browser, navigates to the catalog page to clear Cloudflare,
 * and keeps the session open for subsequent GraphQL calls.
 *
 * Thread-safe: concurrent callers share a single in-flight handshake.
 * Idempotent: if a live session already exists, it is reused.
 *
 * @param {string} url - The catalog URL to visit
 */
async function runHandshake(url) {
  if (session && session.page && !session.page.isClosed()) {
    return session;
  }
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
  const info = parseCatalogUrl(url);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
    locale: 'en-US'
  });

  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    // Give Cloudflare / the SPA a moment to settle and set clearance cookies.
    await page.waitForTimeout(3500);

    session = { browser, context, page, ...info };
    console.log(`Playwright stealth handshake complete (auction ${info.catalogId}).`);
    return session;
  } catch (error) {
    console.error('Playwright handshake failed:', error.message);
    await browser.close().catch(() => {});
    session = null;
    throw error;
  }
}

/**
 * Executes the lot-search GraphQL query for a single page from inside the
 * browser page context. Throws SESSION_EXPIRED on auth/cloudflare failures so
 * the caller can renew the handshake.
 *
 * @param {number} pageNumber - 1-based page index
 * @param {number} pageLength - lots per page (HiBid caps at ~100)
 * @returns {{ lots: Array<Object>, totalCount: number }}
 */
async function fetchLotPage(pageNumber, pageLength = 100) {
  if (!session || !session.page || session.page.isClosed()) {
    throw new Error('Scraper must be initialized with runHandshake() before fetchLotPage().');
  }

  const { page, host, catalogId } = session;

  let result;
  try {
    result = await page.evaluate(async ({ host, query, auctionId, pageNumber, pageLength }) => {
      const res = await fetch(host + '/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          operationName: 'LotSearch',
          query,
          variables: { auctionId, pageNumber, pageLength }
        })
      });
      const text = await res.text();
      return { status: res.status, text };
    }, { host, query: LOT_SEARCH_QUERY, auctionId: catalogId, pageNumber, pageLength });
  } catch (err) {
    throw new Error(`GraphQL request failed on page ${pageNumber}: ${err.message}`);
  }

  if (result.status === 401 || result.status === 403) {
    throw new Error('SESSION_EXPIRED');
  }
  if (result.status !== 200) {
    throw new Error(`GraphQL returned HTTP ${result.status} on page ${pageNumber}`);
  }

  let json;
  try {
    json = JSON.parse(result.text);
  } catch (e) {
    // A Cloudflare interstitial returns HTML, not JSON.
    throw new Error('SESSION_EXPIRED');
  }

  if (json.errors && json.errors.length) {
    throw new Error(`GraphQL error: ${JSON.stringify(json.errors).slice(0, 300)}`);
  }

  const paged = json.data && json.data.lotSearch && json.data.lotSearch.pagedResults;
  if (!paged) {
    throw new Error(`Unexpected GraphQL response shape on page ${pageNumber}`);
  }

  const lots = (paged.results || []).map(item => mapLot(item, host));
  return { lots, totalCount: paged.totalCount || 0 };
}

/**
 * Maps a raw HiBid GraphQL lot object into the scraper's normalized schema.
 * @param {Object} item - raw lot from GraphQL
 * @param {string} host - origin used to build the lot URL
 * @returns {Object}
 */
function mapLot(item, host) {
  const id = String(item.id);
  const state = item.lotState || {};
  const images = Array.isArray(item.pictures)
    ? item.pictures.map(p => p && p.fullSizeLocation).filter(Boolean)
    : [];

  const isClosed = !!state.isClosed;

  return {
    id,
    lotNumber: item.lotNumber != null ? String(item.lotNumber) : '',
    title: item.lead || '',
    description: item.description || '',
    currentPrice: Number(state.highBid || 0),
    minBid: Number(state.minBid || 0),
    bidCount: Number(state.bidCount || 0),
    status: isClosed ? 'Closed' : 'Open',
    endTime: cleanEndTime(state.timeLeftTitle),
    images,
    url: `${host}/lot/${id}`,
    isActive: !isClosed
  };
}

/**
 * Normalizes HiBid's "Internet Bidding closes at: 6/14/2026 5:00:05 PM EST"
 * label into just the date/time portion. Stable across polls (unlike a relative
 * countdown), keeping stored data clean.
 * @param {string} timeLeftTitle
 * @returns {string|null}
 */
function cleanEndTime(timeLeftTitle) {
  if (!timeLeftTitle) return null;
  const cleaned = String(timeLeftTitle).replace(/^.*closes at:\s*/i, '').trim();
  return cleaned || null;
}

/**
 * Closes the active browser session and clears state. Safe to call repeatedly.
 */
async function closeSession() {
  if (session && session.browser) {
    await session.browser.close().catch(() => {});
  }
  session = null;
}

module.exports = {
  parseCatalogUrl,
  runHandshake,
  fetchLotPage,
  closeSession
};
