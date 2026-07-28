# CLAUDE.md — Finesse Finance App

This file gives AI assistants the context needed to work effectively on this codebase. Read it before making any changes.

---

## What this project is

A personal finance PWA (Progressive Web App) for a single user. It runs entirely in the browser — no backend, no authentication, no network calls at runtime. Data lives in IndexedDB via Dexie.js. The app is deployed as a static site and installed on iPhone via Safari's "Add to Home Screen".

**Do not add a backend, database server, or authentication system.** The local-first architecture is intentional.

---

## Tech stack

- **React 19** with Vite 8
- **Dexie 4** + **dexie-react-hooks** for IndexedDB
- **Tailwind CSS 4** (via `@tailwindcss/vite` plugin — no `tailwind.config.js` needed)
- **Recharts 3** for charts
- **lucide-react** for icons
- **date-fns 4** for date arithmetic

---

## Project structure

```
src/
├── App.jsx               # Root: routing, modal state, auto-reset orchestration, all handlers
├── db.js                 # Dexie schema + every database helper function
├── utils.js              # Pure functions only — cycles, scheduling, forecasting, formatting
├── index.css             # All styling: CSS variables, glass classes, component styles
├── hooks/
│   └── useFinesseData.js # Every useLiveQuery call, in one place. Called only by App.jsx
├── views/                # One file per page/tab, lazy-loaded from App.jsx
│   ├── Dashboard.jsx
│   ├── Accounts.jsx
│   ├── Transactions.jsx
│   ├── PurchaseCheck.jsx     # "Can I Purchase It"
│   ├── Calendar.jsx
│   ├── Subscriptions.jsx
│   ├── Forecasting.jsx
│   ├── Wishlist.jsx
│   ├── Variables.jsx
│   └── Settings.jsx
├── components/
│   ├── QuickAdd.jsx      # Floating "log an expense" button (mobile)
│   ├── CommandPalette.jsx # ⌘K: jump to a view, run an action, find a transaction
│   ├── modals/           # Modal dialogs, split by domain
│   │   ├── index.js      #   barrel — import modals from here, never the files directly
│   │   ├── shared.jsx    #   IncomeAllocationEditor, FormulaInput, ColourPicker, PALETTE…
│   │   ├── transaction.jsx, category.jsx, income.jsx, subscription.jsx,
│   │   └── wishlist.jsx, data.jsx, budget.jsx
│   ├── CategorySelect.jsx, DateInput.jsx  # custom accessible form controls
│   ├── ui.jsx            # Modal shell (focus trap), IconButton, Field, CardTitle
│   ├── useDialog.jsx     # Promise-based confirm / alert / prompt
│   └── Toast.jsx         # Transient confirmations with an optional Undo action
└── __tests__/            # Vitest: utils.test.js (pure) + db.test.js (fake-indexeddb)
```

`scripts/smoke.mjs` (`npm run smoke`) drives a real browser through the core
flow against a running preview build. Unit tests can't catch a broken lazy
import or a crashing view; that can.

---

## Architecture rules

### Data flow

All database reads happen in `hooks/useFinesseData.js`, which `App.jsx` calls once. Data is passed down to views as props. Views call prop callbacks for mutations — they do not import from `db.js` directly. The one exception is `deleteTransaction` and `deleteWishlistItem`, which are passed directly as callbacks since they take only an ID.

```
useFinesseData (useLiveQuery) → App.jsx → props → views → callbacks → db.js → IndexedDB
                                                                          ↓
                                                        useLiveQuery re-renders automatically
```

Do not add `useLiveQuery` calls inside views. New live reads go in `useFinesseData.js` and reach views as props. Every query there must be scoped by `accountId` — `accounts` and `accountTransfers` are the only deliberate exceptions.

### Database helpers

All DB operations live in `db.js`. When adding a new operation:

1. Write a named async function (not a method on `db`)
2. Export it
3. Import it in `App.jsx`

The `categories.spent` field is a **counter maintained by the helpers**, not derived from transactions at query time. `addTransaction` increments it, `deleteTransaction` decrements it, `resetBudget` zeros it. Do not recompute it by scanning transactions — keep this pattern.

### Pure utils

`utils.js` contains only pure functions. No Dexie imports, no React hooks, no side effects. If you need a new calculation, add it here as a named export.

