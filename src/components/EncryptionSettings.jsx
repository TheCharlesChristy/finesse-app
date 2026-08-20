import { useCallback, useEffect, useState } from 'react';
import { ShieldCheck, ShieldOff, KeyRound, Copy, Check, AlertTriangle, Download } from 'lucide-react';

import {
  getEncryptionState, enableEncryption, disableEncryption,
  changeVaultSecret, regenerateRecoveryCode,
} from '../db';
import { describeSecretStrength, isValidSecret, vaultSupported, formatRecoveryCode } from '../vault';
import { CardTitle } from './ui';

/**
 * Turning encryption on and off, and everything that has to be said first.
 *
 * The flow is deliberately slower than a toggle. Two facts have to land before
 * a user can consent to this meaningfully, and neither survives being written
 * in small grey text under a switch:
 *
 * 1. **A short PIN is not much of a key.** Ten thousand possibilities is nothing
 *    to someone holding a copy of the database. The strength line is live, it
 *    quotes a real time-to-break, and it turns amber rather than being hidden.
 * 2. **A forgotten secret is unrecoverable.** So a backup is offered first, the
 *    recovery code has to be seen and confirmed, and neither step can be
 *    clicked past.
 */
export default function EncryptionSettings({ onBackup, onUnlocked, showConfirm, showAlert }) {
  const [state, setState] = useState(null);
  const [secret, setSecret] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState(null);
  const [backedUp, setBackedUp] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState(null);
  const [changing, setChanging] = useState(false);
  const [currentSecret, setCurrentSecret] = useState('');

  // Bumped rather than setting state directly, so the read stays inside the
  // effect's own callback — the same shape App uses for the storage estimate.
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion(v => v + 1), []);

  useEffect(() => {
    let cancelled = false;
    getEncryptionState().then(next => { if (!cancelled) setState(next); });
    return () => { cancelled = true; };
  }, [version]);

  const strength = describeSecretStrength(secret);
  const canSubmit = isValidSecret(secret) && secret === confirm;

  const reset = () => {
    setSecret(''); setConfirm(''); setCurrentSecret('');
    setError(''); setProgress(null); setChanging(false);
  };

  const handleEnable = async () => {
    setError('');
    if (!canSubmit) return;
    setBusy('enabling');
    try {
      // Before the vault row exists, not after. Writing it flips the live query
      // that decides whether the app is locked, and this session has plainly
      // just proved itself — without this the app throws its own lock screen up
      // over the migration it is in the middle of running.
      onUnlocked?.();
      const { recoveryCode: code } = await enableEncryption(secret, {
        onProgress: p => setProgress(p),
      });
      setRecoveryCode(code);
      reset();
      setBackedUp(false);
      refresh();
    } catch (problem) {
      console.error('Could not turn on encryption', problem);
      setError(problem?.message || 'Encryption could not be turned on.');
      refresh();
    } finally {
      setBusy('');
      setProgress(null);
    }
  };

  const handleDisable = async () => {
    const ok = await showConfirm?.(
      'Turn off encryption? Every row will be rewritten in the clear, and anyone with this device will be able to read them.',
      { title: 'Turn off encryption', confirmText: 'Turn it off', danger: true },
    );
    if (!ok) return;
    setBusy('disabling');
    try {
      await disableEncryption({ onProgress: p => setProgress(p) });
      refresh();
    } catch (problem) {
      console.error('Could not turn off encryption', problem);
      setError(problem?.message || 'Encryption could not be turned off.');
    } finally {
      setBusy('');
      setProgress(null);
    }
  };

  const handleChange = async () => {
    setError('');
    if (!canSubmit) return;
    setBusy('changing');
    try {
      if (await changeVaultSecret(currentSecret, secret)) {
        reset();
        await showAlert?.('Your PIN or passphrase has been changed.', { title: 'Changed' });
        refresh();
      } else {
        setError('That current PIN or passphrase isn’t right.');
      }
    } finally {
      setBusy('');
    }
  };

  const handleRegenerate = async () => {
    setError('');
    setBusy('recovery');
    try {
      const code = await regenerateRecoveryCode(currentSecret);
      if (code) {
        setRecoveryCode(code);
        setCurrentSecret('');
      } else {
        setError('That PIN or passphrase isn’t right.');
      }
    } finally {
      setBusy('');
    }
  };

  if (!vaultSupported()) return null;

  return (
    <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
        <ShieldCheck size={16} color="var(--accent-mint)" aria-hidden="true" />
        <CardTitle as="h2">Encryption</CardTitle>
      </div>

      {recoveryCode ? (
        <RecoveryCodePanel code={recoveryCode} onDone={() => setRecoveryCode(null)} />
      ) : state?.enabled ? (
        <EnabledPanel
          state={state}
          busy={busy}
          progress={progress}
          error={error}
          changing={changing}
          setChanging={setChanging}
          currentSecret={currentSecret}
          setCurrentSecret={setCurrentSecret}
          secret={secret}
          setSecret={setSecret}
          confirm={confirm}
          setConfirm={setConfirm}
          strength={strength}
          canSubmit={canSubmit}
          onChangeSecret={handleChange}
          onRegenerate={handleRegenerate}
          onDisable={handleDisable}
        />
      ) : (
        <DisabledPanel
          busy={busy}
          progress={progress}
          error={error}
          backedUp={backedUp}
          setBackedUp={setBackedUp}
          onBackup={onBackup}
          secret={secret}
          setSecret={setSecret}
          confirm={confirm}
          setConfirm={setConfirm}
          strength={strength}
          canSubmit={canSubmit}
          onEnable={handleEnable}
        />
      )}
    </div>
  );
}

