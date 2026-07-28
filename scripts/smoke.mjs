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
await page.getByLabel('Note (optional)').fill('Tesco');
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

await browser.close();

if (errors.length) {
  console.error('\n✗ smoke test failed:\n' + errors.map(e => `  - ${e}`).join('\n'));
  process.exit(1);
}
console.log('\n✓ smoke test passed with no console errors');
