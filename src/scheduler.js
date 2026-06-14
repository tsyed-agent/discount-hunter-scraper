require('dotenv').config();
const config = require('../config.json');
const db = require('./db');
const scraper = require('./scraper');

const PAGE_LENGTH = config.pageLength || 100;
const INTER_PAGE_DELAY_MS = config.interPageDelayMs != null ? config.interPageDelayMs : 250;

// Sleep helper
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Core crawl helper — shared by full sync and price poll
// ---------------------------------------------------------------------------

/**
 * Pages through the entire auction catalog via HiBid's GraphQL API and saves
 * every lot. Assumes runHandshake() has already been called.
 *
 * @param {boolean} isFullSync
 *   true  → upserts all fields (title, images, description, prices …)
 *   false → updates price/bid/status fields only (skips static fields)
 * @returns {{ activeIds: Array<string>, totalSaved: number, totalCount: number }}
 */
async function crawlAllPages(isFullSync) {
  const label = isFullSync ? 'Full Crawl' : 'Price Poll';

  const activeIds = [];
  let pageNumber = 1;
  let totalCount = null;
  let totalSaved = 0;

  while (true) {
    let pageResult;
    try {
      pageResult = await scraper.fetchLotPage(pageNumber, PAGE_LENGTH);
    } catch (err) {
      if (err.message === 'SESSION_EXPIRED') {
        console.warn(`[${label}] Session expired on page ${pageNumber} — renewing handshake…`);
        await scraper.closeSession();
        await scraper.runHandshake(config.auctionUrl);
        pageResult = await scraper.fetchLotPage(pageNumber, PAGE_LENGTH);
      } else {
        throw err;
      }
    }

    const { lots, totalCount: tc } = pageResult;
    if (totalCount === null) {
      totalCount = tc;
      const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_LENGTH));
      console.log(`[${label}] Catalog reports ${totalCount} lot(s) across ~${totalPages} page(s).`);
    }

    if (lots.length === 0) break;

    for (const lot of lots) {
      await db.saveLot(lot, isFullSync);
      if (isFullSync) activeIds.push(lot.id);
      totalSaved++;
    }
    console.log(`[${label}] Page ${pageNumber}: saved ${lots.length} lot(s) (${totalSaved}/${totalCount}).`);

    if (totalSaved >= totalCount) break;
    pageNumber++;

    // Safety valve so a misbehaving API can never loop forever.
    if (pageNumber > 1000) {
      console.warn(`[${label}] Page limit (1000) reached — stopping.`);
      break;
    }

    if (INTER_PAGE_DELAY_MS > 0) await sleep(INTER_PAGE_DELAY_MS);
  }

  console.log(`[${label}] Crawl complete — ${totalSaved} lot(s) processed.`);
  return { activeIds, totalSaved, totalCount: totalCount || 0 };
}

// ---------------------------------------------------------------------------
// High-level operations
// ---------------------------------------------------------------------------

/**
 * Full sync: scrapes all catalog pages and upserts every field for every lot.
 * Marks lots that disappeared from the catalog as inactive.
 *
 * Throws if zero lots were captured — this surfaces a broken scrape instead of
 * silently reporting success (e.g. expired auction URL or changed API).
 */
async function performFullCrawl() {
  console.log(`[Full Crawl] Starting — ${config.auctionUrl}`);

  await scraper.runHandshake(config.auctionUrl);
  const { activeIds, totalSaved } = await crawlAllPages(true);

  if (totalSaved === 0) {
    throw new Error(
      'Full crawl captured 0 lots. The auction URL may be expired/invalid or HiBid changed its API. ' +
      'Update config.json "auctionUrl" to the current auction.'
    );
  }

  console.log(`[Full Crawl] Syncing active status for ${activeIds.length} lots…`);
  await db.syncActiveStatus(activeIds);

  console.log(`[Full Crawl] Complete. ${activeIds.length} active lots.`);
  return activeIds;
}

/**
 * Price poll: updates currentPrice, minBid, bidCount, and status for every lot.
 * Static fields (title, images, description) are left untouched. A new
 * price_history record is written only when price or bid count changed.
 */
async function performPricePoll() {
  console.log('[Price Poll] Starting…');

  await scraper.runHandshake(config.auctionUrl);
  const { totalSaved } = await crawlAllPages(false);

  if (totalSaved === 0) {
    throw new Error('Price poll captured 0 lots. The auction URL may be expired/invalid.');
  }

  console.log('[Price Poll] Complete.');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  db.init();

  const isLocalDaemon = process.env.NODE_ENV === 'local' || process.argv.includes('--daemon');

  if (!isLocalDaemon) {
    // -----------------------------------------------------------------------
    // Single-run mode (GitHub Actions)
    // SYNC_MODE=full  → full catalog crawl  (run daily)
    // SYNC_MODE=price → price poll only      (run on a coarser schedule)
    // -----------------------------------------------------------------------
    const syncMode = (process.env.SYNC_MODE || 'full').toLowerCase();
    console.log(`Running in Single-Run Mode — SYNC_MODE=${syncMode}`);

    try {
      if (syncMode === 'price') {
        await performPricePoll();
      } else {
        await performFullCrawl();
      }
      console.log('Single sync run completed successfully.');
      await scraper.closeSession();
      process.exit(0);
    } catch (error) {
      console.error('Critical scraper error during single run:', error.message);
      await scraper.closeSession();
      process.exit(1);
    }
  } else {
    // -----------------------------------------------------------------------
    // Daemon mode (local: npm run local)
    // Initial full crawl → then alternates between price polls (every
    // pricePollIntervalSeconds) and periodic full re-crawls (every 3 h).
    // The browser session is kept open and reused across cycles.
    // -----------------------------------------------------------------------
    console.log('Running in Daemon Mode…');

    try {
      await performFullCrawl();
    } catch (e) {
      console.error('[Daemon] Initial full crawl failed — starting poll loop anyway:', e.message);
    }

    const pollMs = (config.pricePollIntervalSeconds || 60) * 1000;
    const fullCrawlMs = 3 * 60 * 60 * 1000; // re-do full sync every 3 h
    let lastFullCrawl = Date.now();

    while (true) {
      await sleep(pollMs);

      if (Date.now() - lastFullCrawl >= fullCrawlMs) {
        try {
          await performFullCrawl();
          lastFullCrawl = Date.now();
        } catch (e) {
          console.error('[Daemon] Periodic full crawl failed — will retry next interval:', e.message);
        }
      } else {
        try {
          await performPricePoll();
        } catch (e) {
          console.error('[Daemon] Price poll failed:', e.message);
        }
      }
    }
  }
}

// Guard: only auto-start when invoked directly (not when require()'d by tests)
if (require.main === module) {
  main().catch(async error => {
    console.error('Scraper process exited with critical error:', error);
    await scraper.closeSession();
    process.exit(1);
  });
}

module.exports = { performFullCrawl, performPricePoll };
