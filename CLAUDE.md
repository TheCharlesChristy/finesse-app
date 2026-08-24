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
├── csv.js                # Pure: bank-statement parsing, column mapping, dedupe, reconciliation
├── budgetConfig.js       # Pure: budget-config validation and the staged preview diff
├── prediction.js         # Pure: Monte Carlo spend simulation and backtesting
├── storage.js            # navigator.storage: persistence + quota
├── share.js              # navigator.share for exports, with a download fallback
├── lock.js               # PIN derivation (PBKDF2) and re-lock timing — screen lock only
├── vault.js              # The encryption key: Argon2id, wrapping, recovery codes
├── dbCrypto.js           # Dexie middleware that seals rows under the key
├── receipts.js           # Receipt image compression before storage
├── notifications.js      # Opt-in OS notifications for high-severity nudges
├── pwa.js                # Service worker registration and manual update
├── hooks/
│   └── useFinesseData.js # Every useLiveQuery call, in one place. Called only by App.jsx
├── views/                # Lazy-loaded from App.jsx. Six are in NAV; the rest are
│   │                     #   panels the consolidated three render as tabs.
│   ├── Dashboard.jsx
│   ├── Accounts.jsx
│   ├── Activity.jsx          # NAV — tabs: Transactions | Calendar | Subscriptions
│   │   ├── Transactions.jsx
│   │   ├── Calendar.jsx
│   │   └── Subscriptions.jsx
│   ├── Insights.jsx          # NAV — tabs: Outlook | Budget | History | Looking Back
│   │   ├── Forecasting.jsx   #   the first three; takes its section as a `tab` prop
│   │   └── Review.jsx        #   "Looking Back" — long-range retrospective
│   ├── GoalsWishlist.jsx     # NAV — tabs: Goals | Wishlist
│   │   ├── Goals.jsx         #   savings pots and debts
│   │   └── Wishlist.jsx
│   ├── CategoryDetail.jsx    # not in NAV — opened by tapping a category
│   └── Settings.jsx          # NAV
├── components/
│   ├── QuickAdd.jsx      # Floating "log an expense" button (mobile)
│   ├── CommandPalette.jsx # ⌘K: jump to a view, run an action, find a transaction
│   ├── NudgeCenter.jsx   # Bell: what needs attention, from buildNudges()
│   ├── Wizard.jsx        # Guided first run — income, then a starter category pack
│   ├── modals/           # Modal dialogs, split by domain
│   │   ├── index.js      #   barrel — import modals from here, never the files directly
│   │   ├── shared.jsx    #   IncomeAllocationEditor, FormulaInput, ColourPicker, PALETTE…
│   │   ├── transaction.jsx, category.jsx, income.jsx, subscription.jsx,
│   │   ├── statement.jsx #   bank-statement import: map columns → review → commit
│   │   ├── budgetConfig.jsx #  budget-config import: validate → preview diff → stage
│   │   └── wishlist.jsx, data.jsx, budget.jsx, goal.jsx
│   ├── CategorySelect.jsx, DateInput.jsx  # custom accessible form controls
│   ├── LockScreen.jsx    # PIN / passphrase gate, rendered *instead of* the app
│   ├── EncryptionSettings.jsx # Turning encryption on and off, and the recovery code
│   ├── VariablesSettings.jsx  # Named values for allowance formulas — a Settings card
│   ├── ReceiptField.jsx, ReceiptViewer.jsx, useBlobUrl.js
│   ├── ui.jsx            # Modal shell (focus trap), IconButton, Field, CardTitle
│   ├── useDialog.jsx     # Promise-based confirm / alert / prompt
│   └── Toast.jsx         # Transient confirmations with an optional Undo action
└── __tests__/            # Vitest: utils / csv / prediction (pure),
                          #   db + encryption (fake-indexeddb),
                          #   platform (browser-API modules)
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

Do not add `useLiveQuery` calls inside views. New live reads go in `useFinesseData.js` and reach views as props. Every query there must be scoped by `accountId` — `accounts`, `accountTransfers` and `netWorth` are the only deliberate exceptions, each being meaningless scoped to a single account. `netWorth` returns a computed summary rather than raw rows, so unscoped transactions and goals can't leak into props where a scoped view might use them by mistake; keep that shape for any future exception.

