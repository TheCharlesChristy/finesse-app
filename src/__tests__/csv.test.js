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
  inferClosingBalance, normaliseDescription, parseAmount, parseCsv,
  parseStatementDate, reconcile, summariseRows, toTransactionPayload,
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
