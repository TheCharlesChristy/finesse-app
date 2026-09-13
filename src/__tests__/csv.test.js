/**
 * Bank statement parsing.
 *
 * Bank CSVs are a hostile format: no two banks agree on column names, date
 * order, or how a debit is signed. The cases here are drawn from the shapes
 * real exports actually take, because a parser that is merely correct on
 * well-formed input is no use at all.
 */
import { describe, expect, it } from 'vitest';

import {
  buildDedupeKey, buildImportRows, detectDelimiter, guessColumnMapping,
  hasUsableTextLayer, inferClosingBalance, normaliseDescription, parseAmount, parseCsv,
  linesFromContent, parseStatementDate, parseStatementLines, parseStatementText, reconcile,
  scoreRunningBalance, similarDescriptions, summariseRows, textFromContent, toTransactionPayload,
  ROW_DUPLICATE, ROW_INVALID, ROW_NEW, ROW_SIMILAR,
} from '../csv';

describe('parseCsv', () => {
  it('reads headers and rows', () => {
    const { headers, rows } = parseCsv('Date,Description,Amount\n2026-01-05,Tesco,-12.40');
    expect(headers).toEqual(['Date', 'Description', 'Amount']);
    expect(rows).toEqual([['2026-01-05', 'Tesco', '-12.40']]);
  });

  it('keeps a quoted delimiter inside its field', () => {
    const { rows } = parseCsv('Date,Description,Amount\n2026-01-05,"TESCO STORES, LONDON",-12.40');
    expect(rows[0][1]).toBe('TESCO STORES, LONDON');
  });

  it('handles a quoted field spanning two physical lines', () => {
    const { rows } = parseCsv('Date,Description\n2026-01-05,"PAYMENT\nTHANK YOU"');
    expect(rows).toHaveLength(1);
    expect(rows[0][1]).toBe('PAYMENT\nTHANK YOU');
  });

  it('unescapes doubled quotes', () => {
    const { rows } = parseCsv('Date,Description\n2026-01-05,"BOB""S DINER"');
    expect(rows[0][1]).toBe('BOB"S DINER');
  });

  it('strips the BOM Excel writes', () => {
    const { headers } = parseCsv('﻿Date,Amount\n2026-01-05,-1');
    expect(headers[0]).toBe('Date');
  });

  it('survives CRLF and blank lines', () => {
    const { rows } = parseCsv('Date,Amount\r\n2026-01-05,-1\r\n\r\n2026-01-06,-2\r\n');
    expect(rows).toEqual([['2026-01-05', '-1'], ['2026-01-06', '-2']]);
  });

  it('pads a short row rather than shifting later columns', () => {
    const { rows } = parseCsv('Date,Description,Amount\n2026-01-05,Tesco');
    expect(rows[0]).toEqual(['2026-01-05', 'Tesco', '']);
  });

  it('returns nothing for empty input', () => {
    expect(parseCsv('').rows).toEqual([]);
    expect(parseCsv('   ').headers).toEqual([]);
  });
});

describe('detectDelimiter', () => {
  it('finds semicolons and tabs', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
  });

  it('is not fooled by commas inside a semicolon-separated description', () => {
    const text = 'Date;Description;Amount\n05/01/2026;"TESCO, LONDON, UK";-12,40\n06/01/2026;"BOOTS, LEEDS, UK";-3,10';
    expect(detectDelimiter(text)).toBe(';');
  });
});

describe('parseAmount', () => {
  it('reads plain and signed numbers', () => {
    expect(parseAmount('12.40')).toBe(12.4);
    expect(parseAmount('-12.40')).toBe(-12.4);
    expect(parseAmount('+12.40')).toBe(12.4);
  });

  it('strips currency symbols and thousands separators', () => {
    expect(parseAmount('£1,234.56')).toBe(1234.56);
    expect(parseAmount('$1,234.56')).toBe(1234.56);
    expect(parseAmount('1,234')).toBe(1234);
  });

  it('reads the European convention', () => {
    expect(parseAmount('1.234,56')).toBe(1234.56);
    expect(parseAmount('12,40')).toBe(12.4);
  });

  it('reads accountancy parentheses and trailing signs as negative', () => {
    expect(parseAmount('(12.34)')).toBe(-12.34);
    expect(parseAmount('12.34-')).toBe(-12.34);
  });

  it('returns null for anything that is not a number', () => {
    expect(parseAmount('')).toBeNull();
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount('   ')).toBeNull();
    expect(parseAmount('N/A')).toBeNull();
    expect(parseAmount('12.3.4')).toBeNull();
  });

  it('distinguishes zero from absent', () => {
    expect(parseAmount('0.00')).toBe(0);
    expect(parseAmount('')).toBeNull();
  });
});

describe('parseStatementDate', () => {
  it('reads ISO directly', () => {
    expect(parseStatementDate('2026-01-05')).toBe('2026-01-05');
    expect(parseStatementDate('2026-01-05T09:00:00Z')).toBe('2026-01-05');
  });

  it('defaults an ambiguous numeric date to day-first', () => {
    expect(parseStatementDate('05/01/2026')).toBe('2026-01-05');
    expect(parseStatementDate('05/01/2026', { dayFirst: false })).toBe('2026-05-01');
  });

  it('ignores the preference when only one reading is possible', () => {
    expect(parseStatementDate('25/01/2026', { dayFirst: false })).toBe('2026-01-25');
    expect(parseStatementDate('01/25/2026', { dayFirst: true })).toBe('2026-01-25');
  });

  it('expands a two-digit year into this century', () => {
    expect(parseStatementDate('05/01/26')).toBe('2026-01-05');
  });

  it('reads named months in either order', () => {
    expect(parseStatementDate('15 Jan 2026')).toBe('2026-01-15');
    expect(parseStatementDate('15-Jan-26')).toBe('2026-01-15');
    expect(parseStatementDate('Jan 15 2026')).toBe('2026-01-15');
    expect(parseStatementDate('15 January 2026')).toBe('2026-01-15');
  });

  it('rejects a date that does not exist rather than rolling it forward', () => {
    expect(parseStatementDate('31/02/2026')).toBeNull();
    expect(parseStatementDate('2026-13-01')).toBeNull();
  });

  it('returns null for unreadable input', () => {
    expect(parseStatementDate('')).toBeNull();
    expect(parseStatementDate('not a date')).toBeNull();
    expect(parseStatementDate(null)).toBeNull();
  });
});

