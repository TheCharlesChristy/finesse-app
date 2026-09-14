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
  // The separator classes include "." because a statement that abbreviates
  // its month often writes the period too — "05 Jan. 2026". A numeric date
  // separated by periods ("05.01.26") is read by the branch below instead,
  // since that one can't contain three letters.
  const named = text.match(/^(\d{1,2})[\s\-/.]*([A-Za-z]{3,})[\s\-/.]*(\d{2,4})$/)
    || text.match(/^([A-Za-z]{3,})[\s\-/.]*(\d{1,2})[\s,\-/.]*(\d{2,4})$/);
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

// ── Free-form statement text (OCR / a PDF's own text layer) ─────────────────

const LEADING_DATE_PATTERNS = [
  /^(\d{4}-\d{1,2}-\d{1,2})\b/,
  /^(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})\b/,
  /^(\d{1,2}\s*[A-Za-z]{3,9}\.?\s*\d{2,4})\b/,
  /^([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{2,4})\b/,
  // A statement that prints the year once in its header writes each row as
  // just "05 Jan" or "05/01" — common on UK current-account statements, and
  // unreadable as a date until the caller supplies the year.
  /^(\d{1,2}\s*[A-Za-z]{3,9})\b/,
];

/** A leading date this line actually starts with, validated rather than guessed. */
function matchLeadingDate(line, dayFirst, year = null) {
  for (const pattern of LEADING_DATE_PATTERNS) {
    const match = line.match(pattern);
    if (!match) continue;
    const raw = year && !/\d{4}|\d{2}$/.test(match[1]) ? `${match[1]} ${year}` : match[1];
    if (parseStatementDate(raw, { dayFirst })) {
      return { raw, rest: line.slice(match[0].length).trim() };
    }
  }
  return null;
}

// The year a statement prints once, in its own header rather than on every
// row: "Your statement 1 January to 31 January 2026". Rows written as a bare
// "05 Jan" borrow it.
//
// Only a fully written date may supply it. A bare four-digit number in a
// header is as likely to be a company registration or a sort code as a year,
// and dating a whole statement to 2065 off one would be worse than leaving
// its rows unreadable and saying so.
const STATEMENT_YEAR_PATTERNS = [
  /\b\d{1,2}[\s/.-]+[A-Za-z]{3,9}[\s/.,-]+((?:19|20)\d{2})\b/,
  /\b[A-Za-z]{3,9}[\s/.-]+\d{1,2}[\s/.,-]+((?:19|20)\d{2})\b/,
  /\b\d{1,2}[/.-]\d{1,2}[/.-]((?:19|20)\d{2})\b/,
  /\b((?:19|20)\d{2})-\d{1,2}-\d{1,2}\b/,
];

function findStatementYear(lines, dayFirst) {
  for (const line of lines) {
    if (matchLeadingDate(line, dayFirst)) break;   // into the transactions already
    for (const pattern of STATEMENT_YEAR_PATTERNS) {
      const match = line.match(pattern);
      if (match) return match[1];
    }
  }
  return null;
}

// A trailing money amount: optional currency/sign/parenthesis, digits grouped
// with commas, exactly two decimal places, and an optional CR/DR marker.
const MONEY_TOKEN = /[£$€]?\(?-?\d[\d,]*\.\d{2}\)?\s*(?:CR|DR)?/gi;

function findMoneyTokens(text) {
  return [...text.matchAll(MONEY_TOKEN)].map(match => ({ raw: match[0], index: match.index }));
}

/** Whether a cell holds one money value and nothing else. */
function looksLikeMoney(value = '') {
  const text = String(value).trim();
  if (!text) return false;
  const tokens = findMoneyTokens(text);
  return tokens.length === 1 && tokens[0].raw.trim() === text;
}

/** Fold a trailing "CR"/"DR" marker into the sign `parseAmount` understands. */
function normaliseMoneyToken(token = '') {
  const match = token.match(/^(.*?)\s*(CR|DR)$/i);
  if (!match) return token.trim();
  let value = match[1].trim();
  const direction = match[2].toUpperCase();
  if (direction === 'DR' && !/^-/.test(value) && !/^\(/.test(value)) value = `-${value}`;
  // A "+" rather than a bare magnitude, so the direction the statement stated
  // outright is never mistaken for one this file has yet to work out — see
  // `applyBalanceDirection`, which leaves an explicitly signed cell alone.
  else if (direction === 'CR') value = `+${value.replace(/^[+-]/, '')}`;
  return value;
}

/** Whether a cell says which way the money went, rather than only how much. */
function hasExplicitSign(value = '') {
  const text = String(value).trim();
  return /^[+-]/.test(text) || /^\(.*\)$/.test(text) || /\b(CR|DR)\b/i.test(text);
}

/**
 * The run of money tokens at the end of a line — the statement's money
 * columns, as against a reference number that happens to be money-shaped.
 *
 * "PAYPAL REF 100.00 12.40" is a real hazard: the old reading took the last
 * two numbers as amount and balance, importing a £100 reference as the
 * purchase. Money columns are always flush to the right of the row and always
 * adjacent, so only a run that reaches the end of the line qualifies.
 */
function trailingMoneyRun(body) {
  const tokens = findMoneyTokens(body);
  const run = [];
  let expectedEnd = body.length;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const token = tokens[i];
    if (body.slice(token.index + token.raw.length, expectedEnd).trim() !== '') break;
    run.unshift(token);
    expectedEnd = token.index;
  }
  return run;
}

