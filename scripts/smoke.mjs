/**
 * End-to-end smoke test against a running Finesse build.
 *
 * Drives a real browser through the core flow — onboarding, adding an income,
 * a category and an expense, then every view — and fails on any console error
 * or unrendered view. Unit tests can't catch a broken lazy import, a bad modal
 * barrel export or a crashing view; this can.
 *
 *   npm run build && npm run preview   # in one shell
 *   npm run smoke                      # in another
 *
 * Set SMOKE_URL to point at a different origin (defaults to the preview server).
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_URL || 'http://localhost:4173/finesse-app/';

// The sandboxed browser install isn't always where Playwright expects it.
function findChromium() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!existsSync(root)) return undefined;
  const dir = readdirSync(root).find(name => /^chromium-\d+$/.test(name));
  if (!dir) return undefined;
  const bin = join(root, dir, 'chrome-linux', 'chrome');
  return existsSync(bin) ? bin : undefined;
}

const errors = [];
const step = (msg) => console.log(`  ✓ ${msg}`);

const browser = await chromium.launch({ executablePath: findChromium() });
const page = await browser.newPage();

page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
page.on('console', m => {
  if (m.type() !== 'error') return;
  // Web fonts are fetched from Google and may be blocked offline; that's an
  // environment limitation, not an application fault.
  if (/fonts\.(googleapis|gstatic)/.test(m.text() + (m.location()?.url || ''))) return;
  errors.push(`console: ${m.text()}`);
});

await page.goto(BASE, { waitUntil: 'networkidle' });

await page.getByText('Welcome to Finesse').waitFor({ timeout: 15000 });
step('first-run wizard renders');

// The wizard creates the income; categories are added by hand afterwards so the
// rest of the walkthrough works against known figures.
await page.getByLabel("What do you call it?").fill('Salary');
await page.getByLabel(/How much/).fill('2000');
await page.getByRole('button', { name: 'Continue' }).click();
await page.getByRole('radio', { name: /I will set my own up/ }).click();
await page.getByRole('button', { name: 'Start budgeting' }).click();
await page.waitForTimeout(700);

const afterWizard = await page.locator('body').innerText();
if (!afterWizard.includes('Salary')) errors.push('wizard did not create the income');
step('wizard creates the income');

await page.getByRole('button', { name: '+ Category' }).click();
await page.getByRole('dialog').waitFor();
await page.getByLabel('Name').fill('Groceries');
await page.locator('input[placeholder*="300"]').fill('400');
await page.getByRole('button', { name: 'Add Category', exact: true }).click();
await page.getByRole('dialog').waitFor({ state: 'detached' });
step('category added and funded');

await page.getByRole('button', { name: '+ Log Expense' }).click();
await page.getByRole('dialog').waitFor();
await page.getByLabel('Amount (£)').fill('25.50');
await page.getByLabel('Note / merchant').fill('Tesco');
await page.getByRole('button', { name: 'Add Expense', exact: true }).click();
await page.getByRole('dialog').waitFor({ state: 'detached' });
await page.getByText('Recent Transactions').waitFor({ timeout: 5000 });
step('expense logged');

const body = await page.locator('body').innerText();
for (const expected of ['£2,000.00', '£400.00 allocated', '£1,600.00 unallocated', '£374.50', 'Tesco']) {
  if (!body.includes(expected)) errors.push(`dashboard missing: ${expected}`);
}
step('dashboard totals reconcile (2000 income − 400 allocated, 374.50 left of 400)');

for (const name of ['Accounts', 'Transactions', 'Can I Purchase It', 'Calendar', 'Subscriptions',
                    'Forecasting', 'Looking Back', 'Goals', 'Wishlist', 'Variables', 'Settings', 'Dashboard']) {
  await page.getByRole('button', { name, exact: true }).click();
  await page.waitForTimeout(350);
  const heading = await page.locator('h1').innerText();
  if (!heading.includes(name)) errors.push(`view "${name}" did not render (h1 was "${heading}")`);
}
step('all 12 views render');

await page.getByRole('button', { name: 'Adjust Groceries' }).click();
await page.getByRole('dialog').waitFor();
const adjust = await page.getByRole('dialog').innerText();
if (!adjust.includes('Spare income')) errors.push('adjust modal: no spare-income source offered');
if (!adjust.includes('£1,600.00')) errors.push(`adjust modal: wrong free pool\n${adjust}`);
await page.getByRole('button', { name: 'Close dialog' }).click();
step('adjust-budget pool computed per income source');

// ── Fast capture ─────────────────────────────────────────────────────────

// Command palette: opens on ⌘K, and running a command does the thing.
await page.keyboard.press('ControlOrMeta+k');
await page.getByRole('dialog', { name: 'Command palette' }).waitFor({ timeout: 5000 });
await page.getByPlaceholder('Jump to a view').fill('forecast');
await page.keyboard.press('Enter');
await page.waitForTimeout(400);
if (!(await page.locator('h1').innerText()).includes('Forecasting')) {
  errors.push('command palette did not navigate to Forecasting');
}
step('command palette navigates');

// Merchant memory: typing a known merchant should re-suggest its category.
await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
await page.waitForTimeout(300);
await page.keyboard.press('a'); // shortcut
await page.getByRole('dialog').waitFor({ timeout: 5000 });
await page.getByLabel('Amount (£)').fill('12');
await page.getByLabel('Note / merchant').fill('Tesco');
await page.waitForTimeout(250);
const modalText = await page.getByRole('dialog').innerText();
if (!/usually put "Tesco"|Matched your rule/.test(modalText)) {
  errors.push(`no merchant suggestion shown for a repeat merchant:\n${modalText}`);
}
step('“a” shortcut opens capture; merchant memory suggests a category');

// Refund: reduces category spend rather than inflating it.
await page.getByRole('button', { name: 'Refund' }).click();
await page.getByRole('button', { name: 'Add Refund', exact: true }).click();
await page.getByRole('dialog').waitFor({ state: 'detached' });
await page.waitForTimeout(400);
const afterRefund = await page.locator('body').innerText();
// 25.50 spent − 12 refunded = 13.50 spent, so 386.50 of 400 remains.
if (!afterRefund.includes('£386.50')) {
  errors.push(`refund did not reduce category spend (expected £386.50 left)`);
}
step('refund reduces spend and credits the account');

// Split: one purchase across two categories, as separate linked rows.
await page.getByRole('button', { name: '+ Category' }).click();
await page.getByRole('dialog').waitFor();
await page.getByLabel('Name').fill('Fun');
await page.locator('input[placeholder*="300"]').fill('200');
await page.getByRole('button', { name: 'Add Category', exact: true }).click();
await page.getByRole('dialog').waitFor({ state: 'detached' });

await page.keyboard.press('a');
await page.getByRole('dialog').waitFor();
await page.getByLabel('Amount (£)').fill('50');
await page.getByLabel('Note / merchant').fill('Big shop');
await page.getByRole('button', { name: 'Split across categories' }).click();
await page.getByRole('button', { name: 'Add part' }).click();
const splitAmounts = page.getByLabel(/^Split part \d+ amount$/);
await splitAmounts.nth(0).fill('30');
await splitAmounts.nth(1).fill('20');
const splitCats = page.getByLabel(/^Split part \d+ category$/);
await splitCats.nth(0).click();
await page.getByRole('option', { name: /Groceries/ }).first().click();
await splitCats.nth(1).click();
await page.getByRole('option', { name: /Fun/ }).first().click();
await page.getByRole('button', { name: 'Add Split' }).click();
await page.getByRole('dialog').waitFor({ state: 'detached' });
await page.waitForTimeout(400);

await page.getByRole('button', { name: 'Transactions', exact: true }).click();
await page.waitForTimeout(400);
const txText = await page.locator('body').innerText();
if ((txText.match(/split/g) || []).length < 2) {
  errors.push('split did not produce two linked transactions');
}
step('split writes one row per category, tagged as a split');

// ── Insight ──────────────────────────────────────────────────────────────

await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
await page.waitForTimeout(400);
// innerText reflects CSS text-transform, so this label comes back uppercased.
const dash = await page.locator('body').innerText();
if (!/safe to spend today/i.test(dash)) errors.push('safe-to-spend hero missing');
if (!/safe to spend today\s*\n?£/i.test(dash)) errors.push('safe-to-spend shows no figure');
step('safe-to-spend hero renders');

// Category drill-down: tapping a category opens its own page.
await page.getByRole('button', { name: 'Groceries', exact: true }).first().click();
await page.waitForTimeout(500);
const detail = await page.locator('body').innerText();
if (!(await page.locator('h1').innerText()).includes('Groceries')) {
  errors.push('category drill-down did not open');
}
for (const expected of ['Left this cycle', 'Safe per day', 'Transactions', 'Where It Went']) {
  if (!detail.includes(expected)) errors.push(`category detail missing: ${expected}`);
}
step('category drill-down shows cycle stats, merchants and transactions');

await page.getByRole('button', { name: 'Back to Dashboard' }).click();
await page.waitForTimeout(400);
if (!(await page.locator('h1').innerText()).includes('Dashboard')) {
  errors.push('back from category detail did not return to the Dashboard');
}
step('drill-down returns to the Dashboard');

await page.getByRole('button', { name: 'Forecasting', exact: true }).click();
await page.waitForTimeout(600);

// Forecasting is split into three tabs, so a card being absent from the default
// view is no longer a failure — but each tab still has to render its own.
for (const [tabName, expected] of [
  ['Outlook', ['Predicted Spending', 'Income Reset Schedule']],
  ['Budget',  ['Budget Usage', 'Category Allocation']],
  ['History', ['Account Balance', 'Where Your Money Goes']],
]) {
  await page.getByRole('tab', { name: tabName }).click();
  await page.waitForTimeout(400);
  const body = await page.locator('body').innerText();
  for (const text of expected) {
    if (!body.includes(text)) errors.push(`forecasting ${tabName} tab missing: ${text}`);
  }
}
await page.getByRole('tab', { name: 'Outlook' }).click();
await page.waitForTimeout(300);
step('forecasting tabs each render their own cards');

// ── Money concepts ───────────────────────────────────────────────────────

await page.getByRole('button', { name: 'Goals', exact: true }).click();
await page.waitForTimeout(400);
await page.getByRole('button', { name: 'Add your first goal' }).click();
await page.getByRole('dialog').waitFor();
await page.getByLabel('Name').fill('Holiday');
await page.getByLabel('Target amount (£)').fill('1200');
await page.getByLabel('Set aside automatically (£)').fill('100');
await page.getByRole('button', { name: 'Add Goal', exact: true }).click();
await page.getByRole('dialog').waitFor({ state: 'detached' });
await page.waitForTimeout(400);

const goalsText = await page.locator('body').innerText();
if (!goalsText.includes('Holiday')) errors.push('goal was not created');
if (!goalsText.includes('£1,200.00')) errors.push('goal target not shown');
step('savings goal created with an automatic contribution');

// Contributing is an earmark: progress moves, the account balance does not.
await page.getByLabel('Amount to move for Holiday').fill('300');
await page.getByRole('button', { name: 'Add', exact: true }).click();
await page.waitForTimeout(400);
const contributed = await page.locator('body').innerText();
if (!contributed.includes('£300.00')) errors.push('goal contribution not recorded');
if (!/25%/.test(contributed)) errors.push('goal progress percentage wrong');
step('contribution recorded as an earmark');

// Pending savings are held back from safe-to-spend.
await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
await page.waitForTimeout(500);
const dashWithGoal = await page.locator('body').innerText();
if (!/savings/i.test(dashWithGoal)) {
  errors.push('safe-to-spend does not show the pending savings commitment');
}
step('pending savings held back from safe-to-spend');

// ── Reminders ────────────────────────────────────────────────────────────

// A fresh install has never backed up, and that's worth saying.
const bell = page.getByRole('button', { name: /notifications/i });
const bellLabel = await bell.getAttribute('aria-label');
if (!/\d+ notifications/.test(bellLabel || '')) {
  errors.push(`nudge bell shows no count (aria-label was "${bellLabel}")`);
}
await bell.click();
await page.getByRole('dialog', { name: 'Notifications' }).waitFor({ timeout: 5000 });
const panel = await page.getByRole('dialog', { name: 'Notifications' }).innerText();
if (!/never backed up/i.test(panel)) {
  errors.push(`backup nudge missing from the panel:\n${panel}`);
}
step('nudge centre lists outstanding items');

// Dismissal has to survive a reload, or it isn't a dismissal.
const firstDismiss = page.getByRole('button', { name: /^Dismiss:/ }).first();
const dismissedLabel = await firstDismiss.getAttribute('aria-label');
await firstDismiss.click();
await page.waitForTimeout(500);
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(800);
await page.getByRole('button', { name: /notifications/i }).click();
await page.getByRole('dialog', { name: 'Notifications' }).waitFor({ timeout: 5000 });
const afterReload = await page.getByRole('dialog', { name: 'Notifications' }).innerText();
const dismissedTitle = (dismissedLabel || '').replace(/^Dismiss:\s*/, '');
if (dismissedTitle && afterReload.includes(dismissedTitle)) {
  errors.push(`dismissed nudge came back after reload: ${dismissedTitle}`);
}
step('dismissal persists across a reload');