describe('guessColumnMapping', () => {
  it('maps a plain three-column statement', () => {
    expect(guessColumnMapping(['Date', 'Description', 'Amount']))
      .toMatchObject({ date: 0, description: 1, amount: 2 });
  });

  it('prefers an exact header over a fuzzy one', () => {
    const mapping = guessColumnMapping(['Transaction Date', 'Date', 'Description', 'Amount']);
    expect(mapping.date).toBe(1);
  });

  it('maps separate money in and money out columns', () => {
    const mapping = guessColumnMapping(['Date', 'Details', 'Money Out', 'Money In', 'Balance']);
    expect(mapping).toMatchObject({ date: 0, description: 1, debit: 2, credit: 3, balance: 4 });
    expect(mapping.amount).toBeNull();
  });

  it('drops debit and credit when a single amount column exists', () => {
    const mapping = guessColumnMapping(['Date', 'Description', 'Amount', 'Debit', 'Credit']);
    expect(mapping.amount).toBe(2);
    expect(mapping.debit).toBeNull();
    expect(mapping.credit).toBeNull();
  });

  it('never claims one column for two fields', () => {
    const mapping = guessColumnMapping(['Date', 'Description', 'Amount']);
    const used = Object.values(mapping).filter(index => index != null);
    expect(new Set(used).size).toBe(used.length);
  });

  it('leaves unmatched fields null rather than guessing', () => {
    expect(guessColumnMapping(['Foo', 'Bar'])).toEqual({
      date: null, description: null, amount: null, debit: null, credit: null, balance: null,
    });
  });
});

describe('normaliseDescription', () => {
  it('strips the noise banks add around a merchant name', () => {
    expect(normaliseDescription('CARD PAYMENT TO TESCO STORES 05/01/26'))
      .toBe(normaliseDescription('TESCO STORES'));
    expect(normaliseDescription('TESCO xx4412')).toBe('tesco');
  });
});

describe('buildImportRows', () => {
  const mapping = { date: 0, description: 1, amount: 2, debit: null, credit: null, balance: null };

  it('treats money out as expense and money in as refund', () => {
    const rows = buildImportRows({
      rows: [['05/01/2026', 'Tesco', '-12.40'], ['06/01/2026', 'Refund', '8.00']],
      mapping,
    });

    expect(rows[0]).toMatchObject({ amount: 12.4, type: 'expense', date: '2026-01-05' });
    expect(rows[1]).toMatchObject({ amount: 8, type: 'refund' });
  });

  it('inverts signs on request, for banks that do it the other way', () => {
    const rows = buildImportRows({
      rows: [['05/01/2026', 'Tesco', '12.40']],
      mapping,
      invertSigns: true,
    });
    expect(rows[0]).toMatchObject({ amount: 12.4, type: 'expense' });
  });

  it('reads separate debit and credit columns', () => {
    const rows = buildImportRows({
      rows: [['05/01/2026', 'Tesco', '12.40', ''], ['06/01/2026', 'Salary', '', '900.00']],
      mapping: { date: 0, description: 1, amount: null, debit: 2, credit: 3, balance: null },
    });

    expect(rows[0]).toMatchObject({ amount: 12.4, type: 'expense' });
    expect(rows[1]).toMatchObject({ amount: 900, type: 'refund' });
  });

  it('marks rows it cannot read, and excludes them', () => {
    const rows = buildImportRows({
      rows: [['nonsense', 'Tesco', '-12.40'], ['05/01/2026', 'Tesco', 'N/A']],
      mapping,
    });

    expect(rows[0].status).toBe(ROW_INVALID);
    expect(rows[0].problem).toMatch(/date/i);
    expect(rows[1].status).toBe(ROW_INVALID);
    expect(rows[1].problem).toMatch(/amount/i);
    expect(rows.every(row => row.include === false)).toBe(true);
  });

  it('flags an exact duplicate of something already logged, and deselects it', () => {
    const rows = buildImportRows({
      rows: [['05/01/2026', 'TESCO STORES', '-12.40']],
      mapping,
      existingTransactions: [
        { date: '2026-01-05T12:00:00.000Z', amount: 12.4, merchant: 'TESCO STORES', type: 'expense' },
      ],
    });

    expect(rows[0].status).toBe(ROW_DUPLICATE);
    expect(rows[0].include).toBe(false);
  });

  it('flags a same-day same-amount row as similar, but keeps it selected', () => {
    const rows = buildImportRows({
      rows: [['05/01/2026', 'COSTA COFFEE', '-3.20']],
      mapping,
      existingTransactions: [
        { date: '2026-01-05T12:00:00.000Z', amount: 3.2, merchant: 'PRET A MANGER', type: 'expense' },
      ],
    });

    expect(rows[0].status).toBe(ROW_SIMILAR);
    // Two £3.20 coffees in a day is at least as likely as a double import.
    expect(rows[0].include).toBe(true);
  });

  it('catches a row repeated within the same file', () => {
    const rows = buildImportRows({
      rows: [['05/01/2026', 'Tesco', '-12.40'], ['05/01/2026', 'Tesco', '-12.40']],
      mapping,
    });

    expect(rows[0].status).toBe(ROW_NEW);
    expect(rows[1].status).toBe(ROW_DUPLICATE);
  });

  it('applies the injected category suggestion', () => {
    const rows = buildImportRows({
      rows: [['05/01/2026', 'Tesco', '-12.40']],
      mapping,
      suggestCategory: (text) => (/tesco/i.test(text) ? { categoryId: 7, source: 'rule', match: 'tesco' } : null),
    });

    expect(rows[0].categoryId).toBe(7);
    expect(rows[0].suggestion).toMatchObject({ source: 'rule' });
  });

  it('falls back to the default category when nothing matches', () => {
    const rows = buildImportRows({
      rows: [['05/01/2026', 'Unknown Shop', '-12.40']],
      mapping,
      defaultCategoryId: 3,
      suggestCategory: () => null,
    });

    expect(rows[0].categoryId).toBe(3);
  });

  it('flags a same-amount row a few days apart as similar, not a silent duplicate', () => {
    const rows = buildImportRows({
      rows: [['08/01/2026', 'TESCO STORES 3294', '-12.40']],
      mapping,
      // Logged the day of the purchase; the card statement posts it three
      // days later — the classic clearing-lag case.
      existingTransactions: [
        { date: '2026-01-05T12:00:00.000Z', amount: 12.4, merchant: 'Tesco', type: 'expense' },
      ],
    });

    expect(rows[0].status).toBe(ROW_SIMILAR);
    expect(rows[0].include).toBe(true);
    expect(rows[0].dateDrift).toBe(3);
    expect(rows[0].problem).toMatch(/3 days earlier/);
  });

  it('never auto-excludes a cross-date match, even with a matching description', () => {
    // A daily coffee at the same place for the same price is real, recurring
    // spend — not a duplicate import — so it must stay selected by default.
    const rows = buildImportRows({
      rows: [['03/01/2026', 'Costa Coffee', '-3.20']],
      mapping,
      existingTransactions: [
        { date: '2026-01-01T12:00:00.000Z', amount: 3.2, merchant: 'Costa Coffee', type: 'expense' },
      ],
    });

    expect(rows[0].status).toBe(ROW_SIMILAR);
    expect(rows[0].include).toBe(true);
  });

  it('leaves a same-amount row outside the tolerance window untouched', () => {
    const rows = buildImportRows({
      rows: [['20/01/2026', 'Tesco', '-12.40']],
      mapping,
      dateToleranceDays: 3,
      existingTransactions: [
        { date: '2026-01-05T12:00:00.000Z', amount: 12.4, merchant: 'Tesco', type: 'expense' },
      ],
    });

    expect(rows[0].status).toBe(ROW_NEW);
  });

  it('can have the tolerance window switched off entirely', () => {
    const rows = buildImportRows({
      rows: [['06/01/2026', 'Tesco', '-12.40']],
      mapping,
      dateToleranceDays: 0,
      existingTransactions: [
        { date: '2026-01-05T12:00:00.000Z', amount: 12.4, merchant: 'Tesco', type: 'expense' },
      ],
    });

    expect(rows[0].status).toBe(ROW_NEW);
  });
});

