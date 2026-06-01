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
- **Transactions** — full expense log with search and category filter
- **Forecasting** — projected end-of-period balance, daily burn rates, monthly spend history
- **Wishlist** — items with affordability tracking against your budget categories
- **Settings** — configure income, pay day, add/remove categories, export/import data

## Budget reset schedule
- Resets automatically on your configured pay day each month
- **Early pay**: tap "Early" on the dashboard → enter actual pay date → resets immediately
- **Late pay**: tap "Hold" → budget won't auto-reset until you unhold it

## Data sync
Export a `.json` backup from Settings and email/AirDrop it to your other device. Import and choose "Replace" to sync.
