/**
 * Reading a bank statement.
 *
 * Every transaction in Finesse is typed by hand, which is the single biggest
 * reason a budget stops being accurate: the app is only as good as the last
 * evening someone spent catching up on it. A statement export closes that gap,
 * but bank CSVs are a genuinely hostile format — no two banks agree on column
 * names, date order, how a debit is signed, or whether "money out" is a
 * negative number, a separate column, or a word in a type field.
 *
 * So nothing here guesses silently. The parser reports what it found, the
 * mapping is a suggestion the user confirms, and every row is shown with its
 * resolved category and duplicate status before a single write happens.
 *
 * Pure, like utils.js and prediction.js: no Dexie, no React, no I/O. The caller
 * hands in the text and the existing transactions, and gets back rows ready for
 * `addTransactionsBulk`.
 */

import { TX_EXPENSE, TX_REFUND } from './utils';

// ── Delimited text ───────────────────────────────────────────────────────────

const DELIMITERS = [',', ';', '\t', '|'];

/**
 * Which delimiter this file actually uses.
 *
 * Decided by which one yields the most *consistent* column count across the
 * first few lines rather than which appears most often: a description field
 * full of commas would otherwise beat the semicolons actually separating the
 * columns.
 */
export function detectDelimiter(text = '') {
  const sample = String(text).split(/\r?\n/).filter(line => line.trim()).slice(0, 8);
  if (!sample.length) return ',';

  let best = ',';
  let bestScore = -Infinity;

  for (const delimiter of DELIMITERS) {
    const counts = sample.map(line => splitLine(line, delimiter).length);
    const columns = counts[0];
    if (columns < 2) continue;
    // Consistency first, column count as the tie-break.
    const consistent = counts.filter(count => count === columns).length;
    const score = consistent * 10 + columns;
    if (score > bestScore) {
      bestScore = score;
      best = delimiter;
    }
  }

  return best;
}

/** Split one line, honouring quotes. Doubled quotes inside a field are literal. */
function splitLine(line, delimiter) {
  const fields = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"') {
        if (line[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += char;
    } else if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      fields.push(field);
      field = '';
    } else {
      field += char;
    }
  }

  fields.push(field);
  return fields;
}

/**
 * Parse delimited text into headers and rows.
 *
 * Handles quoted fields containing the delimiter, newlines and escaped quotes,
 * which rules out a line-by-line split — a description like "PAYMENT, THANK
 * YOU\nREF 123" is one field spanning two physical lines.
 *
 * Rows are padded or trimmed to the header width so a malformed line can't
 * shift every subsequent column.
 */
