/**
 * Getting a file out of the app and somewhere it will survive.
 *
 * A backup that stays in the browser it was exported from is not a backup, and
 * `<a download>` — the usual way to hand a file over — is the weakest path on
 * the one platform Finesse is actually installed on. In a standalone iOS home
 * screen app there is no visible Downloads UI to follow it to, so the file
 * lands somewhere the user has to go hunting for, if the click works at all.
 *
 * `navigator.share({ files })` opens the system share sheet instead: Files,
 * iCloud Drive, AirDrop, Mail — somewhere off-device, which is the entire point
 * of a backup for an app with no server.
 *
 * Support is patchy (no Firefox, no desktop Safari for files, http:// origins
 * excluded), so every path here falls back to the download link rather than
 * failing. Callers get back which route was taken so the UI can say something
 * true about where the file went.
 */

export const SHARE_SHARED = 'shared';
export const SHARE_DOWNLOADED = 'downloaded';
export const SHARE_CANCELLED = 'cancelled';

/**
 * Whether the share sheet can accept this particular file.
 *
 * `canShare` must be asked about the actual file: iOS accepts some types and
 * silently rejects others, and a `share()` that throws mid-flow is worse than
 * never offering it.
 */
export function canShareFile(file) {
  if (typeof navigator === 'undefined') return false;
  if (typeof navigator.share !== 'function' || typeof navigator.canShare !== 'function') return false;
  try {
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/** The original path: a temporary object URL behind a synthetic click. */
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Revoking synchronously can cancel the download in some browsers; one turn
  // of the event loop is enough for the click to have been picked up.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * Offer a file to the share sheet, falling back to a download.
 *
 * Returns 'shared', 'downloaded' or 'cancelled'. Cancellation is a real
 * outcome, not an error: the user dismissed the sheet, and quietly downloading
 * the file anyway would be the opposite of what they just asked for. It also
 * means the caller must not record a backup as taken.
 */
export async function shareFile({ blob, filename, title = 'Finesse', text = '' }) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });

  if (canShareFile(file)) {
    try {
      await navigator.share({ files: [file], title, ...(text ? { text } : {}) });
      return SHARE_SHARED;
    } catch (error) {
      // AbortError is the user dismissing the sheet. Anything else is the API
      // failing on us, and the download is a better answer than nothing.
      if (error?.name === 'AbortError') return SHARE_CANCELLED;
    }
  }

  downloadBlob(blob, filename);
  return SHARE_DOWNLOADED;
}

/** Share (or download) an object as pretty-printed JSON. */
export function shareJson({ data, filename, title, text }) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  return shareFile({ blob, filename, title, text });
}

/** Share (or download) a CSV string. */
export function shareCsv({ csv, filename, title, text }) {
  const blob = new Blob([csv], { type: 'text/csv' });
  return shareFile({ blob, filename, title, text });
}