// ── Calendar & planning ──────────────────────────────────────────────────

await page.getByRole('button', { name: 'Calendar', exact: true }).click();
await page.waitForTimeout(500);

// Clicking a day opens its detail sheet.
const todayCell = page.locator('.finance-calendar-day.today');
await todayCell.click();
await page.waitForTimeout(400);
const calText = await page.locator('body').innerText();
if (!/Add expense here/i.test(calText)) errors.push('calendar day sheet did not open');
step('calendar days open a detail sheet');

// Logging from a day should date the transaction to that day.
await page.getByRole('button', { name: 'Add expense here' }).click();
await page.getByRole('dialog').waitFor({ timeout: 5000 });
await page.getByLabel('Amount (£)').fill('7.25');
await page.getByLabel('Note / merchant').fill('From calendar');
await page.getByRole('button', { name: 'Add Expense', exact: true }).click();
await page.getByRole('dialog').waitFor({ state: 'detached' });
await page.waitForTimeout(500);

await page.getByRole('button', { name: 'Transactions', exact: true }).click();
await page.waitForTimeout(500);
const txList = await page.locator('body').innerText();
if (!txList.includes('From calendar')) errors.push('expense logged from the calendar is missing');
step('logging from a calendar day works');

await page.getByRole('button', { name: 'Forecasting', exact: true }).click();
await page.waitForTimeout(700);
const fc = await page.locator('body').innerText();
if (!/Cash Flow/i.test(fc)) errors.push('cash-flow forecast missing');
if (!/(goes negative|stay in the black)/i.test(fc)) errors.push('cash-flow verdict missing');
step('cash-flow forecast renders with a verdict');