// Lines a statement prints that aren't transactions. A dated "balance brought
// forward" is the one that matters: it carries a date and a balance, so
// nothing structural tells it from a real row, and it would otherwise reach
// the review table as an unimportable row with no amount. Kept deliberately
// narrow — "TOTAL FITNESS" is a real gym, so a bare leading "total" can't be
// grounds for dropping a row.
const NON_TRANSACTION_ROW = [
  /\b(brought|carried)\s+forward\b/i,
  /\b(opening|closing|previous|start(?:ing)?|end(?:ing)?|statement)\s+balance\b/i,
  /\bbalance\s+(?:on|as\s+at)\b/i,
  /^totals?\s*$/i,
  /\btotals?\s+(?:paid|payments?|debits?|credits?|money|in|out|for)\b/i,
  /^page\s+\d+\b/i,
  /\bcontinued\b/i,
  /^sort\s*code\b/i,
  /^account\s+(?:number|name)\b/i,
];

function isNonTransactionRow(text = '') {
  return NON_TRANSACTION_ROW.some(pattern => pattern.test(text));
}

// How a UK bank says what kind of payment a row was: DD is a direct debit, SO
// a standing order, FPI/FPO a faster payment in or out, DEB a debit card, BGC
// a bank giro credit, CPT a cashpoint withdrawal, TFR a transfer between your
// own accounts, CHQ a cheque. Lloyds, Halifax and Bank of Scotland print it in
// a column of its own; plenty of banks put it in front of the merchant in the
// description instead, and a narrow gap between two columns can merge the two
// anyway.
//
// It isn't part of the merchant's name, and it is the same string on every
// direct debit you have, so leaving it in makes two unrelated rows look alike
// and makes none of them look like what the user typed by hand. The list is
// deliberately short of codes that double as real merchants — "BP" means bill
// payment to Lloyds and a petrol station to everyone else, so it is left in.
const PAYMENT_TYPE_CODE = /^(?:DD|SO|TFR|TRF|FPI|FPO|FPS|DEB|CRD|BGC|BACS?|CPT|CHQ|CHG|INT|ATM|POS|CR|DR|SBT|MPI|MPO|ITL|CSH|TLR|OTR)\b[\s:.-]*/i;

function stripPaymentTypeCode(description = '') {
  const stripped = String(description).replace(PAYMENT_TYPE_CODE, '').trim();
  // Never strip a row down to nothing: a description that was only a code is
  // more use kept than blanked.
  return stripped || String(description).trim();
}

/**
 * A description with the punctuation that isn't part of it removed from either
 * end.
 *
 * A statement is full of characters that carry no meaning but sit hard against
 * a merchant's name: a leader dot, a bullet from a symbol font, the period an
 * abbreviated month leaves behind in the date column, a separator stranded by a
 * column boundary that landed a character off. Every one of them survives into
 * what gets written as the transaction's merchant *and* into every comparison
 * against what the user typed by hand — a description reading ". SAINSBURYS"
 * matches nothing and reads like a bug.
 *
 * Leading punctuation is never part of a name, so it goes unconditionally
 * rather than being chased cause by cause; the causes are many and the fix is
 * the same for all of them.
 */
function tidyDescription(value = '') {
  const trim = text => String(text)
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[^\p{L}\p{N})\]]+$/u, '')
    .trim();
  // Twice: punctuation in front would otherwise hide the payment-type code
  // from the pattern that strips it.
  return trim(stripPaymentTypeCode(trim(value)));
}

// A penny, to absorb float noise rather than real disagreement.
const BALANCE_TOLERANCE = 0.01;

/**
 * The signed amount a parsed row carries, by whichever convention its mapping
 * describes: one signed column, or a pair of positive money-out / money-in
 * columns where the column itself is the sign.
 *
 * Shared with `buildImportRows` deliberately. A balance check that read the
 * columns differently from the importer would happily vouch for a parse the
 * importer then got wrong.
 */
export function signedAmountFromRow(values = [], mapping = {}) {
  if (mapping.amount != null) return parseAmount(values[mapping.amount]);
  const debit = mapping.debit != null ? parseAmount(values[mapping.debit]) : null;
  const credit = mapping.credit != null ? parseAmount(values[mapping.credit]) : null;
  // Separate columns are written as positive magnitudes; the column is the
  // sign. Only one of the pair is ever filled in on a given row.
  if (debit) return -Math.abs(debit);
  if (credit) return Math.abs(credit);
  return null;
}

/**
 * How well a parse agrees with the statement's own arithmetic.
 *
 * A statement that prints a running balance is checking itself: each row's
 * balance is the one before it plus that row's amount, signed. So a parse that
 * put the wrong number in the amount column, or read a money-out row as money
 * in, disagrees with the document it came from — which is the only way this
 * app can tell a good read from a plausible-looking bad one without a human
 * comparing every row against the PDF.
 *
 * `checked` matters as much as `ratio`: a statement with no balance column, or
 * one row, proves nothing either way and must not be reported as verified.
 */
