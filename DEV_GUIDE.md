# Finesse — Developer Guide

A personal finance PWA built with React + Vite + Dexie.js. All data lives in the browser's IndexedDB — no backend, no accounts, no network required.

---

## Stack

| Layer | Library | Version | Purpose |
|---|---|---|---|
| Framework | React | 19 | UI |
| Build | Vite | 8 | Dev server, production bundler |
| CSS | Tailwind CSS | 4 | Utility classes (used sparingly) |
| Database | Dexie.js | 4 | IndexedDB wrapper |
| DB hooks | dexie-react-hooks | 4 | `useLiveQuery` reactive queries |
| Charts | Recharts | 3 | Forecasting visualisations |
| Icons | lucide-react | 1 | Icon set |
| Dates | date-fns | 4 | Date arithmetic |

---

## Commands

```bash
npm install       # install dependencies
npm run dev       # dev server at http://localhost:5173
npm run build     # production build → dist/
npm run preview   # preview the production build locally
npm run lint      # ESLint
```

---

## Project Structure

```
src/
├── main.jsx              # React entry point
├── App.jsx               # Root component: nav, routing, modal state, auto-reset logic
├── db.js                 # Dexie schema + all database helpers
├── vault.js              # Encryption key: Argon2id derivation, wrapping, recovery codes
├── dbCrypto.js           # Dexie DBCore middleware that seals/opens rows
├── utils.js              # Pure functions: scheduling, forecasting, formatting
├── index.css             # All styling. Above the app-specific marker it is SHARED
│                         #   verbatim with Finesse Fit — see DESIGN_SYSTEM.md
├── theme/                # SHARED — appearance model + OKLCH palette generator
│
├── views/
│   ├── Dashboard.jsx     # Safe-to-spend, income summary, category bars, recent transactions
│   ├── Accounts.jsx      # Multiple accounts, transfers, income events
│   ├── Activity.jsx      # Tab bar over the three below
│   │   ├── Transactions.jsx  # Full expense log with search, filters and tags
│   │   ├── Calendar.jsx      # Paydays, subscriptions and logged spend by day
│   │   └── Subscriptions.jsx # Recurring expenses and management links
│   ├── Insights.jsx      # Tab bar over the two below
│   │   ├── Forecasting.jsx   # Cash flow, balance history, projections, burn rates
│   │   └── Review.jsx        # "Looking Back" — the long retrospective
│   ├── GoalsWishlist.jsx # Tab bar over the two below
│   │   ├── Goals.jsx         # Savings pots and debts
│   │   └── Wishlist.jsx      # Wishlist items with affordability tracking
│   ├── CategoryDetail.jsx # One category: cycle stats, merchants, its transactions
│   └── Settings.jsx      # Theme, reminders, rules, variables, export/import, integrity
│
├── hooks/
│   └── useFinesseData.js # Every useLiveQuery call, called once by App.jsx
├── components/
│   ├── modals/           # Modal dialogs split by domain, re-exported via index.js
│   ├── ui.jsx            # Modal shell, IconButton, Field, CardTitle, Tabs
│   ├── EncryptionSettings.jsx  # A Settings card, not a view
│   ├── VariablesSettings.jsx   # Likewise — named values for allowance formulas
│   ├── useDialog.jsx     # Promise-based confirm / alert / prompt
│   └── Toast.jsx         # Transient confirmations with an optional Undo
└── __tests__/            # Vitest suites for utils.js and db.js
```

> Six of these appear in the `NAV` sidebar: Dashboard, Accounts, Activity,
> Insights, Goals & Wishlist and Settings. The indented files are panels those
> pages render as tabs — they are ordinary view components, just not
> destinations of their own. `CategoryDetail` is the remaining exception: it's
> reached by tapping a category on the Dashboard rather than from the nav.
>
> Old page ids (`transactions`, `calendar`, `subscriptions`, `forecasting`,
> `review`, `wishlist`, `variables`) still work as navigation targets —
> `VIEW_ALIASES` in `App.jsx` maps each onto its page and tab.

