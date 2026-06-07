require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');

// Ensure export directory exists
const exportDir = path.resolve(process.cwd(), 'export_data');
if (!fs.existsSync(exportDir)) {
  fs.mkdirSync(exportDir);
}

/**
 * Escapes characters for CSV format.
 * @param {string} value - String value
 * @returns {string} - Escaped CSV string
 */
function escapeCsv(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Exports data to CSV
 * @param {Array<Object>} lots - List of lots
 */
function exportToCsv(lots, history) {
  const csvPath = path.join(exportDir, 'lots.csv');
  console.log(`Writing CSV export to ${csvPath}...`);
  
  const headers = [
    'Lot ID', 'Lot Number', 'Title', 'Description', 
    'Current Price', 'Next Min Bid', 'Bid Count', 
    'Status', 'End Time', 'Images', 'Lot URL', 'Last Updated', 'Is Active'
  ];

  const rows = [headers.join(',')];

  for (const lot of lots) {
    const row = [
      escapeCsv(lot.id),
      escapeCsv(lot.lotNumber),
      escapeCsv(lot.title),
      escapeCsv(lot.description),
      lot.currentPrice !== undefined ? lot.currentPrice : '',
      lot.minBid !== undefined ? lot.minBid : '',
      lot.bidCount !== undefined ? lot.bidCount : '',
      escapeCsv(lot.status),
      escapeCsv(lot.endTime),
      escapeCsv(Array.isArray(lot.images) ? lot.images.join('; ') : ''),
      escapeCsv(lot.url),
      escapeCsv(lot.lastUpdated),
      lot.isActive ? 'Yes' : 'No'
    ];
    rows.push(row.join(','));
  }

  fs.writeFileSync(csvPath, rows.join('\n'), 'utf8');
  console.log(`CSV Export completed successfully. Total lines: ${rows.length}`);

  // Export price history to CSV
  const historyCsvPath = path.join(exportDir, 'price_history.csv');
  console.log(`Writing price history CSV export to ${historyCsvPath}...`);
  
  const historyHeaders = ['History ID', 'Lot ID', 'Price', 'Bid Count', 'Timestamp'];
  const historyRows = [historyHeaders.join(',')];

  for (const entry of history) {
    const row = [
      escapeCsv(entry.historyId),
      escapeCsv(entry.lotId),
      entry.price !== undefined && entry.price !== null ? entry.price : '',
      entry.bidCount !== undefined && entry.bidCount !== null ? entry.bidCount : '',
      escapeCsv(entry.timestamp)
    ];
    historyRows.push(row.join(','));
  }

  fs.writeFileSync(historyCsvPath, historyRows.join('\n'), 'utf8');
  console.log(`Price History CSV Export completed successfully. Total lines: ${historyRows.length}`);
}

/**
 * Exports data to JSON
 * @param {Array<Object>} lots - List of lots
 */
function exportToJson(lots, history) {
  const jsonPath = path.join(exportDir, 'lots.json');
  console.log(`Writing JSON export to ${jsonPath}...`);
  fs.writeFileSync(jsonPath, JSON.stringify(lots, null, 2), 'utf8');
  
  const historyJsonPath = path.join(exportDir, 'price_history.json');
  console.log(`Writing price history JSON export to ${historyJsonPath}...`);
  fs.writeFileSync(historyJsonPath, JSON.stringify(history, null, 2), 'utf8');
  
  console.log(`JSON Exports completed successfully.`);
}

/**
 * Exports data to a local SQLite database file
 * @param {Array<Object>} lots - List of lots
 */
function exportToSqlite(lots, history) {
  const sqlitePath = path.join(exportDir, 'lots.db');
  console.log(`Writing SQLite copy to ${sqlitePath}...`);
  
  if (fs.existsSync(sqlitePath)) {
    fs.unlinkSync(sqlitePath); // Delete old copy to write fresh data
  }

  const Database = require('better-sqlite3');
  const tempDb = new Database(sqlitePath);
  
  // Create schema
  tempDb.prepare(`
    CREATE TABLE lots (
      id TEXT PRIMARY KEY,
      lot_number TEXT,
      title TEXT,
      description TEXT,
      current_price REAL,
      min_bid REAL,
      bid_count INTEGER,
      status TEXT,
      end_time TEXT,
      images TEXT, -- JSON string array
      url TEXT,
      last_updated TEXT,
      is_active INTEGER DEFAULT 1
    )
  `).run();

  tempDb.prepare(`
    CREATE TABLE price_history (
      history_id INTEGER PRIMARY KEY AUTOINCREMENT,
      lot_id TEXT,
      price REAL,
      bid_count INTEGER,
      timestamp TEXT
    )
  `).run();

  const insertLot = tempDb.prepare(`
    INSERT INTO lots (id, lot_number, title, description, current_price, min_bid, bid_count, status, end_time, images, url, last_updated, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertHistory = tempDb.prepare(`
    INSERT INTO price_history (lot_id, price, bid_count, timestamp)
    VALUES (?, ?, ?, ?)
  `);

  const transaction = tempDb.transaction((lotsData, historyData) => {
    for (const lot of lotsData) {
      insertLot.run(
        lot.id,
        lot.lotNumber || null,
        lot.title || null,
        lot.description || null,
        lot.currentPrice !== undefined ? lot.currentPrice : null,
        lot.minBid !== undefined ? lot.minBid : null,
        lot.bidCount !== undefined ? lot.bidCount : 0,
        lot.status || 'Open',
        lot.endTime || null,
        JSON.stringify(lot.images || []),
        lot.url || null,
        lot.lastUpdated || null,
        (lot.isActive !== false) ? 1 : 0
      );
    }

    for (const entry of historyData) {
      insertHistory.run(
        entry.lotId,
        entry.price !== undefined ? entry.price : null,
        entry.bidCount !== undefined ? entry.bidCount : 0,
        entry.timestamp || null
      );
    }
  });

  transaction(lots, history);
  tempDb.close();
  console.log(`SQLite database export completed successfully.`);
}

async function runExport() {
  console.log('Fetching latest lot data from database...');
  
  // Initialize connection (Firebase if credentials present, otherwise SQLite)
  db.init();
  
  const lots = await db.getAllLots();
  
  if (lots.length === 0) {
    console.log('No data found in database to export. Run the scraper first.');
    process.exit(0);
  }

  // Fetch price history
  console.log('Fetching price history data from database...');
  let history = [];
  try {
    history = await db.getPriceHistory();
  } catch (err) {
    console.warn('Could not fetch price history (maybe database not initialized):', err.message);
  }

  console.log(`Fetched ${lots.length} lots and ${history.length} history entries. Building export packages...`);
  
  exportToJson(lots, history);
  exportToCsv(lots, history);
  
  // Only attempt SQLite copy if better-sqlite3 is installed (which it is in package.json)
  try {
    exportToSqlite(lots, history);
  } catch (e) {
    console.error('Failed to write SQLite db copy:', e.message);
  }

  console.log(`\n🎉 All exports successfully compiled in folder: ${exportDir}`);
  process.exit(0);
}

// Guard: only run when invoked directly (not when require()'d by other modules)
if (require.main === module) {
  runExport().catch(err => {
    console.error('Critical export error:', err);
    process.exit(1);
  });
}