export function scoreRunningBalance(rows = [], mapping = {}) {
  if (mapping.balance == null) return { checked: 0, agreed: 0, ratio: null };

  const entries = rows.map(values => ({
    signed: signedAmountFromRow(values, mapping),
    balance: parseAmount(values[mapping.balance]),
  }));

  let checked = 0;
  let agreed = 0;
  for (let i = 1; i < entries.length; i += 1) {
    const previous = entries[i - 1];
    const current = entries[i];
    if (previous.balance == null || current.balance == null || current.signed == null) continue;
    checked += 1;
    if (Math.abs(roundTo2(current.balance - previous.balance) - current.signed) <= BALANCE_TOLERANCE) {
      agreed += 1;
    }
  }

  return { checked, agreed, ratio: checked ? agreed / checked : null };
}

/**
 * Decide which way the money went, where the statement prints one unsigned
 * amount column.
 *
 * A running balance states the direction outright: a row that took the balance
 * down was money out, whatever its amount column looks like. Where the balance
 * confirms the magnitude too, that isn't a guess at all.
 *
 * Rows it can't settle — the first one, a gap in the balance column, no
 * balance column at all — default to money **out**, because an unsigned amount
 * on a bank statement nearly always is. That default is the whole point of
 * this function: `buildImportRows` reads a positive amount as a refund, so an
 * unsigned statement used to import as a page of refunds, every row crediting
 * a category instead of spending from it. A single wrong row is one tap to
 * flip in the review table; a whole statement inverted looked like the feature
 * simply didn't work.
 *
 * A cell that already carries a sign, accountancy parentheses or a CR/DR
 * marker is left exactly as it is — the statement has already spoken.
 */
function applyBalanceDirection(rows, mapping) {
  if (mapping.amount == null) return rows;

  const balances = mapping.balance == null
    ? []
    : rows.map(values => parseAmount(values[mapping.balance]));

  return rows.map((values, index) => {
    const cell = values[mapping.amount];
    if (hasExplicitSign(cell)) return values;
    const amount = parseAmount(cell);
    if (!amount) return values;

    const balance = balances[index];
    const previous = index > 0 ? balances[index - 1] : null;
    if (balance != null && previous != null) {
      const delta = roundTo2(balance - previous);
      if (Math.abs(Math.abs(delta) - amount) <= BALANCE_TOLERANCE && delta > 0) return values;
    }

    const copy = [...values];
    copy[mapping.amount] = `-${amount.toFixed(2)}`;
    return copy;
  });
}

const LINE_MAPPING = { date: 0, description: 1, amount: 2, debit: null, credit: null, balance: 3 };

/**
 * One line's four cells, on the reading that the last money column is (or
 * isn't) a running balance.
 */
function lineRow(dateRaw, body, { lastIsBalance }) {
  const run = trailingMoneyRun(body);
  // A layout that puts the amount first has no trailing run at all; falling
  // back to every money token on the line keeps it readable rather than
  // dropping the row for want of a tidy right-hand column.
  const tokens = run.length ? run : findMoneyTokens(body);
  if (!tokens.length) return [dateRaw, tidyDescription(body), '', ''];

  const balanceToken = lastIsBalance && tokens.length >= 2 ? tokens[tokens.length - 1] : null;
  const pool = balanceToken ? tokens.slice(0, -1) : tokens;
  // A statement with separate money-out and money-in columns prints both on
  // every row, one of them reading 0.00. The amount is the one that isn't.
  const nonZero = pool.filter(token => parseAmount(normaliseMoneyToken(token.raw)));
  const usable = nonZero.length ? nonZero : pool;
  const amountToken = usable[usable.length - 1];

  const descriptionEnd = run.length ? tokens[0].index : amountToken.index;
  return [
    dateRaw,
    tidyDescription(body.slice(0, descriptionEnd)),
    normaliseMoneyToken(amountToken.raw),
    balanceToken ? normaliseMoneyToken(balanceToken.raw) : '',
  ];
}

/**
 * Turn free-form text into the same `{ rows, mapping }` shape a CSV produces,
 * so both feed `buildImportRows` unchanged. The text comes from `ocr.js` —
 * either a PDF's own text layer or a scanned page read by Tesseract — and
 * neither preserves real columns: a transaction can land on one line or wrap
 * onto the next, and column gaps collapse to arbitrary runs of whitespace.
 *
 * The one thing every bank statement layout agrees on is that a transaction
 * line starts with a date and ends with its money columns, so that's what this
 * looks for. Lines before the first date are header noise — account holder,
 * statement period, opening balance — and are dropped rather than guessed at;
 * everything else is either the start of a new transaction or the wrapped
 * remainder of the one before it.
 *
 * A card statement that prints both the purchase date and the date it posted
 * is worth naming specifically: the earlier of the two is kept, because it's
 * the one closer to when the user is likely to have logged the purchase
 * themselves — the later "posted" date is exactly the drift the caller's
 * date-tolerant matching exists to absorb, so starting from the earlier date
 * needs less of it.
 *
 * Whether the last money column on a line is a running balance or the amount
 * itself is not decidable line by line, so it isn't decided there: both
 * readings are built for the whole file and the statement's own arithmetic
 * picks the winner (`scoreRunningBalance`). Prefer a geometric read over this
 * where the page offers one — `parseStatementLines` reads real columns and
 * doesn't have to infer any of it.
 */
