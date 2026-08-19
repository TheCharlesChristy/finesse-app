/**
 * The browser-API modules: storage persistence, file sharing and the PIN lock.
 *
 * These wrap APIs that are missing or half-implemented on real devices, so what
 * matters most is the degradation — every path must return something the UI can
 * explain rather than throwing or, worse, quietly claiming success.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  formatBytes, getPersistenceState, getStorageEstimate, persistenceSupported, requestPersistence,
  STORAGE_BEST_EFFORT, STORAGE_PERSISTED, STORAGE_UNSUPPORTED,
} from '../storage';
import { canShareFile, shareFile, SHARE_CANCELLED, SHARE_DOWNLOADED, SHARE_SHARED } from '../share';
import { buildPinSettings, isValidPin, safeEqual, shouldRelock, verifyPin } from '../lock';
import { EMPTY_RECEIPT, hasReceipt, scaleToFit } from '../receipts';

// The test environment is Node, so both `navigator` and the DOM are absent
// until a test installs one. Each helper puts back exactly what it replaced.
function withNavigator(value) {
  const had = 'navigator' in globalThis;
  const original = globalThis.navigator;
  Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true });
  return () => {
    if (had) Object.defineProperty(globalThis, 'navigator', { value: original, configurable: true, writable: true });
    else delete globalThis.navigator;
  };
}

/**
 * A minimal stand-in for the download path: an anchor whose click is recorded,
 * plus the object-URL calls the real one makes. Node has neither `document` nor
 * `URL.createObjectURL`, so both are installed and removed per test.
 */
function withStubbedDownload() {
  const element = { href: '', download: '', click: vi.fn() };
  const hadDocument = 'document' in globalThis;
  const originalDocument = globalThis.document;
  const originalCreate = URL.createObjectURL;
  const originalRevoke = URL.revokeObjectURL;

  globalThis.document = { createElement: () => element };
  URL.createObjectURL = vi.fn(() => 'blob:stub');
  URL.revokeObjectURL = vi.fn();

  return {
    element,
    click: element.click,
    restore() {
      if (hadDocument) globalThis.document = originalDocument;
      else delete globalThis.document;
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    },
  };
}

let restore = null;
afterEach(() => {
  if (restore) restore();
  restore = null;
});

describe('formatBytes', () => {
  it('scales through the units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(12 * 1024 * 1024)).toBe('12 MB');
    expect(formatBytes(3.2 * 1024 ** 3)).toBe('3.2 GB');
  });

  it('rounds away the decimal once the number is big enough not to need it', () => {
    expect(formatBytes(45.7 * 1024 * 1024)).toBe('46 MB');
    expect(formatBytes(9.4 * 1024 * 1024)).toBe('9.4 MB');
  });

  it('renders "unknown" rather than a confident zero', () => {
    // Number(null) is 0, so this is the case that matters.
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes('')).toBe('—');
    expect(formatBytes(-1)).toBe('—');
    expect(formatBytes('nonsense')).toBe('—');
  });
});

describe('storage persistence', () => {
  it('reports unsupported rather than unprotected when the API is missing', async () => {
    restore = withNavigator({});
    expect(persistenceSupported()).toBe(false);
    expect(await getPersistenceState()).toBe(STORAGE_UNSUPPORTED);
    expect(await requestPersistence()).toBe(STORAGE_UNSUPPORTED);
  });

  it('distinguishes persisted from best-effort', async () => {
    restore = withNavigator({ storage: { persisted: async () => true, persist: async () => true } });
    expect(await getPersistenceState()).toBe(STORAGE_PERSISTED);

    restore();
    restore = withNavigator({ storage: { persisted: async () => false, persist: async () => false } });
    expect(await getPersistenceState()).toBe(STORAGE_BEST_EFFORT);
  });

  it('does not re-request when storage is already persistent', async () => {
    const persist = vi.fn(async () => true);
    restore = withNavigator({ storage: { persisted: async () => true, persist } });

    expect(await requestPersistence()).toBe(STORAGE_PERSISTED);
    expect(persist).not.toHaveBeenCalled();
  });

  it('reports a declined request as best-effort, not as an error', async () => {
    restore = withNavigator({ storage: { persisted: async () => false, persist: async () => false } });
    expect(await requestPersistence()).toBe(STORAGE_BEST_EFFORT);
  });

  it('swallows a throwing implementation', async () => {
    restore = withNavigator({
      storage: {
        persisted: async () => { throw new Error('nope'); },
        persist: async () => { throw new Error('nope'); },
      },
    });
    expect(await getPersistenceState()).toBe(STORAGE_UNSUPPORTED);
    expect(await requestPersistence()).toBe(STORAGE_UNSUPPORTED);
  });

  it('returns null for an estimate it cannot trust', async () => {
    restore = withNavigator({ storage: { estimate: async () => ({ usage: 5, quota: 0 }) } });
    expect(await getStorageEstimate()).toBeNull();

    restore();
    restore = withNavigator({ storage: { estimate: async () => ({}) } });
    expect(await getStorageEstimate()).toBeNull();

    restore();
    restore = withNavigator({});
    expect(await getStorageEstimate()).toBeNull();
  });

  it('computes a percentage from a usable estimate', async () => {
    restore = withNavigator({ storage: { estimate: async () => ({ usage: 250, quota: 1000 }) } });
    expect(await getStorageEstimate()).toEqual({ usage: 250, quota: 1000, percent: 25 });
  });
});