describe('toTransactionPayload', () => {
  it('emits only kept, categorised rows', () => {
    const payload = toTransactionPayload([
      { include: true, status: ROW_NEW, categoryId: 1, amount: 12.4, date: '2026-01-05', description: 'Tesco', type: 'expense' },
      { include: false, status: ROW_DUPLICATE, categoryId: 1, amount: 5, date: '2026-01-06', description: 'x', type: 'expense' },
      { include: true, status: ROW_NEW, categoryId: null, amount: 5, date: '2026-01-07', description: 'y', type: 'expense' },
      { include: true, status: ROW_INVALID, categoryId: 1, amount: 5, date: '2026-01-08', description: 'z', type: 'expense' },
    ]);

    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({ categoryId: 1, amount: 12.4, note: 'Tesco', type: 'expense' });
    // Stored at midday so a timezone shift can't move it to the previous day.
    expect(payload[0].date).toMatch(/^2026-01-05T12:00:00/);
  });
});

describe('summariseRows', () => {
  it('counts by status, and separates what is ticked from what will be written', () => {
    const summary = summariseRows([
      { status: ROW_NEW, include: true, categoryId: 1, amount: 10, type: 'expense' },
      { status: ROW_NEW, include: true, categoryId: null, amount: 5, type: 'expense' },
      { status: ROW_NEW, include: true, categoryId: 1, amount: 4, type: 'refund' },
      { status: ROW_DUPLICATE, include: false, categoryId: 1, amount: 99, type: 'expense' },
      { status: ROW_INVALID, include: false, categoryId: 1, amount: 99, type: 'expense' },
    ]);

    expect(summary).toMatchObject({
      total: 5, new: 3, duplicate: 1, invalid: 1,
      selected: 3, importable: 2, uncategorised: 1,
      // The uncategorised £5 is excluded: it won't be written, so it mustn't
      // appear in the spending figure shown next to the import button.
      expense: 10, refund: 4, net: 6,
    });
  });

  it('reports nothing importable when every ticked row lacks a category', () => {
    const rows = [
      { status: ROW_NEW, include: true, categoryId: null, amount: 10, type: 'expense' },
      { status: ROW_NEW, include: true, categoryId: null, amount: 5, type: 'expense' },
    ];
    const summary = summariseRows(rows);

    expect(summary.selected).toBe(2);
    expect(summary.importable).toBe(0);
    // The button reads from `importable`, so it must agree with the payload.
    expect(toTransactionPayload(rows)).toHaveLength(0);
  });

  it('keeps importable in step with the payload', () => {
    const rows = [
      { status: ROW_NEW, include: true, categoryId: 1, amount: 10, date: '2026-01-05', description: 'a', type: 'expense' },
      { status: ROW_NEW, include: true, categoryId: null, amount: 5, date: '2026-01-06', description: 'b', type: 'expense' },
      { status: ROW_SIMILAR, include: true, categoryId: 2, amount: 7, date: '2026-01-07', description: 'c', type: 'expense' },
      { status: ROW_DUPLICATE, include: false, categoryId: 2, amount: 7, date: '2026-01-08', description: 'd', type: 'expense' },
    ];

    expect(summariseRows(rows).importable).toBe(toTransactionPayload(rows).length);
  });
});