export function parseStatementText(text = '', { dayFirst = true } = {}) {
  const lines = String(text)
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const year = findStatementYear(lines, dayFirst);
  const candidates = [];
  let current = null;

  for (const line of lines) {
    if (isNonTransactionRow(line)) { if (current) { candidates.push(current); current = null; } continue; }
    const dated = matchLeadingDate(line, dayFirst, year);
    if (dated) {
      if (current) candidates.push(current);
      let { rest } = dated;
      const second = matchLeadingDate(rest, dayFirst, year);
      if (second) rest = second.rest;
      current = { dateRaw: dated.raw, body: rest };
    } else if (current) {
      current.body = `${current.body} ${line}`.trim();
    }
  }
  if (current) candidates.push(current);

  const withBalance = candidates.map(({ dateRaw, body }) => lineRow(dateRaw, body, { lastIsBalance: true }));
  const score = scoreRunningBalance(withBalance, LINE_MAPPING);
  // Only overrule the usual reading when the statement's arithmetic says
  // outright that it's wrong. An unverifiable balance column — too few rows,
  // gaps in it — is no evidence either way, and the last number on a bank
  // statement line really is the balance far more often than not.
  const lastIsBalance = !(score.checked >= 2 && score.ratio < 0.5);
  const chosen = lastIsBalance
    ? withBalance
    : candidates.map(({ dateRaw, body }) => lineRow(dateRaw, body, { lastIsBalance: false }));
  const mapping = lastIsBalance ? { ...LINE_MAPPING } : { ...LINE_MAPPING, balance: null };
  const rows = applyBalanceDirection(chosen, mapping);

  return {
    rows,
    mapping,
    layout: { method: 'lines', columns: null, fields: null, balance: scoreRunningBalance(rows, mapping) },
  };
}

/** Whether extracted text has enough on it to skip OCR — a scanned page won't. */
export function hasUsableTextLayer(text = '') {
  return text.replace(/\s+/g, '').length >= 20;
}

// pdf.js hands back each run of text with its own (x, y) position on the
// page, not pre-split into lines — a statement's rows, headers and footer
// all arrive as one flat list. Joining that with spaces collapses an entire
// page into a single run-on string, which is fatal for the line-based parser
// above: only the very first date in the whole page is ever found, and
// everything else — every other transaction — becomes unreadable trailing
// noise on that one line.
const SAME_LINE_TOLERANCE = 2;

/**
 * Reassemble a pdf.js `getTextContent()` result into lines of positioned
 * words, ready for either statement parser. Pure geometry, not pdf.js itself —
 * this takes the plain `{ items: [{ str, width, transform }] }` shape the
 * library returns, which is why it lives here rather than in `ocr.js`
 * alongside the library import.
 *
 * Lines are found by clustering items whose baseline (`transform[5]`, the
 * PDF's y-axis, increasing upward) sits within a small tolerance of each
 * other — real line spacing on a statement is many times that, so this only
 * ever merges runs genuinely typeset together. Each line is then read left
 * to right by x (`transform[4]`). The two passes are deliberately separate:
 * sorting on (y, x) together would let the same sub-point jitter that tells
 * two real lines apart also reorder words *within* one line whenever two of
 * them land a fraction of a point off each other on y — common wherever a
 * run changes weight or glyph — so x only ever breaks ties within a line
 * whose membership has already been settled by y alone.
 */
export function linesFromContent(content) {
  const words = (content?.items || [])
    .filter(item => item.str && item.str.trim() && item.transform)
    .map((item) => {
      const x = item.transform[4];
      const width = Number.isFinite(item.width) ? item.width : 0;
      return { x, endX: x + width, y: item.transform[5], str: item.str };
    });

  const lines = [];
  let current = null;
  for (const word of [...words].sort((a, b) => b.y - a.y)) {
    if (!current || Math.abs(word.y - current.y) > SAME_LINE_TOLERANCE) {
      current = { y: word.y, words: [] };
      lines.push(current);
    }
    current.words.push(word);
  }

  for (const line of lines) line.words.sort((a, b) => a.x - b.x);
  return lines;
}

/** The same page as plain text, one line per typeset line. */
export function textFromContent(content) {
  return textFromLines(linesFromContent(content));
}

/**
 * Lines back to plain text. Exported because `ocr.js` reads each page once as
 * lines and needs its text too — for `hasUsableTextLayer`, and as the input to
 * the flattened reading where the geometric one can't be used.
 */
export function textFromLines(lines = []) {
  return lines.map(line => line.words.map(word => word.str).join(' ')).join('\n');
}

// ── A statement's own columns ───────────────────────────────────────────────