// ── Polish ───────────────────────────────────────────────────────────────

// Undo has to actually restore, or it's just a nicer-looking delete.
await page.getByRole('button', { name: 'Transactions', exact: true }).click();
await page.waitForTimeout(500);
const txRow = page.getByRole('button', { name: /^Edit From calendar/ });
if (await txRow.count() === 0) errors.push('test transaction missing before delete');

await page.getByRole('button', { name: /^Delete From calendar/ }).first().click();
await page.waitForTimeout(500);
if (await txRow.count() !== 0) errors.push('delete did not remove the transaction');
if (!/Deleted From calendar/.test(await page.locator('body').innerText())) {
  errors.push('no undo toast after delete');
}

await page.getByRole('button', { name: 'Undo' }).click();
await page.waitForTimeout(700);
if (await txRow.count() === 0) errors.push('undo did not restore the transaction');
step('delete shows an undo toast that actually restores');

// Keyboard shortcuts sheet.
await page.keyboard.press('?');
await page.getByRole('dialog').waitFor({ timeout: 5000 });
const shortcutText = await page.getByRole('dialog').innerText();
if (!/Command palette/.test(shortcutText)) errors.push('shortcut help sheet missing entries');
await page.getByRole('button', { name: 'Got it' }).click();
await page.waitForTimeout(300);
step('shortcut help sheet opens with "?"');