describe('reconciliation', () => {
  it('reports a match within a penny', () => {
    expect(reconcile(1000, 1000)).toMatchObject({ matches: true, difference: 0 });
    expect(reconcile(1000.004, 1000)).toMatchObject({ matches: true });
  });

  it('reports the size and direction of a real difference', () => {
    expect(reconcile(950, 1000)).toMatchObject({ matches: false, difference: -50 });
    expect(reconcile(1050, 1000)).toMatchObject({ matches: false, difference: 50 });
  });

  it('returns null when either figure is missing', () => {
    expect(reconcile(null, 1000)).toBeNull();
    expect(reconcile(1000, undefined)).toBeNull();
    expect(reconcile('abc', 1000)).toBeNull();
  });

  it('takes the closing balance from the latest row, not the last line', () => {
    // Newest-first, as plenty of banks export.
    const rows = [
      { index: 0, date: '2026-01-07', balance: 880 },
      { index: 1, date: '2026-01-06', balance: 900 },
      { index: 2, date: '2026-01-05', balance: 950 },
    ];
    expect(inferClosingBalance(rows)).toBe(880);
  });

  it('returns null when the file has no balance column', () => {
    expect(inferClosingBalance([{ index: 0, date: '2026-01-05', balance: null }])).toBeNull();
    expect(inferClosingBalance([])).toBeNull();
  });
});

describe('dedupe keys', () => {
  it('ignores time of day and description noise', () => {
    const a = buildDedupeKey({ date: '2026-01-05T09:00:00Z', amount: 12.4, description: 'CARD PAYMENT TO TESCO' });
    const b = buildDedupeKey({ date: '2026-01-05T18:30:00Z', amount: -12.4, description: 'TESCO' });
    expect(a).toBe(b);
  });
});

describe('end to end, on statements shaped like real ones', () => {
  const run = (text, options = {}) => {
    const parsed = parseCsv(text);
    const mapping = guessColumnMapping(parsed.headers);
    const rows = buildImportRows({ rows: parsed.rows, mapping, ...options });
    return { parsed, mapping, rows, payload: toTransactionPayload(rows), summary: summariseRows(rows) };
  };

  it('reads a Monzo-style single signed amount column', () => {
    const { payload, summary } = run(
      [
        'Transaction ID,Date,Time,Type,Name,Amount,Category',
        'tx_001,05/01/2026,09:14:22,Card payment,Tesco,-12.40,Groceries',
        'tx_002,06/01/2026,12:00:00,Faster payment,Refund from ASOS,24.99,Shopping',
      ].join('\n'),
      { defaultCategoryId: 1 },
    );

    expect(summary.selected).toBe(2);
    expect(payload[0]).toMatchObject({ amount: 12.4, type: 'expense', note: 'Tesco' });
    expect(payload[1]).toMatchObject({ amount: 24.99, type: 'refund' });
  });

  it('reads a high-street bank with separate in/out columns and a balance', () => {
    const { mapping, rows, payload } = run(
      [
        'Date,Description,Money Out,Money In,Balance',
        '05/01/2026,"CARD PAYMENT TO TESCO STORES",12.40,,987.60',
        '06/01/2026,"SALARY",,1500.00,2487.60',
      ].join('\n'),
      { defaultCategoryId: 1 },
    );

    expect(mapping.amount).toBeNull();
    expect(mapping.debit).toBe(2);
    expect(payload[0]).toMatchObject({ amount: 12.4, type: 'expense' });
    expect(payload[1]).toMatchObject({ amount: 1500, type: 'refund' });
    expect(inferClosingBalance(rows)).toBe(2487.6);
  });

  it('reads a semicolon-separated export with European decimals, once mapped', () => {
    const text = [
      'Datum;Beschreibung;Betrag',
      '05.01.2026;"REWE, BERLIN";-12,40',
      '06.01.2026;"GEHALT";1.500,00',
    ].join('\n');

    const parsed = parseCsv(text);
    expect(parsed.delimiter).toBe(';');
    expect(parsed.rows[0][1]).toBe('REWE, BERLIN');

    // Headers in another language can't be guessed, and shouldn't be — the
    // mapping step exists precisely so the user settles it.
    expect(guessColumnMapping(parsed.headers).date).toBeNull();

    const rows = buildImportRows({
      rows: parsed.rows,
      mapping: { date: 0, description: 1, amount: 2, debit: null, credit: null, balance: null },
      defaultCategoryId: 2,
    });
    const payload = toTransactionPayload(rows);

    expect(payload[0]).toMatchObject({ amount: 12.4, type: 'expense' });
    expect(payload[1]).toMatchObject({ amount: 1500, type: 'refund' });
  });

  it('skips what is already logged and imports only the rest', () => {
    const text = [
      'Date,Description,Amount',
      '05/01/2026,Tesco,-12.40',
      '06/01/2026,Boots,-8.00',
    ].join('\n');

    const { summary, payload } = run(text, {
      defaultCategoryId: 1,
      existingTransactions: [
        { date: '2026-01-05T12:00:00.000Z', amount: 12.4, merchant: 'Tesco', type: 'expense' },
      ],
    });

    expect(summary.duplicate).toBe(1);
    expect(payload).toHaveLength(1);
    expect(payload[0].note).toBe('Boots');
  });

  it('re-importing the very same file a second time adds nothing', () => {
    const text = [
      'Date,Description,Amount',
      '05/01/2026,Tesco,-12.40',
      '06/01/2026,Boots,-8.00',
    ].join('\n');

    const first = run(text, { defaultCategoryId: 1 });
    expect(first.payload).toHaveLength(2);

    // Feed the first import's own output back in as history, exactly as the
    // app would on a second run.
    const second = run(text, {
      defaultCategoryId: 1,
      existingTransactions: first.payload.map(tx => ({ ...tx, merchant: tx.note })),
    });

    expect(second.payload).toHaveLength(0);
    expect(second.summary.duplicate).toBe(2);
  });

  it('carries a whole statement through without losing or inventing a row', () => {
    const lines = ['Date,Description,Amount'];
    for (let day = 1; day <= 28; day += 1) {
      lines.push(`${String(day).padStart(2, '0')}/01/2026,Shop ${day},-${(day + 0.5).toFixed(2)}`);
    }

    const { rows, summary, payload } = run(lines.join('\n'), { defaultCategoryId: 1 });

    expect(rows).toHaveLength(28);
    expect(summary.invalid).toBe(0);
    expect(payload).toHaveLength(28);
    const total = payload.reduce((sum, tx) => sum + tx.amount, 0);
    // 1.5 + 2.5 + … + 28.5
    expect(total).toBeCloseTo(28 * (1.5 + 28.5) / 2, 2);
  });
});

