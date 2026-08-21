# Finesse — Personal Finance App

A PWA-ready personal finance tracker with expense logging, budget management, wishlist affordability tracking, and forecasting.

## Getting started

### Run locally (dev)
```bash
npm install
npm run dev
```
Open http://localhost:5173

### Build for production
```bash
npm run build
```
Deploy the `dist/` folder to any static host (Netlify, Vercel, your Plesk server).

### Install as PWA on iPhone
1. Open the deployed URL in Safari
2. Tap the Share button → "Add to Home Screen"
3. It will appear as a full-screen app icon

## Features
- **Dashboard** — income overview, category budgets with progress bars, recent transactions
- **Transactions** — full expense log with search, filters and receipt photos
- **Forecasting** — projected end-of-period balance, daily burn rates, net worth over time
- **Looking Back** — where the money went over 3–24 months, and whether subscriptions have crept up
- **Goals** — savings pots and debts, with interest modelled and payoff strategies compared
- **Wishlist** — items with affordability tracking against your budget categories
- **Settings** — income, categories, privacy, encryption, storage, and import/export

## Getting your data in and out
- **Import a bank statement** — Settings or Transactions → Import CSV. Confirm which
  column is which, review every row with its category and duplicate status, then commit.
  Already-logged rows are detected and skipped, so re-importing an overlapping
  statement is safe. If your export has a balance column, Finesse checks its own
  figure against it.
- **Export a backup** — opens the share sheet where supported, so the file can go
  straight to Files, iCloud or another device. Receipt photos aren't included;
  the app tells you how many it left behind.

## Keeping your data safe
Everything lives in one browser. Three things protect it:
- **Persistent storage** (Settings → Storage) asks the browser not to evict the
  database. Without it, browsers may clear app data to reclaim space.
- **Regular backups.** The bell nags if it has been a month.
- **Encryption** (Settings → Encryption), which is off until you turn it on.

Settings → Privacy adds a screen cover for the app switcher and an optional PIN.
Neither encrypts anything — they are a curtain, not a safe.

### Encryption
Turning it on scrambles every row with a key that only exists while the app is
unlocked. Amounts, notes, category names, merchants, dates and receipt photos
all become unreadable without your PIN or passphrase. Worth knowing before you
switch it on:

- **There is no way back in without your secret.** No server holds a copy and no
  reset link exists. You get a recovery code when you turn it on — write it down
  somewhere that isn't the phone.
- **A four-digit PIN is not much of a key.** Ten thousand possibilities falls
  quickly to anyone who copies the database off the device and attacks it at
  leisure. A passphrase of a few words takes longer than anyone will try. The app
  shows you the difference in real terms as you type.
- **A little structure stays readable.** The database has to find rows without
  opening them, so row counts and which account or category a row belongs to
  remain visible in raw storage. No amounts, names, notes, dates or photos do.
  Settings lists exactly which fields those are.
- **Backup files are not encrypted.** The export is plain JSON so it can be
  restored anywhere — keep it somewhere you'd be happy putting a bank statement.

## Budget reset schedule
- Resets automatically on your configured pay day each month
- **Early pay**: tap "Early" on the dashboard → enter actual pay date → resets immediately
- **Late pay**: tap "Hold" → budget won't auto-reset until you unhold it

## Data sync
Export a `.json` backup from Settings and email/AirDrop it to your other device. Import and choose "Replace" to sync.
