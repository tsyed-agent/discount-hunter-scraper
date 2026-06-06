# Project: Discount-hunter Scraper

## Architecture
The application consists of a web scraper that fetches auction items (lots) from HiBid.com and stores them in a dual-database environment (local SQLite and Firebase Firestore).

- **Scraper Engine (`src/scraper.js`)**: Executes the stealth Playwright browser handshake to bypass Cloudflare, then makes direct API fetches to crawl pages.
- **Database Adapter (`src/db.js`)**: Manages connections and operations on SQLite (`lots.db`) and Cloud Firestore (`lots` and `price_history` collections/tables).
- **Scheduler (`src/scheduler.js`)**: Runs in two modes:
  - Single Run: crawls all pages and exits (for GitHub Actions).
  - Daemon Mode: crawls all pages once, then polls for price/bid changes every 60 seconds (for local background run).
- **Export Utility (`src/export.js`)**: Downloads the entire active state from the database and compiles it into CSV, JSON, and SQLite database file copies.
- **CI/CD (`.github/workflows/scraper.yml`)**: Schedules and runs the scraper in GitHub Actions.

## Code Layout
- `src/db.js` - Database connections, schema definitions, and CRUD functions.
- `src/scraper.js` - Playwright stealth handshake and parser logic.
- `src/scheduler.js` - Crawler orchestrator and daemon loop.
- `src/export.js` - Data exporter.
- `config.json` - Target URL and scraping configurations.
- `.github/workflows/scraper.yml` - GitHub Actions CI configuration.
- `firebase.json`, `.firebaserc`, `firestore.rules` - Firebase configuration and security rules.

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|--------------|--------|
| 1 | Git & Firebase Init | Initialize Git, create GitHub repository via `gh` CLI, create `.gitignore`, configure `firebase.json`, `.firebaserc`, and `firestore.rules`. | None | DONE |
| 2 | Dual-DB & History | Add `price_history` schema/collection; implement optimization logic in `src/db.js` and integrate with `src/scheduler.js`. | M1 | DONE |
| 3 | Actions & Daemon | Configure `.github/workflows/scraper.yml` with Cron schedule and credentials. Verify local daemon mode. | M2 | DONE |
| 4 | README & Documentation | Create clear setup instructions in `README.md` for Firebase CLI and secrets configuration. | M3 | IN_PROGRESS (Conv: 069db06e-5504-4976-bdb7-9b5c60005a87) |
| 5 | E2E & Local Verification | Verify full scraper runs, SQLite/Firestore sync, and exports work properly. | M4 | PLANNED |
| 6 | Forensic Audit | Run Forensic Auditor to guarantee codebase integrity and absolute directory isolation. | M5 | PLANNED |

## Interface Contracts
### `src/db.js`
- `init()`: Detects `FIREBASE_SERVICE_ACCOUNT` env variable and initialized Firestore, else falls back to local SQLite.
- `saveLot(lot, isFullSync)`: Saves/updates the lot. In SQLite/Firestore:
  - Compares the incoming lot's `currentPrice` and `bidCount` with the existing entry.
  - If they differ or if it is a new lot, inserts a new record into `price_history`.
- `getAllLots()`: Retrieves all lots.
- `syncActiveStatus(activeIds)`: Marks any lots not in the `activeIds` list as inactive (`isActive = false`, `status = 'Closed'`).
- SQLite schemas:
  - `lots`: fields `id`, `lot_number`, `title`, `description`, `current_price`, `min_bid`, `bid_count`, `status`, `end_time`, `images`, `url`, `last_updated`, `is_active`.
  - `price_history`: fields `history_id` (INTEGER PRIMARY KEY AUTOINCREMENT), `lot_id` (TEXT), `price` (REAL), `bid_count` (INTEGER), `timestamp` (TEXT).
- Firestore schemas:
  - `lots/{lotId}`: fields `id`, `lotNumber`, `title`, `description`, `currentPrice`, `minBid`, `bidCount`, `status`, `endTime`, `images`, `url`, `lastUpdated`, `isActive`.
  - `price_history/{historyId}`: fields `historyId`, `lotId`, `price`, `bidCount`, `timestamp`.