describe('similarDescriptions', () => {
  it('matches a bank\'s verbose text against the user\'s own short note', () => {
    expect(similarDescriptions('Tesco', 'TESCO STORES 3294 LONDON GB')).toBe(true);
  });

  it('matches on shared words even without a clean substring', () => {
    expect(similarDescriptions('Amazon Prime', 'AMAZON PRIME*2K3F9')).toBe(true);
  });

  it('does not match unrelated merchants', () => {
    expect(similarDescriptions('Tesco', 'Shell Petrol Station')).toBe(false);
  });

  it('treats an empty description as no match either way', () => {
    expect(similarDescriptions('', 'Tesco')).toBe(false);
    expect(similarDescriptions('Tesco', '')).toBe(false);
  });
});

describe('hasUsableTextLayer', () => {
  it('accepts a page with real extracted text', () => {
    expect(hasUsableTextLayer('05/01/2026 TESCO STORES 12.40 987.60')).toBe(true);
  });

  it('rejects a blank or near-blank page — a scan with no text layer', () => {
    expect(hasUsableTextLayer('')).toBe(false);
    expect(hasUsableTextLayer('   \n  \n')).toBe(false);
    expect(hasUsableTextLayer('a b')).toBe(false);
  });
});

describe('textFromContent', () => {
  // A pdf.js TextItem carries `str` and a 6-number affine `transform`, of
  // which only index 4 (x) and 5 (y) matter here.
  const item = (str, x, y) => ({ str, transform: [1, 0, 0, 1, x, y] });

  it('keeps words on the same baseline as one line', () => {
    const content = { items: [item('TESCO', 40, 780), item('STORES', 90, 780), item('12.40', 400, 780)] };
    expect(textFromContent(content)).toBe('TESCO STORES 12.40');
  });

  it('separates rows at different baselines into their own lines, ordered top to bottom', () => {
    // Built out of order, and with a real statement's line spacing (~16pt) —
    // this is the exact shape a multi-row bank statement produces once
    // pdf.js has flattened it. Joining all of this with spaces instead of
    // reconstructing lines was the actual bug: a real multi-row statement
    // collapsed into one line, and parseStatementText could only ever find
    // its first date and its very last amount.
    const content = {
      items: [
        item('987.60', 460, 764),
        item('01 Sep 2026', 40, 780),
        item('TESCO STORES', 120, 780),
        item('12.40', 400, 780),
        item('02 Sep 2026', 40, 764),
        item('BRITISH GAS', 120, 764),
        item('45.00', 400, 764),
      ],
    };

    expect(textFromContent(content)).toBe(
      '01 Sep 2026 TESCO STORES 12.40\n02 Sep 2026 BRITISH GAS 45.00 987.60',
    );
  });

  it('tolerates tiny baseline jitter within one visual line without scrambling word order', () => {
    // A bold run or a different glyph can land a fraction of a point off the
    // rest of the line's baseline; that must not read as a second line, and
    // must not let that same jitter reorder the words themselves.
    const content = { items: [item('TESCO', 40, 780.0), item('12.40', 400, 780.8)] };
    expect(textFromContent(content)).toBe('TESCO 12.40');
  });

  it('drops empty and whitespace-only runs', () => {
    const content = { items: [item('TESCO', 40, 780), item('   ', 90, 780), item('', 95, 780)] };
    expect(textFromContent(content)).toBe('TESCO');
  });

  it('returns an empty string for a page with no text', () => {
    expect(textFromContent({ items: [] })).toBe('');
  });

  it('feeds straight into parseStatementText, end to end', () => {
    const content = {
      items: [
        item('01 Sep 2026', 40, 780), item('TESCO STORES', 120, 780), item('12.40', 400, 780), item('987.60', 460, 780),
        item('02 Sep 2026', 40, 764), item('BRITISH GAS', 120, 764), item('45.00', 400, 764), item('942.60', 460, 764),
      ],
    };
    const { rows } = parseStatementText(textFromContent(content));
    // Signed money-out: the amounts are unsigned on the page, as they are on
    // every real statement, and parseStatementText resolves the direction
    // rather than leaving it to be read as a refund. Row two is settled by
    // the running balance falling by exactly 45.00; row one has nothing
    // before it to compare against and takes the money-out default.
    expect(rows).toEqual([
      ['01 Sep 2026', 'TESCO STORES', '-12.40', '987.60'],
      ['02 Sep 2026', 'BRITISH GAS', '-45.00', '942.60'],
    ]);
  });
});