export function parseCsv(text = '', delimiter = null) {
  const clean = String(text).replace(/^﻿/, '');   // strip the BOM Excel adds
  if (!clean.trim()) return { headers: [], rows: [], delimiter: delimiter || ',' };

  const sep = delimiter || detectDelimiter(clean);
  const records = [];
  let field = '';
  let record = [];
  let quoted = false;

  const endField = () => { record.push(field); field = ''; };
  const endRecord = () => {
    endField();
    if (record.some(value => value.trim() !== '')) records.push(record);
    record = [];
  };

  for (let i = 0; i < clean.length; i += 1) {
    const char = clean[i];

    if (quoted) {
      if (char === '"') {
        if (clean[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += char;
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === sep) endField();
    else if (char === '\r') { if (clean[i + 1] === '\n') i += 1; endRecord(); }
    else if (char === '\n') endRecord();
    else field += char;
  }
  if (field !== '' || record.length) endRecord();

  if (!records.length) return { headers: [], rows: [], delimiter: sep };

  const headers = records[0].map(header => header.trim());
  const width = headers.length;
  const rows = records.slice(1).map(values => {
    const padded = values.slice(0, width);
    while (padded.length < width) padded.push('');
    return padded.map(value => value.trim());
  });

  return { headers, rows, delimiter: sep };
}

// ── Values ───────────────────────────────────────────────────────────────────

/**
 * A money value from a statement cell.
 *
 * Copes with currency symbols, thousands separators, a trailing or leading
 * sign, and accountancy parentheses — "(12.34)" is how a good many exports
 * write a negative. Returns null for anything that isn't a number, which is how
 * the caller tells "no value in this column" from "zero".
 */
export function parseAmount(value) {
  if (value == null) return null;
  let text = String(value).trim();
  if (!text) return null;

  let negative = false;
  if (/^\(.*\)$/.test(text)) { negative = true; text = text.slice(1, -1); }

  text = text.replace(/[£$€\s]/g, '');
  if (text.endsWith('-')) { negative = true; text = text.slice(0, -1); }
  if (text.startsWith('-')) { negative = true; text = text.slice(1); }
  if (text.startsWith('+')) text = text.slice(1);

  // Thousands separators, in either convention. The last separator present
  // decides which is the decimal point: "1.234,56" is European, "1,234.56" is
  // not, and "1,234" is a whole number in both.
  const lastComma = text.lastIndexOf(',');
  const lastDot = text.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) text = text.replace(/\./g, '').replace(',', '.');
    else text = text.replace(/,/g, '');
  } else if (lastComma >= 0) {
    // A lone comma is decimal only when it isn't grouping three digits.
    text = /,\d{3}$/.test(text) ? text.replace(/,/g, '') : text.replace(',', '.');
  }

  if (!/^\d*\.?\d+$/.test(text)) return null;
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/**
 * A date from a statement cell, as `yyyy-MM-dd`.
 *
 * Day-first is the default for an ambiguous numeric date, since this is a
 * GBP app and every UK bank writes dd/mm/yyyy — but `dayFirst: false` is
 * offered because getting this backwards silently moves half a year's
 * transactions to the wrong month, and only the user can settle it.
 */
export function parseStatementDate(value, { dayFirst = true } = {}) {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;

  // ISO, and the only unambiguous numeric form.
  const iso = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return toDateString(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // "15 Jan 2026", "15-Jan-26", "Jan 15 2026".
  const named = text.match(/^(\d{1,2})[\s\-/]*([A-Za-z]{3,})[\s\-/]*(\d{2,4})$/)
    || text.match(/^([A-Za-z]{3,})[\s\-/]*(\d{1,2})[\s,\-/]*(\d{2,4})$/);
  if (named) {
    const monthFirst = Number.isNaN(Number(named[1]));
    const day = Number(monthFirst ? named[2] : named[1]);
    const month = MONTHS[String(monthFirst ? named[1] : named[2]).slice(0, 3).toLowerCase()];
    if (month != null) return toDateString(expandYear(Number(named[3])), month + 1, day);
  }

  const numeric = text.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})/);
  if (numeric) {
    const first = Number(numeric[1]);
    const second = Number(numeric[2]);
    // A value above 12 can only be the day, whatever the stated preference.
    const dayIsFirst = first > 12 ? true : second > 12 ? false : dayFirst;
    const day = dayIsFirst ? first : second;
    const month = dayIsFirst ? second : first;
    return toDateString(expandYear(Number(numeric[3])), month, day);
  }

  return null;
}

function expandYear(year) {
  if (year >= 1000) return year;
  // A two-digit year on a bank statement is this century.
  return 2000 + year;
}