// "g then t" navigation.
await page.keyboard.press('g');
await page.keyboard.press('c');
await page.waitForTimeout(400);
if (!(await page.locator('h1').innerText()).includes('Calendar')) {
  errors.push('"g then c" did not navigate to the Calendar');
}
step('"g then <key>" navigation works');

// Integrity check reports honestly on a healthy database.
await page.getByRole('button', { name: 'Settings', exact: true }).click();
await page.waitForTimeout(400);
await page.getByRole('button', { name: /Recalculate Spend Counters/ }).click();
await page.waitForTimeout(700);
const integrity = await page.locator('body').innerText();
if (!/counters match the transaction log/.test(integrity)) {
  const detail = integrity.split('\n').filter(line => /Repaired|counters|Checked/.test(line)).join(' | ');
  errors.push(`integrity check did not report a clean result: ${detail}`);
}
step('integrity check verifies counters against the log');

// ── Storage, privacy and import ──────────────────────────────────────────

// Still on Settings. The two cards guarding the data have to render, and the
// storage one has to say something definite rather than sit on "Checking…".
const settingsText = await page.locator('body').innerText();
for (const expected of ['Storage', 'Privacy', 'Import Bank Statement']) {
  if (!settingsText.includes(expected)) errors.push(`settings missing: ${expected}`);
}
if (/Checking…/.test(settingsText)) errors.push('storage state never resolved');
if (!/(persistent|evictable|doesn’t expose storage persistence)/i.test(settingsText)) {
  errors.push('storage card reports no persistence state');
}
step('storage and privacy cards render with a resolved state');