### Database helpers

All DB operations live in `db.js`. When adding a new operation:

1. Write a named async function (not a method on `db`)
2. Export it
3. Import it in `App.jsx`

The `categories.spent` field is a **counter maintained by the helpers**, not derived from transactions at query time. `addTransaction` increments it, `deleteTransaction` decrements it, `resetBudget` zeros it. Do not recompute it by scanning transactions — keep this pattern.

### Settings — patch one field, don't write the row back

The settings row holds the user's own preferences next to machine-managed state
the reset path rewrites on its own schedule: `stagedBudgetConfig`, `lastReset`,
`budgetConfigUndo`, `notifiedNudges`. So `saveSettings({ ...settings, oneField })`
does not write one field — it writes *every* field, at whatever values the
spread copy was taken with, and silently undoes anything that landed since.

**Use `patchSettings(accountId, changes)` for any write that changes some of the
row.** It merges inside IndexedDB, so nothing the caller didn't name can be
clobbered. `saveSettings` is the replace-the-whole-row primitive underneath it
and currently has no callers outside the tests — reach for it only when the
caller really does hold the entire current row, which in practice means never
from a view.

This is not a style preference. A Settings toggle carrying a React snapshot of
the row put an already-applied `stagedBudgetConfig` back after the apply had
cleared it, leaving the account with a live budget *and* the same config still
queued to apply again at the next reset. Views send the fields they changed,
never a copy of `settings`.

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

### Receipts are bytes, and never leave in a backup

Receipt photos are stored as `Uint8Array` on the transaction row — `receipt`
(full) and `receiptThumb` (list preview) — after being re-encoded through a
canvas by `receipts.js`. Never store an image as it arrived: a phone photo is
2–5 MB and storage quota is the one hard limit this app can hit.

Bytes rather than Blobs because the row cipher is synchronous and
`Blob.arrayBuffer()` is not — see the encryption section below. `receiptBlob()`
turns them back into something an `<img>` can render, and accepts the Blobs
written before v9 so old rows keep working. `hasReceipt()` checks `receiptMeta`
first, deliberately: on an encrypted database the image fields are getters, and
asking "is there a receipt?" by reading one would decrypt every image in a list.

`JSON.stringify` turns a Blob into `{}`, so `exportData()` strips the receipt
fields deliberately and reports `receiptsOmitted`. If you add another binary
field, strip it there too — a backup that looks complete and isn't is worse
than one that says what it left behind.

### Money that can't be derived, isn't drawn

`buildNetWorthHistory` trends assets from the ledger, but reports debt as a
single current figure with `debtHasHistory: false`. Finesse records what remains
on a debt goal, not when each payment landed, so a historical debt line would be
invented. Hold to this: where the data can't support a series, say so rather
than plotting a plausible-looking one.

### Budget config import — staged, never applied on import

A JSON config file redefines every category and variable for an account at once
(`budgetConfig.js` validates, `db.js` writes, `modals/budgetConfig.jsx` previews).
The one rule that shapes everything else: **an import is staged, not applied.**
Changing a budget mid-cycle corrupts that cycle's pacing and every comparison
drawn from it, so a config is validated and previewed on import, held on
`settings.stagedBudgetConfig`, and applied by `applyStagedBudgetConfig` at the
reset of the income its formulas are written against.

Four invariants worth keeping:

- **Runtime state is never written.** `RUNTIME_CATEGORY_FIELDS` names what an
  import must not touch — `spent`, `spentByIncome`, `lastReset`,
  `incomeResetAt`, `temporaryBoost`, `boostSources`, `cycleClearedSpend`. An
  `update` preserves the row's id, so a rename keeps its transaction history.
- **Variables are written before categories,** because category formulas
  dereference them. The preview evaluates against the *post-apply* variable set,
  or it would show numbers the apply step would never produce.