### Budget cycles — use `getCategoryCycle`

A category's spend counter is reset by whichever **income** funds it, not by the
account-wide `settings` schedule. `getCategoryCycle(category, incomes, settings)`
returns `{ start, end, freq, days, elapsed, remaining }` and is the single
source of truth. Anything that needs "this period" — burn rate, projections,
upcoming subscription cost, wishlist timing, safe-to-spend — must go through it.

Reaching for `settings.payDayOfMonth` or `settings.lastReset` directly is almost
always a bug: it silently assumes one monthly income.

### Two denominations — don't mix them

Money in Finesse comes in two units, and adding them together is meaningless:

- **Per cycle** — `category.allowance`, `spent`, `income.amount`. A category
  funded by a weekly wage holds a *weekly* allowance. Correct for "what's left
  to spend right now".
- **Normalised** — `getNormalisedIncomeTotal`, `getNormalisedCategoryAllowance`,
  `getNormalisedAllowanceTotal`. Required whenever income is compared against
  budget, or figures from different pay frequencies are summed.

`getUnallocatedIncomeTotal(incomes, categories)` computes free income per source
rather than subtracting two mixed-unit totals — use it for any "spare money" pool.

### Transaction direction — use `getSignedAmount`

`transactions.amount` is **always stored positive**; `transactions.type`
(`'expense'` | `'refund'`) carries the direction. A refund reduces its
category's spend and credits the account.

Anything that totals transactions must go through `getSignedAmount(tx)`, or
refunds get counted as spend. This applies to filtered totals, monthly history,
cumulative overspend, CSV export and counter rebuilds.

Splits are N ordinary transactions sharing a `splitGroupId` — not a parent row
with children — so every existing query, filter and reset handles them with no
special-casing, and a single part can be edited or deleted on its own.

### Goals are earmarks, not transfers

Contributing to a goal doesn't move money between accounts — it marks some of
what you already have as spoken for. That stops goals double-counting against
transactions, and leaves `account.balance` as the single truth about how much
money exists. `autoContributeGoals` is idempotent per pay date, because the
reset path can fire more than once as live queries settle.

### Rollover

Opt-in per category. At a *full* reset the unspent remainder becomes
`rolloverBalance`, which `getEffectiveAllowance` adds to what's spendable.
Three fields, three behaviours at reset: `allowance` untouched,
`temporaryBoost` cleared, `rolloverBalance` created.

A category funded by several incomes resets piecemeal, so by the final reset
`spent` only holds the remainder. `cycleClearedSpend` accumulates what earlier
partial resets wiped, and `getRolloverForNextCycle` adds it back — without it,
rollover over-credits multi-income categories.

### Schema changes

If you change the Dexie schema, increment the version number and add a new `db.version(N).stores({...})` call. Do not modify the existing `version(1)` call. See DEV_GUIDE.md for the migration pattern.

---

## Styling rules

The design system is **liquid glass** — dark deep-blue background, frosted panels, radial gradient mesh. All design tokens are CSS custom properties in `index.css`.

- Use the semantic glass classes (`.glass`, `.btn-primary`, `.glass-input`, etc.) rather than Tailwind utilities for component styles
- Inline styles are acceptable and used throughout — this is intentional for a single-developer project
- Do not add new CSS files — put styles in `index.css`
- Do not change the colour palette or font stack without a good reason; the aesthetic is deliberate
- Fonts: **DM Serif Display** for headings (`.font-display`), **DM Sans** for body

Key CSS variables:
```css
--good: #4fffb0     /* green / mint */
--warn: #fbbf70     /* amber */
--danger: #ff6b8a   /* red */
--accent-mint, --accent-blue, --accent-purple, --accent-warm
--text-primary, --text-secondary, --text-muted
```

---

## Adding a new view

1. Create `src/views/MyView.jsx` — accept data as props, emit mutations via callbacks
2. Add an entry to the `NAV` array in `App.jsx`
3. Add the query to `hooks/useFinesseData.js` if new data is needed, and pass it down from `App.jsx`
4. Add a `{view === 'myview' && <MyView ... />}` render branch in `App.jsx`

---

## Adding a new modal

