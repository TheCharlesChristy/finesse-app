/**
 * Receipt photos: compression, and the rules about what may be stored.
 *
 * A photo straight from an iPhone camera is 2–5 MB. A few hundred of those
 * would be the largest thing in the database by two orders of magnitude, and
 * the browser's storage quota is the one hard limit Finesse can actually hit —
 * so nothing is stored as it arrived. Every image is re-encoded through a
 * canvas at a bounded edge length, which turns a 4 MB HEIC into roughly 150 KB
 * of JPEG that still reads perfectly well as a receipt.
 *
 * Two sizes come out of it. The thumbnail is what the transaction list renders,
 * so scrolling never decodes a full-size image; the full version is only loaded
 * when one is opened.
 *
 * Both are stored as bytes rather than Blobs. IndexedDB takes either, and Blobs
 * read better at the call site — but `Blob.arrayBuffer()` is async, and the row
 * cipher in `dbCrypto.js` has to run synchronously inside an IndexedDB
 * transaction, so a Blob is a value it cannot encrypt at all. Bytes go in,
 * `receiptBlob` turns them back into something an `<img>` can show, and there is
 * still no base64 anywhere — that would inflate every image by a third for no
 * benefit.
 */

export const MAX_FULL_EDGE = 1600;
export const MAX_THUMB_EDGE = 320;
export const FULL_QUALITY = 0.72;
export const THUMB_QUALITY = 0.6;
export const OUTPUT_TYPE = 'image/jpeg';

// Anything past this is a photo of something that isn't a receipt, or a file
// that will decode to something unreasonable. The check is on the input, before
// any decoding work happens.
export const MAX_INPUT_BYTES = 25 * 1024 * 1024;

export function receiptsSupported() {
  return typeof document !== 'undefined'
    && typeof HTMLCanvasElement !== 'undefined'
    && typeof createImageBitmap === 'function';
}

export function isImageFile(file) {
  return Boolean(file && typeof file.type === 'string' && file.type.startsWith('image/'));
}

/** Fit within a square bound, preserving aspect ratio and never upscaling. */
export function scaleToFit(width, height, maxEdge) {
  const longest = Math.max(width, height);
  if (!(longest > 0)) return { width: 0, height: 0 };
  if (longest <= maxEdge) return { width: Math.round(width), height: Math.round(height) };
  const ratio = maxEdge / longest;
  return { width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) };
}

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => (blob ? resolve(blob) : reject(new Error('Could not encode the image.'))),
      type,
      quality,
    );
  });
}

async function renderTo(bitmap, maxEdge, quality) {
  const { width, height } = scaleToFit(bitmap.width, bitmap.height, maxEdge);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  // Receipts are mostly thin dark text on white; without this the downscale
  // aliases the text into mush at thumbnail size.
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  // JPEG has no alpha, so a transparent PNG would otherwise come out black.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);

  const blob = await canvasToBlob(canvas, OUTPUT_TYPE, quality);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
}

/**
 * Turn a picked file into the pair of images stored on the transaction.
 *
 * Throws with a message meant for the user rather than a console: this runs
 * from a file picker, where "nothing happened" is the worst possible outcome.
 */
export async function buildReceipt(file) {
  if (!isImageFile(file)) throw new Error('That file isn’t an image.');
  if (file.size > MAX_INPUT_BYTES) throw new Error('That image is too large to attach.');
  if (!receiptsSupported()) throw new Error('This browser can’t process images.');

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    // HEIC from an iPhone is the usual culprit where the platform decoder
    // can't help us.
    throw new Error('That image couldn’t be read. Try saving it as a JPEG first.');
  }

  try {
    const full = await renderTo(bitmap, MAX_FULL_EDGE, FULL_QUALITY);
    const thumb = await renderTo(bitmap, MAX_THUMB_EDGE, THUMB_QUALITY);

    return {
      receipt: full.bytes,
      receiptThumb: thumb.bytes,
      receiptMeta: {
        width: full.width,
        height: full.height,
        type: OUTPUT_TYPE,
        bytes: full.bytes.byteLength + thumb.bytes.byteLength,
        addedAt: new Date().toISOString(),
      },
    };
  } finally {
    bitmap.close?.();
  }
}

/** The fields that clear a receipt — spelled out so callers can't half-remove one. */
export const EMPTY_RECEIPT = { receipt: null, receiptThumb: null, receiptMeta: null };

/**
 * Whether a transaction carries a receipt.
 *
 * `receiptMeta` is checked first on purpose. On an encrypted database the image
 * fields are getters that decrypt on read, so asking "is there a receipt?" by
 * reading one would decrypt every image in a list just to find out that they
 * exist. The metadata rides along in the row's own ciphertext, already open.
 */
export function hasReceipt(transaction) {
  if (!transaction) return false;
  if (transaction.receiptMeta) return true;
  return Boolean(transaction.receipt || transaction.receiptThumb);
}

/**
 * A displayable Blob for a stored receipt.
 *
 * Accepts the Blobs written before this changed as well as the bytes written
 * since, so a database that predates the switch keeps rendering while the
 * migration hasn't run.
 */
export function receiptBlob(value, meta = null) {
  if (!value) return null;
  if (typeof Blob !== 'undefined' && value instanceof Blob) return value;
  const type = meta?.type || OUTPUT_TYPE;
  return new Blob([value], { type });
}
