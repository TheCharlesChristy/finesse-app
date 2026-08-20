import Dexie from 'dexie';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import {
  db, addAccount, addCategory, addTransaction, addTransactionsBulk, getTransactions,
  addIncome, recordIncomeReceived, getIncomeEvents, exportData, importData,
  clearAllData, recalculateSpendCounters,
  enableEncryption, disableEncryption, unlockDatabase, unlockDatabaseWithRecovery,
  changeVaultSecret, regenerateRecoveryCode, resetVaultSecretWithRecovery,
  lockDatabase, initEncryption, getEncryptionState, getVaultRecord, resumeSealing,
} from '../db';
import {
  createVault, unlockWithSecret, unlockWithRecovery, rewrapSecret, rewrapRecovery,
  isValidSecret, secretKind, describeSecretStrength, createRecoveryCode,
  normaliseRecoveryCode, isValidRecoveryCode, formatRecoveryCode,
} from '../vault';
import { blindIndex, isSealed, resetEncryption } from '../dbCrypto';

// Argon2id at the shipped parameters costs about a second per derivation, and a
// suite nobody waits for is a suite nobody runs. The cost is a stored per-vault
// property precisely so it can vary; the algorithm under test does not.
const FAST = { t: 1, m: 512, p: 1 };
const SECRET = 'correct-horse-battery';

/**
 * The same database, read without the middleware.
 *
 * This is the only check that actually proves anything: asserting through the
 * app's own reads would pass just as happily if `seal` were the identity
 * function. A second Dexie connection with no middleware installed sees exactly
 * what an attacker with the raw storage would see.
 */
async function readRaw(tableName) {
  const raw = new Dexie('FinanceApp');
  raw.version(9).stores({
    accounts: '++id',
    accountTransfers: '++id, fromAccountId, toAccountId',
    incomeEvents: '++id, accountId, &receiptKey',
    settings: '++id, accountId',
    categories: '++id, accountId',
    transactions: '++id, accountId, categoryId, &subscriptionRunKey',
    wishlist: '++id, accountId',
    wishlistCategories: '++id, accountId',
    incomes: '++id, accountId',
    subscriptions: '++id, accountId, categoryId',
    variables: '++id, accountId',
    rules: '++id, accountId',
    templates: '++id, accountId',
    goals: '++id, accountId',
    vault: '++id',
  });
  await raw.open();
  const rows = await raw.table(tableName).toArray();
  raw.close();
  return rows;
}

let accountId;

beforeEach(async () => {
  resetEncryption();
  await Promise.all(db.tables.map(table => table.clear()));
  accountId = await addAccount({ name: 'Main', balance: 1000 });
});

afterEach(() => {
  resetEncryption();
});

