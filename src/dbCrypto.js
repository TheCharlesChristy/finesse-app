/**
 * Transparent row encryption, installed under Dexie rather than over it.
 *
 * This is a DBCore middleware: it sits between Dexie and IndexedDB, seals rows
 * on the way down and opens them on the way up. Every helper in `db.js`, every
 * `useLiveQuery`, every view keeps handling ordinary objects and none of them
 * knows this exists. That matters more than the tidiness — a scheme that asked
 * two thousand lines of helpers to remember to encrypt would be one forgotten
 * call away from writing a plaintext row for ever.
 *
 * **Why the cipher is synchronous JS and not WebCrypto.** An IndexedDB
 * transaction commits as soon as the microtask queue drains without a new
 * request against it. `crypto.subtle` resolves on a later task, so awaiting it
 * between two IDB operations kills the transaction underneath us. Everything
 * on this path therefore has to be sync, which rules out `subtle` entirely and
 * rules out `Blob.arrayBuffer()` with it. AES-GCM from `@noble/ciphers` seals a
 * row in about fifty microseconds, so the cost is real but small. The one place
 * a slow, async, memory-hard KDF belongs is unlocking, and that happens in
 * `vault.js` with no transaction open.
 *
 * **What stays readable.** The primary key and every indexed field are written
 * in the clear, because IndexedDB has to be able to sort and seek on them. The
 * clear set is read off the live Dexie schema rather than listed here, so an
 * index added later can't quietly start leaking a field this file didn't know
 * about. Schema v9 exists precisely to shrink that set: every index the app
 * never actually queried was dropped, which is what moved category names,
 * merchant tags and the rest behind the cipher. What remains legible to someone
 * reading the raw database is the shape — how many rows, and which account and
 * category each belongs to — and `sealedFieldReport` will tell you exactly
 * that, rather than leaving it to be discovered.
 *
 * **Binaries are sealed apart and opened late.** Receipt images are two orders
 * of magnitude larger than the row that carries them, and a transaction list
 * touches hundreds of rows without looking at a single image. Folding them into
 * the row's ciphertext would mean decrypting megabytes to render a list, so each
 * binary field is sealed on its own and exposed as a getter that decrypts on
 * first read and caches. Spread it, `JSON.stringify` it, hand it to React — it
 * behaves like the bytes it stands in for.
 */

import { gcm } from '@noble/ciphers/aes.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

import { toHex, fromHex, zero } from './vault';

// Field names on a sealed row. Short because they are written to every record.
const F_VERSION = '__v';
const F_NONCE = '__n';
const F_DATA = '__d';
const F_BINARY = '__b';
const SEALED_FIELDS = new Set([F_VERSION, F_NONCE, F_DATA, F_BINARY]);

export const SEALED_VERSION = 1;

// The vault record holds the wrapped key, so it can't be encrypted with it.
// Nothing else in it is private: salts, KDF parameters and two ciphertexts.
export const UNENCRYPTED_TABLES = new Set(['vault']);

const NONCE_BYTES = 12;
const utf8 = new TextEncoder();
const decoder = new TextDecoder();

// ── Key state ───────────────────────────────────────────────────────────────
// Held in a module variable rather than passed around: the middleware is
// installed once, at import, and every call site below is reached from inside a
// transaction where an extra argument can't travel.

const state = { enabled: false, keys: null, suspended: false };

/** Turn sealing on and hand over the keys. Called by `db.js` after an unlock. */
export function activateEncryption(keys) {
  state.enabled = true;
  state.keys = keys;
}

/**
 * Encryption is on, but this page can't read it.
 *
 * Set when a vault exists and hasn't been unlocked yet, so that a stray write
 * throws instead of landing in the clear beside sealed rows.
 */
export function markEncrypted() {
  state.enabled = true;
  state.keys = null;
}

/** Forget the keys — on lock, or on sign-out of a shared device. */
export function lockEncryption() {
  if (state.keys) {
    zero(state.keys.rowKey);
    zero(state.keys.indexKey);
  }
  state.keys = null;
  binaryCache.clear();
}

/** Encryption off entirely: no vault, rows written in the clear. */
export function resetEncryption() {
  lockEncryption();
  state.enabled = false;
  state.suspended = false;
}

/**
 * Keep opening sealed rows, but write new ones in the clear.
 *
 * The one state that makes turning encryption *off* possible in place: without
 * it the whole database — receipts included — would have to be held in memory
 * between the last decrypted read and the first plaintext write.
 */
