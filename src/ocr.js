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
 */

import { GlobalWorkerOptions, getDocument } from 'pdfjs-dist';
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

import { hasUsableTextLayer } from './csv';

GlobalWorkerOptions.workerSrc = pdfWorkerSrc;

const ASSET_BASE = `${import.meta.env.BASE_URL}tesseract/`;

let workerPromise = null;

function getOcrWorker(onProgress) {
  if (!workerPromise) {
    workerPromise = import('tesseract.js').then(({ createWorker }) => createWorker('eng', undefined, {
      workerPath: `${ASSET_BASE}worker.min.js`,
      corePath: `${ASSET_BASE}core/tesseract-core-simd-lstm.wasm.js`,
      langPath: `${ASSET_BASE}lang`,
      logger: onProgress,
    })).catch((error) => {
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

async function renderPdfPageToCanvas(page, scale = 2) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext('2d');
  await page.render({ canvasContext: context, viewport }).promise;
  return canvas;
}

async function extractPdfText(file, onProgress) {
  const buffer = await file.arrayBuffer();
  const pdf = await getDocument({ data: buffer }).promise;
  const pageTexts = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items.map(item => item.str).join(' ');

    if (hasUsableTextLayer(text)) {
      pageTexts.push(text);
    } else {
      // No text layer on this page — it's a scan. Render it and OCR the
      // image rather than giving up on the whole statement over one page.
      const canvas = await renderPdfPageToCanvas(page);
      const ocrText = await ocrSource(canvas, onProgress);
      pageTexts.push(ocrText);
    }
  }

  return pageTexts.join('\n');
}

const PDF_TYPES = ['application/pdf'];

/**
 * Pull raw text out of an uploaded statement file. A PDF is read directly
 * where it has a text layer; anything else — a photo, a screenshot, a
 * scanned PDF page — goes through OCR.
 */
export async function extractStatementText(file, { onProgress } = {}) {
  const isPdf = PDF_TYPES.includes(file.type) || /\.pdf$/i.test(file.name || '');
  const text = isPdf ? await extractPdfText(file, onProgress) : await ocrSource(file, onProgress);
  return { text, method: isPdf ? 'pdf' : 'ocr' };
}