describe('vault keys', () => {
  it('unwraps the master with the right secret and refuses the wrong one', async () => {
    const { record, keys } = await createVault(SECRET, { params: FAST });

    const opened = await unlockWithSecret(record, SECRET);
    expect(opened).not.toBeNull();
    expect([...opened.keys.rowKey]).toEqual([...keys.rowKey]);

    expect(await unlockWithSecret(record, 'wrong-passphrase-here')).toBeNull();
  });

  it('never stores the secret or a verifier for it', async () => {
    const { record } = await createVault('1234', { params: FAST });
    const serialised = JSON.stringify(record);
    expect(serialised).not.toContain('1234');
    // Nothing shaped like a stored digest to compare against: a wrong secret is
    // caught by the GCM tag, not by matching a hash.
    expect(record).not.toHaveProperty('pinHash');
    expect(record.secretWrap).toHaveProperty('data');
  });

  it('opens with the recovery code as well as the secret', async () => {
    const { record, recoveryCode, keys } = await createVault(SECRET, { params: FAST });

    const opened = await unlockWithRecovery(record, recoveryCode);
    expect(opened).not.toBeNull();
    expect([...opened.keys.rowKey]).toEqual([...keys.rowKey]);

    expect(await unlockWithRecovery(record, createRecoveryCode())).toBeNull();
  });

  it('will not let a recovery wrap be opened as the secret wrap', async () => {
    // Both wrap the same master under a KDF of the same shape, so only the
    // bound AAD stops one being presented in place of the other.
    const { record, recoveryCode } = await createVault(SECRET, { params: FAST });
    const swapped = { ...record, secretWrap: record.recoveryWrap, secretSalt: record.recoverySalt };
    expect(await unlockWithSecret(swapped, normaliseRecoveryCode(recoveryCode))).toBeNull();
  });

  it('changes the secret without changing the key', async () => {
    const { record, keys } = await createVault(SECRET, { params: FAST });
    const opened = await unlockWithSecret(record, SECRET);

    const next = await rewrapSecret(record, opened.master, '9182736455');
    expect(await unlockWithSecret(next, SECRET)).toBeNull();

    const reopened = await unlockWithSecret(next, '9182736455');
    expect([...reopened.keys.rowKey]).toEqual([...keys.rowKey]);
    expect(next.secretKind).toBe('pin');
  });

  it('re-mints a recovery code and retires the old one', async () => {
    const { record, recoveryCode } = await createVault(SECRET, { params: FAST });
    const opened = await unlockWithSecret(record, SECRET);

    const { record: next, recoveryCode: fresh } = await rewrapRecovery(record, opened.master);
    expect(fresh).not.toBe(recoveryCode);
    expect(await unlockWithRecovery(next, recoveryCode)).toBeNull();
    expect(await unlockWithRecovery(next, fresh)).not.toBeNull();
  });
});

describe('secrets and recovery codes', () => {
  it('classifies and bounds what it will accept', () => {
    expect(secretKind('1234')).toBe('pin');
    expect(secretKind('hunter2!!')).toBe('passphrase');
    expect(isValidSecret('123')).toBe(false);
    expect(isValidSecret('1234')).toBe(true);
    expect(isValidSecret('short')).toBe(false);
    expect(isValidSecret('longenough')).toBe(true);
  });

  it('is honest that a four-digit PIN falls quickly', () => {
    const pin = describeSecretStrength('1234');
    const phrase = describeSecretStrength('Tr0ubad0ur&Horses');
    expect(pin.level).toBe('weak');
    expect(phrase.level).toBe('strong');
    expect(phrase.seconds).toBeGreaterThan(pin.seconds);
  });

  it('forgives how a written-down code was transcribed', () => {
    const code = createRecoveryCode();
    expect(isValidRecoveryCode(code)).toBe(true);
    expect(isValidRecoveryCode(code.toLowerCase().replace(/-/g, ' '))).toBe(true);
    // Crockford: O reads as 0, I and L as 1.
    expect(normaliseRecoveryCode('O1IL')).toBe('0111');
    expect(formatRecoveryCode(normaliseRecoveryCode(code))).toBe(code);
    expect(isValidRecoveryCode('too-short')).toBe(false);
  });
});

