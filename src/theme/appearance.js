/**
 * The appearance model — shared verbatim by Finesse and Finesse Fit.
 *
 * Every visual preference the user has is one flat object, and every one of them
 * reaches the page the same way: as a `data-*` attribute on <html> that a block
 * of `index.css` answers. Nothing here knows what a card looks like, and no
 * component reads a preference — a view that wanted to know the current palette
 * in order to pick a colour would be the first crack in a system whose whole
 * point is that colour is decided in one file.
 *
 * The one exception is the custom palette, which has no CSS block to answer it
 * (it is computed, not written down): `applyAppearance` writes its six tokens
 * onto <html> as inline custom properties, which land in exactly the same place
 * in the cascade as a `[data-palette]` block would.
 *
 * Persisted in the app's own database — the profile row in Fit, the settings row
 * in Finesse — and *mirrored* to one small localStorage key so the boot script
 * in index.html can paint the right theme before React loads. The mirror is a
 * cache of a decision, never the decision itself; both apps' rule against
 * putting real data in localStorage is intact.
 */
import { CUSTOM_PALETTE_ID, DEFAULT_PALETTE, paletteExists } from './palettes.js';
import { customPaletteModes, customPaletteVars, DEFAULT_CUSTOM, normaliseCustom } from './custom.js';

export const THEME_MODES = [
  { id: 'dark',   name: 'Dark' },
  { id: 'system', name: 'System' },
  { id: 'light',  name: 'Light' },
];

/**
 * How a surface paints. One token system, three finishes — the reason the two
 * apps could be aligned without either of them losing the look it had.
 */
export const SURFACES = [
  { id: 'islands', name: 'Islands', description: 'Solid cards floating on a plain page' },
  { id: 'glass',   name: 'Glass',   description: 'Frosted translucent panels over a colour mesh' },
  { id: 'outline', name: 'Outline', description: 'Flat and shadowless — maximum contrast, minimum ink' },
];

export const DENSITIES = [
  { id: 'compact', name: 'Compact', description: 'More on screen' },
  { id: 'cosy',    name: 'Cosy',    description: 'The default balance' },
  { id: 'roomy',   name: 'Roomy',   description: 'More breathing room' },
];

export const CORNERS = [
  { id: 'sharp', name: 'Sharp' },
  { id: 'soft',  name: 'Soft' },
  { id: 'round', name: 'Round' },
];

export const CONTRASTS = [
  { id: 'standard', name: 'Standard' },
  { id: 'high',     name: 'High', description: 'Stronger text and borders throughout' },
];

export const TEXT_SCALES = [
  { id: 'sm', name: 'Small' },
  { id: 'md', name: 'Default' },
  { id: 'lg', name: 'Large' },
];

export const MOTIONS = [
  { id: 'system',  name: 'Follow system' },
  { id: 'reduced', name: 'Reduced' },
];

export const DEFAULT_APPEARANCE = {
  themeMode: 'dark',
  palette: DEFAULT_PALETTE,
  custom: DEFAULT_CUSTOM,
  surface: 'islands',
  density: 'cosy',
  corners: 'soft',
  contrast: 'standard',
  textScale: 'md',
  motion: 'system',
};

/** The keys `applyAppearance` maps straight onto a `data-*` attribute. */
const ATTRIBUTES = [
  ['surface',  'surface',  SURFACES],
  ['density',  'density',  DENSITIES],
  ['corners',  'corners',  CORNERS],
  ['contrast', 'contrast', CONTRASTS],
  ['textScale', 'text',    TEXT_SCALES],
  ['motion',   'motion',   MOTIONS],
];

const pick = (options, value, fallback) => (options.some((option) => option.id === value) ? value : fallback);

/** Fill in every field, whatever shape (or vintage) the stored row is. */
export function normaliseAppearance(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const palette = paletteExists(source.palette) ? source.palette : DEFAULT_APPEARANCE.palette;
  return {
    themeMode: pick(THEME_MODES, source.themeMode, DEFAULT_APPEARANCE.themeMode),
    palette,
    custom: normaliseCustom(source.custom),
    surface: pick(SURFACES, source.surface, DEFAULT_APPEARANCE.surface),
    density: pick(DENSITIES, source.density, DEFAULT_APPEARANCE.density),
    corners: pick(CORNERS, source.corners, DEFAULT_APPEARANCE.corners),
    contrast: pick(CONTRASTS, source.contrast, DEFAULT_APPEARANCE.contrast),
    textScale: pick(TEXT_SCALES, source.textScale, DEFAULT_APPEARANCE.textScale),
    motion: pick(MOTIONS, source.motion, DEFAULT_APPEARANCE.motion),
  };
}

/** Which of the two real themes a `themeMode` resolves to right now. */
export function resolveTheme(themeMode, media) {
  if (themeMode === 'light') return 'light';
  if (themeMode === 'dark') return 'dark';
  const query = media ?? (typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: light)') : null);
  return query?.matches ? 'light' : 'dark';
}

/**
 * Paint an appearance onto a root element.
 *
 * Returns the resolved theme so the caller can feed it back to components that
 * legitimately need it (a swatch rendering a *different* palette, for instance).
 */
export function applyAppearance(root, appearance, theme = resolveTheme(appearance?.themeMode)) {
  if (!root) return theme;
  const settings = normaliseAppearance(appearance);
  root.dataset.theme = theme;
  root.dataset.palette = settings.palette;
  for (const [key, attribute, options] of ATTRIBUTES) {
    root.dataset[attribute] = pick(options, settings[key], DEFAULT_APPEARANCE[key]);
  }

  // The custom palette has no stylesheet block; its six tokens are written here
  // instead, and cleared again the moment a curated palette is chosen — a stale
  // inline --accent would otherwise outrank every [data-palette] block forever.
  const vars = settings.palette === CUSTOM_PALETTE_ID ? customPaletteVars(settings.custom, theme) : null;
  for (const name of ['--bg', '--accent', '--accent-2', '--accent-3', '--accent-4', '--on-accent']) {
    if (vars) root.style.setProperty(name, vars[name]);
    else root.style.removeProperty(name);
  }
  return theme;
}

/** Keep the browser chrome (iOS status bar, Android toolbar) on the page colour. */
export function syncThemeColor(root = document.documentElement) {
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
  if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
}

/**
 * The pre-paint mirror.
 *
 * It carries the *resolved* custom-palette tokens for both modes rather than the
 * four knobs, so the boot script in index.html stays a dozen lines of attribute
 * setting and never has to contain a second copy of the OKLCH generator that
 * could fall out of step with this one.
 */
export function appearanceMirror(appearance) {
  const settings = normaliseAppearance(appearance);
  return {
    themeMode: settings.themeMode,
    palette: settings.palette,
    surface: settings.surface,
    density: settings.density,
    corners: settings.corners,
    contrast: settings.contrast,
    text: settings.textScale,
    motion: settings.motion,
    vars: settings.palette === CUSTOM_PALETTE_ID ? customPaletteModes(settings.custom) : null,
  };
}

export function writeAppearanceMirror(key, appearance) {
  try {
    localStorage.setItem(key, JSON.stringify(appearanceMirror(appearance)));
  } catch { /* private mode or storage disabled — the CSS defaults still paint */ }
}
