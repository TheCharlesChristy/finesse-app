/**
 * The encryption key: where it comes from, and what it is honestly worth.
 *
 * Finesse can encrypt every row it stores. The key that does it is never
 * written down — it is unwrapped from the user's secret at unlock and held in
 * memory for as long as the page lives. That is the whole point: a key sitting
 * in IndexedDB next to the data it protects would be theatre.
 *
 * Two things follow from it, and both are surfaced in the UI rather than
 * buried here.
 *
 * **A forgotten secret destroys the data.** There is no server to ask and no
 * escrow. So enabling encryption mints a recovery code — 120 bits of random,
 * wrapping a second copy of the same master key — and the Settings flow will
 * not turn encryption on until the user has been shown it.
 *
 * **A four-digit PIN is not a key.** Ten thousand possibilities is nothing to
 * someone holding a copy of the database, whatever the derivation costs. Argon2id
 * at 32 MiB buys roughly a thousand guesses per second against good hardware
 * instead of billions, which turns "instant" into "ten seconds" — an
 * improvement that changes nothing about the conclusion. `describeSecretStrength`
 * exists to say that plainly at the moment the secret is chosen, because the
 * only real fix is a longer secret and the user is the only one who can supply
 * it.
 *
 * Argon2id runs here in pure JS rather than through WebCrypto, which has no
 * memory-hard KDF. It is the one place in the app where a second of blocked
 * main thread is the correct trade.
 */

import { argon2id } from '@noble/hashes/argon2.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';

export const VAULT_VERSION = 1;

// OWASP's Argon2id floor is 19 MiB / t=2. This sits above it at a cost of
// roughly a second on a phone, which is affordable once per app launch. The
// numbers live in the vault record too, so they can be raised later without
// stranding a database written under the old ones.
export const ARGON2_PARAMS = { t: 3, m: 32 * 1024, p: 1 };

const MASTER_BYTES = 32;
const SALT_BYTES = 16;
const NONCE_BYTES = 12;

// Two independent keys from one master, so the cipher key and the key that
// blinds unique indexes never touch. HKDF's `info` is what separates them.
const ROW_KEY_INFO = 'finesse:row-cipher:v1';
const INDEX_KEY_INFO = 'finesse:index-blind:v1';

// Bound into each wrap, so the recovery copy of the master can't be presented
// to the code path that expects the secret copy (or the other way round).
const SECRET_AAD = 'finesse-vault:v1:secret';
const RECOVERY_AAD = 'finesse-vault:v1:recovery';

export const MIN_PIN_LENGTH = 4;
export const MAX_PIN_LENGTH = 12;
export const MIN_PASSPHRASE_LENGTH = 8;
export const MAX_SECRET_LENGTH = 128;

// Crockford base32: no I, L, O or U, so nothing in a written-down code can be
// misread as something else or spell anything unfortunate.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 24; // 24 × 5 bits = 120 bits of entropy
const CODE_GROUP = 4;

const utf8 = new TextEncoder();