---

## Data Layer (`src/db.js`)

### Schema

The Dexie database is named `FinanceApp`, schema version 9.

| Table | Key | Indexed fields | Description |
|---|---|---|---|
| `accounts` | `++id` | — | Each account: name, balance, colour |
| `accountTransfers` | `++id` | `fromAccountId`, `toAccountId` | Money moved between accounts |
| `settings` | `++id` | `accountId` | One row per account: schedule, reset state, lock |
| `categories` | `++id` | `accountId` | Expense categories with allowance + spent |
| `transactions` | `++id` | `accountId`, `categoryId`, `&subscriptionRunKey` | Individual logged expenses |
| `incomes` | `++id` | `accountId` | Recurring income sources |
| `incomeEvents` | `++id` | `accountId`, `&receiptKey` | Income actually received |
| `subscriptions` | `++id` | `accountId`, `categoryId` | Recurring expenses |
| `wishlist` | `++id` | `accountId` | Wishlist items |
| `wishlistCategories` | `++id` | `accountId` | Wishlist item categories |
| `variables` | `++id` | `accountId` | Named values for allowance formulas |
| `rules` | `++id` | `accountId` | Auto-categorisation rules |
| `templates` | `++id` | `accountId` | Saved quick-log transactions |
| `goals` | `++id` | `accountId` | Savings pots and debts |
| `vault` | `++id` | — | Wrapped encryption key. Never encrypted |

Indexes are deliberately sparse. An indexed field can't be encrypted, so v9
dropped every index nothing actually queried — see "Encryption" below before
adding one.

### Settings shape

```js
{
  id: 1,                          // auto-incremented, always 1 (singleton)
  income: 2500,                   // monthly income in GBP
  payDayOfMonth: 25,              // 1–31
  lastReset: "2026-05-25T...",    // ISO string, set on each budget reset
  fastForwardDate: null,          // ISO string if user got paid early; cleared after use
  holdActive: false,              // true if user has paused auto-reset
}
```

### Category shape

```js
{
  id: 1,
  name: "Groceries",
  allowance: 300,                 // monthly allowance in GBP
  spent: 142.50,                  // current period spend; reset to 0 on budget reset
  color: "#4fffb0",               // hex colour for UI
}
```

### Transaction shape

```js
{
  id: 1,
  categoryId: 2,                  // FK → categories.id
  amount: 45.00,
  note: "Aldi shop",              // optional
  date: "2026-06-01T14:22:00Z",  // ISO string
}
```

### Wishlist item shape

```js
{
  id: 1,
  name: "New trainers",
  price: 120.00,
  note: "Nike Air Max",           // optional
  wishlistCategoryId: 3,          // FK → wishlistCategories.id, optional
  categoryIds: [1, 2],            // FK[] → categories.id (for affordability check)
}
```

### Important: spent counter

`categories.spent` is a **derived counter**, not computed from transactions on the fly. When a transaction is added or deleted, the helper functions in `db.js` update `spent` directly on the category. This means:

- Adding a transaction → `category.spent += amount`
- Deleting a transaction → `category.spent -= amount` (floored at 0)
- Budget reset → `category.spent = 0` for all categories

Transactions are never deleted on reset — they are retained for historical charts.

### Schema migrations

If you need to add a field or table, increment the version:

```js
db.version(2).stores({
  settings: '++id',
  categories: '++id, name',
  transactions: '++id, categoryId, date',
  wishlist: '++id, name',
  wishlistCategories: '++id, name',
  // new table:
  incomeHistory: '++id, date',
}).upgrade(tx => {
  // optional data migration
});
```

Dexie handles the upgrade automatically on next open. Keep all previous `version()` calls in the file.

---

## Encryption (`src/vault.js`, `src/dbCrypto.js`)

Opt-in per device, from Settings → Encryption. Off by default; a database that
never turns it on pays nothing for it existing.

