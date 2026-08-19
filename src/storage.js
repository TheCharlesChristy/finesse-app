/**
 * Persistent storage and quota, for an app whose only copy of your data is here.
 *
 * Finesse has no server. Everything lives in one browser's IndexedDB, which
 * browsers treat as evictable by default — under storage pressure, or after a
 * long enough gap without a visit, "best effort" data can simply be deleted.
 * `navigator.storage.persist()` asks for the "persistent" bucket instead, which
 * is only cleared if the user clears it themselves.
 *
 * Whether the request is granted is entirely the browser's call and varies by
 * engine: Chrome grants it on engagement signals, Firefox prompts, and Safari
 * grants it to home-screen web apps. So this reports what actually happened
 * rather than promising an outcome, and every export degrades to a value the UI
 * can explain where the API is missing.
 *
 * Nothing here is called on load without a reason: `persist()` can prompt in
 * some browsers, so it is only ever triggered from an explicit user action in
 * Settings, matching how notification permission is handled.
 */

const STORAGE_UNSUPPORTED = 'unsupported';
const STORAGE_PERSISTED = 'persisted';
const STORAGE_BEST_EFFORT = 'best-effort';

export { STORAGE_UNSUPPORTED, STORAGE_PERSISTED, STORAGE_BEST_EFFORT };

function storageApi() {
  if (typeof navigator === 'undefined') return null;
  return navigator.storage || null;
}

export function persistenceSupported() {
  const storage = storageApi();
  return Boolean(storage && typeof storage.persist === 'function' && typeof storage.persisted === 'function');
}

export function estimateSupported() {
  const storage = storageApi();
  return Boolean(storage && typeof storage.estimate === 'function');
}

/**
 * Whether the database is already in the persistent bucket.
 *
 * Returns 'unsupported' rather than false where the API is missing, so the UI
 * can say "this browser can't tell us" instead of the much scarier — and
 * wrong — "your data is not protected".
 */
export async function getPersistenceState() {
  if (!persistenceSupported()) return STORAGE_UNSUPPORTED;
  try {
    return (await navigator.storage.persisted()) ? STORAGE_PERSISTED : STORAGE_BEST_EFFORT;
  } catch {
    return STORAGE_UNSUPPORTED;
  }
}

/**
 * Ask the browser to keep this data.
 *
 * Must be called from a user gesture: some browsers prompt, and an unprompted
 * permission dialog on load is noise. Already-persisted storage short-circuits
 * rather than re-requesting, since `persist()` on a persisted origin is a
 * no-op that can still cost a prompt.
 */
export async function requestPersistence() {
  if (!persistenceSupported()) return STORAGE_UNSUPPORTED;
  try {
    if (await navigator.storage.persisted()) return STORAGE_PERSISTED;
    return (await navigator.storage.persist()) ? STORAGE_PERSISTED : STORAGE_BEST_EFFORT;
  } catch {
    return STORAGE_UNSUPPORTED;
  }
}

/**
 * How much room the data is taking, and how much there is.
 *
 * `quota` is the browser's advertised ceiling for the whole origin, which is
 * typically a fraction of free disk and moves as the disk fills. Both figures
 * are deliberately imprecise — browsers pad them to avoid fingerprinting — so
 * this is for "am I anywhere near a problem?", not accounting.
 *
 * Returns null when unavailable so callers can hide the row entirely instead of
 * rendering a confident zero.
 */
export async function getStorageEstimate() {
  if (!estimateSupported()) return null;
  try {
    const { usage, quota } = await navigator.storage.estimate();
    if (!Number.isFinite(usage) || !Number.isFinite(quota) || quota <= 0) return null;
    return { usage, quota, percent: Math.min(100, (usage / quota) * 100) };
  } catch {
    return null;
  }
}

/** Bytes as a short human string — "1.2 MB". */
export function formatBytes(bytes) {
  // `Number(null)` is 0, so a missing value would otherwise render a confident
  // "0 B" for "we don't know" — exactly the wrong impression.
  if (bytes == null || bytes === '') return '—';
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return `${Math.round(value)} B`;

  const units = ['KB', 'MB', 'GB', 'TB'];
  let scaled = value / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled >= 10 ? Math.round(scaled) : scaled.toFixed(1)} ${units[unit]}`;
}