function Progress({ progress, label }) {
  if (!progress) return null;
  const pct = progress.total ? Math.round((progress.done / progress.total) * 100) : 100;
  return (
    <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10 }} aria-live="polite">
      {label} {progress.table} — {pct}%
    </div>
  );
}

function StrengthNote({ secret, strength }) {
  if (!secret) return null;
  const colour = strength.level === 'weak' ? 'var(--warn)'
    : strength.level === 'fair' ? 'var(--text-secondary)' : 'var(--good)';
  return (
    <div style={{ fontSize: 11, marginTop: 10, lineHeight: 1.6, color: colour, display: 'flex', gap: 6 }}>
      {strength.level === 'weak' && <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true" />}
      <span>
        {strength.summary}
        {strength.level === 'weak' && ' A passphrase of a few words would take longer than anyone will try.'}
      </span>
    </div>
  );
}

function SecretFields({ secret, setSecret, confirm, setConfirm, idPrefix, disabled }) {
  return (
    <div className="mobile-actions" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
      <div className="field" style={{ flex: 1, minWidth: 150 }}>
        <label className="field-label" htmlFor={`${idPrefix}-secret`}>PIN or passphrase</label>
        <input
          id={`${idPrefix}-secret`} className="glass-input" type="password"
          autoComplete="new-password" value={secret} disabled={disabled}
          placeholder="4+ digits, or 8+ characters"
          onChange={e => setSecret(e.target.value)}
        />
      </div>
      <div className="field" style={{ flex: 1, minWidth: 150 }}>
        <label className="field-label" htmlFor={`${idPrefix}-confirm`}>Confirm</label>
        <input
          id={`${idPrefix}-confirm`} className="glass-input" type="password"
          autoComplete="new-password" value={confirm} disabled={disabled}
          placeholder="Repeat it"
          onChange={e => setConfirm(e.target.value)}
        />
      </div>
    </div>
  );
}

function DisabledPanel({
  busy, progress, error, backedUp, setBackedUp, onBackup,
  secret, setSecret, confirm, setConfirm, strength, canSubmit, onEnable,
}) {
  return (
    <>
      <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16, lineHeight: 1.6 }}>
        Right now everything Finesse stores &mdash; amounts, notes, categories,
        receipt photos &mdash; sits readable in this browser&rsquo;s database.
        Turning encryption on scrambles every row with a key held only while the
        app is unlocked.
      </div>

      <div style={{
        border: '1px solid rgba(251,191,112,0.3)', background: 'rgba(251,191,112,0.06)',
        borderRadius: 12, padding: '12px 14px', marginBottom: 16,
        fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6,
      }}>
        <strong style={{ color: 'var(--warn)' }}>There is no way back in without your secret.</strong>{' '}
        No server holds a copy and no reset link exists. You&rsquo;ll be given a
        recovery code to write down &mdash; if you lose both, the data is gone.
      </div>

      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', marginBottom: 14 }}>
        <input
          id="encrypt-backed-up" type="checkbox"
          checked={backedUp} onChange={e => setBackedUp(e.target.checked)}
          style={{ marginTop: 2, width: 16, height: 16, accentColor: 'var(--accent-mint)' }}
        />
        <span style={{ fontSize: 12, lineHeight: 1.6 }}>
          I&rsquo;ve saved a backup of my data first.
          <button type="button" className="btn-secondary" onClick={onBackup}
            style={{ marginLeft: 8, padding: '2px 8px', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <Download size={11} aria-hidden="true" /> Export now
          </button>
        </span>
      </label>

      <SecretFields
        secret={secret} setSecret={setSecret} confirm={confirm} setConfirm={setConfirm}
        idPrefix="encrypt" disabled={Boolean(busy)}
      />
      <StrengthNote secret={secret} strength={strength} />

      {error && <div style={{ color: 'var(--danger)', fontSize: 11, marginTop: 10 }}>{error}</div>}
      <Progress progress={progress} label="Encrypting" />

      <button
        className="btn-primary mobile-full" onClick={onEnable}
        disabled={!canSubmit || !backedUp || Boolean(busy)}
        style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 7 }}
      >
        <ShieldCheck size={14} aria-hidden="true" />
        {busy === 'enabling' ? 'Encrypting…' : 'Encrypt this device'}
      </button>
    </>
  );
}