### How it fits together

```
secret ──Argon2id──▶ KEK ──unwraps──▶ master ──HKDF──┬─▶ rowKey   (AES-GCM, row cipher)
                                                     └─▶ indexKey (HMAC, blinded indexes)
recovery code ──Argon2id──▶ KEK ──unwraps──▶ the same master
```

The master is random and wrapped twice, never derived from the secret. That is
what makes a PIN change instant — only the wrap is rewritten — and what lets a
recovery code open the same data.

`dbCrypto.js` installs a DBCore middleware with `db.use()`. It hooks `mutate`,
`get`, `getMany`, `query` and `openCursor`; a sealed row keeps its primary key
and indexed fields in the clear and carries the rest as `__d` (ciphertext),
`__n` (nonce) and `__b` (per-field sealed binaries).

### Rules for anyone touching it

1. **Nothing on the row path may be async.** IndexedDB transactions commit when
   the microtask queue drains, so an `await` inside `mutate`/`openCursor` kills
   the transaction. This is why the cipher is `@noble/ciphers` rather than
   `crypto.subtle`, and why receipts are stored as bytes rather than Blobs.
2. **The clear-field set is read from the schema**, not maintained by hand. Add
   an index and it becomes readable without the key — that is the trade.
3. **Migrations are batched and resumable.** Unsealed rows read through
   untouched, so a half-migrated database still works. `vault.sealedAt` records
   completion; `resumeSealing()` finishes an interrupted pass at the next unlock.
4. **`params` on `enableEncryption` is for tests only.** Argon2id at the shipped
   cost is ~1s per derivation.

### Testing it

`src/__tests__/encryption.test.js` opens a second, middleware-free Dexie
connection to the same database and asserts on the bytes actually stored.
Anything checked only through the app's own reads would pass even if sealing
did nothing.

---

## Scheduling Logic (`src/utils.js`)

### How the reset schedule works

The core function is `calcNextScheduledReset(payDayOfMonth, fromDate)`. It returns the next date on which `payDayOfMonth` occurs, starting from `fromDate`. If today *is* the pay day, it returns next month's occurrence (i.e. the reset triggers today and the next one is a month away).

**Fast-forward** (paid early): The user provides their actual pay date. `handleFastForward` in `App.jsx` calls `resetBudget()` immediately and writes `lastReset` to that date. No `fastForwardDate` is persisted — the reset happens at the moment the user confirms.

**Hold** (paid late): `holdActive: true` is written to settings. The auto-reset `useEffect` in `App.jsx` skips the check entirely when `holdActive` is true. The dashboard shows a "HELD" badge on the next reset date. The user manually untaps Hold when they receive pay, which triggers a normal reset check on the next app open.

**Auto-reset trigger**: On every app load (and whenever `settings` changes via `useLiveQuery`), `App.jsx` runs a `useEffect` that:

1. Computes `effectiveReset` (the date the reset should have happened)
2. Compares it against `lastReset`
3. If `effectiveReset` is in the past and after `lastReset`, calls `resetBudget()` and updates `lastReset`

This means resets only trigger when the app is opened — there is no background timer or service worker handling it.

### Forecasting functions

All forecasting is stateless and pure — they take `categories` and `settings` as arguments and return numbers.

| Function | What it returns |
|---|---|
| `getDailyBurnRate(categories, settings)` | `{ [categoryId]: £/day }` based on `spent / daysElapsed` |
| `getProjectedSpend(categories, settings)` | `{ [categoryId]: £ }` projected to end of period at current burn rate |
| `projectedEndBalance(categories, settings)` | `income - totalProjectedSpend` |
| `wishlistAffordability(item, categories, settings)` | `{ canAffordNow, daysUntil, shortfall, combinedLeftover }` |
| `buildMonthlyHistory(transactions, categories)` | Array of `{ month, [catName]: £ }` for the last 6 months |