// How much clear space, relative to the width of a character beside it, marks
// a column boundary rather than a word space. A space is roughly a quarter of
// an em and a character averages half of one, so two character-widths of gap
// is comfortably wider than any inter-word space and far narrower than the
// gap a table leaves between columns.
const COLUMN_GAP_FACTOR = 2;
// For a run whose width pdf.js didn't report, and which therefore has no
// character width to scale from.
const FALLBACK_COLUMN_GAP = 8;
// A header worth trusting names at least this many of the fields we know, one
// of which has to be the date and one an amount. Fewer than that is a line
// with a stray "date" or "balance" in it, not a table header.
const HEADER_MIN_FIELDS = 3;
// How far below a transaction a wrapped description may sit, as a multiple of
// the statement's own line spacing. A real wrap is on the very next baseline;
// anything further down the page is something else that happens to have text
// only under the details column.
const CONTINUATION_GAP_FACTOR = 3;

/** The statement's own line spacing, so a wrap can be told from a stray line. */
function medianLineGap(lines) {
  const gaps = [];
  for (let i = 1; i < lines.length; i += 1) {
    const gap = lines[i - 1].y - lines[i].y;
    if (gap > 0) gaps.push(gap);
  }
  if (!gaps.length) return 0;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

function characterWidth(word) {
  const length = word.str.trim().length || 1;
  const width = word.endX - word.x;
  return width > 0 ? width / length : 0;
}

/** Group one line's words into table cells, splitting only on column gaps. */
function cellsFromLine(words = []) {
  const cells = [];
  let current = null;

  for (const word of words) {
    const text = word.str.trim();
    if (!text) continue;

    if (current) {
      const scale = Math.max(characterWidth(word), characterWidth(current.words[current.words.length - 1]));
      const threshold = (scale || FALLBACK_COLUMN_GAP / COLUMN_GAP_FACTOR) * COLUMN_GAP_FACTOR;
      if (word.x - current.endX <= threshold) {
        current.words.push(word);
        current.text = `${current.text} ${text}`;
        current.endX = Math.max(current.endX, word.endX);
        continue;
      }
    }

    current = { text, x: word.x, endX: word.endX, words: [word] };
    cells.push(current);
  }

  return cells;
}

/**
 * The table header, if this line is one — and with it the x boundaries every
 * later row is sliced on.
 *
 * `guessColumnMapping` does the naming, exactly as it does for a CSV's header
 * row, so the vocabulary a bank might use ("Paid out", "Money out", "Debit",
 * "Withdrawals") is described once for both paths rather than twice.
 *
 * A header carries no money, which is the cheap guard against mistaking a
 * transaction for one: a row reading "Balance brought forward … 1,234.56"
 * matches `/balance/i` as surely as the real header does.
 */
function headerFromLine(line) {
  if (line.words.some(word => looksLikeMoney(word.str))) return null;

  const cells = cellsFromLine(line.words);
  if (cells.length < HEADER_MIN_FIELDS) return null;

  const mapping = guessColumnMapping(cells.map(cell => cell.text));
  const named = Object.values(mapping).filter(index => index != null).length;
  const hasAmount = mapping.amount != null || mapping.debit != null || mapping.credit != null;
  if (mapping.date == null || !hasAmount || named < HEADER_MIN_FIELDS) return null;

  const boundaries = [];
  for (let i = 1; i < cells.length; i += 1) boundaries.push((cells[i - 1].endX + cells[i].x) / 2);

  return { cells, mapping, boundaries, labels: cells.map(cell => cell.text) };
}

/** Slice one line into the header's columns, by where each run's middle sits. */
function cellsForColumns(line, columns) {
  const parts = columns.cells.map(() => []);

  for (const word of line.words) {
    const text = word.str.trim();
    if (!text) continue;
    const middle = (word.x + word.endX) / 2;
    let index = 0;
    while (index < columns.boundaries.length && middle >= columns.boundaries[index]) index += 1;
    parts[index].push(text);
  }

  return parts.map(words => words.join(' ').trim());
}

/**
 * Money columns hold money.
 *
 * A long description runs past the right-hand edge of its own column — most
 * statements leave the details column room to overflow, since nothing is
 * printed beside it on most rows — and its tail then lands in "paid out",
 * where it displaces the amount and the row arrives at review with nothing to
 * import. Sorting the words by what they are, once their column is known,
 * costs nothing and rescues exactly that row.
 */
function repairMoneyColumns(cells, mapping) {
  const spill = [];

  for (const field of ['amount', 'debit', 'credit', 'balance']) {
    const index = mapping[field];
    if (index == null) continue;
    const value = cells[index];
    if (!value) continue;

    const tokens = findMoneyTokens(value);
    const leftover = tokens
      .reduce((text, token) => text.replace(token.raw, ' '), value)
      .replace(/\s+/g, ' ')
      .trim();
    // Normalised, not just extracted: a credit-card statement writes its
    // direction as a trailing CR or DR, which `parseAmount` can't read.
    cells[index] = tokens.length ? normaliseMoneyToken(tokens[tokens.length - 1].raw) : '';
    if (leftover) spill.push(leftover);
  }

  if (spill.length && mapping.description != null) {
    cells[mapping.description] = [cells[mapping.description], ...spill].filter(Boolean).join(' ');
  }

  return cells;
}

/**
 * Read a statement the way it was laid out, from the positioned text of its
 * own pages.
 *
 * This is the accurate path, and the reason it exists: a PDF has no table in
 * it, only runs of text at (x, y), so a parser that flattens a page to lines
 * and works right-to-left along each one has to *infer* which trailing number
 * was the amount, which was the balance, and which way the money went. A UK
 * statement doesn't express direction as a sign at all — Lloyds, Barclays,
 * HSBC, NatWest and Santander all print separate "Paid out"/"Money out" and
 * "Paid in"/"Money in" columns, with the amount unsigned in whichever one
 * applies — so on the flattened reading the single most important fact about
 * a transaction is the one thing that isn't on the line.
 *
 * Finding the header row recovers all of it: its cells name the columns
 * (`guessColumnMapping`, shared with the CSV path) and their x extents give
 * the boundaries every later row is sliced on. Money out and money in then
 * land in different cells, and `buildImportRows` reads the direction
 * structurally, with nothing inferred.
 *
 * Three details a real statement forces, none of them visible in a
 * hand-built fixture:
 *
 * - **The header repeats, or doesn't.** A multi-page statement usually
 *   reprints it, but a table that starts mid-page and continues past a page
 *   break may not, so the last header seen carries forward until another
 *   replaces it. Pages therefore have to arrive as one sequence, already in
 *   reading order, and must not be re-sorted here: y resets on every page.
 * - **A description wraps.** The continuation line has no date and no
 *   amounts, sitting under the details column alone — which is precisely the
 *   test applied, since a page footer or a totals line also lacks a date and
 *   must not be glued onto the previous transaction's description instead.
 *   That test alone isn't enough, though: the statement period reprinted at
 *   the top of page two lands under the details column with every other column
 *   empty, and read as a wrap it appends the whole header to the last
 *   transaction of page one. So a wrap also has to be *adjacent* — same page,
 *   and within a few lines' spacing of the row it belongs to.
 * - **Not every row is a transaction.** "Balance brought forward" carries a
 *   date and a balance and nothing else; `NON_TRANSACTION_ROW` names those so
 *   they're dropped rather than shown as unimportable rows.
 *
 * The geometry can still be wrong — a header split over two lines, a bank
 * that emits each row as one undifferentiated run — so the result is checked
 * against the statement's own running balance and the flattened reading is
 * used instead where it agrees with the document better. `layout` reports
 * which reading won and how well it verified, because "we read this as
 * columns and the arithmetic checks out on 41 of 42 rows" is something the
 * user can act on, and "here are some rows" is not.
 */
export function parseStatementLines(lines = [], { dayFirst = true } = {}) {
  const fallback = parseStatementText(textFromLines(lines), { dayFirst });

  const year = findStatementYear(lines.map(line => line.words.map(word => word.str).join(' ')), dayFirst);
  // A page's baselines run down it, so a baseline higher than the one before
  // can only mean a new page has begun — which is all the page tracking a
  // wrapped description needs, with no page numbers plumbed through.
  const maxContinuationGap = medianLineGap(lines) * CONTINUATION_GAP_FACTOR || Infinity;
  let columns = null;
  let page = 0;
  let previousY = null;
  let openRow = null;      // the row a wrap would belong to: where, and on which page
  const rows = [];

  for (const line of lines) {
    if (previousY != null && line.y > previousY) page += 1;
    previousY = line.y;

    const header = headerFromLine(line);
    if (header) { columns = header; openRow = null; continue; }
    if (!columns) continue;                      // header noise above the table

    const cells = cellsForColumns(line, columns);
    const joined = cells.join(' ').trim();
    if (!joined || isNonTransactionRow(joined)) continue;

    const { mapping } = columns;
    const dated = matchLeadingDate(cells[mapping.date] || '', dayFirst, year);

    if (!dated) {
      // A wrapped description, and only that: text under the details column,
      // every other column of this row empty, and close enough to the row
      // above to be part of it.
      const description = mapping.description == null ? '' : cells[mapping.description];
      const elsewhere = cells.some((cell, index) => cell && index !== mapping.description);
      const adjacent = openRow && openRow.page === page && openRow.y - line.y <= maxContinuationGap;
      if (adjacent && description && !elsewhere) {
        const row = openRow.row;
        row[mapping.description] = `${row[mapping.description]} ${description}`.trim();
        openRow.y = line.y;
      }
      continue;
    }

    cells[mapping.date] = dated.raw;
    // A date cell reading "05 Jan." leaves a bare "." behind; prepending that
    // to the description is where ". SAINSBURYS" came from.
    if (/[\p{L}\p{N}]/u.test(dated.rest) && mapping.description != null) {
      cells[mapping.description] = [dated.rest, cells[mapping.description]].filter(Boolean).join(' ');
    }
    const row = repairMoneyColumns(cells, mapping);
    rows.push(row);
    openRow = { row, page, y: line.y };
  }

  if (!columns || !rows.length) return fallback;

  const { mapping } = columns;
  if (mapping.description != null) {
    for (const row of rows) row[mapping.description] = tidyDescription(row[mapping.description]);
  }
  const signed = applyBalanceDirection(rows, mapping);
  const score = scoreRunningBalance(signed, mapping);
  const fallbackScore = fallback.layout.balance;

  // Geometry beats a line-by-line guess unless the statement itself says
  // otherwise: only hand back to the flattened reading when both readings can
  // be checked, this one visibly doesn't add up, and that one does better.
  if (score.checked >= 2 && score.ratio < 0.75
    && fallbackScore.checked >= 2 && fallbackScore.ratio > score.ratio) {
    return fallback;
  }

  const fields = {};
  for (const [field, index] of Object.entries(mapping)) {
    if (index != null) fields[field] = columns.labels[index];
  }

  return {
    rows: signed,
    mapping,
    layout: { method: 'columns', columns: columns.labels, fields, balance: score },
  };
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

// Most of the words in common, or a safe substring either way. Below this two
// descriptions are treated as naming different things.
const SIMILAR_DESCRIPTION = 0.6;

/**
 * How alike two descriptions are, from 0 to 1.
 *
 * A bank's own text and whatever the user typed rarely match byte-for-byte —
 * "Tesco" against "TESCO STORES 3294 LONDON GB" — so exact equality is too
 * strict a bar. A number rather than a verdict, because the review step ranks
 * candidate matches against each other and needs to know which is the closest,
 * not merely that several passed a threshold.
 */
export function descriptionSimilarity(a = '', b = '') {
  const normA = normaliseDescription(a);
  const normB = normaliseDescription(b);
  if (!normA || !normB) return 0;
  if (normA === normB) return 1;
  if (normA.includes(normB) || normB.includes(normA)) return 0.85;

  const wordsA = normA.split(' ').filter(Boolean);
  const wordsB = normB.split(' ').filter(Boolean);
  if (!wordsA.length || !wordsB.length) return 0;
  const setB = new Set(wordsB);
  const shared = wordsA.filter(word => setB.has(word)).length;
  return shared / Math.min(wordsA.length, wordsB.length);
}

/** Whether two descriptions plausibly name the same purchase. */
export function similarDescriptions(a = '', b = '') {
  return descriptionSimilarity(a, b) >= SIMILAR_DESCRIPTION;
}

/** Whole days between two `yyyy-MM-dd` strings, computed in UTC to dodge DST. */
function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  const msPerDay = 86400000;
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / msPerDay);
}

