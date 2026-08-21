import { useEffect, useRef, useState } from 'react';
import { Lock, KeyRound, ShieldCheck } from 'lucide-react';

import { MAX_PIN_LENGTH, MIN_PIN_LENGTH, verifyPin } from '../lock';
import { unlockDatabase, resetVaultSecretWithRecovery } from '../db';
import { isValidRecoveryCode, isValidSecret, describeSecretStrength } from '../vault';

// Wrong guesses get slower, so the field can't be brute-forced by hand. The
// step is small enough to be invisible to someone who simply fat-fingered a
// digit, and painful by the tenth attempt.
//
// Worth being clear about what this is not: it protects the form, not the
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
  // A PIN is digits and nothing else, which is what lets the field ask for the
  // number pad. A passphrase takes the ordinary keyboard.
  const numericPin = !encrypted || vault.secretKind === 'pin';

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
  const longEnough = numericPin ? pin.length >= MIN_PIN_LENGTH : isValidSecret(pin);

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

  // Digits only, and never longer than a PIN can be — the same clamp the field
  // in Settings applies when the PIN is chosen, so the two can't disagree about
  // what is enterable. A paste of "1 2 3 4" lands as 1234 rather than failing.
  const handleChange = (e) => {
    setError('');
    const value = e.target.value;
    setPin(numericPin ? value.replace(/\D/g, '').slice(0, MAX_PIN_LENGTH) : value);
  };

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
            ? `Enter your ${numericPin ? 'PIN' : 'passphrase'} to decrypt your data`
            : 'Enter your PIN to continue'}
        </div>
      </div>

      {/* One field for both secrets, rather than a keypad for digits and a text
          box for the rest. A drawn keypad has to reimplement everything a real
          input already does — caret, selection, paste, password managers, the
          hardware keyboard — and on the phone this is actually used on, the
          system number pad has bigger targets than twelve buttons squeezed into
          a card. `inputMode` is what summons it; `pattern` is what makes older
          iOS agree. */}
      <form onSubmit={e => { e.preventDefault(); if (longEnough) submit(pin); }}>
        <label className="field-label" htmlFor="unlock-secret">
          {numericPin ? 'PIN' : 'Passphrase'}
        </label>
        <input
          id="unlock-secret"
          className="glass-input"
          type="password"
          autoFocus
          autoComplete="current-password"
          inputMode={numericPin ? 'numeric' : 'text'}
          pattern={numericPin ? '[0-9]*' : undefined}
          enterKeyHint="go"
          placeholder={numericPin ? `${MIN_PIN_LENGTH}–${MAX_PIN_LENGTH} digits` : undefined}
          value={pin}
          disabled={waiting || busy}
          onChange={handleChange}
          style={{
            width: '100%',
            ...(numericPin ? { textAlign: 'center', fontSize: 20 } : null),
            // Only once there is something to space out — the placeholder reads
            // as gibberish at a third of an em between its letters.
            ...(numericPin && pin ? { letterSpacing: '0.35em', paddingLeft: 14 } : null),
          }}
        />
      </form>

      <div aria-live="assertive" style={{
        textAlign: 'center', fontSize: 11, minHeight: 26, paddingTop: 6,
        color: error ? 'var(--danger)' : 'var(--text-muted)',
      }}>
        {waiting ? `Try again in ${Math.ceil(waitMs / 1000)}s` : error || (busy ? 'Decrypting…' : ' ')}
      </div>

      <button
        type="button"
        className="btn-primary"
        onClick={() => submit(pin)}
        disabled={waiting || busy || !longEnough}
        style={{ width: '100%', height: 46 }}
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
