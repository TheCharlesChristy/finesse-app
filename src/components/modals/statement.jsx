import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowLeft, Camera, Check, Columns3, FileUp, Loader2, Scale, Upload,
} from 'lucide-react';

import { Modal, Field } from '../ui';
import CategorySelect from '../CategorySelect';
import {
  buildImportRows, guessColumnMapping, inferClosingBalance, parseAmount, parseCsv,
  parseStatementLines, parseStatementText, reconcile, summariseRows, toTransactionPayload,
  ROW_DUPLICATE, ROW_INVALID, ROW_SIMILAR,
} from '../../csv';
import { fmt, suggestCategoryForNote, TX_EXPENSE, TX_REFUND } from '../../utils';

const LAYOUT_TONES = {
  good: { background: 'rgba(79,255,176,0.08)', color: 'var(--good)' },
  warn: { background: 'rgba(251,191,112,0.09)', color: 'var(--warn)' },
  neutral: { background: 'rgba(255,255,255,0.04)', color: 'var(--text-secondary)' },
};

/**
 * What to tell the user about how their statement was read.
 *
 * There is no way to show the PDF beside the rows on a phone, so the
 * statement's own running balance is the only check available — and it is a
 * real one: it confirms both the amount and which way the money went. Where it
 * verifies, say so; where there is nothing to verify against, say that too,
 * rather than presenting a guess with the same confidence as a checked read.
 */
function describeLayout(layout) {
  if (!layout) return null;
  const { checked, agreed } = layout.balance;

  const heading = layout.method === 'columns'
    ? `Read using your statement’s own columns — ${layout.columns.join(' · ')}.`
    : 'No column headings were found, so each row was read as a date at the start and its amounts at the end.';

  if (!checked) {
    return { tone: 'neutral', heading, detail: 'It has no running balance to check those amounts against, so give them a glance before importing.' };
  }
  if (agreed === checked) {
    return {
      tone: 'good',
      heading,
      detail: `Its running balance adds up on every row that could be checked (${checked}), so the amounts and whether each is spending or a refund match the statement itself.`,
    };
  }
  return {
    tone: 'warn',
    heading,
    detail: `Its running balance doesn’t add up on ${checked - agreed} of the ${checked} rows that could be checked — worth looking over those amounts, and whether they’re spending or refunds.`,
  };
}

const STATUS_STYLES = {
  duplicate: { label: 'Already logged', color: 'var(--text-muted)' },
  similar: { label: 'Looks familiar', color: 'var(--warn)' },
  invalid: { label: 'Can’t import', color: 'var(--danger)' },
};

const MAPPING_FIELDS = [
  ['date', 'Date', true],
  ['description', 'Description', false],
  ['amount', 'Amount', false],
  ['debit', 'Money out', false],
  ['credit', 'Money in', false],
  ['balance', 'Balance', false],
];

/** A WebAssembly compile/link failure reaching here means SIMD was already
 * confirmed supported (see ocr.js) — the one case worth calling a bad
 * download rather than naming the pipeline stage plainly. */
function isLikelyBadDownload(error) {
  const cause = error?.cause;
  return typeof WebAssembly !== 'undefined'
    && (cause instanceof WebAssembly.CompileError || cause instanceof WebAssembly.LinkError);
}

/** Short, one-page-of-many description for the partial-failure warning list. */
function describeOcrError(error) {
  if (error?.name === 'StageError') {
    return isLikelyBadDownload(error)
      ? `${error.stage} — likely an interrupted download`
      : `${error.stage}: ${String(error.cause?.message || error.cause || 'unknown error').slice(0, 100)}`;
  }
  return error?.message ? String(error.message).slice(0, 100) : (error?.name || 'unknown error');
}

