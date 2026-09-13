/**
 * Getting text out of a bank statement that didn't arrive as a CSV.
 *
 * A digitally-generated PDF — the normal download from online banking — has
 * its own text layer, and pdf.js reads that directly: fast, exact, no OCR
 * involved. A scanned page, or a photo or screenshot of a paper statement,
 * has no such layer, so it's rendered to a canvas and read by Tesseract
 * instead. Both paths hand back the same thing — raw text — for
 * `parseStatementText` in `csv.js` to turn into candidate rows.
 *
 * Both libraries are loaded on demand (`import()`), not from App's main
 * bundle, since most sessions never open this flow. And both run from files
 * this app ships under `public/tesseract/`, not a CDN: the worker, the wasm
 * core and the English language data are same-origin, so a statement's
 * contents never leave the device and OCR keeps working offline once the
 * service worker has cached them (see the `runtimeCaching` entry in
 * vite.config.js).
 *
 * Only the SIMD build of tesseract-core is shipped, and `corePath` below
 * points at that exact file rather than a directory — tesseract.js's own
 * feature-detection otherwise reaches for a "relaxed SIMD" build this app
 * doesn't ship, which would 404 on a browser that happens to support it. A
 * device too old for SIMD wasm gets a clear error instead of a silent hang;
 * that trade keeps a second multi-megabyte core out of the app entirely.
 *
 * Genuinely unsupported hardware is rare, though — essentially every device
 * still receiving updates has had WASM SIMD for years. Far more likely is a
 * *transport* failure: the core is 2.86MB and its glue script another 3.9MB,
 * a lot to ask a phone on a shaky connection to fetch in one piece, and the
 * `runtimeCaching` rule in vite.config.js means a response that got cut off
 * mid-download can end up cached and replayed forever after, since CacheFirst
 * never re-validates against the network. `simd()` from `wasm-feature-detect`
 * (a real dependency of tesseract.js already, just not one this file used to
 * ask directly) settles which of the two happened *before* the multi-megabyte
 * fetch even starts, with a few bytes of throwaway wasm — so a genuine
 * incompatibility is never confused with a bad download, and a bad download
 * gets its cache entry cleared and one automatic retry rather than failing
 * the same way forever.
 */

import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { simd } from 'wasm-feature-detect';

import { hasUsableTextLayer, textFromContent } from './csv';

GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

const ASSET_BASE = `${import.meta.env.BASE_URL}tesseract/`;
const CORE_URL = `${ASSET_BASE}core/tesseract-core-simd-lstm.wasm.js`;
const CORE_WASM_URL = `${ASSET_BASE}core/tesseract-core-simd-lstm.wasm`;
const OCR_CACHE_NAME = 'ocr-assets';

export class OcrUnsupportedError extends Error {
  constructor() {
    super('This device or browser does not support the WebAssembly features Finesse’s OCR needs.');
    this.name = 'OcrUnsupportedError';
  }
}

/**
 * An error tagged with which named step of the pipeline it happened in.
 *
 * A real bank-generated PDF is a much more complex document than anything
 * hand-built for testing here — compressed cross-reference streams, embedded
 * and subsetted fonts, content structures the simplest valid PDF never
 * touches — and pdf.js (or Tesseract, on the OCR fallback) can fail deep
 * inside code this app doesn't own. Without on-device devtools, a stage name
 * shown directly in the review modal is the only diagnosis a phone can give;
 * see `withStage` and the per-page handling in `extractPdfText` below.
 */
export class StageError extends Error {
  constructor(stage, cause) {
    super(`${stage}: ${cause?.message || String(cause)}`);
    this.name = 'StageError';
    this.stage = stage;
    this.cause = cause;
  }
}

async function withStage(stage, fn) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof OcrUnsupportedError) throw error;
    throw new StageError(stage, error);
  }
}

/** Drop any cached copy of the wasm core, in case it was cached mid-download. */
async function evictCachedCore() {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(OCR_CACHE_NAME);
    await Promise.all([cache.delete(CORE_URL), cache.delete(CORE_WASM_URL)]);
  } catch {
    // Best effort — Cache Storage can be unavailable (private browsing,
    // Safari's own quirks); the caller's retry still helps even without it.
  }
}

let simdSupported = null;

async function createOcrWorker(onProgress) {
  if (simdSupported == null) simdSupported = await simd().catch(() => false);
  if (!simdSupported) throw new OcrUnsupportedError();

  const { createWorker } = await import('tesseract.js');
  try {
    return await createWorker('eng', undefined, {
      workerPath: `${ASSET_BASE}worker.min.js`,
      corePath: CORE_URL,
      langPath: `${ASSET_BASE}lang`,
      logger: onProgress,
    });
  } catch (error) {
    // SIMD is confirmed supported above, so a WebAssembly compile/link
    // failure here isn't a real incompatibility — almost certainly a
    // truncated download, possibly one the service worker cached partway
    // through. Clear it so the retry the caller gets to offer fetches fresh.
    const isWasmError = typeof WebAssembly !== 'undefined'
      && (error instanceof WebAssembly.CompileError || error instanceof WebAssembly.LinkError);
    if (isWasmError) await evictCachedCore();
    throw error;
  }
}

