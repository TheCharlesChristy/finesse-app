/**
 * A PIN gate over the UI, and the derivation behind it.
 *
 * Be clear about what this is. Finesse stores everything in IndexedDB in
 * plaintext, and a PIN checked in JavaScript cannot change that: anyone with
 * the unlocked device and a browser console can read the database directly. So
 * this defends against the realistic threat — someone picking up your phone, or
 * looking over your shoulder at the app switcher — and not against someone who
 * has your device and knows where to look. The UI says so rather than implying
 * a safety it doesn't provide.
 *
 * Encrypting the database with a key derived from the PIN would be the real
 * version, and would also mean a forgotten PIN destroys the data with no
 * recovery path — a much worse failure than the one being solved.
 *
 * What it does do properly: the PIN is never stored. PBKDF2-SHA-256 over a
 * random per-install salt is, so the stored value is useless on its own, and
 * comparison is constant-time so the check leaks nothing through timing.
 */

const PBKDF2_ITERATIONS = 250000;
const SALT_BYTES = 16;
const KEY_BITS = 256;

export const MIN_PIN_LENGTH = 4;
export const MAX_PIN_LENGTH = 12;

function subtle() {
  if (typeof crypto === 'undefined' || !crypto.subtle) return null;
  return crypto.subtle;
}

/**
 * Whether a PIN can be set at all.
 *
 * `crypto.subtle` only exists in a secure context, so this is false on a
 * plain-http origin. Better to hide the feature than to offer a lock that
 * silently fails to engage.
 */
export function lockSupported() {
  return Boolean(subtle() && typeof crypto.getRandomValues === 'function');
}

function toHex(buffer) {
  return [...new Uint8Array(buffer)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function fromHex(hex) {
  const clean = String(hex || '');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** A fresh random salt, hex-encoded for storage in the settings row. */
export function createSalt() {
  const salt = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(salt);
  return toHex(salt);
}

/** Derive the stored verifier for a PIN. Returns null where crypto is absent. */
export async function derivePinHash(pin, saltHex) {
  const api = subtle();
  if (!api) return null;

  const key = await api.importKey('raw', new TextEncoder().encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await api.deriveBits(
    { name: 'PBKDF2', salt: fromHex(saltHex), iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    KEY_BITS,
  );
  return toHex(bits);
}

/**
 * Compare two hex digests without leaking where they diverge.
 *
 * Length is compared first and separately: two digests of the same algorithm
 * are always the same length, so an early return here reveals nothing about
 * the PIN itself.
 */
export function safeEqual(a = '', b = '') {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Check a PIN against the stored salt and verifier. */
export async function verifyPin(pin, { pinSalt, pinHash } = {}) {
  if (!pinSalt || !pinHash) return false;
  const candidate = await derivePinHash(pin, pinSalt);
  return candidate != null && safeEqual(candidate, pinHash);
}

/** The settings patch that turns the lock on. */
export async function buildPinSettings(pin) {
  const pinSalt = createSalt();
  const pinHash = await derivePinHash(pin, pinSalt);
  if (!pinHash) return null;
  return { pinSalt, pinHash };
}

/** A PIN the app will accept: digits only, within length bounds. */
export function isValidPin(pin) {
  const value = String(pin || '');
  return new RegExp(`^\\d{${MIN_PIN_LENGTH},${MAX_PIN_LENGTH}}$`).test(value);
}

// How long the app may sit in the background before the PIN is asked for
// again. Re-locking the instant you glance at a notification would train
// anyone to turn the feature off, so "immediately" is offered but not default.
export const LOCK_DELAYS = [
  [0, 'Immediately'],
  [60_000, 'After 1 minute'],
  [300_000, 'After 5 minutes'],
  [900_000, 'After 15 minutes'],
];

export const DEFAULT_LOCK_DELAY_MS = 60_000;

/** Whether enough background time has passed to re-lock. */
export function shouldRelock(hiddenSince, delayMs = DEFAULT_LOCK_DELAY_MS, now = Date.now()) {
  if (hiddenSince == null) return false;
  return now - hiddenSince >= (Number(delayMs) || 0);
}
