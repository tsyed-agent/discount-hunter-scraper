const fs = require('fs');
const path = require('path');

let dbType = 'sqlite'; // Default to SQLite
let sqliteDb = null;
let firestoreDb = null;

// Initialize the database connection
function init() {
  const serviceAccountEnv = process.env.FIREBASE_SERVICE_ACCOUNT;
  const isLocalEnv = process.env.NODE_ENV === 'local';

  if (serviceAccountEnv && !isLocalEnv) {
    try {
      console.log('Initializing Firebase Firestore database adapter...');
      const admin = require('firebase-admin');

      let serviceAccount;
      if (fs.existsSync(serviceAccountEnv)) {
        // It's a file path
        serviceAccount = require(path.resolve(serviceAccountEnv));
      } else {
        // It's a raw JSON string
        serviceAccount = JSON.parse(serviceAccountEnv);
      }

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });

      firestoreDb = admin.firestore();
      dbType = 'firestore';
      console.log('Firebase Firestore initialized successfully.');
    } catch (error) {
      console.error('Failed to initialize Firebase Firestore, falling back to SQLite:', error);
      initSqlite();
    }
  } else {
    initSqlite();
  }
}

function initSqlite() {
  console.log('Initializing SQLite database adapter...');
  const Database = require('better-sqlite3');
  const dbPath = path.resolve(process.cwd(), 'lots.db');
  
  sqliteDb = new Database(dbPath);
  sqliteDb.pragma('journal_mode = WAL'); // Performance optimization
  
  // Create schema
  sqliteDb.prepare(`
    CREATE TABLE IF NOT EXISTS lots (
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

  // Create indexes for fast querying
  sqliteDb.prepare(`CREATE INDEX IF NOT EXISTS idx_lots_lot_number ON lots (lot_number)`).run();
  sqliteDb.prepare(`CREATE INDEX IF NOT EXISTS idx_lots_is_active ON lots (is_active)`).run();

  dbType = 'sqlite';
  console.log(`SQLite initialized successfully at ${dbPath}`);
}

/**
 * Saves or updates a lot.
 * @param {Object} lot - The lot object to save.
 * @param {boolean} isFullSync - Whether to perform a full update of all fields.
 */
async function saveLot(lot, isFullSync = true) {
  if (!lot.id) {
    throw new Error('Lot ID is required to save');
  }

  const now = new Date().toISOString();

  if (dbType === 'firestore') {
    const docRef = firestoreDb.collection('lots').doc(lot.id);
    
    if (isFullSync) {
      // Full sync: write all fields
      await docRef.set({
        id: lot.id,
        lotNumber: lot.lotNumber || null,
        title: lot.title || null,
        description: lot.description || null,
        currentPrice: lot.currentPrice !== undefined ? lot.currentPrice : null,
        minBid: lot.minBid !== undefined ? lot.minBid : null,
        bidCount: lot.bidCount !== undefined ? lot.bidCount : 0,
        status: lot.status || 'Open',
        endTime: lot.endTime || null,
        images: lot.images || [],
        url: lot.url || null,
        lastUpdated: now,
        isActive: lot.isActive !== undefined ? lot.isActive : true
      }, { merge: true });
    } else {
      // Pricing-only update: only update mutable pricing/bidding fields
      await docRef.set({
        currentPrice: lot.currentPrice !== undefined ? lot.currentPrice : null,
        minBid: lot.minBid !== undefined ? lot.minBid : null,
        bidCount: lot.bidCount !== undefined ? lot.bidCount : 0,
        status: lot.status || 'Open',
        lastUpdated: now
      }, { merge: true });
    }
  } else {
    // SQLite mode
    if (isFullSync) {
      const stmt = sqliteDb.prepare(`
        INSERT INTO lots (id, lot_number, title, description, current_price, min_bid, bid_count, status, end_time, images, url, last_updated, is_active)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          lot_number = excluded.lot_number,
          title = excluded.title,
          description = excluded.description,
          current_price = excluded.current_price,
          min_bid = excluded.min_bid,
          bid_count = excluded.bid_count,
          status = excluded.status,
          end_time = excluded.end_time,
          images = excluded.images,
          url = excluded.url,
          last_updated = excluded.last_updated,
          is_active = excluded.is_active
      `);
      
      stmt.run(
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
        now,
        (lot.isActive !== false) ? 1 : 0
      );
    } else {
      // Pricing-only sync
      const stmt = sqliteDb.prepare(`
        UPDATE lots SET
          current_price = ?,
          min_bid = ?,
          bid_count = ?,
          status = ?,
          last_updated = ?
        WHERE id = ?
      `);
      stmt.run(
        lot.currentPrice !== undefined ? lot.currentPrice : null,
        lot.minBid !== undefined ? lot.minBid : null,
        lot.bidCount !== undefined ? lot.bidCount : 0,
        lot.status || 'Open',
        now,
        lot.id
      );
    }
  }
}

/**
 * Gets all lots in the database.
 * @returns {Array} - Array of lots.
 */
async function getAllLots() {
  if (dbType === 'firestore') {
    const snapshot = await firestoreDb.collection('lots').get();
    const lots = [];
    snapshot.forEach(doc => {
      lots.push(doc.data());
    });
    return lots;
  } else {
    const rows = sqliteDb.prepare('SELECT * FROM lots').all();
    return rows.map(row => ({
      ...row,
      images: row.images ? JSON.parse(row.images) : [],
      isActive: row.is_active === 1
    }));
  }
}

/**
 * Marks lots not in the active list as inactive
 * @param {Array<string>} activeIds - List of active lot IDs from the current crawl
 */
async function syncActiveStatus(activeIds) {
  if (activeIds.length === 0) return;

  if (dbType === 'firestore') {
    // Batch updates for Firestore
    const batch = firestoreDb.batch();
    const snapshot = await firestoreDb.collection('lots').where('isActive', '==', true).get();
    
    let count = 0;
    snapshot.forEach(doc => {
      if (!activeIds.includes(doc.id)) {
        batch.update(doc.ref, { isActive: false, status: 'Closed' });
        count++;
      }
    });

    if (count > 0) {
      await batch.commit();
      console.log(`Deactivated ${count} stale lots in Firestore.`);
    }
  } else {
    // SQLite
    const placeholders = activeIds.map(() => '?').join(',');
    const stmt = sqliteDb.prepare(`
      UPDATE lots SET is_active = 0, status = 'Closed' 
      WHERE is_active = 1 AND id NOT IN (${placeholders})
    `);
    const info = stmt.run(...activeIds);
    if (info.changes > 0) {
      console.log(`Deactivated ${info.changes} stale lots in SQLite.`);
    }
  }
}

module.exports = {
  init,
  saveLot,
  getAllLots,
  syncActiveStatus,
  getDbType: () => dbType,
  getSqliteDb: () => sqliteDb,
  getFirestoreDb: () => firestoreDb
};