export function vaultSupported() {
  return typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function';
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function toHex(bytes) {
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function fromHex(hex) {
  const clean = String(hex || '');
  const bytes = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Wipe key material we're done with. Best-effort — JS strings can't be wiped. */
export function zero(bytes) {
  if (bytes instanceof Uint8Array) bytes.fill(0);
}

// ── The secret: PIN or passphrase ───────────────────────────────────────────

/**
 * Which kind of secret this is.
 *
 * Digits alone are a PIN however many there are, because that is how the
 * keypad will be offered and how an attacker will enumerate it.
 */
export function secretKind(secret) {
  const value = String(secret ?? '');
  if (!value) return null;
  return /^\d+$/.test(value) ? 'pin' : 'passphrase';
}

export function isValidSecret(secret) {
  const value = String(secret ?? '');
  if (value.length > MAX_SECRET_LENGTH) return false;
  const kind = secretKind(value);
  if (kind === 'pin') return value.length >= MIN_PIN_LENGTH && value.length <= MAX_PIN_LENGTH;
  if (kind === 'passphrase') return value.length >= MIN_PASSPHRASE_LENGTH;
  return false;
}

// What a serious attacker gets per second against Argon2id at these parameters,
// holding a copy of the database. Memory-hardness is what keeps this in the
// thousands rather than the billions a GPU manages against PBKDF2 — but it is
// an estimate, and deliberately a generous one to the attacker.
const GUESSES_PER_SECOND = 1000;

function humanDuration(seconds) {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} seconds`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hours`;
  if (seconds < 86400 * 365) return `${Math.round(seconds / 86400)} days`;
  const years = seconds / (86400 * 365);
  if (years > 1e6) return 'longer than anyone will try';
  return `${Math.round(years).toLocaleString()} years`;
}

/**
 * How long this secret survives an offline attack, said plainly.
 *
 * The search space for a passphrase is estimated from the character classes it
 * actually uses, which flatters anything built from dictionary words — so the
 * figure is a ceiling, not a promise, and the copy says "up to".
 */
export function describeSecretStrength(secret) {
  const value = String(secret ?? '');
  const kind = secretKind(value);
  if (!kind) return { level: 'none', guesses: 0, seconds: 0, summary: '' };

  let alphabet;
  if (kind === 'pin') {
    alphabet = 10;
  } else {
    alphabet = 0;
    if (/[a-z]/.test(value)) alphabet += 26;
    if (/[A-Z]/.test(value)) alphabet += 26;
    if (/\d/.test(value)) alphabet += 10;
    if (/[^a-zA-Z0-9]/.test(value)) alphabet += 32;
  }

  const guesses = Math.pow(alphabet, value.length) / 2;
  const seconds = guesses / GUESSES_PER_SECOND;

  // Banded on time-to-break rather than on length, so the advice tracks the
  // thing that actually matters.
  let level = 'weak';
  if (seconds >= 86400 * 365 * 100) level = 'strong';
  else if (seconds >= 86400 * 30) level = 'fair';

  return {
    level,
    kind,
    guesses,
    seconds,
    summary: `Someone with a copy of your database could try every possibility in up to ${humanDuration(seconds)}.`,
  };
}

// ── Recovery codes ──────────────────────────────────────────────────────────

/** A fresh recovery code, grouped for transcription. */
export function createRecoveryCode() {
  // Rejection-free because the alphabet is exactly 32 long: five bits per
  // character, taken from a byte each, with no modulo bias.
  const bytes = randomBytes(CODE_LENGTH);
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    if (i > 0 && i % CODE_GROUP === 0) out += '-';
    out += CODE_ALPHABET[bytes[i] & 31];
  }
  zero(bytes);
  return out;
}

/**
 * Fold a written-down code back to canonical form.
 *
 * Case, spacing and the characters Crockford drops are all forgiven — someone
 * reading their own handwriting off a bit of paper should not be told the code
 * is wrong because they typed a lowercase O.
 */
export function normaliseRecoveryCode(input) {
  return String(input ?? '')
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');
}

export function isValidRecoveryCode(input) {
  const clean = normaliseRecoveryCode(input);
  return clean.length === CODE_LENGTH && [...clean].every(ch => CODE_ALPHABET.includes(ch));
}

/** Group a canonical code back into readable blocks. */
export function formatRecoveryCode(input) {
  const clean = normaliseRecoveryCode(input);
  return clean.replace(new RegExp(`(.{${CODE_GROUP}})(?=.)`, 'g'), '$1-');
}

// ── Key derivation and wrapping ─────────────────────────────────────────────

/**
 * Stretch a secret into a key-encryption key.
 *
 * Async only so the caller can paint a spinner: Argon2id itself is synchronous
 * and will block the main thread for about a second, so the yield before it is
 * what stops the UI freezing with no explanation.
 */
async function deriveKek(secret, saltHex, params = ARGON2_PARAMS) {
  await new Promise(resolve => setTimeout(resolve, 0));
  return argon2id(utf8.encode(String(secret)), fromHex(saltHex), {
    t: params.t, m: params.m, p: params.p, dkLen: 32,
  });
}

function wrap(master, kek, aad) {
  const nonce = randomBytes(NONCE_BYTES);
  const data = gcm(kek, nonce, utf8.encode(aad)).encrypt(master);
  return { nonce: toHex(nonce), data: toHex(data) };
}

function unwrap(wrapped, kek, aad) {
  if (!wrapped?.nonce || !wrapped?.data) return null;
  try {
    // A wrong secret fails here, on the GCM tag, rather than being detected by
    // comparing a stored verifier — so there is no verifier to store.
    return gcm(kek, fromHex(wrapped.nonce), utf8.encode(aad)).decrypt(fromHex(wrapped.data));
  } catch {
    return null;
  }
}

/**
 * Split the master into the two keys the database actually uses.
 *
 * Returned as raw bytes rather than `CryptoKey`s because the row cipher has to
 * run synchronously inside IndexedDB transactions — see `dbCrypto.js`, where
 * that constraint is explained. Non-extractable keys would be a little safer
 * against a script that already runs on this origin, but nothing weaker than a
 * key it could simply use in place.
 */
export function deriveKeys(master) {
  return {
    rowKey: hkdf(sha256, master, undefined, utf8.encode(ROW_KEY_INFO), 32),
    indexKey: hkdf(sha256, master, undefined, utf8.encode(INDEX_KEY_INFO), 32),
  };
}

/**
 * Mint a vault: a fresh master key, wrapped twice.
 *
 * The recovery code is returned once and never stored — only its wrap is. If
 * the caller loses it here, it is gone.
 */
export async function createVault(secret, { params = ARGON2_PARAMS } = {}) {
  if (!vaultSupported()) throw new Error('This browser can’t encrypt data securely.');
  if (!isValidSecret(secret)) throw new Error('That secret is too short.');

  const master = randomBytes(MASTER_BYTES);
  const recoveryCode = createRecoveryCode();
  const secretSalt = toHex(randomBytes(SALT_BYTES));
  const recoverySalt = toHex(randomBytes(SALT_BYTES));

  const [secretKek, recoveryKek] = [
    await deriveKek(secret, secretSalt, params),
    await deriveKek(normaliseRecoveryCode(recoveryCode), recoverySalt, params),
  ];

  const record = {
    version: VAULT_VERSION,
    kdf: 'argon2id',
    kdfParams: { ...params },
    secretKind: secretKind(secret),
    secretSalt,
    recoverySalt,
    secretWrap: wrap(master, secretKek, SECRET_AAD),
    recoveryWrap: wrap(master, recoveryKek, RECOVERY_AAD),
    createdAt: new Date().toISOString(),
    // Set once every pre-existing row has been sealed. Until then the database
    // is legitimately half-encrypted and `dbCrypto` reads both shapes.
    sealedAt: null,
  };

  const keys = deriveKeys(master);
  zero(secretKek); zero(recoveryKek);
  return { record, recoveryCode, master, keys };
}

async function open(record, secret, { salt, wrapped, aad }) {
  if (!record || !salt || !wrapped) return null;
  const kek = await deriveKek(secret, salt, record.kdfParams || ARGON2_PARAMS);
  const master = unwrap(wrapped, kek, aad);
  zero(kek);
  if (!master) return null;
  // The master is handed back with the keys rather than discarded: changing a
  // secret rewraps it, and making the caller unlock a second time to do that
  // would cost another Argon2 pass for no security — anything holding the row
  // key can already read everything the master protects.
  return { master, keys: deriveKeys(master) };
}

/** Unlock with the user's PIN or passphrase. Null means "wrong secret". */
export function unlockWithSecret(record, secret) {
  return open(record, secret, {
    salt: record?.secretSalt, wrapped: record?.secretWrap, aad: SECRET_AAD,
  });
}

/** Unlock with the recovery code. Null means "wrong code". */
export function unlockWithRecovery(record, code) {
  if (!isValidRecoveryCode(code)) return Promise.resolve(null);
  return open(record, normaliseRecoveryCode(code), {
    salt: record?.recoverySalt, wrapped: record?.recoveryWrap, aad: RECOVERY_AAD,
  });
}

/**
 * Change the secret without re-encrypting anything.
 *
 * Only the wrap around the master changes, which is the reason for wrapping a
 * random master in the first place rather than deriving the row key from the
 * secret directly — that version would have to rewrite every row in the
 * database to change a PIN.
 */
export async function rewrapSecret(record, master, nextSecret) {
  if (!isValidSecret(nextSecret)) throw new Error('That secret is too short.');
  const params = record?.kdfParams || ARGON2_PARAMS;
  const secretSalt = toHex(randomBytes(SALT_BYTES));
  const kek = await deriveKek(nextSecret, secretSalt, params);
  const next = {
    ...record,
    secretKind: secretKind(nextSecret),
    secretSalt,
    secretWrap: wrap(master, kek, SECRET_AAD),
  };
  zero(kek);
  return next;
}

/**
 * Re-mint the recovery code against the same master, invalidating the old one.
 *
 * Same shape as `rewrapSecret` and for the same reason: a code written on a
 * piece of paper that has since been lost should be replaceable without
 * touching the data.
 */
export async function rewrapRecovery(record, master) {
  const params = record?.kdfParams || ARGON2_PARAMS;
  const recoveryCode = createRecoveryCode();
  const recoverySalt = toHex(randomBytes(SALT_BYTES));
  const kek = await deriveKek(normaliseRecoveryCode(recoveryCode), recoverySalt, params);
  const next = { ...record, recoverySalt, recoveryWrap: wrap(master, kek, RECOVERY_AAD) };
  zero(kek);
  return { record: next, recoveryCode };
}