describe('encrypting an existing database', () => {
  it('seals what was already there and reads it back unchanged', async () => {
    const categoryId = await addCategory({ accountId, name: 'Groceries', allowance: 200 });
    await addTransaction({ accountId, categoryId, amount: 42.5, note: 'Weekly shop', merchant: 'Tesco' });

    await enableEncryption(SECRET, { params: FAST });

    const [raw] = await readRaw('transactions');
    expect(isSealed(raw)).toBe(true);
    expect(JSON.stringify(raw)).not.toContain('Weekly shop');
    expect(JSON.stringify(raw)).not.toContain('Tesco');
    expect(JSON.stringify(raw)).not.toContain('42.5');
    // The indexes IndexedDB has to seek on are the declared exception.
    expect(raw.accountId).toBe(accountId);
    expect(raw.categoryId).toBe(categoryId);

    const [tx] = await getTransactions(accountId);
    expect(tx.note).toBe('Weekly shop');
    expect(tx.merchant).toBe('Tesco');
    expect(tx.amount).toBe(42.5);
  });

  it('hides a category name, which had an index before v9', async () => {
    await addCategory({ accountId, name: 'Therapy', allowance: 100 });
    await enableEncryption(SECRET, { params: FAST });

    const [raw] = await readRaw('categories');
    expect(JSON.stringify(raw)).not.toContain('Therapy');
  });

  it('seals rows written after it was turned on', async () => {
    await enableEncryption(SECRET, { params: FAST });
    const categoryId = await addCategory({ accountId, name: 'Later', allowance: 50 });
    await addTransaction({ accountId, categoryId, amount: 9.99, note: 'Bought afterwards' });

    const raws = await readRaw('transactions');
    expect(raws.every(isSealed)).toBe(true);
    expect(JSON.stringify(raws)).not.toContain('Bought afterwards');
  });

  it('locks and reopens with the secret, and refuses the wrong one', async () => {
    const categoryId = await addCategory({ accountId, name: 'Bills', allowance: 300 });
    await addTransaction({ accountId, categoryId, amount: 12, note: 'Water' });
    await enableEncryption(SECRET, { params: FAST });

    lockDatabase();
    await expect(getTransactions(accountId)).rejects.toThrow(/locked/i);

    expect(await unlockDatabase('not-the-secret')).toBe(false);
    expect(await unlockDatabase(SECRET)).toBe(true);
    const [tx] = await getTransactions(accountId);
    expect(tx.note).toBe('Water');
  });

  it('refuses to write while locked rather than writing in the clear', async () => {
    const categoryId = await addCategory({ accountId, name: 'Bills', allowance: 300 });
    await enableEncryption(SECRET, { params: FAST });
    lockDatabase();

    await expect(addTransaction({ accountId, categoryId, amount: 5, note: 'Sneaky' }))
      .rejects.toThrow(/locked/i);
  });

  it('reopens with the recovery code when the secret is gone', async () => {
    const categoryId = await addCategory({ accountId, name: 'Travel', allowance: 80 });
    await addTransaction({ accountId, categoryId, amount: 30, note: 'Train' });
    const { recoveryCode } = await enableEncryption(SECRET, { params: FAST });

    lockDatabase();
    expect(await unlockDatabaseWithRecovery(recoveryCode)).toBe(true);
    const [tx] = await getTransactions(accountId);
    expect(tx.note).toBe('Train');
  });

  it('sets a new secret from the recovery code in one step', async () => {
    const { recoveryCode } = await enableEncryption(SECRET, { params: FAST });
    lockDatabase();

    expect(await resetVaultSecretWithRecovery(recoveryCode, '456789')).toBe(true);
    lockDatabase();
    expect(await unlockDatabase(SECRET)).toBe(false);
    expect(await unlockDatabase('456789')).toBe(true);
  });
});

describe('binary fields', () => {
  it('seals receipt bytes separately and opens them on demand', async () => {
    const categoryId = await addCategory({ accountId, name: 'Food', allowance: 100 });
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4, 5]);
    await addTransaction({
      accountId, categoryId, amount: 8, note: 'Lunch',
      receipt: bytes, receiptMeta: { type: 'image/jpeg', bytes: bytes.length },
    });

    await enableEncryption(SECRET, { params: FAST });

    const [raw] = await readRaw('transactions');
    // Held apart from the row's own ciphertext, so a list render never pays to
    // decrypt an image it isn't showing.
    expect(raw.__b).toHaveProperty('receipt');
    expect(Buffer.from(raw.__b.receipt.d).includes(Buffer.from(bytes))).toBe(false);

    const [tx] = await getTransactions(accountId);
    expect([...tx.receipt]).toEqual([...bytes]);
    // Reading twice must not consume or corrupt it.
    expect([...tx.receipt]).toEqual([...bytes]);
  });

  it('converts a legacy Blob receipt to bytes as it seals it', async () => {
    const categoryId = await addCategory({ accountId, name: 'Food', allowance: 100 });
    await addTransaction({
      accountId, categoryId, amount: 3, note: 'Old receipt',
      receipt: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
      receiptMeta: { bytes: 3 },
    });

    await enableEncryption(SECRET, { params: FAST });

    const [tx] = await getTransactions(accountId);
    expect([...tx.receipt]).toEqual([1, 2, 3]);
    expect(tx.receiptMeta.type).toBe('image/png');
  });

  it('keeps a receipt out of an export without decrypting it', async () => {
    const categoryId = await addCategory({ accountId, name: 'Food', allowance: 100 });
    await addTransaction({
      accountId, categoryId, amount: 8, note: 'Lunch',
      receipt: new Uint8Array([9, 9, 9]), receiptMeta: { type: 'image/jpeg', bytes: 3 },
    });
    await enableEncryption(SECRET, { params: FAST });

    const payload = await exportData();
    expect(payload.receiptsOmitted).toBe(1);
    expect(payload.transactions[0]).not.toHaveProperty('receipt');
    expect(payload.transactions[0].note).toBe('Lunch');
  });
});