function toDateString(year, month, day) {
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return null;
  const date = new Date(year, month - 1, day);
  // Rejects 31 February and friends, which `Date` would roll forward.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

// ── Column mapping ───────────────────────────────────────────────────────────

const HEADER_HINTS = {
  date: [/^date$/i, /transaction\s*date/i, /posting\s*date/i, /value\s*date/i, /^date\b/i, /date/i],
  description: [/^description$/i, /^details$/i, /^narrative$/i, /^reference$/i, /^payee$/i,
    /^merchant$/i, /^name$/i, /transaction\s*(description|information)/i, /description|details|narrative|payee|merchant|reference/i],
  amount: [/^amount$/i, /^value$/i, /transaction\s*amount/i, /^amount\b/i, /amount|value/i],
  debit: [/^debit$/i, /money\s*out/i, /paid\s*out/i, /^withdrawal/i, /debit|out|withdraw/i],
  credit: [/^credit$/i, /money\s*in/i, /paid\s*in/i, /^deposit/i, /credit|in\b|deposit/i],
  balance: [/^balance$/i, /running\s*balance/i, /balance/i],
};

function scoreHeader(header, patterns) {
  for (let i = 0; i < patterns.length; i += 1) {
    if (patterns[i].test(header)) return patterns.length - i;
  }
  return 0;
}

/**
 * Suggest which column is which.
 *
 * Earlier patterns score higher, so an exact "Amount" beats a fuzzy match on
 * "Amount in account currency". Each column is claimed at most once, strongest
 * match first, which stops "Debit" and "Credit" both landing on the same
 * column when a file has only one of them.
 *
 * Debit/credit only survive if the file has no single amount column, since a
 * file with all three would otherwise double-count.
 */
export function guessColumnMapping(headers = []) {
  const candidates = [];
  for (const [field, patterns] of Object.entries(HEADER_HINTS)) {
    headers.forEach((header, index) => {
      const score = scoreHeader(header, patterns);
      if (score > 0) candidates.push({ field, index, score });
    });
  }

  candidates.sort((a, b) => b.score - a.score || a.index - b.index);

  const mapping = { date: null, description: null, amount: null, debit: null, credit: null, balance: null };
  const takenColumns = new Set();

  for (const { field, index } of candidates) {
    if (mapping[field] != null || takenColumns.has(index)) continue;
    mapping[field] = index;
    takenColumns.add(index);
  }

  if (mapping.amount != null) {
    mapping.debit = null;
    mapping.credit = null;
  }

  return mapping;
}

// ── Row building ─────────────────────────────────────────────────────────────

/** Strip the noise banks add so two spellings of one purchase compare equal. */
export function normaliseDescription(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/\b\d{2}[/-]\d{2}[/-]\d{2,4}\b/g, ' ')     // embedded dates
    .replace(/\bx{2,}\d+\b/gi, ' ')                      // masked card numbers
    // The connector words matter as much as the nouns: "CARD PAYMENT TO TESCO"
    // must reduce to the same thing as "TESCO", and dropping only "payment"
    // leaves a stray "to" that breaks the comparison.
    .replace(/\b(card|ref|reference|payment|purchase|pos|visa|mastercard|to|from|on|at)\b/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The key an exact duplicate shares: same day, same amount, same description. */
export function buildDedupeKey({ date, amount, description }) {
  const day = String(date || '').slice(0, 10);
  return `${day}|${Math.abs(Number(amount) || 0).toFixed(2)}|${normaliseDescription(description)}`;
}

/** The looser key: same day and amount, whatever the wording. */
export function buildLooseKey({ date, amount }) {
  const day = String(date || '').slice(0, 10);
  return `${day}|${Math.abs(Number(amount) || 0).toFixed(2)}`;
}

export const ROW_NEW = 'new';
export const ROW_DUPLICATE = 'duplicate';
export const ROW_SIMILAR = 'similar';
export const ROW_INVALID = 'invalid';

/**
 * Turn parsed rows into reviewable import candidates.
 *
 * Every row carries why it is what it is: which category was suggested and on
 * what basis, whether it looks like something already logged, and — for rows
 * that can't be imported — what was wrong with them. The caller renders that
 * and lets the user override any of it.
 *
 * `suggestCategory` is injected rather than imported so this module stays free
 * of the rules/history plumbing; the modal passes a closure over
 * `suggestCategoryForNote`.
 */
export function buildImportRows({
  rows = [],
  mapping = {},
  existingTransactions = [],
  suggestCategory = null,
  defaultCategoryId = null,
  dayFirst = true,
  invertSigns = false,
} = {}) {
  const exactKeys = new Set();
  const looseKeys = new Set();
  for (const tx of existingTransactions) {
    const entry = { date: tx.date, amount: tx.amount, description: tx.merchant || tx.note || '' };
    exactKeys.add(buildDedupeKey(entry));
    looseKeys.add(buildLooseKey(entry));
  }

  // Duplicates *within* the file matter too — a statement re-exported over an
  // overlapping window repeats rows, and only the first is genuinely new.
  const seenInFile = new Set();

  return rows.map((values, index) => {
    const rawDate = mapping.date != null ? values[mapping.date] : '';
    const description = mapping.description != null ? String(values[mapping.description] || '').trim() : '';
    const date = parseStatementDate(rawDate, { dayFirst });

    let signed = null;
    if (mapping.amount != null) {
      signed = parseAmount(values[mapping.amount]);
    } else {
      const debit = mapping.debit != null ? parseAmount(values[mapping.debit]) : null;
      const credit = mapping.credit != null ? parseAmount(values[mapping.credit]) : null;
      // Separate columns are written as positive magnitudes; the column is the
      // sign. Only one of the pair is ever filled in on a given row.
      if (debit) signed = -Math.abs(debit);
      else if (credit) signed = Math.abs(credit);
    }

    if (signed != null && invertSigns) signed = -signed;

    const row = {
      index,
      raw: values,
      date,
      rawDate: String(rawDate || '').trim(),
      description,
      // Money out is an expense; money in is a refund. Stored positive either
      // way, with `type` carrying the direction, as everywhere else in the app.
      amount: signed == null ? null : Math.abs(signed),
      type: signed != null && signed > 0 ? TX_REFUND : TX_EXPENSE,
      balance: mapping.balance != null ? parseAmount(values[mapping.balance]) : null,
      categoryId: defaultCategoryId != null ? Number(defaultCategoryId) : null,
      suggestion: null,
      status: ROW_NEW,
      problem: null,
      include: true,
    };

    if (!date) {
      row.status = ROW_INVALID;
      row.problem = rawDate ? `Couldn’t read the date “${row.rawDate}”` : 'No date';
    } else if (signed == null || row.amount === 0) {
      row.status = ROW_INVALID;
      row.problem = 'No amount';
    }

    if (row.status !== ROW_INVALID) {
      const entry = { date, amount: row.amount, description };
      const exact = buildDedupeKey(entry);
      const loose = buildLooseKey(entry);

      if (exactKeys.has(exact) || seenInFile.has(exact)) {
        row.status = ROW_DUPLICATE;
        row.problem = 'Already logged';
      } else if (looseKeys.has(loose)) {
        row.status = ROW_SIMILAR;
        row.problem = 'Same day and amount as something already logged';
      }
      seenInFile.add(exact);

      if (suggestCategory && description) {
        const hint = suggestCategory(description);
        if (hint) {
          row.suggestion = hint;
          row.categoryId = Number(hint.categoryId);
        }
      }
    }

    // An exact duplicate is off by default; a loose match is left on, because
    // two coffees on one day is at least as likely as a double import.
    row.include = row.status === ROW_NEW || row.status === ROW_SIMILAR;
    if (row.status === ROW_INVALID) row.include = false;

    return row;
  });
}

/** Rows the user has kept, in the shape `addTransactionsBulk` expects. */
export function toTransactionPayload(rows = []) {
  return rows
    .filter(row => row.include && row.status !== ROW_INVALID && row.categoryId && row.amount > 0)
    .map(row => ({
      categoryId: Number(row.categoryId),
      amount: row.amount,
      note: row.description,
      merchant: row.description,
      type: row.type,
      date: `${row.date}T12:00:00.000Z`,
      importedAt: new Date().toISOString(),
    }));
}

/**
 * Headline counts for the review screen.
 *
 * `selected` is what the user has ticked; `importable` is what will actually be
 * written, which is smaller whenever a ticked row still has no category. The
 * two are kept apart because the button must promise the second — offering to
 * import three rows and then writing none, because `toTransactionPayload` drops
 * the uncategorised ones, is indistinguishable from the import silently failing.
 *
 * The money totals follow `importable` for the same reason: a row that won't be
 * written mustn't contribute to the spending figure shown beside the button.
 */
export function summariseRows(rows = []) {
  const summary = {
    total: rows.length, new: 0, duplicate: 0, similar: 0, invalid: 0,
    selected: 0, importable: 0, uncategorised: 0, expense: 0, refund: 0, net: 0,
  };

  for (const row of rows) {
    summary[row.status] += 1;
    if (!row.include || row.status === ROW_INVALID) continue;
    summary.selected += 1;

    if (!row.categoryId) {
      summary.uncategorised += 1;
      continue;
    }

    summary.importable += 1;
    if (row.type === TX_REFUND) { summary.refund += row.amount; summary.net -= row.amount; }
    else { summary.expense += row.amount; summary.net += row.amount; }
  }

  summary.expense = roundTo2(summary.expense);
  summary.refund = roundTo2(summary.refund);
  summary.net = roundTo2(summary.net);
  return summary;
}

// csv.js stays free of utils' money helpers so it can be read on its own; this
// is the only place it needs rounding.
function roundTo2(value) {
  return Math.round(value * 100) / 100;
}

// ── Reconciliation ───────────────────────────────────────────────────────────

/**
 * Compare the statement's closing balance against the app's.
 *
 * `account.balance` is maintained by arithmetic on every mutation, so it can
 * drift from reality in ways nothing else in the app would ever notice —
 * a cash withdrawal spent over a week, a transaction logged twice, an edit that
 * missed. The statement is the authority; this is the only thing in Finesse
 * that can tell you the two disagree.
 *
 * The tolerance is a penny, to absorb float noise rather than real error.
 */
export function reconcile(statementBalance, accountBalance, { tolerance = 0.01 } = {}) {
  // `Number(null)` and `Number('')` are both 0, so a missing balance would
  // otherwise reconcile against zero and report the entire account as drift.
  if (statementBalance == null || statementBalance === '') return null;
  if (accountBalance == null || accountBalance === '') return null;

  const statement = Number(statementBalance);
  const app = Number(accountBalance);
  if (!Number.isFinite(statement) || !Number.isFinite(app)) return null;

  const difference = Math.round((statement - app) * 100) / 100;
  return {
    statementBalance: statement,
    accountBalance: app,
    difference,
    matches: Math.abs(difference) <= tolerance,
  };
}

/**
 * The closing balance a statement implies: the balance column of its last row.
 *
 * Rows are ordered by date rather than trusted as given — plenty of banks
 * export newest-first, which would otherwise take the *opening* balance as the
 * closing one and report a difference the size of the whole statement.
 */
export function inferClosingBalance(rows = []) {
  const withBalance = rows.filter(row => row.balance != null && row.date);
  if (!withBalance.length) return null;

  const sorted = [...withBalance].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.index - b.index));
  return sorted[sorted.length - 1].balance;
}