// A default expense category, so imported rows that match no rule still have
// somewhere to go — and so this exercises the defaultCategoryId path.
await page.getByRole('combobox', { name: 'Default expense category' }).click();
await page.getByRole('option', { name: /Groceries/ }).first().click();
await page.waitForTimeout(400);
if (!/Groceries/.test(await page.locator('body').innerText())) {
  errors.push('default expense category was not set');
}
step('default expense category set');

// The statement importer is the longest new flow, so at minimum it must open,
// parse a file, and reach the review step with rows in it.
await page.getByRole('button', { name: /Import Bank Statement/ }).click();
await page.getByRole('dialog').waitFor({ timeout: 5000 });
await page.setInputFiles('input[type="file"][accept*="csv"]', {
  name: 'statement.csv',
  mimeType: 'text/csv',
  buffer: Buffer.from(
    'Date,Description,Amount,Balance\n'
    + '01/07/2026,COFFEE HUT,-3.20,996.80\n'
    + '02/07/2026,TESCO STORES,-41.05,955.75\n'
    + '03/07/2026,REFUND ASOS,18.99,974.74\n',
  ),
});
await page.waitForTimeout(600);

const mapText = await page.getByRole('dialog').innerText();
if (!/Which column is which/i.test(mapText)) errors.push(`importer did not reach the mapping step:\n${mapText}`);
// The guess has to be right on an ordinary statement, or every import is manual.
if (!/2026-07-01/.test(mapText) || !/3\.20/.test(mapText)) {
  errors.push(`column mapping preview wrong:\n${mapText}`);
}
await page.getByRole('button', { name: /Review 3 rows/ }).click();
await page.waitForTimeout(500);

const reviewText = await page.getByRole('dialog').innerText();
if (!/Review before importing/i.test(reviewText)) errors.push('importer did not reach the review step');
if (!/COFFEE HUT/.test(reviewText)) errors.push('review step lists no rows');
// £3.20 + £41.05 out, £18.99 back.
if (!/£44\.25/.test(reviewText)) errors.push(`review totals wrong:\n${reviewText}`);
if (!/£18\.99/.test(reviewText)) errors.push('refund row not recognised as money in');
// The balance column is present, so reconciliation must have an opinion.
if (!/statement closes at/i.test(reviewText)) errors.push('reconciliation not reported');
step('statement importer maps columns, reviews rows and reconciles');

await page.getByRole('button', { name: /^Import 3 transactions$/ }).click();
await page.waitForTimeout(900);

await page.getByRole('button', { name: 'Transactions', exact: true }).click();
await page.waitForTimeout(600);
const imported = await page.locator('body').innerText();
for (const expected of ['COFFEE HUT', 'TESCO STORES', 'REFUND ASOS']) {
  if (!imported.includes(expected)) errors.push(`imported transaction missing: ${expected}`);
}
step('imported rows land in the ledger');

