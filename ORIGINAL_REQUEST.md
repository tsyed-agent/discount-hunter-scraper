# Original User Request

## Initial Request — 2026-06-06T16:54:14-04:00

An automated, resilient web scraper for weekly Discount Hunters auctions (hosted on HiBid.com) that extracts all lot details, structures active pricing, logs a time-series history of price/bid changes, and runs on a free cloud schedule (GitHub Actions) syncing to Firebase Firestore with a local SQLite copy.

Working directory: /Users/talha/Documents/code/Discount-hunter Scraper
Integrity mode: development

## Requirements

### R1. Dynamic Scraper Engine
- Extract lot details (Lot number, Title, Description, Bidding End Time, Image URLs, Lot URL)
- Pull pricing/bidding details (Current Price, Min Bid, Bid Count, Bidding Status) on a fast polling loop (e.g., 60 seconds).
- Session Handshake: Use Playwright stealth browser to handle Cloudflare challenges, extract session headers/cookies, and perform lightweight API fetches.
- Build on top of the existing scripts in the workspace.

### R2. Dual-Database Storage & Time-Series History
- Support saving current lot states to Firebase Firestore (cloud) and local SQLite (`lots.db`).
- Maintain a historic log of price changes (`price_history` table/collection) containing (History ID, Lot ID, Price, Bid Count, Timestamp).
- Implement optimization logic: only write history entries when the price or bid count changes to stay within free database write limits.

### R3. Cloud Compute & Scheduling
- Deploy the scraper on GitHub Actions scheduled via cron (e.g., hourly for full runs, manual trigger option).
- Include local daemon option for 60-second price polling.
- Read credentials via the `FIREBASE_SERVICE_ACCOUNT` environment variable/secret.

### R4. Project Initialization & Git/Firebase CLI Setup
- Initialize Git locally in the working directory.
- Create a public GitHub repository named `discount-hunter-scraper` on the user's account using the `gh` CLI and push the codebase to it.
- Pre-configure Firebase files (`firebase.json`, `.firebaserc`, and `firestore.rules`) locally using the Firebase CLI template standard.
- Create a clear, step-by-step setup guide in `README.md` explaining how the user can:
  1. Install/use the Firebase CLI locally to log in (`npx firebase login`) and deploy the preconfigured Firestore security rules (`npx firebase deploy --only firestore`).
  2. Export the Firebase Service Account JSON key from the Google Cloud/Firebase console.
  3. Add the Firebase Service Account JSON credential as a Repository Secret named `FIREBASE_SERVICE_ACCOUNT` in the GitHub repository (critical: do not commit this credential directly to the code since the repository is public).

### R5. Safety & Cleanup
- All code, packages, and local databases must remain strictly isolated inside the working directory.
- Any packages used must be standard, secure packages listed in `package.json`. No global system packages or modifications are permitted.
- The verifier/auditor agent must inspect the code to ensure safety and confirm that deleting the working directory will completely remove all project footprint from the device.

## Acceptance Criteria

### Data Extraction Accuracy
- [ ] Scraper extracts 100% of lots from a given HiBid catalog URL.
- [ ] Data points (Lot number, Title, Description, Prices, Bid Count) match the values displayed on the website.

### Price History & Database Logic
- [ ] New lots are inserted successfully; existing lots are updated.
- [ ] A new entry is written to `price_history` if and only if `current_price` or `bid_count` has changed since the last check.

### Local & Cloud Verification
- [ ] Running the local test suite completes successfully.
- [ ] The GitHub Actions workflow file (`scraper.yml`) is correctly structured to run on a schedule and injects the Firebase credentials.