describe('parseStatementText', () => {
  it('reads a simple ledger line: date, description, trailing amount', () => {
    const { rows, mapping } = parseStatementText('05/01/2026 TESCO STORES 12.40');
    expect(rows).toEqual([['05/01/2026', 'TESCO STORES', '-12.40', '']]);
    expect(mapping).toEqual({ date: 0, description: 1, amount: 2, debit: null, credit: null, balance: 3 });
  });

  it('takes two trailing numbers as amount then running balance', () => {
    const { rows } = parseStatementText('05/01/2026 TESCO STORES 12.40 987.60');
    expect(rows[0]).toEqual(['05/01/2026', 'TESCO STORES', '-12.40', '987.60']);
  });

  it('drops header lines that appear before the first date', () => {
    const text = [
      'Account: 12345678',
      'Statement period: Jan 2026',
      '05/01/2026 TESCO STORES 12.40',
    ].join('\n');
    const { rows } = parseStatementText(text);
    expect(rows).toHaveLength(1);
  });

  it('folds a wrapped description onto the transaction it belongs to', () => {
    const text = [
      '05/01/2026 CARD PAYMENT TO',
      'TESCO STORES 3294 12.40',
    ].join('\n');
    const { rows } = parseStatementText(text);
    expect(rows).toHaveLength(1);
    expect(rows[0][1]).toBe('CARD PAYMENT TO TESCO STORES 3294');
    expect(rows[0][2]).toBe('-12.40');
  });

  it('keeps the earlier of two dates on a line — transaction date over posting date', () => {
    const { rows } = parseStatementText('01/09/2026 03/09/2026 TESCO STORES 12.40');
    expect(rows[0][0]).toBe('01/09/2026');
    expect(rows[0][1]).toBe('TESCO STORES');
  });

  it('turns a trailing CR marker into a credit, and DR into a debit', () => {
    const text = [
      '05/01/2026 SALARY 1500.00 CR',
      '06/01/2026 TESCO STORES 12.40 DR',
    ].join('\n');
    const { rows, mapping } = parseStatementText(text);

    const built = buildImportRows({ rows, mapping });
    expect(built[0]).toMatchObject({ amount: 1500, type: 'refund' });
    expect(built[1]).toMatchObject({ amount: 12.4, type: 'expense' });
  });

  it('feeds straight into buildImportRows like a CSV would', () => {
    const { rows, mapping } = parseStatementText('05/01/2026 TESCO STORES -12.40 987.60');
    const built = buildImportRows({ rows, mapping, defaultCategoryId: 1 });
    expect(built[0]).toMatchObject({
      date: '2026-01-05', description: 'TESCO STORES', amount: 12.4, type: 'expense', balance: 987.6,
    });
  });

  it('returns nothing for text with no dated lines at all', () => {
    const { rows } = parseStatementText('This is not a bank statement.');
    expect(rows).toEqual([]);
  });
});

describe('parseStatementText, on the shapes real statements print', () => {
  it('ignores a money-shaped reference and takes the amount flush to the right', () => {
    // Money columns are always the rightmost thing on a row and always
    // adjacent; a figure with words after it is part of the description, not
    // a column. Reading right-to-left without that rule imported the £100
    // reference instead of the £12.40 purchase.
    const { rows } = parseStatementText('01/09/2026 DD BRITISH GAS REF 100.00 PAID 12.40');
    // The "DD" goes too — both readings drop the payment-type code, or a
    // description would depend on which of them ran.
    expect(rows[0][1]).toBe('BRITISH GAS REF 100.00 PAID');
    expect(rows[0][2]).toBe('-12.40');
  });

  it('reads the non-zero column when a statement prints money out and money in on every row', () => {
    const text = [
      '01/09/2026 TESCO STORES 12.40 0.00 987.60',
      '02/09/2026 ACME LTD SALARY 0.00 1500.00 2487.60',
    ].join('\n');
    const { rows } = parseStatementText(text);

    expect(rows[0]).toEqual(['01/09/2026', 'TESCO STORES', '-12.40', '987.60']);
    expect(rows[1]).toEqual(['02/09/2026', 'ACME LTD SALARY', '1500.00', '2487.60']);
  });

  it('works out money in from a rising balance, and money out from a falling one', () => {
    const text = [
      '01/09/2026 TESCO STORES 12.40 987.60',
      '02/09/2026 ACME LTD SALARY 1500.00 2487.60',
      '03/09/2026 BRITISH GAS 45.00 2442.60',
    ].join('\n');
    const { rows, mapping, layout } = parseStatementText(text);
    const built = buildImportRows({ rows, mapping, defaultCategoryId: 1 });

    expect(built[1]).toMatchObject({ amount: 1500, type: 'refund' });
    expect(built[2]).toMatchObject({ amount: 45, type: 'expense' });
    // Nothing precedes the first row, so it takes the money-out default.
    expect(built[0]).toMatchObject({ amount: 12.4, type: 'expense' });
    expect(layout.balance).toMatchObject({ checked: 2, agreed: 2 });
  });

  it('stops reading the last column as a balance when the arithmetic says it is not one', () => {
    // Three rows that all carry the same figure before the amount: read as a
    // running balance it would have to change by 100.00 every row and plainly
    // doesn't, so the last column is the amount and there is no balance.
    const text = [
      '01/09/2026 TESCO 100.00 12.40',
      '02/09/2026 BOOTS 100.00 18.99',
      '03/09/2026 SHELL 100.00 42.10',
    ].join('\n');
    const { rows, mapping } = parseStatementText(text);

    expect(mapping.balance).toBeNull();
    expect(rows.map(row => row[2])).toEqual(['-12.40', '-18.99', '-42.10']);
  });

  it('borrows the year from the statement header for rows that print only a day and month', () => {
    const text = [
      'Your statement 1 January 2026 to 31 January 2026',
      '05 Jan TESCO STORES 12.40 987.60',
      '06 Jan BRITISH GAS 45.00 942.60',
    ].join('\n');
    const { rows, mapping } = parseStatementText(text);
    const built = buildImportRows({ rows, mapping, defaultCategoryId: 1 });

    expect(built.map(row => row.date)).toEqual(['2026-01-05', '2026-01-06']);
  });

  it('will not take a bare four-digit number in a header as the year', () => {
    // A registration number, a sort code fragment or a page count would
    // otherwise date the whole statement to something invented.
    const { rows } = parseStatementText('Registered in England no 2065514\n05 Jan TESCO 12.40');
    expect(rows).toEqual([]);
  });

  it('drops a balance-carried-forward line instead of gluing it to the last transaction', () => {
    const text = [
      '01/09/2026 TESCO STORES 12.40 987.60',
      'BALANCE CARRIED FORWARD 987.60',
    ].join('\n');
    const { rows } = parseStatementText(text);

    expect(rows).toHaveLength(1);
    expect(rows[0][1]).toBe('TESCO STORES');
  });

  it('leaves a CR-marked credit alone rather than defaulting it to money out', () => {
    const { rows, mapping } = parseStatementText('05/01/2026 SALARY 1500.00 CR');
    const built = buildImportRows({ rows, mapping, defaultCategoryId: 1 });
    expect(built[0]).toMatchObject({ amount: 1500, type: 'refund' });
  });
});