// The production build writes a *hidden* sourcemap (vite.config.js) — never
// fetched by a browser, but able to turn a raw minified stack trace back
// into real file/line locations for whoever has the matching dist output.
// An iPhone has no easy path to devtools, so this — copied out of the error
// text and sent back — is the only way a genuinely new failure ever becomes
// more than a stage name.
function stackSnippet(error) {
  const stack = error?.cause?.stack || error?.stack;
  return stack ? `\n${String(stack).split('\n').slice(0, 4).join('\n')}` : '';
}

/**
 * The full, honest message for a failure that stopped the import outright.
 *
 * Only the WebAssembly-compile-failure case gets to claim a cause ("likely
 * an interrupted download") — everything else just names the stage it broke
 * in, rather than guessing why. A real bank-generated PDF is far more
 * complex than anything hand-built for testing here, so a genuine pdf.js or
 * Tesseract incompatibility on someone's actual statement is a real
 * possibility this can't rule out or explain away.
 */
function describeOcrFailure(err, ocrModule) {
  if (ocrModule && err instanceof ocrModule.OcrUnsupportedError) {
    return 'OCR isn’t supported on this device or browser. A CSV export, or your bank’s own PDF, will still work.';
  }
  if (isLikelyBadDownload(err)) {
    return `Couldn’t read that file — likely an interrupted download rather than the file itself (failed while ${err.stage}). Please try again.`;
  }
  if (err?.name === 'StageError') {
    return `Couldn’t read that file — it failed while ${err.stage}. (${String(err.cause?.message || '').slice(0, 120)}) A CSV export is the most reliable option.${stackSnippet(err)}`;
  }
  const detail = err?.message ? String(err.message).slice(0, 140) : (err?.name || 'unknown error');
  return `Couldn’t read that file. (${detail}) A CSV export is the most reliable option.${stackSnippet(err)}`;
}

function ColumnPicker({ label, headers, value, onChange, required }) {
  return (
    <Field label={required ? `${label} *` : label}>
      {id => (
        <select id={id} className="glass-input" value={value == null ? '' : String(value)}
          onChange={e => onChange(e.target.value === '' ? null : Number(e.target.value))}
          style={{ padding: '8px 10px', fontSize: 12 }}>
          <option value="">— none —</option>
          {headers.map((header, index) => (
            <option key={index} value={index}>{header || `Column ${index + 1}`}</option>
          ))}
        </select>
      )}
    </Field>
  );
}

/**
 * The amount field needs its own local text, uncommitted until blur.
 *
 * It's a post-hoc override (see `buildImportRows` below) rather than a value
 * threaded back through `parseAmount`, so nothing re-parses it keystroke by
 * keystroke — a controlled input bound straight to the parsed number would
 * otherwise reformat "12.50" down to "12.5" after the first new digit.
 */
function AmountField({ value, disabled, onCommit }) {
  const [text, setText] = useState(() => (value == null ? '' : String(value)));
  // Adjusting state during render (guarded, so it only fires the one extra
  // render React expects) rather than in an effect — resetting the typed
  // text when the committed value changes from outside shouldn't wait a tick.
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setText(value == null ? '' : String(value));
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      className="glass-input"
      disabled={disabled}
      value={text}
      onChange={e => setText(e.target.value)}
      onBlur={() => {
        const parsed = parseAmount(text);
        if (parsed != null) onCommit(Math.abs(parsed));
        else setText(value == null ? '' : String(value));
      }}
      aria-label="Amount"
      style={{ padding: '4px 6px', fontSize: 12, width: 64, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}
    />
  );
}

/**
 * Import a bank statement: pick the file, confirm the columns (or skip
 * straight past that for a photo/PDF), review the rows.
 *
 * Three ways in, one shared review. A CSV export goes through column mapping
 * because its shape genuinely varies bank to bank; a photo, screenshot or PDF
 * doesn't have columns to map in the first place — `ocr.js` and
 * `parseStatementText` turn it into the same `{ rows, mapping }` shape a CSV
 * produces, so everything downstream (dedupe, category suggestion, the review
 * table) runs unchanged.
 *
 * The review step is the point of the whole thing, more so than ever with a
 * source this noisy: every row's date, description and amount stays editable
 * right up to import, because OCR misreads a character far more often than a
 * bank's own CSV export does, and a row that can't be fixed is a row that
 * can't be imported. Nothing is written until the user says so.
 */
