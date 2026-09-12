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

// ── Free-form statement text (OCR / a PDF's own text layer) ─────────────────

const LEADING_DATE_PATTERNS = [
  /^(\d{4}-\d{1,2}-\d{1,2})\b/,
  /^(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})\b/,
  /^(\d{1,2}\s*[A-Za-z]{3,9}\s*\d{2,4})\b/,
  /^([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{2,4})\b/,
];

/** A leading date this line actually starts with, validated rather than guessed. */
function matchLeadingDate(line, dayFirst) {
  for (const pattern of LEADING_DATE_PATTERNS) {
    const match = line.match(pattern);
    if (match && parseStatementDate(match[1], { dayFirst })) {
      return { raw: match[1], rest: line.slice(match[0].length).trim() };
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

/** Fold a trailing "CR"/"DR" marker into the sign `parseAmount` understands. */
function normaliseMoneyToken(token = '') {
  const match = token.match(/^(.*?)\s*(CR|DR)$/i);
  if (!match) return token.trim();
  let value = match[1].trim();
  const direction = match[2].toUpperCase();
  if (direction === 'DR' && !/^-/.test(value) && !/^\(/.test(value)) value = `-${value}`;
  else if (direction === 'CR') value = value.replace(/^-/, '');
  return value;
}

/**
 * Turn free-form text into the same `{ rows, mapping }` shape a CSV produces,
 * so both feed `buildImportRows` unchanged. The text comes from `ocr.js` —
 * either a PDF's own text layer or a scanned page read by Tesseract — and
 * neither preserves real columns: a transaction can land on one line or wrap
 * onto the next, and column gaps collapse to arbitrary runs of whitespace.
 *
 * The one thing every bank statement layout agrees on is that a transaction
 * line starts with a date and ends with an amount (often followed by a
 * running balance), so that's what this looks for. Lines before the first
 * date are header noise — account holder, statement period, opening balance —
 * and are dropped rather than guessed at; everything else is either the start
 * of a new transaction or the wrapped remainder of the one before it.
 *
 * A card statement that prints both the purchase date and the date it posted
 * is worth naming specifically: the earlier of the two is kept, because it's
 * the one closer to when the user is likely to have logged the purchase
 * themselves — the later "posted" date is exactly the drift the caller's
 * date-tolerant matching exists to absorb, so starting from the earlier date
 * needs less of it.
 *
 * A line with three trailing numbers — separate money-out, money-in and
 * balance columns, all printed even when one reads zero — will be misread:
 * the last two are always taken as amount and balance. Statements shaped that
 * way are rare enough, and a misread row can be fixed or dropped at review,
 * that this isn't worth a configuration option.
 */
export function parseStatementText(text = '', { dayFirst = true } = {}) {
  const lines = String(text)
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const candidates = [];
  let current = null;

  for (const line of lines) {
    const dated = matchLeadingDate(line, dayFirst);
    if (dated) {
      if (current) candidates.push(current);
      let { rest } = dated;
      const second = matchLeadingDate(rest, dayFirst);
      if (second) rest = second.rest;
      current = { dateRaw: dated.raw, body: rest };
    } else if (current) {
      current.body = `${current.body} ${line}`.trim();
    }
  }
  if (current) candidates.push(current);

  const rows = candidates.map(({ dateRaw, body }) => {
    const tokens = findMoneyTokens(body);
    if (!tokens.length) return [dateRaw, body, '', ''];

    const last = tokens[tokens.length - 1];
    const secondLast = tokens.length >= 2 ? tokens[tokens.length - 2] : null;
    const amountToken = secondLast || last;
    const balanceToken = secondLast ? last : null;

    return [
      dateRaw,
      body.slice(0, amountToken.index).trim(),
      normaliseMoneyToken(amountToken.raw),
      balanceToken ? normaliseMoneyToken(balanceToken.raw) : '',
    ];
  });

  return {
    rows,
    mapping: { date: 0, description: 1, amount: 2, debit: null, credit: null, balance: 3 },
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
 * Reassemble a pdf.js `getTextContent()` result into real lines, ready for
 * `parseStatementText`. Pure geometry, not pdf.js itself — this takes the
 * plain `{ items: [{ str, transform }] }` shape the library returns, which
 * is why it lives here rather than in `ocr.js` alongside the library import.
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
export function textFromContent(content) {
  const words = content.items
    .filter(item => item.str && item.str.trim() && item.transform)
    .map(item => ({ x: item.transform[4], y: item.transform[5], str: item.str }));

  const lines = [];
  let current = null;
  for (const word of [...words].sort((a, b) => b.y - a.y)) {
    if (!current || Math.abs(word.y - current.y) > SAME_LINE_TOLERANCE) {
      current = { y: word.y, words: [] };
      lines.push(current);
    }
    current.words.push(word);
  }

  return lines
    .map(line => [...line.words].sort((a, b) => a.x - b.x).map(w => w.str).join(' '))
    .join('\n');
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

/**
 * Whether two descriptions plausibly name the same purchase.
 *
 * A bank's own text and whatever the user typed rarely match byte-for-byte —
 * "Tesco" against "TESCO STORES 3294 LONDON GB" — so exact equality is too
 * strict a bar. A safe substring either way, or most of the words in common,
 * is close enough. This never decides whether a row gets excluded on its own;
 * see the date-tolerant pass in `buildImportRows` for why.
 */
export function similarDescriptions(a = '', b = '') {
  const normA = normaliseDescription(a);
  const normB = normaliseDescription(b);
  if (!normA || !normB) return false;
  if (normA === normB) return true;
  if (normA.includes(normB) || normB.includes(normA)) return true;

  const wordsA = normA.split(' ').filter(Boolean);
  const wordsB = normB.split(' ').filter(Boolean);
  if (!wordsA.length || !wordsB.length) return false;
  const setB = new Set(wordsB);
  const shared = wordsA.filter(word => setB.has(word)).length;
  return shared / Math.min(wordsA.length, wordsB.length) >= 0.6;
}

/** Whole days between two `yyyy-MM-dd` strings, computed in UTC to dodge DST. */
function daysBetween(a, b) {
  const [ay, am, ad] = a.split('-').map(Number);
  const [by, bm, bd] = b.split('-').map(Number);
  const msPerDay = 86400000;
  return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / msPerDay);
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
  const exactKeys = new Set();
  const looseKeys = new Set();
  const byAmount = new Map();
  for (const tx of existingTransactions) {
    const description = tx.merchant || tx.note || '';
    const entry = { date: tx.date, amount: tx.amount, description };
    exactKeys.add(buildDedupeKey(entry));
    looseKeys.add(buildLooseKey(entry));

    const day = tx.date ? String(tx.date).slice(0, 10) : null;
    if (day && tx.amount != null) {
      const amountKey = Math.abs(Number(tx.amount) || 0).toFixed(2);
      const bucket = byAmount.get(amountKey);
      if (bucket) bucket.push({ date: day, description });
      else byAmount.set(amountKey, [{ date: day, description }]);
    }
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
      } else if (dateToleranceDays > 0) {
        const candidates = byAmount.get(row.amount.toFixed(2));
        let closest = null;
        if (candidates) {
          for (const candidate of candidates) {
            const drift = Math.abs(daysBetween(date, candidate.date));
            if (drift > 0 && drift <= dateToleranceDays && (!closest || drift < closest.drift)) {
              closest = { drift, description: candidate.description };
            }
          }
        }
        if (closest) {
          row.status = ROW_SIMILAR;
          row.dateDrift = closest.drift;
          const days = `${closest.drift} day${closest.drift === 1 ? '' : 's'}`;
          row.problem = similarDescriptions(description, closest.description)
            ? `Looks like it was logged ${days} earlier — probably the same purchase, clearing late`
            : `Same amount as something logged ${days} apart`;
        }
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
