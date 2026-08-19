import { useState, useRef } from 'react';
import { Upload, AlertTriangle, Info, ArrowRight, Plus, Pencil, Minus, CalendarClock } from 'lucide-react';

import { Modal } from '../ui';
import { parseBudgetConfigFile, buildBudgetConfigPlan } from '../../budgetConfig';
import { fmt } from '../../utils';

// ── Presentation helpers ─────────────────────────────────────────────────────

const ACTION_STYLE = {
  create: { label: 'New', color: 'var(--good)', background: 'rgba(79,255,176,0.12)', Icon: Plus },
  update: { label: 'Changed', color: 'var(--accent-blue)', background: 'rgba(93,184,255,0.12)', Icon: Pencil },
  keep: { label: 'Unchanged', color: 'var(--text-muted)', background: 'rgba(255,255,255,0.05)', Icon: Minus },
};

function Tag({ color, background, children, title }) {
  return (
    <span title={title} style={{
      fontSize: 10, color, background, padding: '1px 6px', borderRadius: 10, whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}

function Notice({ tone, icon: Icon, children }) {
  const color = tone === 'danger' ? 'var(--danger)' : tone === 'warn' ? 'var(--warn)' : 'var(--text-secondary)';
  const background = tone === 'danger' ? 'rgba(255,107,138,0.1)'
    : tone === 'warn' ? 'rgba(251,191,112,0.1)' : 'rgba(255,255,255,0.04)';
  return (
    <div style={{
      display: 'flex', gap: 9, alignItems: 'flex-start', background, color,
      borderRadius: 12, padding: '10px 12px', fontSize: 12, lineHeight: 1.5,
    }}>
      <Icon size={14} style={{ flexShrink: 0, marginTop: 2 }} />
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

function Delta({ value }) {
  if (value == null) return <span style={{ color: 'var(--text-muted)' }}>—</span>;
  if (value === 0) return <span style={{ color: 'var(--text-muted)' }}>no change</span>;
  return (
    <span style={{ color: value > 0 ? 'var(--good)' : 'var(--danger)', fontWeight: 500 }}>
      {value > 0 ? '+' : '−'}{fmt(Math.abs(value))}
    </span>
  );
}

// ── Modal ────────────────────────────────────────────────────────────────────

/**
 * Import a budget config: choose a file, read the diff, confirm.
 *
 * Confirming *stages* the config rather than applying it — the copy says so in
 * as many words, because a user who thinks their budget just changed will spend
 * the rest of the cycle against numbers that aren't live yet.
 */
export function ImportBudgetConfigModal({
  context, stagedConfig, nextResetLabel, onStage, onClose,
}) {
  const [file, setFile] = useState(null);
  const [plan, setPlan] = useState(null);
  const [fileError, setFileError] = useState(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef(null);

  const handleFile = (event) => {
    const chosen = event.target.files?.[0];
    event.target.value = '';
    if (!chosen) return;

    setFileError(null);
    setPlan(null);
    setFile(chosen);

    const reader = new FileReader();
    reader.onload = (e) => {
      const parsed = parseBudgetConfigFile(String(e.target.result));
      if (!parsed.ok) {
        setFileError(parsed.error);
        return;
      }
      setPlan({ config: parsed.config, ...buildBudgetConfigPlan(parsed.config, context) });
    };
    reader.onerror = () => setFileError('The file could not be read.');
    reader.readAsText(chosen);
  };

  const handleConfirm = async () => {
    if (!plan?.ok || busy) return;
    setBusy(true);
    try {
      await onStage({ config: plan.config, plan, fileName: file?.name || null });
    } finally {
      setBusy(false);
    }
  };

  const totals = plan?.totals;

  return (
    <Modal
      title="Import Budget Config"
      subtitle="Redefine every category and variable from a JSON file, applied at your next payday."
      onClose={onClose}
      maxWidth={760}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

        {stagedConfig && !plan && (
          <Notice tone="warn" icon={CalendarClock}>
            A budget config is already staged{nextResetLabel ? ` and applies on ${nextResetLabel}` : ''}.
            Importing another replaces it.
          </Notice>
        )}

        {/* ── Step 1: choose a file ── */}
        <div>
          <label className="btn-secondary" style={{
            display: 'inline-flex', alignItems: 'center', gap: 7, cursor: 'pointer',
          }}>
            <Upload size={14} /> {file ? 'Choose a different file' : 'Choose config file (.json)'}
            <input ref={inputRef} type="file" accept=".json,application/json"
              onChange={handleFile} style={{ display: 'none' }} />
          </label>
          {file && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
              {file.name}
            </div>
          )}
        </div>

        {fileError && <Notice tone="danger" icon={AlertTriangle}>{fileError}</Notice>}

        {/* ── Step 2: what's wrong, if anything ── */}
        {plan?.errors?.length > 0 && (
          <Notice tone="danger" icon={AlertTriangle}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              This config cannot be imported. Nothing has been changed.
            </div>
            <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {plan.errors.map((error, index) => <li key={index}>{error.message}</li>)}
            </ul>
          </Notice>
        )}

        {plan?.warnings?.length > 0 && (
          <Notice tone="warn" icon={AlertTriangle}>
            <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {plan.warnings.map((warning, index) => <li key={index}>{warning.message}</li>)}
            </ul>
          </Notice>
        )}

        {/* ── Step 3: the diff ── */}
        {plan?.ok && (
          <>
            <Notice tone="info" icon={CalendarClock}>
              Nothing changes today. This is staged and applies at your next reset
              {nextResetLabel ? ` on ${nextResetLabel}` : ''}, so the current cycle keeps its
              pacing and comparisons. Formulas are evaluated again at that point, against
              whatever your income actually is.
            </Notice>

            {plan.variables.length > 0 && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
                  Variables ({plan.variables.length})
                  <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> — written first, because formulas read them</span>
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {plan.variables.map(row => {
                    const style = ACTION_STYLE[row.action];
                    return (
                      <div key={`${row.action}-${row.id ?? row.name}`} style={{
                        display: 'flex', alignItems: 'center', gap: 8, fontSize: 12,
                        justifyContent: 'space-between',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <Tag color={style.color} background={style.background}>{style.label}</Tag>
                          <span style={{ fontWeight: 500 }}>${row.name}</span>
                          {row.renamed && (
                            <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>
                              was ${row.previousName}
                            </span>
                          )}
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)' }}>
                          {row.previousValue != null && row.previousValue !== row.value && (
                            <>
                              <span style={{ color: 'var(--text-muted)' }}>{fmt(row.previousValue)}</span>
                              <ArrowRight size={11} style={{ opacity: 0.5 }} />
                            </>
                          )}
                          <span style={{ fontWeight: 500 }}>{fmt(row.value)}</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
                Categories ({plan.categories.length})
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, minWidth: 460 }}>
                  <thead>
                    <tr style={{ color: 'var(--text-muted)', fontSize: 11, textAlign: 'left' }}>
                      <th style={{ padding: '4px 8px 8px 0', fontWeight: 500 }}>Category</th>
                      <th style={{ padding: '4px 8px 8px', fontWeight: 500, textAlign: 'right' }}>Now</th>
                      <th style={{ padding: '4px 8px 8px', fontWeight: 500, textAlign: 'right' }}>New</th>
                      <th style={{ padding: '4px 0 8px 8px', fontWeight: 500, textAlign: 'right' }}>Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plan.categories.map(row => {
                      const style = ACTION_STYLE[row.action];
                      return (
                        <tr key={`${row.action}-${row.id ?? row.name}`}
                          style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
                          <td style={{ padding: '8px 8px 8px 0' }}>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                              <span style={{ fontWeight: 500 }}>{row.name}</span>
                              <Tag color={style.color} background={style.background}>{style.label}</Tag>
                              {row.renamed && (
                                <Tag color="var(--accent-purple)" background="rgba(167,139,250,0.12)"
                                  title={`Keeps id ${row.id} and all its transactions`}>
                                  was “{row.previousName}”
                                </Tag>
                              )}
                              {row.rollover && (
                                <Tag color="var(--accent-blue)" background="rgba(93,184,255,0.12)"
                                  title="Unspent money accumulates instead of resetting each cycle">
                                  rollover
                                </Tag>
                              )}
                              {row.usedFallback && (
                                <Tag color="var(--warn)" background="rgba(251,191,112,0.12)"
                                  title="The main formula could not be evaluated — this is the fallback">
                                  fallback
                                </Tag>
                              )}
                            </div>
                            {row.formula && (
                              <div style={{
                                fontSize: 10, color: 'var(--text-muted)', marginTop: 3,
                                fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all',
                              }}>
                                {row.usedFallback ? row.fallback : row.formula}
                              </div>
                            )}
                          </td>
                          <td style={{ padding: '8px', textAlign: 'right', color: 'var(--text-muted)' }}>
                            {row.previousAllowance == null ? '—' : fmt(row.previousAllowance)}
                          </td>
                          <td style={{ padding: '8px', textAlign: 'right', fontWeight: 500 }}>
                            {fmt(row.allowance)}
                          </td>
                          <td style={{ padding: '8px 0 8px 8px', textAlign: 'right' }}>
                            <Delta value={row.delta} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ borderTop: '1px solid rgba(255,255,255,0.14)' }}>
                      <td style={{ padding: '10px 8px 0 0', color: 'var(--text-secondary)' }}>
                        Allocated of {plan.meta.baselineIncomeName} income
                      </td>
                      <td />
                      <td style={{ padding: '10px 8px 0', textAlign: 'right', fontWeight: 600 }}>
                        {fmt(totals.evaluatedTotal)}
                      </td>
                      <td style={{ padding: '10px 0 0 8px', textAlign: 'right', color: 'var(--good)' }}>
                        {totals.difference === 0 ? '100%' : <Delta value={totals.difference} />}
                      </td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>

            {plan.meta.importerNotes.length > 0 && (
              <Notice tone="info" icon={Info}>
                <ul style={{ margin: 0, paddingLeft: 16, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {plan.meta.importerNotes.map((note, index) => <li key={index}>{note}</li>)}
                </ul>
              </Notice>
            )}
          </>
        )}

        {/* ── Actions ── */}
        <div className="mobile-actions mobile-actions-full" style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button className="btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn-primary" onClick={handleConfirm} disabled={!plan?.ok || busy}>
            {busy ? 'Staging…' : 'Stage for next payday'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