- **Formulas are the source of truth, not the file's numbers.** Apply
  re-evaluates against live income; a config that no longer balances is left
  staged and reported rather than written at numbers the user didn't approve.
- **Import never deletes.** A category the config omits is left untouched and
  the user is told so.
- **Apply lands at most once.** The plan and the backup are built outside the
  write transaction, so two callers arriving together — the reset path fires
  more than once as live queries settle, and a PWA can be open in two tabs —
  both planned against the same pre-apply categories and both wrote, running
  every `create` row twice. The transaction therefore *claims* the staged
  record before touching a category, aborting if it is no longer the one on
  disk; `applyStagedBudgetConfig` also chains calls per account so the loser
  doesn't pay for a plan and a full backup it can't use. Duplicate categories
  are not a cosmetic problem: `evaluateFormula` resolves `$Name` and `[Name]`
  by whichever row Dexie returns first, and every allowance total counts them
  twice.

`reconcileStagedBudgetConfig` runs at startup and clears a staged record that
has already been applied — the state the stale-write bug left behind, which
would otherwise apply a second time at the next reset. It identifies it exactly
(`undo.stagedAt`, or `undo.backup.exportedAt` for records written before that
field existed) rather than assuming both fields being set means trouble; a
config staged *after* the last apply is a genuine new import.

Both paths that reset an income apply a due config — the scheduled one and
`handleIncomeFastForward`. Getting paid early is still getting paid, and a
fast-forward writes `lastPaid`, so a config that doesn't land there never lands
at all. Everything acting on a reset goes through App's one reset queue.

Apply runs in one Dexie transaction and takes an `exportSnapshot()` backup
first. Undo is offered for one cycle (`undoExpiresAt`) — long enough to catch a
budget you didn't want, short of restoring allowances that have gone stale and
discarding rollover accrued since.

### Encryption — the middleware, and what it can't hide

Encryption is opt-in per device. When it is on, `dbCrypto.js` sits under Dexie
as a DBCore middleware and seals every row on the way down, opening it on the
way up. Nothing in `db.js` or the views knows: they handle ordinary objects
either way. A scheme that asked 2,200 lines of helpers to remember to encrypt
would be one forgotten call away from a permanent plaintext row.

Five things shape everything else here:

- **The cipher is synchronous, and has to be.** An IndexedDB transaction commits
  as soon as the microtask queue drains without a new request against it, so
  awaiting `crypto.subtle` between two IDB operations kills the transaction.
  Hence AES-GCM from `@noble/ciphers` on the row path — and hence bytes rather
  than Blobs for receipts, since `Blob.arrayBuffer()` is async too. The slow,
  memory-hard KDF (Argon2id) runs only at unlock, in `vault.js`, with no
  transaction open. **Never `await` anything in the middleware's row path.**
- **The clear set comes from the schema, not a list.** `clearFieldsFor` reads
  the primary key and indexes off the live Dexie schema, so an index added later
  can't quietly start leaking a field this file didn't know about.
- **A key is wrapped, never derived directly.** The row key comes from a random
  master, and the secret only wraps it — which is why changing a PIN is instant
  instead of rewriting the database. The same master is wrapped a second time
  under a random recovery code.
- **Migrations are resumable, not transactional.** Both directions rewrite every
  row in batches. `openRow` passes unsealed rows through untouched, so a
  half-migrated database is a working database; `sealedAt` records whether the
  pass finished and `resumeSealing` picks it up at the next unlock.
- **Binaries are sealed apart and opened late.** Receipt images are sealed one
  field at a time into `__b` and exposed as getters that decrypt on first read.
  Anything that only needs to know *whether* a receipt exists must check
  `receiptMeta`, or it will decrypt an image per row.

`blindIndex` covers the two unique indexes that have to survive — `receiptKey`
and `subscriptionRunKey`. Their raw form spells out an account, an income and a
date, so what is indexed is an HMAC of it; the raw value rides along inside the
encrypted payload as `*Plain` so turning encryption off can restore it.

