/**
 * Which build this device is running.
 *
 * The three constants are replaced at build time by Vite's `define` (see
 * vite.config.js). They exist so Settings can answer "is the change I just
 * merged actually on my phone, or is Safari still serving a cached build?" —
 * package.json's version never moves, so the commit and the build time are the
 * parts that actually identify a build.
 *
 * The `typeof` guards keep this importable anywhere the defines aren't applied
 * (Vitest runs from vitest.config.js, which has no `define`). Vite substitutes
 * the literal before the check runs, so nothing is lost in a real build.
 */

export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';
export const APP_COMMIT = typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : 'dev';
export const APP_BUILT_AT = typeof __APP_BUILT_AT__ === 'string' ? __APP_BUILT_AT__ : null;

/** Build timestamp as a short local string, or null if it wasn't injected. */
export function formatBuiltAt(iso = APP_BUILT_AT) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}
