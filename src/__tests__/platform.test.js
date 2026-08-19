/**
 * The two browser-API modules: storage persistence and file sharing.
 *
 * Both wrap APIs that are missing or half-implemented on real devices, so what
 * matters is the degradation — every path must return something the UI can
 * explain rather than throwing or, worse, quietly claiming success.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  formatBytes, getPersistenceState, getStorageEstimate, persistenceSupported, requestPersistence,
  STORAGE_BEST_EFFORT, STORAGE_PERSISTED, STORAGE_UNSUPPORTED,
} from '../storage';
import { canShareFile, shareFile, SHARE_CANCELLED, SHARE_DOWNLOADED, SHARE_SHARED } from '../share';

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