**What is still readable without the key**: the primary key and the remaining
indexes — row counts, and which account and category each row belongs to. No
amount, name, note, date, tag or photo. Settings says exactly this, generated
from the live schema by `sealedFieldReport`, rather than implying encryption
hides everything. Keep that honesty if you touch this.

### The lock gate resolves before the first paint

Whether a lock stands in front of the app is answered by `lock` in
`useFinesseData` — its own unscoped query, resolved before anything renders and
`undefined` until genuinely known. App draws a bare background until then.

It cannot be derived from `settings`. That query is scoped to an account, so
until `accounts` resolves it short-circuits to `null`, which is indistinguishable
from "no PIN set" — the app painted a full dashboard, balance and all, and
swapped the lock screen in a few frames later. **Anything that decides whether
to render financial content must wait on `lockChecked`, never on `settings`.**

The query is unscoped on purpose: a PIN covers the device, not one account, so a
PIN set against any account locks the app, and the row carrying it comes back
with the answer because that is the row the entered PIN is verified against.

**A short PIN is not a key.** Ten thousand possibilities falls in seconds to
someone holding a copy of the database, whatever the KDF costs; Argon2id buys
orders of magnitude, not safety. `describeSecretStrength` says so in real units
at the moment the secret is chosen, and the enable flow will not proceed until
the recovery code has been shown and confirmed. Do not soften either.

### Formula evaluation

`evaluateFormula` substitutes `$var`, `{Income}` and `[Category]` tokens, then
hands the result to `evaluateArithmetic` — a real tokeniser and recursive-descent
parser, not a regex and `Function()`. Precedence has to be right for the chained
residual formulas (`a - b/12 - c*3.33`), and building a function from user text
is exactly what a PWA's content-security policy should be free to forbid.

`evaluateFormulaDetailed` is the same thing with a reason attached, so the config
importer can say *which* reference failed rather than only that something did.

### Schema changes

If you change the Dexie schema, increment the version number and add a new `db.version(N).stores({...})` call. Do not modify the existing `version(1)` call. See DEV_GUIDE.md for the migration pattern. The current version is **9**.

**Think hard before adding an index.** An indexed field cannot be encrypted —
IndexedDB has to read it to sort and seek on it — so every index is a column
that stays legible to anyone holding the raw database. v9 dropped seven `name`
indexes, `*tags`, `date`, `nextDueAt`, `active`, `priority` and `incomeId`
because nothing ever queried them; they were costing a write per insert and
would have left category names, merchants and every transaction date in plain
sight. If a new index is genuinely needed, add it knowing that, and say so in
the same commit.

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

### `.mobile-row-stack` turns a row into a column — and its children with it

The class flips a flex row to `flex-direction: column` below 620px. That also
reinterprets every child's `flex-basis`: what was a *width* in a row becomes a
*height* in a column. A `<select>` written as `flex: 1 1 220px` rendered as a
220px-tall box with 180px of nothing inside it, and three Settings cards were
carrying the same bug.

So the rule sets `flex: 0 0 auto` on every child, which is what a stacked row
wants anyway — `align-items: stretch` already gives each child the full width,
and the height should come from the content. **If you add a `.mobile-row-stack`,
size its children for the row case and let the media query handle the column.**

---

## Navigation — six entries, and the aliases behind them

`NAV` in `App.jsx` is six items. Three of them are consolidated pages that render
their old siblings as tabs, and each keeps a `viewTabs[pageId]` entry in App
saying which tab is showing.

The old page ids did not go away, because they are the vocabulary the rest of
the app navigates in — `buildNudges` returns `view: 'subscriptions'`, the goto
keys are muscle memory, and a nudge should land on the tab that answers it.
`VIEW_ALIASES` maps each old id onto a `[page, tab]` pair, and `navigate()`
resolves through it. **Call `navigate(id)`, never `setView(id)`,** or an alias
will land on the right page and the wrong tab.

### Adding a new view

1. Create `src/views/MyView.jsx` — accept data as props, emit mutations via callbacks
2. Add an entry to the `NAV` array in `App.jsx`, and to the view list in
   `scripts/smoke.mjs` so it is actually exercised