/**
 * An existing transaction, reduced to what matching and the review UI need.
 *
 * One shape, so the automatic match and the by-hand comparison are looking at
 * the same thing — including the `id`, which is what lets the review step name
 * the transaction it thinks a row already is instead of only asserting that one
 * exists somewhere.
 */
function existingEntry(tx) {
  return {
    id: tx.id ?? null,
    date: tx.date ? String(tx.date).slice(0, 10) : null,
    amount: Math.abs(Number(tx.amount) || 0),
    type: tx.type === TX_REFUND ? TX_REFUND : TX_EXPENSE,
    description: tx.merchant || tx.note || '',
    categoryId: tx.categoryId ?? null,
  };
}

/**
 * Every transaction already logged near a date, whatever it cost.
 *
 * The automatic match only ever considers the same amount to the penny, which
 * is the right bar for a decision made without asking — but useless the moment
 * a person wants to settle a row by eye. A purchase typed as £12.50 when the
 * card took £12.49, one statement line covering a split, a tip added after the
 * fact: none of those will ever be offered as a candidate, and all of them are
 * things only the user can recognise. This is the list that makes that
 * possible, ordered by how close to the row's own date each one is.
 */
export function findNearbyTransactions(transactions = [], { date, windowDays = 7, limit = 40 } = {}) {
  if (!date) return [];
  const entries = [];
  for (const tx of transactions) {
    const entry = existingEntry(tx);
    if (!entry.date) continue;
    const drift = daysBetween(date, entry.date);
    if (Math.abs(drift) > windowDays) continue;
    entries.push({ ...entry, drift, days: Math.abs(drift) });
  }
  entries.sort((a, b) => a.days - b.days || b.amount - a.amount);
  return entries.slice(0, limit);
}