describe('scoreRunningBalance', () => {
  const mapping = { date: 0, description: 1, amount: 2, debit: null, credit: null, balance: 3 };

  it('agrees with a statement whose balance column adds up', () => {
    const rows = [
      ['01/09/2026', 'TESCO', '-12.40', '987.60'],
      ['02/09/2026', 'SHELL', '-45.00', '942.60'],
      ['03/09/2026', 'SALARY', '1500.00', '2442.60'],
    ];
    expect(scoreRunningBalance(rows, mapping)).toEqual({ checked: 2, agreed: 2, ratio: 1 });
  });

  it('reports nothing checked rather than a passing score when there is no balance column', () => {
    const rows = [['01/09/2026', 'TESCO', '-12.40', '']];
    expect(scoreRunningBalance(rows, { ...mapping, balance: null }))
      .toEqual({ checked: 0, agreed: 0, ratio: null });
  });

  it('catches a parse that put the wrong number in the amount column', () => {
    const rows = [
      ['01/09/2026', 'TESCO', '-12.40', '987.60'],
      ['02/09/2026', 'SHELL', '-99.99', '942.60'],
    ];
    expect(scoreRunningBalance(rows, mapping)).toMatchObject({ checked: 1, agreed: 0 });
  });

  it('reads a money-out/money-in pair the same way buildImportRows does', () => {
    const pair = { date: 0, description: 1, amount: null, debit: 2, credit: 3, balance: 4 };
    const rows = [
      ['01/09/2026', 'TESCO', '12.40', '', '987.60'],
      ['02/09/2026', 'SALARY', '', '1500.00', '2487.60'],
    ];
    expect(scoreRunningBalance(rows, pair)).toMatchObject({ checked: 1, agreed: 1 });
  });
});