`daysElapsed` is calculated from `settings.lastReset` to now. If `lastReset` is not set, burn rate functions return empty objects and forecasting charts will be blank.

---

## Reactive Data Flow

All database reads in `App.jsx` use `useLiveQuery` from `dexie-react-hooks`. This means any write to IndexedDB (from anywhere — modal, settings view, etc.) automatically re-renders the relevant components without any manual state management.

```
User action → db helper (db.js) → Dexie writes IndexedDB
                                         ↓
                              useLiveQuery detects change
                                         ↓
                              App.jsx re-renders with new data
                                         ↓
                              Views receive updated props
```

Views are pure in the sense that they receive data as props and call callbacks for mutations — they do not read from the DB directly, except `Settings.jsx` which reads from props passed down from `App.jsx`.

---

## Design System

**Shared with Finesse Fit, byte for byte.** The full reference is
[DESIGN_SYSTEM.md](DESIGN_SYSTEM.md); this is the orientation.

`src/index.css` is one stylesheet in two halves. Everything above the
`FINESSE — app-specific` marker is identical to the same region of
`finesse-fit/src/index.css`; everything below it is the calendar, the statement
importer, the command palette and the rest of this app's own furniture — built
from the same tokens.

Seven token layers on `<html>`, each driven by one `data-*` attribute that
`src/theme/appearance.js` writes:

| Layer | Attribute | Decides |
|---|---|---|
| Structure | — | `--radius-*`, `--gap*`, `--control-h`, motion timings |
| Palette | `data-palette` | `--bg` + `--accent`, `--accent-2/3/4`, `--on-accent` |
| Mode | `data-theme` | `--surface*`, `--line*`, `--text-*`, `--good/warn/danger/info` |
| Surface | `data-surface` | `--card-bg`, `--card-border`, `--card-shadow`, `--card-blur` |
| Contrast | `data-contrast` | Stronger lines and text over whatever else is set |
| Density | `data-density` | `--density-scale`, which spacing and control sizes derive from |
| Shape/type | `data-corners`, `data-text`, `data-motion` | `--radius-scale`, root font size, animation |

The old `--glass-*` and `--accent-mint/blue/purple/warm` variables are gone.
Surfaces are `color-mix()`ed from `--bg`, so each palette's tint carries through
the whole app rather than stopping at the buttons.

### The liquid glass look is now a setting

`islands` (solid cards on a plain page, the default), `glass` (translucent over a
palette-built gradient mesh — this app's original aesthetic) and `outline` (flat,
no shadow). One `.card` rule reads five tokens; each finish writes them, and
nothing else in the app knows which is active.

**Under Glass a card carries a `backdrop-filter`, which makes it the containing
block for `position: fixed` descendants.** Anything positioned by script goes
through `Portal` from `ui.jsx`.

### Palettes

Twelve curated (`tide` — this app's original mint-and-sky — plus `mint`,
`aurora`, `cobalt`, `evergreen`, `ember`, `marigold`, `oxide`, `rose`, `sakura`,
`neon`, `graphite`) and **Custom**, which `src/theme/custom.js` builds in OKLCH
from a hue, a harmony, an intensity and a background tint. The choice is stored
per account, so a personal and a business budget can look different.

### The classes worth knowing

| Class | Purpose |
|---|---|
| `.card` / `.card-raised` / `.panel` | Surfaces; a card inside a card renders flat |
| `.btn-primary` / `-secondary` / `-danger` / `-quiet` / `-ghost` / `.btn-icon` | Buttons |
| `.input`, `.field`, `.form-grid` | Form controls and their labels |
| `.stack` / `.row` / `.split` / `.grid-auto` / `.layout-split` / `.pair` | Layout primitives |
| `.list` / `.list-row` / `.list-main` / `.list-trail` | Repeating records |
| `.stat-grid` / `.stat` / `.metric` / `.summary-value` | Numbers |
| `.progress-track` / `.progress-fill` / `.segments` | Bars, including stacked shares |
| `.status-good/-warn/-danger/-info`, `.badge`, `.chip` | Status and filters |
| `.page-head` / `.page-title` / `.eyebrow` / `.card-title` | Page and card headings |
| `.tab-bar` / `.tab-pill` | The tab strip on a consolidated page |
| `.banner` (+ `.info/.good/.warn/.danger`) | An inline message attached to its subject |
| `.empty-state` | Never a bare "No data" |
| `.modal-overlay` / `.modal-box` / `.modal-body` / `.modal-footer` | Dialogs |
| `.table-wrap` / `.table` | The statement review step — the one genuinely tabular screen |
| `.mobile-*` | Legacy responsive helpers; prefer the layout primitives above |