describe('sharing a file', () => {
  const blob = () => new Blob(['{"a":1}'], { type: 'application/json' });

  it('declines to offer the sheet when the API is absent', () => {
    restore = withNavigator({});
    expect(canShareFile(new File([blob()], 'x.json'))).toBe(false);
  });

  it('asks canShare about the actual file rather than assuming', () => {
    const canShare = vi.fn(() => false);
    restore = withNavigator({ share: async () => {}, canShare });

    expect(canShareFile(new File([blob()], 'x.json'))).toBe(false);
    expect(canShare).toHaveBeenCalledWith({ files: expect.any(Array) });
  });

  it('shares when the platform accepts the file', async () => {
    const share = vi.fn(async () => {});
    restore = withNavigator({ share, canShare: () => true });

    expect(await shareFile({ blob: blob(), filename: 'backup.json' })).toBe(SHARE_SHARED);
    expect(share).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0][0].files[0].name).toBe('backup.json');
  });

  it('treats a dismissed sheet as cancelled, and does not download behind the user', async () => {
    const share = vi.fn(async () => {
      const error = new Error('dismissed');
      error.name = 'AbortError';
      throw error;
    });
    const anchor = withStubbedDownload();
    restore = withNavigator({ share, canShare: () => true });

    expect(await shareFile({ blob: blob(), filename: 'backup.json' })).toBe(SHARE_CANCELLED);
    expect(anchor.click).not.toHaveBeenCalled();
    anchor.restore();
  });

  it('falls back to a download when the sheet is unavailable', async () => {
    const anchor = withStubbedDownload();
    restore = withNavigator({});

    expect(await shareFile({ blob: blob(), filename: 'backup.json' })).toBe(SHARE_DOWNLOADED);
    expect(anchor.click).toHaveBeenCalledTimes(1);
    expect(anchor.element.download).toBe('backup.json');
    anchor.restore();
  });

  it('falls back to a download when the sheet itself fails', async () => {
    const share = vi.fn(async () => { throw new Error('platform said no'); });
    const anchor = withStubbedDownload();
    restore = withNavigator({ share, canShare: () => true });

    expect(await shareFile({ blob: blob(), filename: 'backup.json' })).toBe(SHARE_DOWNLOADED);
    expect(anchor.click).toHaveBeenCalledTimes(1);
    anchor.restore();
  });
});

describe('PIN lock', () => {
  it('accepts only digit PINs of a sensible length', () => {
    expect(isValidPin('1234')).toBe(true);
    expect(isValidPin('123456789012')).toBe(true);
    expect(isValidPin('123')).toBe(false);
    expect(isValidPin('1234567890123')).toBe(false);
    expect(isValidPin('12a4')).toBe(false);
    expect(isValidPin('')).toBe(false);
    expect(isValidPin(null)).toBe(false);
  });

  it('never stores the PIN itself, and salts each install separately', async () => {
    const first = await buildPinSettings('1234');
    const second = await buildPinSettings('1234');

    expect(first.pinHash).not.toContain('1234');
    expect(first.pinSalt).not.toBe(second.pinSalt);
    // Same PIN, different salt — the stored verifier must differ, or a shared
    // hash would give away that two installs use the same PIN.
    expect(first.pinHash).not.toBe(second.pinHash);
  });

  it('verifies the right PIN and rejects the wrong one', async () => {
    const stored = await buildPinSettings('4821');

    expect(await verifyPin('4821', stored)).toBe(true);
    expect(await verifyPin('4822', stored)).toBe(false);
    expect(await verifyPin('', stored)).toBe(false);
    expect(await verifyPin('4821', {})).toBe(false);
    expect(await verifyPin('4821', { pinSalt: stored.pinSalt })).toBe(false);
  });

  it('compares digests without short-circuiting on the first difference', () => {
    expect(safeEqual('abcd', 'abcd')).toBe(true);
    expect(safeEqual('abcd', 'abce')).toBe(false);
    expect(safeEqual('abcd', 'abc')).toBe(false);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual(null, null)).toBe(false);
  });

  it('re-locks only once the grace period has passed', () => {
    const hidden = 1_000_000;

    expect(shouldRelock(null, 60_000, hidden + 90_000)).toBe(false);
    expect(shouldRelock(hidden, 60_000, hidden + 59_000)).toBe(false);
    expect(shouldRelock(hidden, 60_000, hidden + 60_000)).toBe(true);
    // "Immediately" must not be defeated by a zero-length background trip.
    expect(shouldRelock(hidden, 0, hidden)).toBe(true);
  });
});

describe('receipt sizing', () => {
  it('never upscales an image that already fits', () => {
    expect(scaleToFit(800, 600, 1600)).toEqual({ width: 800, height: 600 });
    expect(scaleToFit(1600, 1200, 1600)).toEqual({ width: 1600, height: 1200 });
  });

  it('bounds the longest edge, preserving aspect ratio', () => {
    expect(scaleToFit(4000, 3000, 1600)).toEqual({ width: 1600, height: 1200 });
    // Portrait: the bound applies to the height instead.
    expect(scaleToFit(3000, 4000, 1600)).toEqual({ width: 1200, height: 1600 });
  });

  it('keeps an extreme aspect ratio at least one pixel wide', () => {
    expect(scaleToFit(10000, 5, 320).height).toBe(1);
  });

  it('handles a degenerate image without producing NaN', () => {
    expect(scaleToFit(0, 0, 320)).toEqual({ width: 0, height: 0 });
  });

  it('recognises which transactions carry a receipt', () => {
    expect(hasReceipt(null)).toBe(false);
    expect(hasReceipt({ amount: 5 })).toBe(false);
    expect(hasReceipt({ receipt: new Blob(['x']) })).toBe(true);
    // A row whose thumbnail encoded but whose full image didn't still counts.
    expect(hasReceipt({ receiptThumb: new Blob(['x']) })).toBe(true);
  });

  it('spells out every field that clearing a receipt must null', () => {
    expect(EMPTY_RECEIPT).toEqual({ receipt: null, receiptThumb: null, receiptMeta: null });
  });
});
