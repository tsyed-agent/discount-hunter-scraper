# HiBid Discount Hunters Auction Scraper

An automated, lightweight, and 100% free web scraper designed to crawl weekly Discount Hunters auctions hosted on HiBid.com. 

It runs automatically in the cloud via **GitHub Actions** and saves all lot listings directly to a free **Firebase Firestore** database (no credit card required). You can also run it locally on your laptop to sync to a local SQLite database or export your cloud data to CSV/Excel anytime.

---

## Features

* 🚀 **100% Free Hosting**: Zero runtime cost and zero risk of unexpected billing.
* 🛡️ **Anti-Bot Bypass**: Uses `playwright-extra` + `puppeteer-extra-plugin-stealth` to bypass Cloudflare security.
* 📦 **GraphQL-Based Fetching**: Negotiates the Cloudflare handshake with one stealth browser page, then pulls the entire catalog directly from HiBid's GraphQL API (clean, structured JSON — no fragile HTML parsing).
* 🔄 **Smart Dual-Sync Cycles**: 
  - **Full Sync**: Crawls all pages to parse descriptions, titles, and images.
  - **Price Sync**: Polls only current bids/prices on a fast loop.
* 📊 **Multi-Format Local Export**: Export your cloud listings into **JSON**, **CSV (Excel)**, or **SQLite DB** with a single command.

---

## Directory Structure

```text
├── .github/
│   └── workflows/
│       ├── scraper-full.yml   # Daily full catalog crawl (02:00 UTC)
│       ├── scraper-price.yml  # Price poll every 4 hours
│       └── deploy-rules.yml   # Deploys Firestore rules on change
├── src/
│   ├── db.js               # Database adapter (Firestore & SQLite support)
│   ├── scraper.js          # Playwright stealth handshake + HiBid GraphQL fetcher
│   ├── scheduler.js        # Single-run & local daemon orchestrator
│   ├── export.js           # Cloud data downloader & exporter
│   └── test-local.js       # Local syntax and module validator
├── config.json             # Target auction URL & scraper configuration
├── package.json            # Node.js dependencies
└── README.md               # Documentation
```

---

## Setup Instructions

### 1. Local Dependencies Installation
Open your terminal in the project directory and run:
```bash
npm install
```

### 2. Set Up a Free Firebase Database & Deploy Rules
1. Go to the [Firebase Console](https://console.firebase.google.com/) and click **Create a Project** (select the free Spark Plan, no credit card needed).
2. Once the project is created, click on **Build -> Firestore Database** in the left menu and click **Create Database**.
3. Select your location and choose **Start in test mode** (or configure secure rules).
4. Authenticate the Firebase CLI locally on your machine by running:
   ```bash
   npx firebase login
   ```
5. Deploy the preconfigured Firestore security rules to your Firebase project by running:
   ```bash
   npx firebase deploy --only firestore
   ```
6. Export the Firebase Service Account JSON key from the Firebase Console:
   - Go to **Project Settings** (gear icon next to Project Overview) -> **Service Accounts**.
   - Click **Generate New Private Key** to download a Service Account JSON file.
7. Keep this JSON file safe! Rename it to `firebase-key.json` and place it in your project folder (do not upload it to GitHub as it is already added to `.gitignore`).

---

## How to Run the Scraper

### Mode A: Run in the Cloud (GitHub Actions - Recommended)
This runs the scraper automatically on GitHub's servers for free.

1. Create a GitHub repository and push your project files. Two scheduled workflows live in `.github/workflows/`:
   - `scraper-full.yml` — a **full catalog crawl** once per day (02:00 UTC) that captures every field (title, description, images, prices) and marks ended lots as `Closed`.
   - `scraper-price.yml` — a lighter **price poll** every 4 hours that refreshes current bid, next minimum bid, bid count, and status.
2. Go to your GitHub repository -> **Settings** -> **Secrets and variables** -> **Actions** -> **New repository secret**.
3. Name the secret `FIREBASE_SERVICE_ACCOUNT`.
4. Open the `firebase-key.json` file you downloaded from Firebase, copy its entire text contents, and paste it into the secret value. Click **Add secret**.
5. **How it runs**:
   - The two workflows trigger automatically on their schedules.
   - You can also run either one manually from the **Actions** tab by selecting the workflow and clicking **Run workflow**.
   - Note: GitHub's scheduled runs are best-effort and can be delayed or skipped during peak load, so exact interval timing is not guaranteed.

> **Free-tier quota note:** This auctioneer's weekly catalogs can contain 5,000+ lots. Because change-detection reads each lot once per run, polling too frequently can exceed Firestore's free Spark tier (50,000 reads/day). The default 4-hour price poll keeps a 5,000-lot catalog around ~30,000 reads/day. Increase the interval for larger catalogs, or decrease it only if your catalog is small or you are on a paid plan.

### Mode B: Run Locally on Your Laptop (SQLite/Firestore)
If you want to run the scraper directly on your machine:

1. Create a file named `.env` in the root of the project.
2. Add the path to your Firebase key file:
   ```env
   FIREBASE_SERVICE_ACCOUNT=./firebase-key.json
   ```
3. To run the continuous **Daemon Mode** (which does a full sync, then polls price updates every 60 seconds):
   ```bash
   npm run local
   ```
   *Note: If you omit the `.env` file, the script automatically defaults to storing data in a local SQLite file named `lots.db` in your workspace.*

---

## How to Export Your Data (CSV, SQLite, JSON)

At any time, you can download all lot listings from the Cloud Firestore database and compile them into clean files on your laptop:

1. Ensure your `.env` contains the path to your Firebase key.
2. Run:
   ```bash
   npm run export
   ```
3. The exported files will be saved in the `export_data/` folder:
   - `export_data/lots.csv` (Open in Excel / Google Sheets)
   - `export_data/lots.json` (Structured JSON array)
   - `export_data/lots.db` (Local SQLite database copy)

---

## Weekly Auction Updates

Every Sunday night or Monday morning when the new auction is posted:
1. Copy the new weekly HiBid auction URL (e.g., `https://discounthunters.hibid.com/catalog/747454/-408--returns-and-unclaimed`).
2. Open `config.json` in your repository.
3. Paste the new URL into the `"auctionUrl"` field.
4. Commit and push the `config.json` change to GitHub. The scraper will automatically detect the new URL and start tracking the new lots!

---

## Additional Documentation
* **[Product Requirement Document (PRD)](PRD.md)**: Details the goals, system architecture, database schemas, and constraints.
* **[Handoff Document](handoff.md)**: Contains operational workflows, codebase maps, and troubleshooting guidelines.