export function setSealingSuspended(suspended) {
  state.suspended = Boolean(suspended);
}

export function isEncryptionEnabled() { return state.enabled; }
export function isUnlocked() { return Boolean(state.keys); }

// ── Blind index ─────────────────────────────────────────────────────────────

/**
 * A keyed digest standing in for a value that has to stay indexed.
 *
 * `receiptKey` and `subscriptionRunKey` are unique indexes used only to answer
 * "have I already written this one?". Their contents — an account id, an income
 * id and a date — would sit in the clear for ever otherwise. An HMAC under a key
 * derived separately from the row cipher preserves both the uniqueness and the
 * equality lookup while telling a reader of the raw database nothing.
 *
 * Returns the value untouched when there is no key, so a database that never
 * turned encryption on keeps working and keeps its old rows findable.
 */
export function blindIndex(value) {
  if (value == null || value === '') return value;
  if (!state.enabled || state.suspended) return value;
  if (!state.keys) throw new Error('Finesse is locked: no key to derive an index with.');
  return toHex(hmac(sha256, state.keys.indexKey, utf8.encode(String(value))));
}

// ── The row codec ───────────────────────────────────────────────────────────

function isBinary(value) {
  return value instanceof Uint8Array || value instanceof ArrayBuffer;
}

function toBytes(value) {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}

function sealBytes(bytes) {
  const nonce = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(nonce);
  return { n: toHex(nonce), d: gcm(state.keys.rowKey, nonce).encrypt(bytes) };
}

function openBytes(sealed) {
  return gcm(state.keys.rowKey, fromHex(sealed.n)).decrypt(toBytes(sealed.d));
}

/**
 * A bounded cache of opened binaries.
 *
 * Live queries re-run on every write, so a transaction list re-reads — and
 * would re-decrypt — every visible receipt thumbnail each time. The nonce is
 * part of the key, so a rewritten row can never hit a stale entry.
 */
const BINARY_CACHE_BYTES = 8 * 1024 * 1024;
const binaryCache = new Map();
let binaryCacheBytes = 0;

function cacheBinary(key, bytes) {
  binaryCache.set(key, bytes);
  binaryCacheBytes += bytes.byteLength;
  // Insertion-ordered, so the first key is the oldest.
  while (binaryCacheBytes > BINARY_CACHE_BYTES && binaryCache.size > 1) {
    const oldest = binaryCache.keys().next().value;
    binaryCacheBytes -= binaryCache.get(oldest).byteLength;
    binaryCache.delete(oldest);
  }
  return bytes;
}

/**
 * Seal one row. Clear fields stay put; everything else goes into one ciphertext.
 *
 * A Blob here throws rather than being stored as it is. There is no synchronous
 * way to read one, and writing it in the clear next to sealed rows — silently,
 * where the whole point is that nothing sensitive is written in the clear — is
 * not a failure mode worth having. `receipts.js` stores bytes for this reason,
 * and the migration converts the ones written before it did.
 */
function sealRow(row, clearFields) {
  if (!row || typeof row !== 'object') return row;
  if (!state.keys) throw new Error('Finesse is locked: refusing to write.');

  const out = {};
  const payload = {};
  let binaries = null;

  for (const key of Object.keys(row)) {
    const value = row[key];
    if (SEALED_FIELDS.has(key)) continue;
    if (clearFields.has(key)) { out[key] = value; continue; }
    if (isBinary(value)) {
      binaries = binaries || {};
      binaries[key] = sealBytes(toBytes(value));
      continue;
    }
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
      throw new Error(`Cannot encrypt the Blob in "${key}" — store bytes instead.`);
    }
    // JSON would turn this into a string and hand it back as one, so the row
    // would quietly come out of the database a different type than it went in —
    // the kind of drift nothing ever traces back to here. Every date in Finesse
    // is already an ISO string; this makes that a rule rather than a habit.
    // Only the top level is checked, which is where rows actually hold dates.
    if (value instanceof Date) {
      throw new Error(`Cannot encrypt the Date in "${key}" — store an ISO string instead.`);
    }
    payload[key] = value;
  }

  const sealed = sealBytes(utf8.encode(JSON.stringify(payload)));
  out[F_VERSION] = SEALED_VERSION;
  out[F_NONCE] = sealed.n;
  out[F_DATA] = sealed.d;
  if (binaries) out[F_BINARY] = binaries;
  return out;
}

