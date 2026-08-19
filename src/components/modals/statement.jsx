import { useMemo, useState } from 'react';
import { AlertTriangle, ArrowLeft, Check, FileUp, Scale, Upload } from 'lucide-react';

import { Modal, Field } from '../ui';
import CategorySelect from '../CategorySelect';
import {
  buildImportRows, guessColumnMapping, inferClosingBalance, parseCsv, reconcile,
  summariseRows, toTransactionPayload,
  ROW_DUPLICATE, ROW_INVALID, ROW_SIMILAR,
} from '../../csv';
import { fmt, suggestCategoryForNote } from '../../utils';

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
 * Import a bank statement: pick the file, confirm the columns, review the rows.
 *
 * The review step is the point of the whole thing. An import that silently
 * writes two hundred rows is indistinguishable from a bug when it gets
 * something wrong, so every row arrives with its resolved category, its
 * duplicate status and a checkbox — and nothing is written until the user has
 * seen the totals.
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
  const [step, setStep] = useState('file');
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState(null);
  const [mapping, setMapping] = useState(null);
  const [dayFirst, setDayFirst] = useState(true);
  const [invertSigns, setInvertSigns] = useState(false);
  const [overrides, setOverrides] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Rules and history are the app's, not this module's — hence a closure rather
  // than csv.js reaching for them itself.
  const suggestCategory = useMemo(() => (
    (text) => suggestCategoryForNote(text, { rules, transactions, categories })
  ), [rules, transactions, categories]);

  // Derived on every render rather than stored: the mapping, the date order and
  // the sign convention all change what every row means, and keeping rows in
  // state would mean re-deriving them from three separate effects.
  const rows = useMemo(() => {
    if (!parsed || !mapping) return [];
    const built = buildImportRows({
      rows: parsed.rows,
      mapping,
      existingTransactions: transactions,
      suggestCategory,
      defaultCategoryId,
      dayFirst,
      invertSigns,
    });
    // User edits are layered on top by index, so changing the mapping doesn't
    // discard the categories they have already corrected.
    return built.map(row => (overrides[row.index] ? { ...row, ...overrides[row.index] } : row));
  }, [parsed, mapping, transactions, suggestCategory, defaultCategoryId, dayFirst, invertSigns, overrides]);

  const summary = useMemo(() => summariseRows(rows), [rows]);
  const closingBalance = useMemo(() => inferClosingBalance(rows), [rows]);
  const reconciliation = useMemo(
    () => reconcile(closingBalance, account?.balance),
    [closingBalance, account?.balance],
  );

  const setOverride = (index, patch) => {
    setOverrides(current => ({ ...current, [index]: { ...current[index], ...patch } }));
  };

  const handleFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setError('');
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
      setParsed(result);
      setMapping(guessed);
      setOverrides({});
      setStep('map');
    } catch {
      setError('That file couldn’t be read.');
    } finally {
      setBusy(false);
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

  // ── Step: file ──
  if (step === 'file') {
    return (
      <Modal title="Import a statement" subtitle="Bring in transactions from your bank's CSV export." onClose={onClose}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label className="btn-primary" style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            padding: '16px', cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.6 : 1,
          }}>
            <FileUp size={16} /> {busy ? 'Reading…' : 'Choose a CSV file'}
            <input type="file" accept=".csv,text/csv,text/plain" onChange={handleFile}
              disabled={busy} style={{ display: 'none' }} />
          </label>

          {error && <div style={{ color: 'var(--danger)', fontSize: 12 }}>{error}</div>}

          <div style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.6 }}>
            Most banks offer a CSV download on the statements page. You&rsquo;ll confirm
            which column is which, then review every row before anything is saved —
            nothing is written until you say so.
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

  // ── Step: mapping ──
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
                headers={parsed.headers}
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

          {parsed.rows[0] && (
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
              Review {parsed.rows.length} row{parsed.rows.length === 1 ? '' : 's'}
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
    <Modal title="Review before importing" subtitle={fileName} onClose={onClose} maxWidth={720}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {[
            ['Importing', String(summary.selected), 'var(--accent-mint)'],
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

        {summary.uncategorised > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--warn)' }}>
            <AlertTriangle size={13} aria-hidden="true" />
            {summary.uncategorised} row{summary.uncategorised === 1 ? '' : 's'} still need a category and won&rsquo;t be imported.
          </div>
        )}

        <div style={{ maxHeight: 340, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map(row => {
            const invalid = row.status === ROW_INVALID;
            const style = STATUS_STYLES[row.status];
            return (
              <div key={row.index} style={{
                display: 'flex', alignItems: 'center', gap: 10, padding: '9px 11px',
                background: 'rgba(255,255,255,0.035)', borderRadius: 10,
                opacity: invalid ? 0.55 : 1,
              }}>
                <input
                  type="checkbox"
                  checked={Boolean(row.include) && !invalid}
                  disabled={invalid}
                  onChange={e => setOverride(row.index, { include: e.target.checked })}
                  aria-label={`Import ${row.description || 'row'} on ${row.date || 'unknown date'}`}
                  style={{ width: 15, height: 15, flexShrink: 0, accentColor: 'var(--accent-mint)' }}
                />
                <div style={{ flex: '1 1 130px', minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {row.description || <span style={{ color: 'var(--text-muted)' }}>No description</span>}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                    {row.date || row.rawDate || '—'}
                    {style && <span style={{ color: style.color }}> · {row.problem || style.label}</span>}
                    {row.suggestion?.source === 'rule' && <span> · matched a rule</span>}
                  </div>
                </div>
                <div style={{
                  fontSize: 13, fontWeight: 600, flexShrink: 0, minWidth: 74, textAlign: 'right',
                  fontVariantNumeric: 'tabular-nums',
                  color: row.type === 'refund' ? 'var(--good)' : 'var(--accent-warm)',
                }}>
                  {invalid ? '—' : `${row.type === 'refund' ? '+' : '−'}${fmt(row.amount)}`}
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
          <button className="btn-secondary" onClick={() => setStep('map')}
            style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            <ArrowLeft size={13} /> Columns
          </button>
          <button className="btn-primary" onClick={handleImport} disabled={busy || summary.selected === 0}
            style={{ flex: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7 }}>
            {busy ? <Upload size={14} /> : <Check size={14} />}
            {busy ? 'Importing…' : `Import ${summary.selected} transaction${summary.selected === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
