import { useEffect, useRef, useState } from 'react';
import { Lock, Delete, KeyRound, ShieldCheck } from 'lucide-react';

import { MAX_PIN_LENGTH, MIN_PIN_LENGTH, verifyPin } from '../lock';
import { unlockDatabase, resetVaultSecretWithRecovery } from '../db';
import { isValidRecoveryCode, isValidSecret, describeSecretStrength } from '../vault';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', null, '0', 'del'];

// Wrong guesses get slower, so the keypad can't be brute-forced by hand. The
// step is small enough to be invisible to someone who simply fat-fingered a
// digit, and painful by the tenth attempt.
//
// Worth being clear about what this is not: it protects the keypad, not the
// data. Someone attacking a copy of the database offline never sees this
// screen. `describeSecretStrength` is what speaks to that case, at the moment
// the secret is chosen.
const LOCKOUT_AFTER = 4;
const LOCKOUT_STEP_MS = 5000;
const MAX_LOCKOUT_MS = 60000;

function lockoutFor(attempts) {
  if (attempts < LOCKOUT_AFTER) return 0;
  return Math.min(MAX_LOCKOUT_MS, (attempts - LOCKOUT_AFTER + 1) * LOCKOUT_STEP_MS);
}

/**
 * The lock, rendered instead of the app rather than over it.
 *
 * Covering the app with an overlay would leave the real figures in the DOM,
 * one dev-tools node-delete away — and, more to the point, visible for a frame
 * before the overlay paints. Returning this in place of the whole tree means
 * there is nothing underneath to reveal.
 *
 * It stands in front of two different things. Without a vault it is a screen
 * lock and the check is a stored PBKDF2 verifier. With one it is the only way
 * to read the database at all: the secret unwraps the key, so a wrong entry
 * fails on a GCM tag rather than a comparison, and there is no verifier stored
 * anywhere to compare against. The copy at the bottom changes accordingly,
 * because the two offer genuinely different protection and saying otherwise
 * would be the one dishonest thing this screen could do.
 */
