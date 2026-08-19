import { useEffect, useRef, useState } from 'react';
import { Lock, Delete } from 'lucide-react';

import { MAX_PIN_LENGTH, MIN_PIN_LENGTH, verifyPin } from '../lock';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', null, '0', 'del'];

// Wrong guesses get slower, so the keypad can't be brute-forced by hand. The
// step is small enough to be invisible to someone who simply fat-fingered a
// digit, and painful by the tenth attempt.
const LOCKOUT_AFTER = 4;
const LOCKOUT_STEP_MS = 5000;
const MAX_LOCKOUT_MS = 60000;

function lockoutFor(attempts) {
  if (attempts < LOCKOUT_AFTER) return 0;
  return Math.min(MAX_LOCKOUT_MS, (attempts - LOCKOUT_AFTER + 1) * LOCKOUT_STEP_MS);
}

/**
 * The PIN gate, rendered instead of the app rather than over it.
 *
 * Covering the app with an overlay would leave the real figures in the DOM,
 * one dev-tools node-delete away — and, more to the point, visible for a frame
 * before the overlay paints. Returning this in place of the whole tree means
 * there is nothing underneath to reveal.
 */
export default function LockScreen({ settings, onUnlock }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [attempts, setAttempts] = useState(0);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const checking = useRef(false);

  const waitMs = Math.max(0, lockedUntil - now);
  const waiting = waitMs > 0;

  // Only ticks while a lockout is counting down — no idle timer on the happy path.
  useEffect(() => {
    if (lockedUntil <= Date.now()) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [lockedUntil]);

  const submit = async (candidate) => {
    if (checking.current || waiting) return;
    checking.current = true;
    try {
      if (await verifyPin(candidate, settings)) {
        onUnlock();
        return;
      }
      const next = attempts + 1;
      setAttempts(next);
      setPin('');
      const penalty = lockoutFor(next);
      if (penalty > 0) setLockedUntil(Date.now() + penalty);
      setError(penalty > 0 ? 'Too many attempts.' : 'Incorrect PIN.');
    } finally {
      checking.current = false;
    }
  };

  const press = (key) => {
    if (waiting) return;
    setError('');
    if (key === 'del') {
      setPin(value => value.slice(0, -1));
      return;
    }
    setPin(value => {
      const next = (value + key).slice(0, MAX_PIN_LENGTH);
      // Auto-submitting at the minimum length would make a longer PIN
      // impossible to enter, so the user always confirms.
      return next;
    });
  };

  // A hardware keyboard is the fast path on desktop; the keypad is for thumbs.
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key >= '0' && e.key <= '9') press(e.key);
      else if (e.key === 'Backspace') press('del');
      else if (e.key === 'Enter' && pin.length >= MIN_PIN_LENGTH) submit(pin);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  return (
    <div style={{ minHeight: '100vh', position: 'relative' }}>
      <div className="bg-mesh" />
      <div style={{
        position: 'relative', zIndex: 1, minHeight: '100vh',
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        padding: 'calc(24px + env(safe-area-inset-top, 0px)) 20px calc(24px + env(safe-area-inset-bottom, 0px))',
      }}>
        <div className="glass" style={{ borderRadius: 22, padding: '32px 28px', width: '100%', maxWidth: 320 }}>
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
              Enter your PIN to continue
            </div>
          </div>

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

          <div aria-live="assertive" style={{
            textAlign: 'center', fontSize: 11, minHeight: 26, paddingTop: 6,
            color: error ? 'var(--danger)' : 'transparent',
          }}>
            {waiting ? `Try again in ${Math.ceil(waitMs / 1000)}s` : error || ' '}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
            {KEYS.map((key, index) => key === null ? <span key={`gap-${index}`} /> : (
              <button
                key={key}
                type="button"
                className="btn-secondary"
                onClick={() => press(key)}
                disabled={waiting}
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

          <button
            type="button"
            className="btn-primary"
            onClick={() => submit(pin)}
            disabled={waiting || pin.length < MIN_PIN_LENGTH}
            style={{ width: '100%', marginTop: 12, height: 46 }}
          >
            Unlock
          </button>
        </div>

        <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 18, maxWidth: 320, textAlign: 'center', lineHeight: 1.6 }}>
          This hides the app from someone holding your phone. It does not encrypt
          the data on this device.
        </div>
      </div>
    </div>
  );
}
