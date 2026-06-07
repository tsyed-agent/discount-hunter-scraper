require('dotenv').config();
const config = require('../config.json');
const db = require('./db');
const scraper = require('./scraper');

const JITTER_MS = config.requestJitterMs || 200;
const CONCURRENCY_LIMIT = config.maxConcurrentRequests || 5;

// Sleep helper
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Runs an array of async task-factories concurrently, capped at `limit`
 * in-flight at a time. Uses a Set + .finally() so that failed tasks are
 * always removed from the tracking set (prevents stall after errors).
 *
 * Returns Promise.allSettled so one failed page never aborts the whole crawl.
 *
 * @param {Array<() => Promise>} tasks
 * @param {number} limit
 */
async function runBatched(tasks, limit) {
  const results = [];
  const executing = new Set();

  for (const task of tasks) {
    const p = (async () => task())();
    results.push(p);

    if (tasks.length > limit) {
      // Track in-flight count; clean up on both resolve and reject
      const e = p.finally(() => executing.delete(e));
      executing.add(e);

      if (executing.size >= limit) {
        await Promise.race(executing);
      }
    }
  }

  return Promise.allSettled(results);
}

// ---------------------------------------------------------------------------
// Core crawl helper — shared by full sync and price-poll fallback
// ---------------------------------------------------------------------------

/**
 * Crawls every page of the catalog concurrently.
 * Assumes runHandshake() has already been called (session is active).
 *
 * @param {boolean} isFullSync
 *   true  → upserts all fields (title, images, description, prices …)
 *   false → updates price/bid fields only (skips static fields in DB)
 * @returns {Array<string>} allActiveIds  (populated only when isFullSync=true)
 */
async function crawlAllPages(isFullSync) {
  const label = isFullSync ? 'Full Crawl' : 'Price Scan';

  let totalPages;
  try {
    totalPages = await scraper.getTotalPages();
  } catch (err) {
    console.error(`[${label}] Failed to determine page count:`, err.message);
    throw err;
  }

  console.log(`[${label}] Crawling ${totalPages} page(s) with concurrency=${CONCURRENCY_LIMIT}.`);

  const allActiveIds = [];

  const pageTasks = Array.from({ length: totalPages }, (_, i) => {
    const page = i + 1;
    return async () => {
      // Small random jitter so bursts look organic
      await sleep(Math.random() * JITTER_MS);

      let lots;
      try {
        lots = await scraper.fetchCatalogPage(page);
      } catch (err) {
        if (err.message === 'SESSION_EXPIRED') {
          console.warn(`[${label}] Session expired on page ${page} — renewing handshake…`);
          try {
            await scraper.runHandshake(config.auctionUrl);
            lots = await scraper.fetchCatalogPage(page);
          } catch (retryErr) {
            console.error(`[${label}] Page ${page} failed after session renewal:`, retryErr.message);
            return; // skip this page — don't crash the whole crawl
          }
        } else {
          console.error(`[${label}] Page ${page} error:`, err.message);
          return;
        }
      }

      console.log(`[${label}] Page ${page}: ${lots.length} lots.`);

      for (const lot of lots) {
        await db.saveLot(lot, isFullSync);
        if (isFullSync) allActiveIds.push(lot.id);
      }
    };
  });

  await runBatched(pageTasks, CONCURRENCY_LIMIT);
  console.log(`[${label}] Page scan complete.`);
  return allActiveIds;
}

// ---------------------------------------------------------------------------
// High-level operations
// ---------------------------------------------------------------------------

/**
 * Full sync: scrapes all catalog pages and upserts every field for every lot.
 * Also marks lots that disappeared from the catalog as inactive.
 * Should run once per day (or on manual trigger).
 */
async function performFullCrawl() {
  console.log(`[Full Crawl] Starting — ${config.auctionUrl}`);

  await scraper.runHandshake(config.auctionUrl);
  const allActiveIds = await crawlAllPages(true);

  console.log(`[Full Crawl] Syncing active status for ${allActiveIds.length} lots…`);
  await db.syncActiveStatus(allActiveIds);

  console.log(`[Full Crawl] Complete. ${allActiveIds.length} active lots.`);
  return allActiveIds;
}

/**
 * Price poll: updates currentPrice, minBid, bidCount, and status for every lot.
 * Static fields (title, images, description) are left untouched.
 *
 * Strategy 1 — fast path: hit HiBid's status API (single HTTP call for all lots).
 * Strategy 2 — page-scan fallback: re-crawl all pages with isFullSync=false.
 *   This is safe for catalogs of any size since it uses the same concurrency
 *   pool and change-detection logic as the full crawl.
 */
async function performPricePoll() {
  console.log('[Price Poll] Starting…');

  await scraper.runHandshake(config.auctionUrl);

  // --- Strategy 1: single-shot API ---
  try {
    const updates = await scraper.tryFetchPricesFromApi();
    let saved = 0;
    for (const update of updates) {
      if (update.id) {
        await db.saveLot(update, false);
        saved++;
      }
    }
    console.log(`[Price Poll] API path complete — ${saved} lots updated.`);
    return;
  } catch (apiErr) {
    // 404, empty response, or status API not available for this account
    console.warn('[Price Poll] Status API unavailable, falling back to page scan:', apiErr.message);
  }

  // --- Strategy 2: paginated fallback (handles any catalog size) ---
  await crawlAllPages(false);
  console.log('[Price Poll] Page-scan path complete.');
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
    // SYNC_MODE=price → price poll only      (run hourly)
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
      process.exit(0);
    } catch (error) {
      console.error('Critical scraper error during single run:', error);
      process.exit(1);
    }
  } else {
    // -----------------------------------------------------------------------
    // Daemon mode (local: npm run local)
    // Initial full crawl → then alternates between price polls (every
    // pricePollIntervalSeconds) and periodic full re-crawls (every 3 h).
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
  main().catch(error => {
    console.error('Scraper process exited with critical error:', error);
    process.exit(1);
  });
}
