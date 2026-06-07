# Project Handoff Document — HiBid Auction Scraper

This document outlines the operational structure, files map, execution workflows, and maintenance guidelines for the HiBid Auction Scraper.

---

## 1. File Summary & Architecture Map

Here is the functional description of the core files in this project:

- **`config.json`**
  - **Purpose**: Configuration file for the scraper target URL and concurrency.
  - **Weekly Action**: Update the `auctionUrl` here every Sunday/Monday when the new auction is listed.
- **`src/db.js`**
  - **Purpose**: Database adapter supporting dual modes.
  - **Behavior**:
    - **Firestore**: Triggered when `FIREBASE_SERVICE_ACCOUNT` is present in the environment (e.g. GitHub secrets or `.env`).
    - **SQLite**: Local fallback (`lots.db`) if no Firebase credentials are found.
  - **Optimization**: Inserts into the `price_history` database tables only when a price change is detected.
- **`src/scraper.js`**
  - **Purpose**: Playwright stealth engine and HTTP fetcher.
  - **Behavior**: Launches a headless browser, hits the main auction page to solve Cloudflare checks and fetch session parameters, then makes fast API queries to crawl pages.
- **`src/scheduler.js`**
  - **Purpose**: Main orchestrator.
  - **Behavior**: Decides between a daemon run (local `npm run local` which loops price checks every 60 seconds) and a single run (GitHub Actions `npm start`).
- **`src/export.js`**
  - **Purpose**: Data extractor.
  - **Behavior**: Fetches current lots and price histories from the active database and generates CSV, JSON, and SQLite copy files in `export_data/`.
- **`src/test-local.js`**
  - **Purpose**: Development helper script to verify syntax, config loading, and database schemas.
- **`.github/workflows/scraper.yml`**
  - **Purpose**: Scheduled hourly workflow file for GitHub Actions.

---

## 2. Daily Operations & Workflows

### 2.1. Weekly Config Update (Every Sunday/Monday)
To scrape the new auction:
1. Retrieve the new weekly HiBid auction link (e.g., `https://discounthunters.hibid.com/catalog/747454/-408--returns-and-unclaimed`).
2. Open `config.json` and change the `"auctionUrl"` value.
3. Commit and push the file:
   ```bash
   git add config.json
   git commit -m "Update target auction URL for new week"
   git push origin main
   ```
4. The GitHub Actions cloud scheduler will automatically start parsing the new auction catalog on its next run.

### 2.2. Running a Local Price Daemon
If you want to track prices in real-time on your laptop:
1. Ensure your `.env` contains:
   ```env
   FIREBASE_SERVICE_ACCOUNT=./firebase-key.json
   ```
   *(Or omit `.env` to scrape into a local `lots.db` file).*
2. Execute:
   ```bash
   npm run local
   ```
3. Keep the terminal window open; the script will perform a full sync and then run a price check every 60 seconds.

### 2.3. Downloading and Exporting Data
To download all listing and price history records from the cloud to CSV/JSON files:
1. Verify the `.env` file points to your Firebase key.
2. Run:
   ```bash
   npm run export
   ```
3. Inspect `export_data/lots.csv` and `export_data/price_history.csv` using Excel or Google Sheets.

---

## 3. Deployment Checklists

### 3.1. Firebase Configuration
1. Initialize the Firebase project in your browser.
2. Run `npx firebase login` in your terminal to link it.
3. Deploy preconfigured rules: `npx firebase deploy --only firestore`.
4. Export the Service Account JSON and save it securely (do not push to git!).

### 3.2. GitHub Actions Secrets
1. Go to repository **Settings -> Secrets and variables -> Actions**.
2. Click **New repository secret**.
3. Name: `FIREBASE_SERVICE_ACCOUNT`.
4. Value: Paste the *entire* raw JSON contents of your downloaded Firebase key file.

---

## 4. Troubleshooting Guidelines

### Playwright Anti-Bot / Handshake Failures
- **Symptom**: Scraper fails at step `runHandshake` with timeout or Cloudflare blocking errors.
- **Solution**: Cloudflare sometimes flags specific IP ranges (like some cloud hosting regions). Because GitHub Actions uses public cloud IP pools, a run might occasionally get flagged. The scheduler will automatically retry. If the problem persists, trigger a manual run in the GitHub Action tab to get a runner on a clean IP block.

### Firebase Firestore write limits
- **Symptom**: Reached Firestore write quota limit (20,000 writes/day).
- **Solution**: Check if you have multiple scraper instances running, or if you decreased the price poll interval too low. The default hourly sync (GitHub Actions) combined with change-detection rules is optimized to use less than 3,000 writes per day for a standard 1,000-lot catalog.