Tailwind is available but used sparingly — prefer the semantic classes, which are
the only things the appearance settings can reach.

---

## Responsive Layout

`AppShell` (shared with Finesse Fit) draws a persistent 248px rail on a desktop
and a floating bottom tab bar on a phone — not a drawer. A navigation you have to
summon costs a tap before every move and hides how many places there are to go.
The tab bar takes at most five slots (below ~64px a target stops being reliably
hittable with a thumb); anything past that goes to a "More" sheet.

Four breakpoints, each with one job: **1100px** two-column pages fold to one;
**860px** the rail becomes the tab bar and dialogs become sheets; **700px**
inline content rows stack; **430px** the narrowest phone in use.

---

## Export / Import Format

The JSON backup is a flat snapshot of all five tables:

```json
{
  "version": 1,
  "exportedAt": "2026-06-01T...",
  "settings": [ { ...settingsRow } ],
  "categories": [ { ...categoryRow }, ... ],
  "transactions": [ { ...txRow }, ... ],
  "wishlist": [ { ...wishlistRow }, ... ],
  "wishlistCategories": [ { ...catRow }, ... ]
}
```

On import, `id` fields are stripped before `bulkAdd` so Dexie assigns fresh auto-increment IDs, preventing collisions. **Replace** mode clears all tables first. **Merge** mode does not — it appends, which can create duplicate categories if they share a name.

---

## Deployment

The `dist/` folder after `npm run build` is a fully static site. Drop it anywhere:

- **Plesk** — upload `dist/` contents to a subdomain's document root
- **Netlify / Vercel** — connect the repo, set build command to `npm run build` and publish directory to `dist`
- **GitHub Pages** — set `base: '/repo-name/'` in `vite.config.js` first

### PWA installation (iPhone)

1. Open the deployed URL in **Safari** (not Chrome — iOS only allows Add to Home Screen from Safari)
2. Tap the Share icon → "Add to Home Screen"
3. The app opens fullscreen with no browser chrome

The `<meta name="apple-mobile-web-app-capable">` tag in `index.html` enables this.

---

## Known Limitations & Future Work

**Auto-reset only triggers on app open.** If the app isn't opened on pay day, the reset fires the next time it is opened. A service worker with a periodic background sync could fix this, but it requires HTTPS and a slightly more complex setup.

**Hold state requires manual release.** When the user gets paid (after a hold), they need to open the app and tap "Unhold". There's no automatic release mechanism.

**Merge import can create duplicates.** If you import the same backup twice in merge mode, you'll get duplicate categories and transactions. Replace mode is safe to use for syncing between devices.

**No currency selection.** The app is hardcoded to GBP (£). To change: update `fmt()` and `fmtShort()` in `utils.js`.

**A short PIN can't protect an encrypted database from an offline attack.** Ten
thousand possibilities falls in seconds to someone holding a copy of the
storage, and Argon2id raises the cost without changing the conclusion. The app
says so where the secret is chosen; a passphrase is the only real answer. A
platform-backed keystore with hardware attempt limiting would be the proper
fix, and no such thing is available to a PWA.

**Wishlist multi-period affordability is approximate.** For items costing more than one period's combined allowance, the `periodsNeeded` estimate assumes a flat 30-day period. It doesn't account for variable month lengths.