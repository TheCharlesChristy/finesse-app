/**
 * The one genuinely testable piece of ocr.js: the ReadableStream async-
 * iterator polyfill. Everything else in that file is Tesseract/pdf.js
 * orchestration, but this specific gap is exactly what cost real debugging
 * time to track down — see the comment above it in ocr.js.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { polyfillReadableStreamAsyncIterator } from '../ocr';

describe('polyfillReadableStreamAsyncIterator', () => {
  const before = ReadableStream.prototype[Symbol.asyncIterator];
  afterEach(() => {
    if (before) ReadableStream.prototype[Symbol.asyncIterator] = before;
    else delete ReadableStream.prototype[Symbol.asyncIterator];
  });

  it('leaves an existing implementation alone', () => {
    const marker = () => 'not touched';
    ReadableStream.prototype[Symbol.asyncIterator] = marker;
    polyfillReadableStreamAsyncIterator();
    expect(ReadableStream.prototype[Symbol.asyncIterator]).toBe(marker);
  });

  it('adds a working async iterator when the native one is missing — the exact gap pdf.js hits', async () => {
    delete ReadableStream.prototype[Symbol.asyncIterator];
    polyfillReadableStreamAsyncIterator();

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue('a');
        controller.enqueue('b');
        controller.close();
      },
    });

    // This is pdf.js's own line, verbatim (pdf.mjs, getTextContent): the
    // real bug was `for await` over a stream whose prototype had no
    // Symbol.asyncIterator at all, which throws before the loop body ever
    // runs — not something a value-level assertion on the stream can catch.
    const seen = [];
    for await (const value of stream) seen.push(value);
    expect(seen).toEqual(['a', 'b']);
  });
});
