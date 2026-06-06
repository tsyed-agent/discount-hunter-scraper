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
function exportToCsv(lots) {
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
}

/**
 * Exports data to JSON
 * @param {Array<Object>} lots - List of lots
 */
function exportToJson(lots) {
  const jsonPath = path.join(exportDir, 'lots.json');
  console.log(`Writing JSON export to ${jsonPath}...`);
  fs.writeFileSync(jsonPath, JSON.stringify(lots, null, 2), 'utf8');
  console.log(`JSON Export completed successfully.`);
}

/**
 * Exports data to a local SQLite database file
 * @param {Array<Object>} lots - List of lots
 */
function exportToSqlite(lots) {
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

  const insert = tempDb.prepare(`
    INSERT INTO lots (id, lot_number, title, description, current_price, min_bid, bid_count, status, end_time, images, url, last_updated, is_active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = tempDb.transaction((lotsData) => {
    for (const lot of lotsData) {
      insert.run(
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
  });

  transaction(lots);
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

  console.log(`Fetched ${lots.length} lots. Building export packages...`);
  
  exportToJson(lots);
  exportToCsv(lots);
  
  // Only attempt SQLite copy if better-sqlite3 is installed (which it is in package.json)
  try {
    exportToSqlite(lots);
  } catch (e) {
    console.error('Failed to write SQLite db copy:', e.message);
  }

  console.log(`\n🎉 All exports successfully compiled in folder: ${exportDir}`);
  process.exit(0);
}

runExport().catch(err => {
  console.error('Critical export error:', err);
  process.exit(1);
});
