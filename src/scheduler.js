require('dotenv').config();
const fs = require('fs');
const path = require('path');
const config = require('../config.json');
const db = require('./db');
const scraper = require('./scraper');

const JITTER_MS = config.requestJitterMs || 200;
const CONCURRENCY_LIMIT = config.maxConcurrentRequests || 5;

// Sleep helper
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Helper for running promises in batches with a concurrency limit
async function runBatched(tasks, limit) {
  const results = [];
  const executing = [];
  
  for (const task of tasks) {
    const p = Promise.resolve().then(() => task());
    results.push(p);
    
    if (limit <= tasks.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= limit) {
        await Promise.race(executing);
      }
    }
  }
  
  return Promise.all(results);
}

/**
 * Performs a complete crawl of all pages in the auction catalog.
 */
async function performFullCrawl() {
  console.log(`[Full Crawl] Starting crawl for: ${config.auctionUrl}`);
  
  // 1. Get total pages
  let totalPages = 1;
  try {
    totalPages = await scraper.getTotalPages(config.auctionUrl);
  } catch (error) {
    console.error('[Full Crawl] Failed during initial page count fetch:', error.message);
    throw error;
  }

  console.log(`[Full Crawl] Total pages to crawl: ${totalPages}`);

  const allActiveIds = [];
  const pageTasks = [];

  // Create page scraping tasks
  for (let page = 1; page <= totalPages; page++) {
    pageTasks.push(async () => {
      // Add brief randomized delay (jitter) before launching the request to behave naturally
      await sleep(Math.random() * JITTER_MS);
      
      try {
        const lots = await scraper.fetchCatalogPage(page);
        console.log(`[Full Crawl] Page ${page} scraped. Found ${lots.length} lots.`);
        
        // Save lots to database
        for (const lot of lots) {
          await db.saveLot(lot, true); // true = Full Sync
          allActiveIds.push(lot.id);
        }
      } catch (error) {
        if (error.message === 'SESSION_EXPIRED') {
          console.warn('[Full Crawl] Session expired. Renewing handshake...');
          await scraper.runHandshake(config.auctionUrl);
          // Retry page
          const lots = await scraper.fetchCatalogPage(page);
          for (const lot of lots) {
            await db.saveLot(lot, true);
            allActiveIds.push(lot.id);
          }
        } else {
          console.error(`[Full Crawl] Failed to scrape page ${page}:`, error.message);
        }
      }
    });
  }

  // Run page tasks concurrently in batches
  await runBatched(pageTasks, CONCURRENCY_LIMIT);
  
  console.log(`[Full Crawl] Database sync complete. Processing active status...`);
  
  // Mark stale lots as closed
  await db.syncActiveStatus(allActiveIds);
  
  console.log(`[Full Crawl] Complete. Synced ${allActiveIds.length} active lots.`);
  return allActiveIds;
}

/**
 * Performs a fast polling update of pricing/bidding fields only.
 * @param {Array<string>} activeIds - List of active lot IDs to poll
 */
async function performPricePoll(activeIds) {
  if (activeIds.length === 0) {
    console.log('[Price Poll] No active lots found to poll.');
    return;
  }
  
  console.log(`[Price Poll] Polling prices for ${activeIds.length} lots...`);
  
  try {
    const updates = await scraper.fetchPricesOnly(activeIds);
    let updateCount = 0;
    
    for (const update of updates) {
      // Pricing sync (false = Price/Bids update only)
      await db.saveLot(update, false);
      updateCount++;
    }
    
    console.log(`[Price Poll] Successfully updated ${updateCount} lots.`);
  } catch (error) {
    if (error.message === 'SESSION_EXPIRED') {
      console.warn('[Price Poll] Session expired. Renewing handshake...');
      await scraper.runHandshake(config.auctionUrl);
      // Retry poll
      const updates = await scraper.fetchPricesOnly(activeIds);
      for (const update of updates) {
        await db.saveLot(update, false);
      }
    } else {
      console.error('[Price Poll] Pricing updates failed:', error.message);
    }
  }
}

/**
 * Main Orchestration Loop
 */
async function main() {
  // Initialize Database
  db.init();

  const isLocalDaemon = process.env.NODE_ENV === 'local' || process.argv.includes('--daemon');
  
  if (!isLocalDaemon) {
    // Single Run Mode (GitHub Actions standard workflow)
    console.log('Running in Single Run Mode (GitHub Actions)...');
    try {
      await performFullCrawl();
      console.log('Single sync run completed successfully.');
      process.exit(0);
    } catch (error) {
      console.error('Critical scraper error occurred during single run:', error);
      process.exit(1);
    }
  } else {
    // Daemon Mode (Local running loop)
    console.log('Running in continuous Daemon Mode...');
    
    // 1. Initial full crawl
    let activeIds = [];
    try {
      activeIds = await performFullCrawl();
    } catch (e) {
      console.error('Initial crawl failed, starting loop anyway:', e.message);
    }

    const pollIntervalMs = (config.pricePollIntervalSeconds || 60) * 1000;
    const fullCrawlIntervalMs = 3 * 60 * 60 * 1000; // Recrawl full details every 3 hours
    
    let lastFullCrawl = Date.now();
    
    // Continuous loop
    while (true) {
      await sleep(pollIntervalMs);
      
      const now = Date.now();
      
      // Determine if it is time to perform another full crawl
      if (now - lastFullCrawl >= fullCrawlIntervalMs) {
        try {
          activeIds = await performFullCrawl();
          lastFullCrawl = now;
        } catch (e) {
          console.error('[Daemon] Periodic full crawl failed. Will retry next interval.', e.message);
        }
      } else {
        // Otherwise, run pricing poll only
        try {
          await performPricePoll(activeIds);
        } catch (e) {
          console.error('[Daemon] Pricing poll failed:', e.message);
        }
      }
    }
  }
}

// Start Scraper
main().catch(error => {
  console.error('Scraper process exited with critical error:', error);
  process.exit(1);
});
