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
step('first-run onboarding renders');

await page.getByRole('button', { name: 'Add your first income' }).click();
await page.getByRole('dialog').waitFor();
await page.getByLabel('Name').fill('Salary');
await page.getByLabel('Amount (£)').fill('2000');
await page.getByRole('button', { name: 'Add Income', exact: true }).click();
await page.getByRole('dialog').waitFor({ state: 'detached' });
step('income added');

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
                    'Forecasting', 'Wishlist', 'Variables', 'Settings', 'Dashboard']) {
  await page.getByRole('button', { name, exact: true }).click();
  await page.waitForTimeout(350);
  const heading = await page.locator('h1').innerText();
  if (!heading.includes(name)) errors.push(`view "${name}" did not render (h1 was "${heading}")`);
}
step('all 10 views render');

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
const forecast = await page.locator('body').innerText();
for (const expected of ['Account Balance', 'Where Your Money Goes']) {
  if (!forecast.includes(expected)) errors.push(`forecasting missing: ${expected}`);
}
step('balance history and merchant breakdown render');

await browser.close();

if (errors.length) {
  console.error('\n✗ smoke test failed:\n' + errors.map(e => `  - ${e}`).join('\n'));
  process.exit(1);
}
console.log('\n✓ smoke test passed with no console errors');