// How many candidates a row carries for review. More than a handful is not a
// list anyone reads; it's a sign the amount is a common one.
const MAX_MATCHES = 5;

/**
 * The transactions that could be this row, best first.
 *
 * Ranked rather than merely collected, because "something with this amount
 * exists" is not useful and "this is probably *that* one" is. Description
 * similarity and closeness in date both count, and matching direction counts
 * for more than either: a £50 refund and a £50 expense are not the same
 * transaction however alike their wording.
 */
function rankMatches(row, candidates, dateToleranceDays) {
  const matches = [];
  for (const candidate of candidates) {
    const drift = daysBetween(row.date, candidate.date);
    const days = Math.abs(drift);
    if (days > dateToleranceDays) continue;
    const similarity = descriptionSimilarity(row.description, candidate.description);
    const sameDirection = candidate.type === row.type;
    matches.push({
      ...candidate,
      drift,
      days,
      similarity,
      sameDirection,
      score: similarity + (1 - days / (dateToleranceDays + 1)) + (sameDirection ? 0.5 : 0),
    });
  }
  matches.sort((a, b) => b.score - a.score || a.days - b.days);
  return matches;
}

/** Why a row is flagged, naming the transaction it was matched against. */
function describeMatch(match) {
  const name = match.description ? `“${match.description}”` : 'a transaction with no description';
  const when = match.days === 0
    ? 'the same day'
    : `${match.days} day${match.days === 1 ? '' : 's'} ${match.drift < 0 ? 'earlier' : 'later'}`;

  if (!match.sameDirection) {
    const logged = match.type === TX_REFUND ? 'a refund' : 'spending';
    return `Same amount as ${name} (${when}), but that one is logged as ${logged}`;
  }
  if (match.similarity >= SIMILAR_DESCRIPTION) {
    return match.days === 0
      ? `Looks like ${name}, already logged that day`
      : `Probably ${name}, logged ${when} — the same purchase clearing late`;
  }
  return `Same amount as ${name}, ${match.days === 0 ? 'logged that day' : `logged ${when}`}`;
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
 *
 * A bank doesn't post a transaction the day it happened — a card purchase
 * clears a day or two later, a weekend purchase clears the following Monday,
 * a direct debit can lag longer still. Matching only on the exact day, as the
 * two dedupe keys above do, would miss all of that and quietly re-import
 * every transaction the user already logged by hand. So a third pass looks
 * for the same amount within `dateToleranceDays` of the statement date and
 * flags it as `ROW_SIMILAR` — included by default, same as a same-day loose
 * match, never auto-excluded. A same amount at the same merchant on nearby
 * days is exactly what a recurring charge or a daily coffee habit looks like
 * too, and silently dropping a real second transaction is worse than asking
 * the user to glance at one that says "similar" and confirm it's new.
 */
export function buildImportRows({
  rows = [],
  mapping = {},
  existingTransactions = [],
  suggestCategory = null,
  defaultCategoryId = null,
  dayFirst = true,
  invertSigns = false,
  dateToleranceDays = 3,
} = {}) {
  // One index, bucketed by amount to the penny: every candidate for every row
  // comes out of here, whether it lands on the same day or a few days off.
  // There used to be three passes with three different notions of a match, and
  // the only one that could name what it had matched was the one that ran last.
  const byAmount = new Map();
  for (const tx of existingTransactions) {
    const entry = existingEntry(tx);
    if (!entry.date) continue;
    const amountKey = entry.amount.toFixed(2);
    const bucket = byAmount.get(amountKey);
    if (bucket) bucket.push(entry);
    else byAmount.set(amountKey, [entry]);
  }

  // Duplicates *within* the file matter too — a statement re-exported over an
  // overlapping window repeats rows, and only the first is genuinely new.
  const seenInFile = new Set();

  return rows.map((values, index) => {
    const rawDate = mapping.date != null ? values[mapping.date] : '';
    const description = mapping.description != null ? String(values[mapping.description] || '').trim() : '';
    const date = parseStatementDate(rawDate, { dayFirst });

    let signed = signedAmountFromRow(values, mapping);

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
      const exact = buildDedupeKey({ date, amount: row.amount, description });
      const matches = rankMatches(row, byAmount.get(row.amount.toFixed(2)) || [], dateToleranceDays);
      row.matches = matches.slice(0, MAX_MATCHES);
      const best = matches[0] || null;

      if (seenInFile.has(exact)) {
        row.status = ROW_DUPLICATE;
        row.problem = 'The same row appears earlier in this file';
      } else if (best && best.days === 0 && best.sameDirection && best.similarity >= SIMILAR_DESCRIPTION) {
        // Same day, same amount, same direction and a recognisable name: the
        // one case confident enough to settle without asking. Matching on
        // *similarity* rather than an identical string is what catches the
        // common case of a purchase the user typed as "Tesco" and the bank
        // calls "TESCO STORES 3294 LONDON GB".
        row.status = ROW_DUPLICATE;
        row.problem = describeMatch(best);
      } else if (best) {
        // Everything else the automatic pass found is a question, not an
        // answer — including a cross-date hit, which must never auto-exclude a
        // row (see the note above this function). The review step groups these
        // as "needs checking" and walks them one at a time.
        row.status = ROW_SIMILAR;
        row.dateDrift = best.days;
        row.problem = describeMatch(best);
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

    // Only a row nothing looked like is written without being asked about.
    //
    // A "needs checking" row used to be included by default, on the reasoning
    // that two coffees on one day is at least as likely as a double import —
    // and that silently dropping a real transaction is the worse failure. Both
    // are true, and the conclusion was still wrong: it made the pile's whole
    // purpose advisory. Someone who read every flagged row, left them flagged
    // because they *were* unsure, and pressed Import got all of them anyway,
    // which is the one outcome the three piles exist to prevent.
    //
    // Nothing is dropped silently instead: the review step shows the count in
    // its own loud banner, with one tap to accept the lot and one to walk them
    // row by row. The decision is still the user's — it just has to be made.
    row.include = row.status === ROW_NEW;

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