// Re-importing the same file must find them all as duplicates.
await page.getByRole('button', { name: /Import CSV/ }).click();
await page.getByRole('dialog').waitFor({ timeout: 5000 });
await page.setInputFiles('input[type="file"][accept*="csv"]', {
  name: 'statement.csv',
  mimeType: 'text/csv',
  buffer: Buffer.from(
    'Date,Description,Amount,Balance\n'
    + '01/07/2026,COFFEE HUT,-3.20,996.80\n'
    + '02/07/2026,TESCO STORES,-41.05,955.75\n'
    + '03/07/2026,REFUND ASOS,18.99,974.74\n',
  ),
});
await page.waitForTimeout(600);
await page.getByRole('button', { name: /Review 3 rows/ }).click();
await page.waitForTimeout(500);
const secondPass = await page.getByRole('dialog').innerText();
if (!/Already logged/.test(secondPass)) errors.push('re-import did not flag duplicates');
if (await page.getByRole('button', { name: /^Import \d+ transactions?$/ }).isEnabled()) {
  errors.push('re-import still offers to import already-logged rows');
}
await page.getByRole('button', { name: 'Close dialog' }).click();
await page.waitForTimeout(300);
step('re-importing the same statement imports nothing twice');

// ── Looking back ─────────────────────────────────────────────────────────

await page.getByRole('button', { name: 'Looking Back', exact: true }).click();
await page.waitForTimeout(700);
const review = await page.locator('body').innerText();
for (const expected of ['Month by month', 'Where it went', 'Who got it', 'Spent', 'Kept']) {
  if (!review.includes(expected)) errors.push(`review view missing: ${expected}`);
}
// Switching the window must not blank the page.
await page.getByRole('button', { name: '3 months', exact: true }).click();
await page.waitForTimeout(500);
if (!/Month by month/.test(await page.locator('body').innerText())) {
  errors.push('review view broke when the window changed');
}
step('looking-back view renders and survives a window change');

// ── Debt interest ────────────────────────────────────────────────────────

await page.getByRole('button', { name: 'Goals', exact: true }).click();
await page.waitForTimeout(500);
await page.getByRole('button', { name: '+ Add Goal' }).click();
await page.getByRole('dialog').waitFor({ timeout: 5000 });
await page.getByRole('button', { name: 'Paying off' }).click();
await page.getByLabel('Name').fill('Credit card');
await page.getByLabel('Total owed (£)').fill('1000');
await page.getByLabel('Interest rate (APR %)').fill('24');
await page.getByLabel('Set aside automatically (£)').fill('100');
await page.waitForTimeout(400);

const debtModal = await page.getByRole('dialog').innerText();
// £1000 at £100/month is 10 payments without interest; with 24% APR it is more.
if (!/interest/i.test(debtModal)) errors.push(`debt modal shows no interest preview:\n${debtModal}`);
if (/\b10 × month\b/.test(debtModal)) errors.push('debt preview ignored the interest');
await page.getByRole('button', { name: 'Add Debt', exact: true }).click();
await page.getByRole('dialog').waitFor({ state: 'detached' });
await page.waitForTimeout(600);

const goalsAfter = await page.locator('body').innerText();
if (!/24% APR/.test(goalsAfter)) errors.push('debt card does not show its APR and interest cost');
step('debt goal models interest rather than dividing the balance');

// ── Budget config import ──
// The importer is the one flow that rewrites every allowance at once, so it has
// to be exercised end to end: parse, validate against the live account, preview,
// stage, and cancel. The config is built from the ids actually in IndexedDB
// rather than hard-coded, since an `update` that names the wrong id is exactly
// what validation is supposed to reject.
await page.getByRole('button', { name: 'Settings', exact: true }).click();
await page.waitForTimeout(600);

