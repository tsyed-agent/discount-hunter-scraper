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

  sqliteDb.prepare(`
    CREATE TABLE IF NOT EXISTS price_history (
      history_id INTEGER PRIMARY KEY AUTOINCREMENT,
      lot_id TEXT,
      price REAL,
      bid_count INTEGER,
      timestamp TEXT,
      FOREIGN KEY(lot_id) REFERENCES lots(id)
    )
  `).run();

  // Create indexes for fast querying
  sqliteDb.prepare(`CREATE INDEX IF NOT EXISTS idx_lots_lot_number ON lots (lot_number)`).run();
  sqliteDb.prepare(`CREATE INDEX IF NOT EXISTS idx_lots_is_active ON lots (is_active)`).run();
  sqliteDb.prepare(`CREATE INDEX IF NOT EXISTS idx_price_history_lot_id ON price_history (lot_id)`).run();

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
    const docSnap = await docRef.get();
    const exists = docSnap.exists;

    let previousPrice = null;
    let previousBidCount = null;
    let previousStatus = null;

    if (exists) {
      const existingData = docSnap.data();
      previousPrice = existingData.currentPrice;
      previousBidCount = existingData.bidCount;
      previousStatus = existingData.status;
    }

    const incomingPrice = lot.currentPrice !== undefined ? lot.currentPrice : null;
    const incomingBidCount = lot.bidCount !== undefined ? lot.bidCount : 0;
    const incomingStatus = lot.status || 'Open';

    const priceChanged = incomingPrice !== previousPrice;
    const bidCountChanged = incomingBidCount !== previousBidCount;
    const statusChanged = incomingStatus !== previousStatus;

    const hasHistoryChanged = !exists || priceChanged || bidCountChanged;
    const shouldUpdateLot = isFullSync || !exists || priceChanged || bidCountChanged || statusChanged;

    if (shouldUpdateLot || hasHistoryChanged) {
      const batch = firestoreDb.batch();

      if (shouldUpdateLot) {
        if (isFullSync) {
          batch.set(docRef, {
            id: lot.id,
            lotNumber: lot.lotNumber || null,
            title: lot.title || null,
            description: lot.description || null,
            currentPrice: incomingPrice,
            minBid: lot.minBid !== undefined ? lot.minBid : null,
            bidCount: incomingBidCount,
            status: incomingStatus,
            endTime: lot.endTime || null,
            images: lot.images || [],
            url: lot.url || null,
            lastUpdated: now,
            isActive: lot.isActive !== undefined ? lot.isActive : true
          }, { merge: true });
        } else {
          batch.set(docRef, {
            currentPrice: incomingPrice,
            minBid: lot.minBid !== undefined ? lot.minBid : null,
            bidCount: incomingBidCount,
            status: incomingStatus,
            lastUpdated: now
          }, { merge: true });
        }
      }

      if (hasHistoryChanged) {
        const historyRef = firestoreDb.collection('price_history').doc();
        batch.set(historyRef, {
          historyId: historyRef.id,
          lotId: lot.id,
          price: incomingPrice,
          bidCount: incomingBidCount,
          timestamp: now
        });
      }

      await batch.commit();
      if (hasHistoryChanged) {
        console.log(`[Firestore] Added price history for lot ${lot.id}. Price: ${incomingPrice}, Bids: ${incomingBidCount}`);
      }
    }
  } else {
    // SQLite mode
    const existingRow = sqliteDb.prepare('SELECT current_price, bid_count, status FROM lots WHERE id = ?').get(lot.id);
    const exists = !!existingRow;

    let previousPrice = null;
    let previousBidCount = null;
    let previousStatus = null;

    if (exists) {
      previousPrice = existingRow.current_price;
      previousBidCount = existingRow.bid_count;
      previousStatus = existingRow.status;
    }

    const incomingPrice = lot.currentPrice !== undefined ? lot.currentPrice : null;
    const incomingBidCount = lot.bidCount !== undefined ? lot.bidCount : 0;
    const incomingStatus = lot.status || 'Open';

    const priceChanged = incomingPrice !== previousPrice;
    const bidCountChanged = incomingBidCount !== previousBidCount;
    const statusChanged = incomingStatus !== previousStatus;

    const hasHistoryChanged = !exists || priceChanged || bidCountChanged;
    const shouldUpdateLot = isFullSync || !exists || priceChanged || bidCountChanged || statusChanged;

    if (shouldUpdateLot || hasHistoryChanged) {
      const runTransaction = sqliteDb.transaction(() => {
        if (shouldUpdateLot) {
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
              incomingPrice,
              lot.minBid !== undefined ? lot.minBid : null,
              incomingBidCount,
              incomingStatus,
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
              incomingPrice,
              lot.minBid !== undefined ? lot.minBid : null,
              incomingBidCount,
              incomingStatus,
              now,
              lot.id
            );
          }
        }

        if (hasHistoryChanged) {
          const histStmt = sqliteDb.prepare(`
            INSERT INTO price_history (lot_id, price, bid_count, timestamp)
            VALUES (?, ?, ?, ?)
          `);
          histStmt.run(lot.id, incomingPrice, incomingBidCount, now);
        }
      });

      runTransaction();
      if (hasHistoryChanged) {
        console.log(`[SQLite] Added price history for lot ${lot.id}. Price: ${incomingPrice}, Bids: ${incomingBidCount}`);
      }
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
      id: row.id,
      lotNumber: row.lot_number,
      title: row.title,
      description: row.description,
      currentPrice: row.current_price,
      minBid: row.min_bid,
      bidCount: row.bid_count,
      status: row.status,
      endTime: row.end_time,
      images: row.images ? JSON.parse(row.images) : [],
      url: row.url,
      lastUpdated: row.last_updated,
      isActive: row.is_active === 1
    }));
  }
}

/**
 * Gets all price history records in the database.
 * @returns {Array} - Array of price history records.
 */
async function getPriceHistory() {
  if (dbType === 'firestore') {
    const snapshot = await firestoreDb.collection('price_history').get();
    const history = [];
    snapshot.forEach(doc => {
      history.push(doc.data());
    });
    return history;
  } else {
    const rows = sqliteDb.prepare('SELECT * FROM price_history').all();
    return rows.map(row => ({
      historyId: row.history_id,
      lotId: row.lot_id,
      price: row.price,
      bidCount: row.bid_count,
      timestamp: row.timestamp
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
  getPriceHistory,
  syncActiveStatus,
  getDbType: () => dbType,
  getSqliteDb: () => sqliteDb,
  getFirestoreDb: () => firestoreDb
};