1. Add the modal component to the matching file in `src/components/modals/` as a named export (or a new file if it's a new domain)
2. Re-export it from `src/components/modals/index.js`
3. Add a new string value to the `modal` state in `App.jsx` (e.g. `'myModal'`)
4. Add `{modal === 'myModal' && <MyModal ... />}` at the bottom of `App.jsx`'s JSX
5. Open it with `setModal('myModal')` from a button or callback

Shared pieces (`IncomeAllocationEditor`, `FormulaInput`, `ColourPicker`, `PALETTE`, `FrequencyFields`) live in `modals/shared.jsx` — reuse them rather than rebuilding.

Modals use `.modal-overlay` and `.modal-box` CSS classes. Always close on overlay click:
```jsx
<div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
```

---

## Adding a new expense category field

Categories currently have: `id`, `name`, `allowance`, `spent`, `color`.

To add a field (e.g. `icon`):

1. Add it to the `addCategory` call shape in `db.js` (no schema change needed for new fields in Dexie — it stores arbitrary objects)
2. Update the category form in `Settings.jsx`
3. Update anywhere the field is rendered

---

## Budget reset — do not break this

The auto-reset logic in `App.jsx`'s `useEffect` is load-time only. It checks whether the effective reset date has passed since `lastReset` and fires `resetBudget()` if so. The three states are:

- **Normal**: resets on `payDayOfMonth` each month
- **Fast-forward**: user got paid early → `handleFastForward` resets immediately and sets `lastReset` to the early date
- **Hold**: `holdActive: true` → the `useEffect` skips the check entirely until the user untogles it

When modifying this logic, preserve the `holdActive` early-exit and the `fastForwardDate` priority over the scheduled date.

---

## Testing

```bash
npm test          # Vitest: pure utils + db helpers (fake-indexeddb)
npm run lint
npm run build
npm run preview   # then, in another shell:
npm run smoke     # real-browser walkthrough of the core flow
```

`categories.spent` is a counter, so anything touching transactions or resets
must keep it in step with the transaction log — `db.test.js` covers those
invariants and new mutations belong there too. `recalculateSpendCounters()`
rebuilds the counters from the log if they ever drift.

The repo has 10 pre-existing ESLint errors (mostly `setState` inside effects).
Don't add new ones; fixing the existing set is tracked separately.

---

## What not to do

- **Don't add a backend.** Data stays in IndexedDB.
- **Don't add React Router.** Navigation is a single `view` state string in `App.jsx`.
- **Don't use localStorage.** Dexie/IndexedDB is the only storage layer.
- **Don't add global state management** (Redux, Zustand, Context). `useLiveQuery` in `App.jsx` + prop drilling is sufficient and explicit.
- **Don't install a component library** (shadcn, MUI, etc.). The glass design system is hand-rolled and should stay that way.
- **Don't rename `db.js` or `utils.js`** — they're imported widely.
- **Don't put business logic in views.** Views render and emit events. Logic goes in `utils.js` (pure) or `db.js` (DB operations) or `App.jsx` (orchestration).

---

## Common tasks

### Add a new transaction field (e.g. receipt image)

1. Accept the new field in `AddTransactionModal` in `components/modals/transaction.jsx`
2. Pass it through to `onAdd(...)` → `addTransaction(tx)` in `db.js` — Dexie will persist any extra fields automatically
3. Render it in `Transactions.jsx`

### Change the currency

Find `fmt()` and `fmtShort()` in `utils.js`. Change the `currency` option in `Intl.NumberFormat` and update the `£` prefix in `fmtShort`.

### Add a new chart to Forecasting

Import from `recharts` and add to `Forecasting.jsx`. Put any new data-crunching logic in `utils.js` as a pure function, accepting `transactions` and/or `categories` and `settings` as arguments.

### Inspect the database in browser

Open DevTools → Application → IndexedDB → FinanceApp. All five tables are visible and editable there. Useful for debugging.

---

## Export / import format

```json
{
  "version": 1,
  "exportedAt": "<ISO string>",
  "settings": [...],
  "categories": [...],
  "transactions": [...],
  "wishlist": [...],
  "wishlistCategories": [...]
}
```

`id` fields are stripped on import so Dexie assigns fresh IDs. If you add a new table to the export, update both `exportData()` and `importData()` in `db.js`, and bump `version` in the export payload (not the Dexie schema version).