export function ImportStatementModal({
  categories = [],
  transactions = [],
  rules = [],
  account = null,
  defaultCategoryId = null,
  onImport,
  onClose,
}) {
  const [step, setStep] = useState('file'); // file | extracting | map | review
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState([]); // non-empty only for a CSV source
  const [parsedRows, setParsedRows] = useState(null);
  const [mapping, setMapping] = useState(null);
  const [dayFirst, setDayFirst] = useState(true);
  const [invertSigns, setInvertSigns] = useState(false);
  const [dateToleranceDays, setDateToleranceDays] = useState(3);
  const [overrides, setOverrides] = useState({});
  // How a photo or PDF was read, and whether the statement's own running
  // balance agrees with the result. Null for a CSV, where the user chose the
  // columns themselves and has nothing to be told.
  const [layout, setLayout] = useState(null);
  const [error, setError] = useState('');
  // Set when some (not all) pages of a PDF failed to read — non-blocking,
  // shown alongside whatever rows the readable pages still produced.
  const [partialWarning, setPartialWarning] = useState('');
  const [busy, setBusy] = useState(false);
  const [ocrProgress, setOcrProgress] = useState(null);

  // The OCR worker holds a real wasm heap open; there's no reason to keep it
  // alive once this modal is gone.
  useEffect(() => () => {
    import('../../ocr').then(({ terminateOcr }) => terminateOcr()).catch(() => {});
  }, []);

  // Rules and history are the app's, not this module's — hence a closure rather
  // than csv.js reaching for them itself.
  const suggestCategory = useMemo(() => (
    (text) => suggestCategoryForNote(text, { rules, transactions, categories })
  ), [rules, transactions, categories]);

  // Edits to date or description are folded back into the raw values *before*
  // buildImportRows runs, so a corrected date re-enters dedupe and category
  // suggestion properly rather than just changing what's displayed.
  const effectiveRawRows = useMemo(() => {
    if (!parsedRows || !mapping) return [];
    return parsedRows.map((values, index) => {
      const fields = overrides[index]?.fields;
      if (!fields) return values;
      const next = [...values];
      if (fields.date != null && mapping.date != null) next[mapping.date] = fields.date;
      if (fields.description != null && mapping.description != null) next[mapping.description] = fields.description;
      return next;
    });
  }, [parsedRows, mapping, overrides]);

  const rows = useMemo(() => {
    if (!effectiveRawRows.length || !mapping) return [];
    const built = buildImportRows({
      rows: effectiveRawRows,
      mapping,
      existingTransactions: transactions,
      suggestCategory,
      defaultCategoryId,
      dayFirst,
      invertSigns,
      dateToleranceDays,
    });
    // Amount, type, category and include are layered on top rather than fed
    // back through parsing — an amount edit fixes what gets written, not the
    // sign or the dedupe decision already made against the parsed one.
    return built.map(row => (overrides[row.index] ? { ...row, ...overrides[row.index] } : row));
  }, [effectiveRawRows, mapping, transactions, suggestCategory, defaultCategoryId, dayFirst, invertSigns, dateToleranceDays, overrides]);

  const summary = useMemo(() => summariseRows(rows), [rows]);
  const closingBalance = useMemo(() => inferClosingBalance(rows), [rows]);
  const reconciliation = useMemo(
    () => reconcile(closingBalance, account?.balance),
    [closingBalance, account?.balance],
  );
  const layoutNote = useMemo(() => describeLayout(layout), [layout]);

  const setOverride = (index, patch) => {
    setOverrides(current => {
      const prev = current[index] || {};
      const next = { ...prev, ...patch };
      if (patch.fields) next.fields = { ...prev.fields, ...patch.fields };
      return { ...current, [index]: next };
    });
  };

  const handleCsvFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setError('');
    setPartialWarning('');
    setBusy(true);
    try {
      const text = await file.text();
      const result = parseCsv(text);
      if (!result.headers.length || !result.rows.length) {
        setError('That file has no rows we could read.');
        return;
      }
      const guessed = guessColumnMapping(result.headers);
      if (guessed.date == null) {
        setError('Couldn’t find a date column. Check this is a statement export.');
      }
      setFileName(file.name);
      setHeaders(result.headers);
      setParsedRows(result.rows);
      setMapping(guessed);
      setLayout(null);
      setOverrides({});
      setStep('map');
    } catch {
      setError('That file couldn’t be read.');
    } finally {
      setBusy(false);
    }
  };

  const handleOcrFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setError('');
    setPartialWarning('');
    setFileName(file.name);
    setOcrProgress({ status: 'starting', progress: 0 });
    setStep('extracting');
    // Declared outside the try so the catch block — a separate scope — can
    // still reach OcrUnsupportedError to tell a real incompatibility apart
    // from everything else.
    let ocrModule;
    try {
      ocrModule = await import('../../ocr');
      const { text, lines, pageErrors } = await ocrModule.extractStatementText(file, { onProgress: setOcrProgress });
      // Real columns where the PDF's own geometry offers them — that is what
      // tells money out from money in — and the flattened reading otherwise.
      const result = lines
        ? parseStatementLines(lines, { dayFirst })
        : parseStatementText(text, { dayFirst });
      if (!result.rows.length) {
        setError('Couldn’t find anything that looked like a transaction in that file. A clearer photo, or your bank’s own PDF, works best.');
        setStep('file');
        return;
      }
      // Some pages failed but at least one didn't — extractStatementText
      // only throws outright when every page does. Worth a warning, not a
      // dead end: the rows below are still real, just incomplete.
      if (pageErrors?.length) {
        const summary = pageErrors.map(({ page, error }) => `page ${page} (${describeOcrError(error)})`).join('; ');
        setPartialWarning(`Couldn’t read the whole statement — ${summary}. Rows from the rest of it are below.`);
      }
      setHeaders([]);
      setParsedRows(result.rows);
      setMapping(result.mapping);
      setLayout(result.layout);
      setOverrides({});
      setStep('review');
    } catch (err) {
      setError(describeOcrFailure(err, ocrModule));
      setStep('file');
    } finally {
      setOcrProgress(null);
    }
  };

  const handleImport = async () => {
    const payload = toTransactionPayload(rows);
    if (!payload.length) return;
    setBusy(true);
    try {
      await onImport(payload, { fileName, reconciliation });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const hasAmountSource = mapping
    && (mapping.amount != null || mapping.debit != null || mapping.credit != null);
  const canReview = Boolean(mapping?.date != null && hasAmountSource);
  const cameFromCsv = headers.length > 0;

  // ── Step: file ──
  if (step === 'file') {
    return (
      <Modal title="Import a statement" subtitle="Bring in transactions from your bank." onClose={onClose}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label className="btn-primary" style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            padding: '16px', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
          }}>
            <FileUp size={16} /> {busy ? 'Reading…' : 'Choose a CSV file'}
            <input type="file" accept=".csv,text/csv,text/plain" onChange={handleCsvFile}
              disabled={busy} style={{ display: 'none' }} />
          </label>

          <label className="btn-secondary" style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            padding: '16px', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
          }}>
            <Camera size={16} /> Choose a photo or PDF
            <input type="file" accept="application/pdf,image/*" onChange={handleOcrFile}
              disabled={busy} style={{ display: 'none' }} />
          </label>

          {error && (
            <div style={{ color: 'var(--danger)', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {error}
            </div>
          )}

          <div style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.6 }}>
            A CSV export is the most reliable option, if your bank offers one. A PDF
            statement is read directly; a photo or screenshot is read with OCR that
            runs on your device — nothing is uploaded anywhere either way. You&rsquo;ll
            confirm every row before anything is saved.
          </div>

          {categories.length === 0 && (
            <div style={{ color: 'var(--warn)', fontSize: 12 }}>
              Add at least one budget category first, or there will be nowhere to file the rows.
            </div>
          )}
        </div>
      </Modal>
    );
  }

  // ── Step: extracting (photo/PDF only) ──
  if (step === 'extracting') {
    const pct = typeof ocrProgress?.progress === 'number' ? Math.round(ocrProgress.progress * 100) : null;
    return (
      <Modal title="Reading your statement" subtitle={fileName} onClose={onClose}>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: '22px 0 8px' }}>
          <Loader2 size={26} className="spin" style={{ color: 'var(--accent-mint)' }} aria-hidden="true" />
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', textTransform: 'capitalize' }}>
            {(ocrProgress?.status || 'starting').replace(/-/g, ' ')}{pct != null ? ` — ${pct}%` : ''}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', textAlign: 'center', maxWidth: 320 }}>
            A scanned or photographed statement can take a little while to read on a phone.
          </div>
        </div>
      </Modal>
    );
  }

  // ── Step: mapping (CSV only) ──
  if (step === 'map') {
    return (
      <Modal title="Which column is which?" subtitle={fileName} onClose={onClose} maxWidth={560}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 12 }}>
            {MAPPING_FIELDS.map(([field, label, required]) => (
              <ColumnPicker
                key={field}
                label={label}
                required={required}
                headers={headers}
                value={mapping[field]}
                onChange={index => setMapping(current => ({ ...current, [field]: index }))}
              />
            ))}
          </div>

          <div style={{ color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.6 }}>
            Use <strong>Amount</strong> for a single signed column, or <strong>Money out</strong> and{' '}
            <strong>Money in</strong> where your bank splits them. Balance is optional — with it,
            Finesse can check its own figure against your statement&rsquo;s.
          </div>

          <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer', fontSize: 12 }}>
              <input type="checkbox" checked={dayFirst} onChange={e => setDayFirst(e.target.checked)}
                style={{ width: 15, height: 15, accentColor: 'var(--accent-mint)' }} />
              Dates are day first (05/01 is 5 January)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer', fontSize: 12 }}>
              <input type="checkbox" checked={invertSigns} onChange={e => setInvertSigns(e.target.checked)}
                style={{ width: 15, height: 15, accentColor: 'var(--accent-mint)' }} />
              Flip the signs (my bank writes spending as positive)
            </label>
          </div>

          {parsedRows[0] && (
            <div style={{ background: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: '10px 12px', fontSize: 11, color: 'var(--text-muted)' }}>
              <div style={{ marginBottom: 4, fontWeight: 600, color: 'var(--text-secondary)' }}>First row reads as</div>
              {rows[0]?.status === ROW_INVALID
                ? <span style={{ color: 'var(--danger)' }}>{rows[0].problem}</span>
                : rows[0] && (
                  <span>
                    {rows[0].date} · {rows[0].description || 'no description'} ·{' '}
                    <strong style={{ color: rows[0].type === 'refund' ? 'var(--good)' : 'var(--accent-warm)' }}>
                      {rows[0].type === 'refund' ? '+' : '−'}{fmt(rows[0].amount || 0)}
                    </strong>
                  </span>
                )}
            </div>
          )}

          <div className="modal-actions" style={{ display: 'flex', gap: 10, marginTop: 4 }}>
            <button className="btn-secondary" onClick={() => setStep('file')} style={{ flex: 1 }}>Back</button>
            <button className="btn-primary" onClick={() => setStep('review')} style={{ flex: 2 }} disabled={!canReview}>
              Review {parsedRows.length} row{parsedRows.length === 1 ? '' : 's'}
            </button>
          </div>
          {!canReview && (
            <div style={{ color: 'var(--warn)', fontSize: 11 }}>
              A date column and at least one amount column are needed.
            </div>
          )}
        </div>
      </Modal>
    );
  }

  // ── Step: review ──
  return (
    <Modal title="Review before importing" subtitle={fileName} onClose={onClose} maxWidth={760}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {[
            ['Importing', String(summary.importable), 'var(--accent-mint)'],
            ['Spending', fmt(summary.expense), 'var(--accent-warm)'],
            ['Refunds', fmt(summary.refund), 'var(--good)'],
            ['Skipping', String(summary.duplicate + summary.invalid), 'var(--text-muted)'],
          ].map(([label, value, color]) => (
            <div key={label} style={{ flex: '1 1 110px', background: 'rgba(255,255,255,0.04)', borderRadius: 10, padding: '9px 12px' }}>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</div>
              <div style={{ fontSize: 15, fontWeight: 600, color, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
            </div>
          ))}
        </div>

        {layoutNote && (
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 9, fontSize: 12, lineHeight: 1.6,
            padding: '11px 13px', borderRadius: 10, ...LAYOUT_TONES[layoutNote.tone],
          }}>
            <Columns3 size={14} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true" />
            <span>{layoutNote.heading} {layoutNote.detail}</span>
          </div>
        )}

        {reconciliation && (
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 9, fontSize: 12, lineHeight: 1.6,
            padding: '11px 13px', borderRadius: 10,
            background: reconciliation.matches ? 'rgba(79,255,176,0.08)' : 'rgba(251,191,112,0.09)',
            color: reconciliation.matches ? 'var(--good)' : 'var(--warn)',
          }}>
            <Scale size={14} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true" />
            <span>
              {reconciliation.matches
                ? `Your statement closes at ${fmt(reconciliation.statementBalance)}, which matches this account exactly.`
                : `Your statement closes at ${fmt(reconciliation.statementBalance)}, but this account holds ${fmt(reconciliation.accountBalance)} — a difference of ${fmt(Math.abs(reconciliation.difference))}. Importing won't change the account balance; adjust it on the Accounts page if the statement is right.`}
            </span>
          </div>
        )}

        <label style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 11, color: 'var(--text-secondary)' }}>
          Flag a same-amount transaction as a possible match within
          <input
            type="number" min={0} max={14} className="glass-input"
            value={dateToleranceDays}
            onChange={e => setDateToleranceDays(Math.max(0, Math.min(14, Number(e.target.value) || 0)))}
            style={{ width: 46, padding: '4px 6px', fontSize: 12, textAlign: 'center' }}
          />
          day{dateToleranceDays === 1 ? '' : 's'} — a card purchase often clears a few days after it happened
        </label>

        {/* A photo or PDF has no mapping step of its own to carry these, and a
            CSV's guess can still be wrong once you can see every row — so
            both live here too, not just in the CSV-only mapping step. */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer', fontSize: 11, color: 'var(--text-secondary)' }}>
            <input type="checkbox" checked={dayFirst} onChange={e => setDayFirst(e.target.checked)}
              style={{ width: 14, height: 14, accentColor: 'var(--accent-mint)' }} />
            Dates are day first (05/01 is 5 January)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 9, cursor: 'pointer', fontSize: 11, color: 'var(--text-secondary)' }}>
            <input type="checkbox" checked={invertSigns} onChange={e => setInvertSigns(e.target.checked)}
              style={{ width: 14, height: 14, accentColor: 'var(--accent-mint)' }} />
            Every row below has spending and refunds swapped — flip them all
          </label>
        </div>

        {partialWarning && (
          <div style={{
            display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12, lineHeight: 1.6,
            padding: '10px 12px', borderRadius: 10, background: 'rgba(251,191,112,0.09)', color: 'var(--warn)',
          }}>
            <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true" />
            <span>{partialWarning}</span>
          </div>
        )}

        {summary.uncategorised > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--warn)' }}>
            <AlertTriangle size={13} aria-hidden="true" />
            {summary.uncategorised} row{summary.uncategorised === 1 ? '' : 's'} still need a category and won&rsquo;t be imported.
          </div>
        )}

        <div className="scroll-region" style={{ maxHeight: 340, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map(row => {
            const invalid = row.status === ROW_INVALID;
            const style = STATUS_STYLES[row.status];
            return (
              <div key={row.index} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '9px 11px',
                background: 'rgba(255,255,255,0.035)', borderRadius: 10,
                opacity: invalid ? 0.7 : 1,
              }}>
                <input
                  type="checkbox"
                  checked={Boolean(row.include) && !invalid}
                  disabled={invalid}
                  onChange={e => setOverride(row.index, { include: e.target.checked })}
                  aria-label={`Import ${row.description || 'row'} on ${row.date || 'unknown date'}`}
                  style={{ width: 15, height: 15, flexShrink: 0, accentColor: 'var(--accent-mint)' }}
                />
                <div style={{ flex: '1 1 150px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <input
                    type="text"
                    className="glass-input"
                    value={row.description}
                    onChange={e => setOverride(row.index, { fields: { description: e.target.value } })}
                    placeholder="No description"
                    aria-label="Description"
                    style={{ padding: '5px 8px', fontSize: 12, fontWeight: 500 }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                    <input
                      type="text"
                      className="glass-input"
                      value={row.rawDate}
                      onChange={e => setOverride(row.index, { fields: { date: e.target.value } })}
                      placeholder="Date"
                      aria-label="Date"
                      style={{ padding: '3px 6px', fontSize: 10, width: 96 }}
                    />
                    {style && <span style={{ fontSize: 10, color: style.color }}>{row.problem || style.label}</span>}
                    {row.suggestion?.source === 'rule' && <span style={{ fontSize: 10, color: 'var(--text-muted)' }}>· matched a rule</span>}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
                  <button
                    type="button"
                    onClick={() => setOverride(row.index, { type: row.type === TX_REFUND ? TX_EXPENSE : TX_REFUND })}
                    disabled={invalid}
                    title={row.type === TX_REFUND ? 'Refund — click to flip to spending' : 'Spending — click to flip to a refund'}
                    style={{
                      background: 'none', border: 'none', padding: '0 2px', cursor: invalid ? 'default' : 'pointer',
                      fontSize: 15, fontWeight: 700, lineHeight: 1,
                      color: row.type === TX_REFUND ? 'var(--good)' : 'var(--accent-warm)',
                    }}
                  >
                    {row.type === TX_REFUND ? '+' : '−'}
                  </button>
                  {mapping.amount != null
                    ? (
                      <AmountField
                        value={row.amount}
                        disabled={invalid}
                        onCommit={amount => setOverride(row.index, { amount })}
                      />
                    )
                    : (
                      <div style={{ fontSize: 13, fontWeight: 600, minWidth: 64, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {invalid ? '—' : fmt(row.amount)}
                      </div>
                    )}
                </div>
                <div style={{ flex: '0 1 150px', minWidth: 120 }}>
                  <CategorySelect
                    categories={categories}
                    value={String(row.categoryId || '')}
                    onChange={id => setOverride(row.index, { categoryId: Number(id) })}
                    disabled={invalid}
                    placeholder="Pick one"
                    aria-label={`Category for ${row.description || 'row'}`}
                  />
                </div>
              </div>
            );
          })}
        </div>

        <div className="modal-actions" style={{ display: 'flex', gap: 10 }}>
          <button className="btn-secondary" onClick={() => setStep(cameFromCsv ? 'map' : 'file')}
            style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <ArrowLeft size={13} /> {cameFromCsv ? 'Columns' : 'Back'}
          </button>
          {/* Counts what will actually be written, not what is ticked — a row
              with no category is dropped on the way to the database. */}
          <button className="btn-primary" onClick={handleImport} disabled={busy || summary.importable === 0}
            style={{ flex: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}>
            {busy ? <Upload size={14} /> : <Check size={14} />}
            {busy ? 'Importing…' : `Import ${summary.importable} transaction${summary.importable === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