/**
 * Open one row, or pass it through if it was never sealed.
 *
 * Rows written before encryption was switched on stay readable, which is what
 * lets the migration run in resumable batches instead of one transaction big
 * enough to lose everything if the tab closes halfway.
 */
function openRow(row, tableName) {
  if (!row || typeof row !== 'object' || row[F_VERSION] == null) return row;
  if (!state.keys) throw new Error('Finesse is locked: this data is encrypted.');

  const out = {};
  for (const key of Object.keys(row)) {
    if (!SEALED_FIELDS.has(key)) out[key] = row[key];
  }
  Object.assign(out, JSON.parse(decoder.decode(openBytes({ n: row[F_NONCE], d: row[F_DATA] }))));

  const binaries = row[F_BINARY];
  if (binaries) {
    const identity = `${tableName}:${out.id ?? ''}`;
    for (const field of Object.keys(binaries)) {
      const sealed = binaries[field];
      const cacheKey = `${identity}:${field}:${sealed.n}`;
      Object.defineProperty(out, field, {
        enumerable: true,
        configurable: true,
        // Writable in effect: assigning replaces the accessor with a plain
        // value, which is what an editing code path expects to be able to do.
        set(value) {
          Object.defineProperty(out, field, {
            value, writable: true, enumerable: true, configurable: true,
          });
        },
        get() {
          const hit = binaryCache.get(cacheKey);
          if (hit) return hit;
          return cacheBinary(cacheKey, openBytes(sealed));
        },
      });
    }
  }
  return out;
}

/** True for a row this middleware has sealed. Used by the migration. */
export function isSealed(row) {
  return Boolean(row && typeof row === 'object' && row[F_VERSION] != null);
}

// ── The middleware ──────────────────────────────────────────────────────────

/**
 * Which fields IndexedDB must be able to read for itself.
 *
 * Taken from the schema Dexie hands the middleware, so this tracks the real
 * indexes rather than a list that has to be kept in step with them.
 */
function clearFieldsFor(schema) {
  const fields = new Set();
  const add = (keyPath) => {
    if (typeof keyPath === 'string') fields.add(keyPath.split('.')[0]);
    else if (Array.isArray(keyPath)) keyPath.forEach(add);
  };
  add(schema.primaryKey?.keyPath);
  for (const index of schema.indexes || []) add(index.keyPath);
  return fields;
}

/** The names of the fields left readable on each table, for the UI to show. */
export function sealedFieldReport(database) {
  const report = {};
  for (const table of database.tables) {
    if (UNENCRYPTED_TABLES.has(table.name)) continue;
    const fields = new Set();
    if (table.schema.primKey?.keyPath) fields.add(table.schema.primKey.keyPath);
    for (const index of table.schema.indexes || []) {
      if (typeof index.keyPath === 'string') fields.add(index.keyPath);
    }
    report[table.name] = [...fields];
  }
  return report;
}

export function encryptionMiddleware() {
  return {
    stack: 'dbcore',
    name: 'finesseEncryption',
    create(down) {
      return {
        ...down,
        table(tableName) {
          const table = down.table(tableName);
          if (UNENCRYPTED_TABLES.has(tableName)) return table;
          const clearFields = clearFieldsFor(table.schema);
          const open = row => openRow(row, tableName);

          return {
            ...table,

            mutate(req) {
              if (!state.enabled || state.suspended || !req.values?.length) return table.mutate(req);
              return table.mutate({ ...req, values: req.values.map(v => sealRow(v, clearFields)) });
            },

            get(req) {
              return table.get(req).then(open);
            },

            getMany(req) {
              return table.getMany(req).then(rows => rows.map(open));
            },

            query(req) {
              return table.query(req).then(res => (
                // `values: false` asks for keys, which are never sealed.
                req.values === false ? res : { ...res, result: res.result.map(open) }
              ));
            },

            openCursor(req) {
              return table.openCursor(req).then(cursor => {
                if (!cursor || req.values === false) return cursor;
                // Same shape Dexie's own virtual-index middleware uses: the
                // real cursor is the prototype, so `continue`, `stop` and
                // `done` keep resolving to whatever it currently holds — it
                // reassigns them as iteration proceeds — and only `value` is
                // shadowed.
                return Object.create(cursor, {
                  value: { get: () => open(cursor.value), enumerable: true },
                });
              });
            },
          };
        },
      };
    },
  };
}