describe('blinded dedupe keys', () => {
  it('keeps the raw key out of the index but still dedupes on it', async () => {
    const incomeId = await addIncome({ accountId, name: 'Salary', amount: 2000, frequency: 'monthly' });
    await enableEncryption(SECRET, { params: FAST });

    const when = '2026-03-01T00:00:00.000Z';
    const first = await recordIncomeReceived({
      accountId, incomeId, name: 'Salary', amount: 2000, date: when, type: 'recurring',
    });
    const second = await recordIncomeReceived({
      accountId, incomeId, name: 'Salary', amount: 2000, date: when, type: 'recurring',
    });

    expect(second).toBe(first);
    expect(await getIncomeEvents(accountId)).toHaveLength(1);

    const [raw] = await readRaw('incomeEvents');
    expect(raw.receiptKey).not.toContain(when);
    expect(raw.receiptKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('passes the value straight through when nothing is encrypted', () => {
    expect(blindIndex('1:income:2:2026-01-01')).toBe('1:income:2:2026-01-01');
    expect(blindIndex(null)).toBeNull();
  });
});

describe('turning it off again', () => {
  it('rewrites every row in the clear and drops the vault', async () => {
    const categoryId = await addCategory({ accountId, name: 'Groceries', allowance: 200 });
    await addTransaction({
      accountId, categoryId, amount: 42.5, note: 'Weekly shop',
      receipt: new Uint8Array([4, 5, 6]), receiptMeta: { type: 'image/jpeg', bytes: 3 },
    });
    await enableEncryption(SECRET, { params: FAST });

    expect(await disableEncryption()).toBe(true);

    const [raw] = await readRaw('transactions');
    expect(isSealed(raw)).toBe(false);
    expect(raw.note).toBe('Weekly shop');
    expect([...raw.receipt]).toEqual([4, 5, 6]);
    expect(await getVaultRecord()).toBeNull();

    const [tx] = await getTransactions(accountId);
    expect(tx.note).toBe('Weekly shop');
  });

  it('restores a blinded dedupe key so nothing records itself twice', async () => {
    const incomeId = await addIncome({ accountId, name: 'Salary', amount: 2000, frequency: 'monthly' });
    await enableEncryption(SECRET, { params: FAST });

    const when = '2026-04-01T00:00:00.000Z';
    const first = await recordIncomeReceived({
      accountId, incomeId, name: 'Salary', amount: 2000, date: when, type: 'recurring',
    });
    await disableEncryption();

    const again = await recordIncomeReceived({
      accountId, incomeId, name: 'Salary', amount: 2000, date: when, type: 'recurring',
    });
    expect(again).toBe(first);
    expect(await getIncomeEvents(accountId)).toHaveLength(1);
  });

  it('needs the key, so it cannot be done from a locked device', async () => {
    await enableEncryption(SECRET, { params: FAST });
    lockDatabase();
    await expect(disableEncryption()).rejects.toThrow(/unlock/i);
  });
});

describe('an interrupted first pass', () => {
  it('leaves the database readable and finishes at the next unlock', async () => {
    const categoryId = await addCategory({ accountId, name: 'Bills', allowance: 300 });
    await addTransaction({ accountId, categoryId, amount: 20, note: 'Gas' });
    await enableEncryption(SECRET, { params: FAST });

    // Rewind to the state a tab closed mid-migration would leave behind: the
    // vault exists, some tables are sealed, and the marker says it never ended.
    const record = await getVaultRecord();
    await db.vault.put({ ...record, sealedAt: null, sealedTables: ['accounts'] });

    lockDatabase();
    await initEncryption();
    expect((await getEncryptionState()).sealed).toBe(false);

    expect(await unlockDatabase(SECRET)).toBe(true);
    expect((await getEncryptionState()).sealed).toBe(true);
    expect(await resumeSealing()).toBe(false);

    const [tx] = await getTransactions(accountId);
    expect(tx.note).toBe('Gas');
  });
});

describe('changing the secret through db.js', () => {
  it('rejects the wrong current secret and accepts the right one', async () => {
    await enableEncryption(SECRET, { params: FAST });

    expect(await changeVaultSecret('wrong-one-entirely', '112233')).toBe(false);
    expect(await changeVaultSecret(SECRET, '112233')).toBe(true);

    lockDatabase();
    expect(await unlockDatabase('112233')).toBe(true);
  });

  it('issues a fresh recovery code for the current secret', async () => {
    const { recoveryCode } = await enableEncryption(SECRET, { params: FAST });
    expect(await regenerateRecoveryCode('nope-not-this')).toBeNull();

    const fresh = await regenerateRecoveryCode(SECRET);
    expect(fresh).not.toBe(recoveryCode);

    lockDatabase();
    expect(await unlockDatabaseWithRecovery(recoveryCode)).toBe(false);
    expect(await unlockDatabaseWithRecovery(fresh)).toBe(true);
  });
});

describe('query paths that do not go through get()', () => {
  it('opens rows arriving by cursor, not just by key', async () => {
    const categoryId = await addCategory({ accountId, name: 'Coffee', allowance: 40 });
    await addTransaction({ accountId, categoryId, amount: 3.2, note: 'Flat white' });
    await addTransaction({ accountId, categoryId, amount: 2.8, note: 'Filter' });
    await enableEncryption(SECRET, { params: FAST });

    // `.filter()` forces Dexie down the cursor path rather than `getAll`, which
    // is a separate hook in the middleware and would silently hand back sealed
    // rows if it were missed.
    const cheap = await db.transactions.filter(tx => tx.amount < 3).toArray();
    expect(cheap.map(tx => tx.note)).toEqual(['Filter']);

    const seen = [];
    await db.transactions.each(tx => seen.push(tx.note));
    expect(seen.sort()).toEqual(['Filter', 'Flat white']);
  });

  it('modifies a sealed row in place and re-seals it', async () => {
    const categoryId = await addCategory({ accountId, name: 'Coffee', allowance: 40 });
    await addTransaction({ accountId, categoryId, amount: 3.2, note: 'Flat white' });
    await enableEncryption(SECRET, { params: FAST });

    await db.transactions.where('categoryId').equals(categoryId)
      .modify({ note: 'Cortado' });

    const [tx] = await getTransactions(accountId);
    expect(tx.note).toBe('Cortado');
    const [raw] = await readRaw('transactions');
    expect(isSealed(raw)).toBe(true);
    expect(JSON.stringify(raw)).not.toContain('Cortado');
  });

  it('deletes through a collection without needing to read the plaintext', async () => {
    const categoryId = await addCategory({ accountId, name: 'Coffee', allowance: 40 });
    await addTransaction({ accountId, categoryId, amount: 3.2, note: 'Flat white' });
    await enableEncryption(SECRET, { params: FAST });

    await db.transactions.where('categoryId').equals(categoryId).delete();
    expect(await getTransactions(accountId)).toHaveLength(0);
  });

  it('bulk-adds sealed rows and keeps the spend counter in step', async () => {
    const categoryId = await addCategory({ accountId, name: 'Sundries', allowance: 90 });
    await enableEncryption(SECRET, { params: FAST });

    await addTransactionsBulk({
      accountId,
      categoryId,
      transactions: [
        { amount: 10, note: 'One', date: new Date().toISOString() },
        { amount: 15, note: 'Two', date: new Date().toISOString() },
      ],
    });

    const rows = await getTransactions(accountId);
    expect(rows.map(tx => tx.note).sort()).toEqual(['One', 'Two']);
    expect((await db.categories.get(categoryId)).spent).toBe(25);
    expect((await readRaw('transactions')).every(isSealed)).toBe(true);
  });

  it('rebuilds spend counters from sealed rows', async () => {
    const categoryId = await addCategory({ accountId, name: 'Sundries', allowance: 90 });
    await addTransaction({ accountId, categoryId, amount: 12, note: 'Thing' });
    await enableEncryption(SECRET, { params: FAST });

    await db.categories.update(categoryId, { spent: 999 });
    const report = await recalculateSpendCounters(accountId);
    expect(report.repaired).toBe(1);
    expect((await db.categories.get(categoryId)).spent).toBe(12);
  });
});

describe('the paths that wipe tables', () => {
  it('keeps the vault through a full reset, so the secret still opens the device', async () => {
    await addCategory({ accountId, name: 'Bills', allowance: 300 });
    await enableEncryption(SECRET, { params: FAST });

    await clearAllData();

    // Clearing the data must not quietly turn encryption off. If the vault went
    // with the rows, the next write would be sealed under a key whose only wrap
    // had just been deleted — unreadable from the next launch onwards.
    expect(await getVaultRecord()).not.toBeNull();
    lockDatabase();
    expect(await unlockDatabase(SECRET)).toBe(true);
  });

  it('seals rows arriving from a plaintext backup', async () => {
    const categoryId = await addCategory({ accountId, name: 'Groceries', allowance: 200 });
    await addTransaction({ accountId, categoryId, amount: 18, note: 'Backed up' });
    const backup = await exportData();

    await enableEncryption(SECRET, { params: FAST });
    await importData(backup, 'replace');

    const raws = await readRaw('transactions');
    expect(raws.length).toBeGreaterThan(0);
    expect(raws.every(isSealed)).toBe(true);
    expect(JSON.stringify(raws)).not.toContain('Backed up');

    const notes = (await getTransactions(null)).map(tx => tx.note);
    expect(notes).toContain('Backed up');
  });
});

describe('values the codec refuses', () => {
  it('rejects a Date rather than handing back a string', async () => {
    const categoryId = await addCategory({ accountId, name: 'Bills', allowance: 50 });
    await enableEncryption(SECRET, { params: FAST });

    // Storing this unencrypted works, so the failure has to be loud: JSON would
    // turn it into a string and nothing downstream would know why its date
    // arithmetic had started behaving oddly.
    await expect(addTransaction({
      accountId, categoryId, amount: 5, note: 'When', reviewedAt: new Date(),
    })).rejects.toThrow(/ISO string/);
  });

  it('rejects a Blob, which no synchronous cipher can read', async () => {
    const categoryId = await addCategory({ accountId, name: 'Bills', allowance: 50 });
    await enableEncryption(SECRET, { params: FAST });

    await expect(addTransaction({
      accountId, categoryId, amount: 5, note: 'Photo',
      receipt: new Blob([new Uint8Array([1])]),
    })).rejects.toThrow(/store bytes instead/);
  });
});

describe('restoring a backup that predates blinding', () => {
  it('blinds a raw dedupe key on the way in', async () => {
    const incomeId = await addIncome({ accountId, name: 'Salary', amount: 2000, frequency: 'monthly' });
    const when = '2026-05-01T00:00:00.000Z';
    await recordIncomeReceived({
      accountId, incomeId, name: 'Salary', amount: 2000, date: when, type: 'recurring',
    });
    const backup = await exportData();
    // Strip the twin, leaving the shape a pre-encryption export had.
    backup.incomeEvents = backup.incomeEvents.map(({ receiptKeyPlain, ...rest }) => rest);
    expect(backup.incomeEvents[0].receiptKey).toContain(when);

    await enableEncryption(SECRET, { params: FAST });
    await importData(backup, 'replace');

    const [raw] = await readRaw('incomeEvents');
    expect(raw.receiptKey).not.toContain(when);
    expect(raw.receiptKey).toMatch(/^[0-9a-f]{64}$/);
  });
});