3. Add the query to `hooks/useFinesseData.js` if new data is needed, and pass it down from `App.jsx`
4. Add a `{view === 'myview' && <MyView ... />}` render branch in `App.jsx`

### Adding a tab to a consolidated page

1. Add `{ id, label, Icon }` to that page's `TABS`, and a panel branch beside the others
2. If the tab was previously reachable by another name, add a `VIEW_ALIASES` entry
   so old navigation targets still land on it
3. Add it to `TAB_TARGETS` so the command palette can still find it by its own name
4. Add it to `PAGE_OF` and the tab sweep in `scripts/smoke.mjs`

Tab bars come from `Tabs` in `components/ui.jsx` — never hand-rolled, so the
four of them can't drift apart. Its styling is `.tab-bar` / `.tab-item` in
`index.css`; icons are hidden below 620px, which is what lets four tabs fit an
iPhone SE without the bar scrolling.

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

`encryption.test.js` proves sealing by opening a *second* Dexie connection to
the same database with no middleware installed, and asserting on what is
actually stored. Assertions made through the app's own reads would pass just as
happily if `seal` were the identity function — if you add a case here, check it
the raw way. Its `FAST` Argon2 parameters exist so the suite stays runnable;
the algorithm under test is unchanged.

`npm run lint` is clean — keep it that way. `setState` inside an effect is the
error you're most likely to hit; the fix is almost always to derive the value
during render instead. The two allocation effects in `modals/category.jsx` are
the one justified exception (the allowance and its funding split depend on each
other, so the circle can't close in a single render) and carry a comment saying
so.

---

## What not to do

- **Don't add a backend.** Data stays in IndexedDB.
- **Don't add React Router.** Navigation is a single `view` state string in `App.jsx`.
- **Don't put app data in localStorage.** Dexie/IndexedDB is the storage layer
  for everything the user owns — including UI state that should survive an
  export/import, such as dismissed nudges. The single exception is
  `finesse.activeAccountId`, which records which account was last open and is
  meaningless on another device.
- **Don't add global state management** (Redux, Zustand, Context). `useLiveQuery` in `App.jsx` + prop drilling is sufficient and explicit.
- **Don't install a component library** (shadcn, MUI, etc.). The glass design system is hand-rolled and should stay that way.
- **Don't rename `db.js` or `utils.js`** — they're imported widely.
- **Don't `await` in the `dbCrypto.js` row path.** It runs inside IndexedDB
  transactions, which commit the moment you hand control back.
- **Don't add a way to recover data without the secret or the recovery code.**
  There isn't one, and any hint otherwise in the UI is a lie the user will act on.
- **Don't put business logic in views.** Views render and emit events. Logic goes in `utils.js` (pure) or `db.js` (DB operations) or `App.jsx` (orchestration).

---

## Common tasks

### Add a new transaction field (e.g. receipt image)

1. Accept the new field in `AddTransactionModal` in `components/modals/transaction.jsx`
2. Pass it through to `onAdd(...)` → `addTransaction(tx)` in `db.js` — Dexie will persist any extra fields automatically
3. Render it in `Transactions.jsx`

### Change the currency

Find `fmt()` and `fmtShort()` in `utils.js`. Change the `currency` option in `Intl.NumberFormat` and update the `£` prefix in `fmtShort`.

### Import a bank statement

`csv.js` is pure and self-contained: parsing, delimiter detection, amount and
date reading, column mapping, duplicate detection and reconciliation. The modal
(`modals/statement.jsx`) owns the three-step flow and injects
`suggestCategoryForNote` as a closure, so `csv.js` never reaches for rules or
history itself.

Two invariants worth keeping: nothing is written until the review step is
confirmed, and `summariseRows().importable` must always equal
`toTransactionPayload().length` — the button promises what will actually be
written, not what is merely ticked.

### Add a new chart to Forecasting

Import from `recharts` and add to `Forecasting.jsx` — inside the `tab === 'outlook' | 'budget' | 'history'` branch it belongs to. Put any new data-crunching logic in `utils.js` as a pure function, accepting `transactions` and/or `categories` and `settings` as arguments.

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