function EnabledPanel({
  state, busy, progress, error, changing, setChanging,
  currentSecret, setCurrentSecret, secret, setSecret, confirm, setConfirm,
  strength, canSubmit, onChangeSecret, onRegenerate, onDisable,
}) {
  const readable = state.readableFields || {};
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--good)', fontSize: 13, marginBottom: 12 }}>
        <ShieldCheck size={15} aria-hidden="true" />
        This device is encrypted{state.sealed ? '.' : ' — finishing the first pass.'}
      </div>

      <details style={{ marginBottom: 16 }}>
        <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-secondary)' }}>
          What is still readable without the key
        </summary>
        <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.7, marginTop: 10 }}>
          <p style={{ marginBottom: 8 }}>
            The database has to be able to find rows without opening them, so a
            few fields stay in the clear. Someone reading the raw storage can see
            how many rows there are and which account or category each belongs
            to &mdash; but no amount, name, note, date or photo.
          </p>
          <ul style={{ paddingLeft: 16, listStyle: 'disc' }}>
            {Object.entries(readable).map(([table, fields]) => (
              <li key={table} style={{ marginBottom: 2 }}>
                <code style={{ color: 'var(--text-secondary)' }}>{table}</code>: {fields.join(', ')}
              </li>
            ))}
          </ul>
        </div>
      </details>

      <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 16 }}>
        <div className="field" style={{ marginBottom: 12 }}>
          <label className="field-label" htmlFor="vault-current">Current PIN or passphrase</label>
          <input
            id="vault-current" className="glass-input" type="password" autoComplete="current-password"
            value={currentSecret} disabled={Boolean(busy)}
            onChange={e => setCurrentSecret(e.target.value)}
          />
        </div>

        {changing && (
          <>
            <SecretFields
              secret={secret} setSecret={setSecret} confirm={confirm} setConfirm={setConfirm}
              idPrefix="vault-new" disabled={Boolean(busy)}
            />
            <StrengthNote secret={secret} strength={strength} />
          </>
        )}

        {error && <div style={{ color: 'var(--danger)', fontSize: 11, marginTop: 10 }}>{error}</div>}
        <Progress progress={progress} label="Decrypting" />

        <div className="mobile-actions" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }}>
          {changing ? (
            <>
              <button className="btn-primary" onClick={onChangeSecret}
                disabled={!canSubmit || !currentSecret || Boolean(busy)}>
                {busy === 'changing' ? 'Changing…' : 'Save new secret'}
              </button>
              <button className="btn-secondary" onClick={() => setChanging(false)} disabled={Boolean(busy)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button className="btn-secondary" onClick={() => setChanging(true)} disabled={Boolean(busy)}>
                Change it
              </button>
              <button className="btn-secondary" onClick={onRegenerate}
                disabled={!currentSecret || Boolean(busy)}
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <KeyRound size={13} aria-hidden="true" />
                {busy === 'recovery' ? 'Working…' : 'New recovery code'}
              </button>
              <button className="btn-secondary" onClick={onDisable} disabled={Boolean(busy)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--danger)' }}>
                <ShieldOff size={13} aria-hidden="true" />
                {busy === 'disabling' ? 'Decrypting…' : 'Turn off'}
              </button>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * The one time the recovery code is ever shown.
 *
 * It is not stored anywhere in readable form — only a wrap of the master key
 * under it — so closing this panel without writing it down really does lose it.
 * Hence the checkbox: it is the last honest moment to insist.
 */
function RecoveryCodePanel({ code, onDone }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  return (
    <>
      <div style={{ color: 'var(--text-secondary)', fontSize: 13, marginBottom: 14, lineHeight: 1.6 }}>
        Write this down and keep it somewhere that isn&rsquo;t this phone. It is
        the only way back in if you forget your PIN or passphrase, and it
        won&rsquo;t be shown again.
      </div>

      <div className="glass" style={{
        borderRadius: 12, padding: '16px 14px', textAlign: 'center',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 15, letterSpacing: '0.08em', wordBreak: 'break-all', lineHeight: 1.8,
      }}>
        {formatRecoveryCode(code)}
      </div>

      <button className="btn-secondary" onClick={copy}
        style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 7 }}>
        {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
        {copied ? 'Copied' : 'Copy to clipboard'}
      </button>

      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', margin: '16px 0 14px' }}>
        <input id="recovery-saved" type="checkbox" checked={saved} onChange={e => setSaved(e.target.checked)}
          style={{ marginTop: 2, width: 16, height: 16, accentColor: 'var(--accent-mint)' }} />
        <span style={{ fontSize: 12, lineHeight: 1.6 }}>
          I&rsquo;ve written this code down somewhere safe.
        </span>
      </label>

      <button className="btn-primary mobile-full" onClick={onDone} disabled={!saved}>
        Done
      </button>
    </>
  );
}