describe('parseStatementLines — a statement read as the columns it was printed in', () => {
  // A pdf.js TextItem, with the `width` the library reports alongside `str`
  // and `transform`. That width is what makes column geometry readable: it is
  // the difference between knowing where a run starts and knowing what space
  // it occupies.
  const run = (str, x, y, width) => ({ str, width, transform: [1, 0, 0, 1, x, y] });

  // The layout Lloyds, Halifax and Bank of Scotland share, and close to what
  // Barclays, HSBC, NatWest and Santander print: money out and money in are
  // separate columns and the amount in each is unsigned, so the direction of
  // a transaction is carried by *which column it is in* and by nothing on the
  // line itself. Flattening the page to text throws that away.
  const header = [
    run('Date', 40, 700, 18),
    run('Payment type', 80, 700, 50),
    run('Details', 140, 700, 30),
    run('Paid out', 330, 700, 34),
    run('Paid in', 390, 700, 28),
    run('Balance', 445, 700, 32),
  ];
  const expense = [
    run('05 Jan 2026', 40, 684, 45),
    run('DEB', 80, 684, 14),
    run('TESCO STORES 3294', 140, 684, 76),
    run('12.40', 341, 684, 23),
    run('987.60', 449, 684, 28),
  ];
  const wrapped = [run('LONDON GB', 140, 670, 44)];
  const credit = [
    run('06 Jan 2026', 40, 654, 45),
    run('BGC', 80, 654, 14),
    run('ACME LTD SALARY', 140, 654, 68),
    run('1,500.00', 380, 654, 38),
    run('2,487.60', 440, 654, 37),
  ];

  const linesOf = (...items) => linesFromContent({ items: items.flat() });
  const parse = (...items) => parseStatementLines(linesOf(...items));
  // Lines are clustered per page and then concatenated in reading order,
  // exactly as ocr.js hands them over: y restarts at the top of every page,
  // so a page-two row at the same height as page one's header must not be
  // merged into it.
  const parsePages = (...pages) => parseStatementLines(pages.flatMap(page => linesOf(...page)));

  it('maps money out and money in to their own columns, so direction is structural', () => {
    const { rows, mapping, layout } = parse(header, expense, credit);

    expect(layout.method).toBe('columns');
    expect(layout.fields).toEqual({
      date: 'Date', description: 'Details', debit: 'Paid out', credit: 'Paid in', balance: 'Balance',
    });
    expect(mapping.amount).toBeNull();

    const built = buildImportRows({ rows, mapping, defaultCategoryId: 1 });
    expect(built[0]).toMatchObject({ date: '2026-01-05', amount: 12.4, type: 'expense', balance: 987.6 });
    expect(built[1]).toMatchObject({ date: '2026-01-06', amount: 1500, type: 'refund', balance: 2487.6 });
  });

  it('checks itself against the statement’s own running balance', () => {
    const { layout } = parse(header, expense, credit);
    expect(layout.balance).toMatchObject({ checked: 1, agreed: 1, ratio: 1 });
  });

  it('leaves the payment-type column out of the description', () => {
    // "DEB" is noise for matching a bank's wording against something the user
    // typed by hand, and the flattened reading had no way to drop it.
    const { rows, mapping } = parse(header, expense, credit);
    expect(rows[0][mapping.description]).toBe('TESCO STORES 3294');
    // The raw row keeps every column the statement printed, mapped or not —
    // what matters is that an unmapped one never reaches the transaction.
    const built = buildImportRows({ rows, mapping, defaultCategoryId: 1 });
    expect(built[0].description).toBe('TESCO STORES 3294');
  });

  it('folds a wrapped description onto the row above it', () => {
    const { rows, mapping } = parse(header, expense, wrapped, credit);
    expect(rows[0][mapping.description]).toBe('TESCO STORES 3294 LONDON GB');
    expect(rows).toHaveLength(2);
  });

  it('carries the header across a page break that does not reprint it', () => {
    // A table starting mid-page and continuing past a break is the case that
    // breaks position-by-position parsers: page two has rows and no header.
    const page2 = [
      run('07 Jan 2026', 40, 700, 45),
      run('DD', 80, 700, 10),
      run('BRITISH GAS', 140, 700, 52),
      run('45.00', 341, 700, 23),
      run('2,442.60', 440, 700, 37),
    ];
    const { rows, mapping } = parsePages([header, expense, credit], [page2]);
    const built = buildImportRows({ rows, mapping, defaultCategoryId: 1 });

    expect(built).toHaveLength(3);
    expect(built[2]).toMatchObject({ date: '2026-01-07', amount: 45, type: 'expense' });
  });

  it('drops a dated balance-brought-forward row rather than showing it as unimportable', () => {
    const broughtForward = [
      run('01 Jan 2026', 40, 692, 45),
      run('BALANCE BROUGHT FORWARD', 140, 692, 104),
      run('900.00', 449, 692, 28),
    ];
    const { rows } = parse(header, broughtForward, expense, credit);
    expect(rows).toHaveLength(2);
  });

  it('drops page furniture instead of appending it to the last transaction', () => {
    const footer = [run('Page 1 of 2', 40, 60, 45)];
    const { rows, mapping } = parse(header, expense, credit, footer);
    expect(rows).toHaveLength(2);
    expect(rows[1][mapping.description]).toBe('ACME LTD SALARY');
  });

  it('rescues an amount from a description that overflows into the money column', () => {
    // Most statements leave the details column room to run past its own edge,
    // since nothing is printed beside it on most rows. Its tail then lands in
    // "paid out" and displaces the amount, and the row reaches review with
    // nothing to import.
    const overflowing = [
      run('07 Jan 2026', 40, 638, 45),
      run('A VERY LONG MERCHANT NAME INDEED', 140, 638, 220),
      run('9.99', 346, 638, 18),
      run('2,477.61', 440, 638, 37),
    ];
    const { rows, mapping } = parse(header, expense, credit, overflowing);
    const built = buildImportRows({ rows, mapping, defaultCategoryId: 1 });

    expect(built[2]).toMatchObject({ amount: 9.99, type: 'expense' });
    expect(built[2].description).toContain('A VERY LONG MERCHANT NAME INDEED');
  });

  it('groups a header label split across two runs', () => {
    const split = [
      run('Date', 40, 700, 18),
      run('Payment type', 80, 700, 50),
      run('Details', 140, 700, 30),
      run('Paid', 330, 700, 16),
      run('out', 349, 700, 13),
      run('Paid in', 390, 700, 28),
      run('Balance', 445, 700, 32),
    ];
    const { layout } = parse(split, expense, credit);
    expect(layout.fields.debit).toBe('Paid out');
  });

  it('drops the payment-type code a bank prints beside the merchant', () => {
    // "DEB" is the same string on every card payment and no part of the
    // merchant's name, so it makes two unrelated rows look alike and none of
    // them look like what the user typed by hand.
    const { rows, mapping } = parse(header, expense, credit);
    expect(rows[0][mapping.description]).toBe('TESCO STORES 3294');
    expect(rows[1][mapping.description]).toBe('ACME LTD SALARY');
  });

  it('does not mistake the start of a real merchant for a payment-type code', () => {
    const interest = [
      run('21 Jan 2026', 40, 654, 45),
      run('INT', 80, 654, 12),
      run('INTEREST PAID', 140, 654, 58),
      run('1.24', 384, 654, 18),
      run('988.84', 449, 654, 28),
    ];
    const { rows, mapping } = parse(header, expense, interest);
    expect(rows[1][mapping.description]).toBe('INTEREST PAID');
  });

  it('reads a CR-marked amount in a money column as money in', () => {
    // A credit-card statement writes direction as a trailing CR or DR rather
    // than with separate columns, and parseAmount cannot read "12.40 CR".
    const singleAmount = [
      run('Date', 40, 700, 18),
      run('Description', 140, 700, 50),
      run('Amount', 360, 700, 30),
      run('Balance', 445, 700, 32),
    ];
    const refund = [
      run('05 Jan 2026', 40, 684, 45),
      run('REFUND ASOS', 140, 684, 52),
      run('18.99 CR', 350, 684, 36),
      run('1,006.59', 440, 684, 37),
    ];
    const { rows, mapping, layout } = parse(singleAmount, refund);

    expect(layout.method).toBe('columns');
    const built = buildImportRows({ rows, mapping, defaultCategoryId: 1 });
    expect(built[0]).toMatchObject({ amount: 18.99, type: 'refund' });
  });

  it('does not read a header reprinted at the top of page two as a wrapped description', () => {
    // The statement period lands under the details column with every other
    // column empty — indistinguishable from a wrap except that it is on the
    // next page. Read as one it appends the whole header to page one's last
    // transaction.
    const page2 = [
      [run('Your statement 1 January to 31 January 2026', 140, 800, 196)],
      [
        run('07 Jan 2026', 40, 760, 45),
        run('DD', 80, 760, 10),
        run('BRITISH GAS', 140, 760, 52),
        run('45.00', 341, 760, 23),
        run('2,442.60', 440, 760, 37),
      ],
    ];
    const { rows, mapping } = parsePages([header, expense, credit], page2.flat());

    expect(rows).toHaveLength(3);
    expect(rows[1][mapping.description]).toBe('ACME LTD SALARY');
    expect(rows.join(' ')).not.toContain('Your statement');
  });

  it('does not append a line far below the last transaction', () => {
    const marketing = [run('Ways to bank with us', 140, 400, 90)];
    const { rows, mapping } = parse(header, expense, credit, marketing);
    expect(rows[1][mapping.description]).toBe('ACME LTD SALARY');
  });

  it('falls back to the line-by-line reading when the page has no header at all', () => {
    const { layout, rows } = parse(expense, credit);
    expect(layout.method).toBe('lines');
    expect(rows).toHaveLength(2);
  });

  it('does not mistake a transaction row for a header', () => {
    // "Balance brought forward … 900.00" matches /balance/i as surely as the
    // real header does; carrying money is what tells them apart.
    const { layout } = parse(
      [run('01 Jan 2026', 40, 700, 45), run('BALANCE BROUGHT FORWARD', 140, 700, 104), run('900.00', 449, 700, 28)],
      expense,
    );
    expect(layout.method).toBe('lines');
  });
});
