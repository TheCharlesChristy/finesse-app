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
├── App.jsx               # Root: routing, modal state, auto-reset logic, all useLiveQuery calls
├── db.js                 # Dexie schema + every database helper function
├── utils.js              # Pure functions only — scheduling, forecasting, formatting
├── index.css             # All styling: CSS variables, glass classes, component styles
├── views/                # One file per page/tab
│   ├── Dashboard.jsx
│   ├── Transactions.jsx
│   ├── Forecasting.jsx
│   ├── Wishlist.jsx
│   └── Settings.jsx
└── components/
    └── Modals.jsx        # All modal dialogs
```

---

## Architecture rules

### Data flow

All database reads happen in `App.jsx` via `useLiveQuery`. Data is passed down to views as props. Views call prop callbacks for mutations — they do not import from `db.js` directly. The one exception is `deleteTransaction` and `deleteWishlistItem`, which are passed directly as callbacks since they take only an ID.

```
App.jsx (useLiveQuery) → props → views → callbacks → db.js → IndexedDB
                                                          ↓
                                              useLiveQuery re-renders automatically
```

Do not add `useLiveQuery` calls inside views. Keep all DB reads in `App.jsx`.

### Database helpers

All DB operations live in `db.js`. When adding a new operation:

1. Write a named async function (not a method on `db`)
2. Export it
3. Import it in `App.jsx`

The `categories.spent` field is a **counter maintained by the helpers**, not derived from transactions at query time. `addTransaction` increments it, `deleteTransaction` decrements it, `resetBudget` zeros it. Do not recompute it by scanning transactions — keep this pattern.

### Pure utils

`utils.js` contains only pure functions. No Dexie imports, no React hooks, no side effects. If you need a new calculation, add it here as a named export.

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
3. Add `useLiveQuery` calls in `App.jsx` if new data is needed
4. Add a `{view === 'myview' && <MyView ... />}` render branch in `App.jsx`

---

## Adding a new modal

1. Add the modal component to `src/components/Modals.jsx` as a named export
2. Add a new string value to the `modal` state in `App.jsx` (e.g. `'myModal'`)
3. Add `{modal === 'myModal' && <MyModal ... />}` at the bottom of `App.jsx`'s JSX
4. Open it with `setModal('myModal')` from a button or callback

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

1. Accept the new field in `AddTransactionModal` in `Modals.jsx`
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