const configPayload = await page.evaluate(async () => {
  const open = () => new Promise((resolve, reject) => {
    const request = indexedDB.open('FinanceApp');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const readAll = (database, table) => new Promise((resolve, reject) => {
    const req = database.transaction(table, 'readonly').objectStore(table).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  const database = await open();
  const [accounts, incomes, categories] = await Promise.all([
    readAll(database, 'accounts'), readAll(database, 'incomes'), readAll(database, 'categories'),
  ]);
  const account = accounts[0];
  const income = incomes[0];
  const scoped = categories.filter(c => Number(c.accountId) === Number(account.id));

  // Keep every existing category at its current allowance, then add one
  // residual that absorbs whatever income is left — so the plan allocates
  // exactly 100% and the allocation check has something real to verify.
  const held = scoped.reduce((sum, c) => sum + (Number(c.allowance) || 0), 0);
  const residual = Math.round((income.amount - held) * 100) / 100;

  return {
    incomeName: income.name,
    incomeAmount: income.amount,
    residual,
    config: {
      schemaVersion: 1,
      kind: 'finesse.categoryConfig',
      targetAccountId: account.id,
      applyAt: 'next-cycle',
      baselineIncome: { id: income.id, name: income.name, amount: income.amount },
      variables: [{ action: 'create', id: null, name: 'SmokeRate', value: residual }],
      categories: [
        ...scoped.map((c, index) => ({
          action: 'update',
          id: c.id,
          name: `${c.name} Renamed`,
          renamedFrom: c.name,
          allowance: Math.round((Number(c.allowance) || 0) * 100) / 100,
          sortOrder: index + 1,
        })),
        {
          action: 'create',
          id: null,
          name: 'Smoke Savings',
          allowance: residual,
          allowanceFormula: '$SmokeRate',
          rollover: true,
          sortOrder: scoped.length + 1,
        },
      ],
      validation: { expectedIncomeTotal: income.amount, expectedAllowanceTotal: income.amount },
      importerNotes: ['Built by the smoke test from the live account.'],
    },
  };
});

// A malformed file must be rejected in the preview, with nothing staged.
await page.getByRole('button', { name: /Import Budget Config/ }).click();
await page.getByRole('dialog').waitFor({ timeout: 5000 });
// Scoped to the dialog: Settings' own backup importer also takes a .json file.
const configInput = page.getByRole('dialog').locator('input[type="file"]');
await configInput.setInputFiles({
  name: 'broken.json',
  mimeType: 'application/json',
  buffer: Buffer.from(JSON.stringify({ ...configPayload.config, kind: 'finesse.backup' })),
});
await page.waitForTimeout(600);

const rejected = await page.getByRole('dialog').innerText();
if (!/cannot be imported/i.test(rejected)) errors.push(`bad config was not rejected:\n${rejected}`);
if (!/Nothing has been changed/i.test(rejected)) errors.push('rejection does not say the data is untouched');
if (await page.getByRole('button', { name: /Stage for next payday/ }).isEnabled()) {
  errors.push('a config that failed validation can still be staged');
}
step('budget config importer rejects a malformed file without staging it');

// The same config, valid: it must preview, name the renames, and balance.
await configInput.setInputFiles({
  name: 'budget.json',
  mimeType: 'application/json',
  buffer: Buffer.from(JSON.stringify(configPayload.config)),
});
await page.waitForTimeout(600);

const preview = await page.getByRole('dialog').innerText();
if (!/Nothing changes today/i.test(preview)) errors.push('preview does not say the change is staged');
if (!/was “Groceries”/.test(preview)) errors.push(`preview does not mark the rename:\n${preview}`);
if (!/Smoke Savings/.test(preview)) errors.push('preview omits the created category');
if (!/rollover/.test(preview)) errors.push('preview does not mark the rollover category');
if (!/100%/.test(preview)) errors.push(`preview does not report a fully allocated budget:\n${preview}`);
step('budget config previews the diff and reports a fully allocated budget');

await page.getByRole('button', { name: /Stage for next payday/ }).click();
await page.getByRole('dialog').waitFor({ state: 'detached' });
await page.waitForTimeout(800);

// Staging must change nothing yet — the banner says when it will.
const staged = await page.locator('body').innerText();
if (!/New budget applies on/i.test(staged)) errors.push(`no staged-budget banner:\n${staged}`);
if (/Groceries Renamed/.test(staged)) errors.push('staging applied the config immediately');
step('staging shows a banner and leaves the current cycle untouched');

await page.getByRole('button', { name: 'Dashboard', exact: true }).click();
await page.waitForTimeout(500);
if (!/New budget applies on/i.test(await page.locator('body').innerText())) {
  errors.push('staged-budget banner does not follow the user across views');
}

await page.getByRole('button', { name: 'Cancel', exact: true }).first().click();
await page.getByRole('button', { name: 'Discard' }).click();
await page.waitForTimeout(800);
if (/New budget applies on/i.test(await page.locator('body').innerText())) {
  errors.push('cancelling a staged budget left the banner up');
}
step('a staged budget can be cancelled before it lands');

await browser.close();

if (errors.length) {
  console.error('\n✗ smoke test failed:\n' + errors.map(e => `  - ${e}`).join('\n'));
  process.exit(1);
}
console.log('\n✓ smoke test passed with no console errors');