let workerPromise = null;

function getOcrWorker(onProgress) {
  if (!workerPromise) {
    workerPromise = createOcrWorker(onProgress).catch((error) => {
      // A failed load must not wedge every later attempt behind the same
      // rejected promise — worth letting the user try again.
      workerPromise = null;
      throw error;
    });
  }
  return workerPromise;
}

/** Release the OCR worker's memory. Safe to call whether or not one was ever created. */
export async function terminateOcr() {
  if (!workerPromise) return;
  const pending = workerPromise;
  workerPromise = null;
  try {
    const worker = await pending;
    await worker.terminate();
  } catch {
    // Already gone, or never finished loading — nothing to clean up.
  }
}

async function ocrSource(source, onProgress) {
  const worker = await getOcrWorker(onProgress);
  const { data } = await worker.recognize(source);
  return data.text || '';
}

// iOS Safari has a hard per-canvas pixel-area ceiling (roughly 16 million
// pixels, varying a little by device) past which 2D operations silently
// fail or return null rather than throwing something catchable — a large or
// non-standard page size at scale 2 can realistically approach that on a
// statement PDF. Scale is capped down rather than left fixed so a big page
// still renders, just at a lower resolution.
const MAX_CANVAS_PIXELS = 4096 * 4096;

async function renderPdfPageToCanvas(page, scale = 2) {
  const nativeViewport = page.getViewport({ scale: 1 });
  const nativePixels = nativeViewport.width * nativeViewport.height;
  const safeScale = nativePixels * scale * scale > MAX_CANVAS_PIXELS
    ? Math.sqrt(MAX_CANVAS_PIXELS / nativePixels)
    : scale;

  const viewport = page.getViewport({ scale: safeScale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext('2d');
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas;
}

/**
 * Read every page, but don't let one bad page sink transactions already
 * read from good ones — a statement generator that trips up pdf.js or
 * Tesseract on, say, its final summary page shouldn't cost the rest.
 */
async function extractPdfText(file, onProgress) {
  const buffer = await withStage('reading the file', () => file.arrayBuffer());
  const pdf = await withStage('opening the PDF', () => getDocument({ data: buffer }).promise);
  const pageTexts = [];
  const pageErrors = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    try {
      const page = await withStage(`reading page ${pageNumber}`, () => pdf.getPage(pageNumber));
      const content = await withStage(`reading text on page ${pageNumber}`, () => page.getTextContent());
      const text = await withStage(`laying out text on page ${pageNumber}`, () => textFromContent(content));

      if (hasUsableTextLayer(text)) {
        pageTexts.push(text);
      } else {
        // No text layer on this page — it's a scan. Render it and OCR the
        // image rather than giving up on the whole statement over one page.
        const canvas = await withStage(`rendering page ${pageNumber} for OCR`, () => renderPdfPageToCanvas(page));
        const ocrText = await withStage(`recognising text on page ${pageNumber}`, () => ocrSource(canvas, onProgress));
        pageTexts.push(ocrText);
      }
    } catch (error) {
      if (error instanceof OcrUnsupportedError) throw error;
      pageErrors.push({ page: pageNumber, error });
    }
  }

  if (!pageTexts.length && pageErrors.length) {
    // Every page failed — the first failure's stage is as good a place as
    // any to point at, and better than a blanket "couldn't read this file".
    throw pageErrors[0].error;
  }

  return { text: pageTexts.join('\n'), pageErrors };
}

const PDF_TYPES = ['application/pdf'];

/**
 * Pull raw text out of an uploaded statement file. A PDF is read directly
 * where it has a text layer; anything else — a photo, a screenshot, a
 * scanned PDF page — goes through OCR.
 *
 * `pageErrors` is non-empty when some (not all) pages failed — the caller
 * can still show whatever rows the good pages produced, with a warning
 * naming which pages and why, rather than discarding a partly-good result.
 */
export async function extractStatementText(file, { onProgress } = {}) {
  const isPdf = PDF_TYPES.includes(file.type) || /\.pdf$/i.test(file.name || '');
  if (isPdf) {
    const { text, pageErrors } = await extractPdfText(file, onProgress);
    return { text, method: 'pdf', pageErrors };
  }
  const text = await withStage('recognising the image', () => ocrSource(file, onProgress));
  return { text, method: 'ocr', pageErrors: [] };
}