export default function LockScreen({ settings, vault, onUnlock }) {
  const encrypted = Boolean(vault);
  const usesKeypad = !encrypted || vault.secretKind === 'pin';

  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [attempts, setAttempts] = useState(0);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [recovering, setRecovering] = useState(false);
  const checking = useRef(false);

  const waitMs = Math.max(0, lockedUntil - now);
  const waiting = waitMs > 0;
  const longEnough = usesKeypad ? pin.length >= MIN_PIN_LENGTH : isValidSecret(pin);

  // Only ticks while a lockout is counting down — no idle timer on the happy path.
  useEffect(() => {
    if (lockedUntil <= Date.now()) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [lockedUntil]);

  const fail = (message) => {
    const next = attempts + 1;
    setAttempts(next);
    setPin('');
    const penalty = lockoutFor(next);
    if (penalty > 0) setLockedUntil(Date.now() + penalty);
    setError(penalty > 0 ? 'Too many attempts.' : message);
  };

  const submit = async (candidate) => {
    if (checking.current || waiting) return;
    checking.current = true;
    setBusy(true);
    try {
      // Unwrapping a vault key costs about a second of Argon2 — hence the busy
      // state, which is the difference between "thinking" and "broken".
      const ok = encrypted
        ? await unlockDatabase(candidate)
        : await verifyPin(candidate, settings);
      if (ok) {
        onUnlock();
        return;
      }
      fail(encrypted ? 'That didn’t unlock it.' : 'Incorrect PIN.');
    } catch (problem) {
      console.error('Unlock failed', problem);
      setError('Something went wrong unlocking this device.');
    } finally {
      checking.current = false;
      setBusy(false);
    }
  };

  const press = (key) => {
    if (waiting) return;
    setError('');
    if (key === 'del') {
      setPin(value => value.slice(0, -1));
      return;
    }
    // Auto-submitting at the minimum length would make a longer PIN impossible
    // to enter, so the user always confirms.
    setPin(value => (value + key).slice(0, MAX_PIN_LENGTH));
  };

  // A hardware keyboard is the fast path on desktop; the keypad is for thumbs.
  useEffect(() => {
    if (!usesKeypad || recovering) return undefined;
    const handleKeyDown = (e) => {
      if (e.key >= '0' && e.key <= '9') press(e.key);
      else if (e.key === 'Backspace') press('del');
      else if (e.key === 'Enter' && longEnough) submit(pin);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  if (recovering) {
    return (
      <RecoveryForm
        onCancel={() => { setRecovering(false); setError(''); }}
        onDone={onUnlock}
      />
    );
  }

  return (
    <Shell>
      <div style={{ textAlign: 'center', marginBottom: 22 }}>
        <span style={{
          width: 46, height: 46, borderRadius: 15, margin: '0 auto 12px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(192,132,252,0.14)', color: 'var(--accent-purple)',
        }}>
          <Lock size={20} aria-hidden="true" />
        </span>
        <div className="font-display" style={{ fontSize: 21, letterSpacing: '-0.02em' }}>Finesse</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>
          {encrypted
            ? `Enter your ${usesKeypad ? 'PIN' : 'passphrase'} to decrypt your data`
            : 'Enter your PIN to continue'}
        </div>
      </div>

      {usesKeypad ? (
        <div role="status" aria-live="polite" aria-label={`${pin.length} of ${MAX_PIN_LENGTH} digits entered`}
          style={{ display: 'flex', justifyContent: 'center', gap: 9, marginBottom: 8, minHeight: 13 }}>
          {Array.from({ length: Math.max(MIN_PIN_LENGTH, pin.length) }).map((_, index) => (
            <span key={index} style={{
              width: 11, height: 11, borderRadius: '50%',
              background: index < pin.length ? 'var(--accent-mint)' : 'rgba(255,255,255,0.14)',
              transition: 'background 0.15s ease',
            }} />
          ))}
        </div>
      ) : (
        <form onSubmit={e => { e.preventDefault(); if (longEnough) submit(pin); }}>
          <label className="field-label" htmlFor="unlock-secret">Passphrase</label>
          <input
            id="unlock-secret"
            className="glass-input"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={pin}
            disabled={waiting || busy}
            onChange={e => { setError(''); setPin(e.target.value); }}
            style={{ width: '100%' }}
          />
        </form>
      )}

      <div aria-live="assertive" style={{
        textAlign: 'center', fontSize: 11, minHeight: 26, paddingTop: 6,
        color: error ? 'var(--danger)' : 'var(--text-muted)',
      }}>
        {waiting ? `Try again in ${Math.ceil(waitMs / 1000)}s` : error || (busy ? 'Decrypting…' : ' ')}
      </div>

      {usesKeypad && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
          {KEYS.map((key, index) => key === null ? <span key={`gap-${index}`} /> : (
            <button
              key={key}
              type="button"
              className="btn-secondary"
              onClick={() => press(key)}
              disabled={waiting || busy}
              aria-label={key === 'del' ? 'Delete last digit' : key}
              style={{
                height: 52, fontSize: key === 'del' ? 13 : 19, fontWeight: 500,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {key === 'del' ? <Delete size={17} aria-hidden="true" /> : key}
            </button>
          ))}
        </div>
      )}

      <button
        type="button"
        className="btn-primary"
        onClick={() => submit(pin)}
        disabled={waiting || busy || !longEnough}
        style={{ width: '100%', marginTop: 12, height: 46 }}
      >
        {busy ? 'Decrypting…' : 'Unlock'}
      </button>

      {encrypted && (
        <button
          type="button"
          className="btn-secondary"
          onClick={() => { setRecovering(true); setError(''); setPin(''); }}
          style={{ width: '100%', marginTop: 8, fontSize: 12 }}
        >
          <KeyRound size={13} aria-hidden="true" /> Use recovery code
        </button>
      )}

      <Footnote encrypted={encrypted} />
    </Shell>
  );
}

/**
 * The recovery path: the code, and a new secret, in one step.
 *
 * Deliberately not two. Unlocking with the code alone leaves the device open
 * but still keyed to the secret that was forgotten — fine until the next
 * relock, at which point the user is locked out again with their one code
 * already spent.
 */
function RecoveryForm({ onCancel, onDone }) {
  const [code, setCode] = useState('');
  const [secret, setSecret] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const strength = describeSecretStrength(secret);
  const ready = isValidRecoveryCode(code) && isValidSecret(secret) && secret === confirm;

  const submit = async (e) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError('');
    try {
      if (await resetVaultSecretWithRecovery(code, secret)) onDone();
      else setError('That recovery code doesn’t match this device.');
    } catch (problem) {
      console.error('Recovery failed', problem);
      setError('Something went wrong. Your data has not been changed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell>
      <div style={{ textAlign: 'center', marginBottom: 18 }}>
        <span style={{
          width: 46, height: 46, borderRadius: 15, margin: '0 auto 12px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(93,184,255,0.14)', color: 'var(--accent-blue)',
        }}>
          <KeyRound size={20} aria-hidden="true" />
        </span>
        <div className="font-display" style={{ fontSize: 19 }}>Recovery code</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4, lineHeight: 1.6 }}>
          Enter the code you saved when you turned encryption on, then choose a
          new PIN or passphrase.
        </div>
      </div>

      <form onSubmit={submit}>
        <label className="field-label" htmlFor="recovery-code">Recovery code</label>
        <input
          id="recovery-code" className="glass-input" autoFocus autoCapitalize="characters"
          spellCheck={false} value={code} disabled={busy}
          placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
          onChange={e => { setError(''); setCode(e.target.value); }}
          style={{ width: '100%', fontFamily: 'ui-monospace, monospace', letterSpacing: '0.04em' }}
        />

        <label className="field-label" htmlFor="recovery-secret" style={{ marginTop: 12 }}>
          New PIN or passphrase
        </label>
        <input
          id="recovery-secret" className="glass-input" type="password" value={secret} disabled={busy}
          autoComplete="new-password"
          onChange={e => { setError(''); setSecret(e.target.value); }}
          style={{ width: '100%' }}
        />

        <label className="field-label" htmlFor="recovery-confirm" style={{ marginTop: 12 }}>Confirm</label>
        <input
          id="recovery-confirm" className="glass-input" type="password" value={confirm} disabled={busy}
          autoComplete="new-password"
          onChange={e => setConfirm(e.target.value)}
          style={{ width: '100%' }}
        />

        {secret && (
          <div style={{
            fontSize: 11, marginTop: 8, lineHeight: 1.6,
            color: strength.level === 'weak' ? 'var(--warn)' : 'var(--text-muted)',
          }}>
            {strength.summary}
          </div>
        )}

        <div aria-live="assertive" style={{
          fontSize: 11, minHeight: 20, paddingTop: 8, color: 'var(--danger)',
        }}>
          {error}
        </div>

        <button type="submit" className="btn-primary" disabled={!ready || busy}
          style={{ width: '100%', height: 46 }}>
          {busy ? 'Unlocking…' : 'Unlock and set new secret'}
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}
          style={{ width: '100%', marginTop: 8, fontSize: 12 }}>
          Back
        </button>
      </form>
    </Shell>
  );
}

function Shell({ children }) {
  return (
    <div style={{ minHeight: '100vh', position: 'relative' }}>
      <div className="bg-mesh" />
      <div style={{
        position: 'relative', zIndex: 1, minHeight: '100vh',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: 'calc(24px + env(safe-area-inset-top, 0px)) 20px calc(24px + env(safe-area-inset-bottom, 0px))',
      }}>
        <div className="glass" style={{ borderRadius: 22, padding: '32px 28px', width: '100%', maxWidth: 340 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

function Footnote({ encrypted }) {
  return (
    <div style={{
      color: 'var(--text-muted)', fontSize: 11, marginTop: 18,
      textAlign: 'center', lineHeight: 1.6,
      display: 'flex', gap: 6, alignItems: 'flex-start', justifyContent: 'center',
    }}>
      {encrypted && <ShieldCheck size={13} style={{ flexShrink: 0, marginTop: 2 }} aria-hidden="true" />}
      <span>
        {encrypted
          ? 'Everything on this device is encrypted. Without this secret or your recovery code, the data cannot be read — including by you.'
          : 'This hides the app from someone holding your phone. It does not encrypt the data on this device.'}
      </span>
    </div>
  );
}
