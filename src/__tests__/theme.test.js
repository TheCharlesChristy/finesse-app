import { describe, expect, it } from 'vitest';

import {
  appearanceMirror, applyAppearance, DEFAULT_APPEARANCE, normaliseAppearance, resolveTheme,
} from '../theme/appearance';
import { customPaletteVars, describeCustom, HARMONIES, normaliseCustom } from '../theme/custom';
import { CUSTOM_PALETTE_ID, PALETTES, paletteExists } from '../theme/palettes';

/**
 * A stand-in for <html>. Testing against this rather than jsdom keeps the suite
 * dependency-free and, more usefully, asserts on exactly what `applyAppearance`
 * is contracted to touch: a set of data attributes and six custom properties.
 */
function fakeRoot() {
  const props = new Map();
  return {
    dataset: {},
    style: {
      setProperty: (name, value) => props.set(name, value),
      removeProperty: (name) => props.delete(name),
    },
    props,
  };
}

describe('normaliseAppearance', () => {
  it('fills every field from an empty object', () => {
    expect(normaliseAppearance({})).toEqual(DEFAULT_APPEARANCE);
    expect(normaliseAppearance(undefined)).toEqual(DEFAULT_APPEARANCE);
  });

  it('rejects values that no CSS block answers', () => {
    const result = normaliseAppearance({ palette: 'chartreuse', surface: 'frosted', density: 'huge' });
    expect(result.palette).toBe(DEFAULT_APPEARANCE.palette);
    expect(result.surface).toBe(DEFAULT_APPEARANCE.surface);
    expect(result.density).toBe(DEFAULT_APPEARANCE.density);
  });

  it('keeps every valid value', () => {
    const chosen = {
      themeMode: 'light', palette: 'ember', surface: 'glass', density: 'compact',
      corners: 'sharp', contrast: 'high', textScale: 'lg', motion: 'reduced',
    };
    expect(normaliseAppearance(chosen)).toMatchObject(chosen);
  });

  // The migration path: a profile saved before the appearance model existed.
  it('reads a legacy flat themeMode/palette pair', () => {
    const result = normaliseAppearance({ themeMode: 'light', palette: 'mint' });
    expect(result.themeMode).toBe('light');
    expect(result.palette).toBe('mint');
    expect(result.surface).toBe(DEFAULT_APPEARANCE.surface);
  });

  it('accepts the custom palette, which has no CSS block of its own', () => {
    expect(paletteExists(CUSTOM_PALETTE_ID)).toBe(true);
    expect(normaliseAppearance({ palette: CUSTOM_PALETTE_ID }).palette).toBe(CUSTOM_PALETTE_ID);
  });

  it('every catalogued palette is accepted', () => {
    for (const palette of PALETTES) expect(normaliseAppearance({ palette: palette.id }).palette).toBe(palette.id);
  });
});

describe('resolveTheme', () => {
  it('answers a fixed choice without asking the device', () => {
    expect(resolveTheme('dark', null)).toBe('dark');
    expect(resolveTheme('light', null)).toBe('light');
  });

  it('follows the media query only for "system"', () => {
    expect(resolveTheme('system', { matches: true })).toBe('light');
    expect(resolveTheme('system', { matches: false })).toBe('dark');
    expect(resolveTheme('dark', { matches: true })).toBe('dark');
  });
});

describe('applyAppearance', () => {
  it('writes one data attribute per preference', () => {
    const root = fakeRoot();
    applyAppearance(root, { palette: 'ember', surface: 'glass', density: 'roomy', corners: 'round', contrast: 'high', textScale: 'lg', motion: 'reduced' }, 'light');
    expect(root.dataset).toEqual({
      theme: 'light', palette: 'ember', surface: 'glass', density: 'roomy',
      corners: 'round', contrast: 'high', text: 'lg', motion: 'reduced',
    });
  });

  it('leaves no inline palette tokens for a curated palette', () => {
    const root = fakeRoot();
    applyAppearance(root, { palette: 'aurora' }, 'dark');
    expect(root.props.size).toBe(0);
  });

  it('writes the six tokens for the custom palette', () => {
    const root = fakeRoot();
    applyAppearance(root, { palette: CUSTOM_PALETTE_ID, custom: { hue: 200 } }, 'dark');
    expect([...root.props.keys()].sort()).toEqual(['--accent', '--accent-2', '--accent-3', '--accent-4', '--bg', '--on-accent']);
  });

  /*
   * The bug this exists to stop: an inline `--accent` left behind by the custom
   * palette outranks every `[data-palette]` block, so switching back to a
   * curated palette would change the attribute and nothing else.
   */
  it('clears the inline tokens when switching back to a curated palette', () => {
    const root = fakeRoot();
    applyAppearance(root, { palette: CUSTOM_PALETTE_ID, custom: { hue: 200 } }, 'dark');
    expect(root.props.size).toBe(6);
    applyAppearance(root, { palette: 'tide' }, 'dark');
    expect(root.props.size).toBe(0);
  });

  it('returns the theme it resolved to', () => {
    expect(applyAppearance(fakeRoot(), { themeMode: 'light' }, 'light')).toBe('light');
  });
});

describe('appearanceMirror', () => {
  it('carries only attributes for a curated palette', () => {
    const mirror = appearanceMirror({ palette: 'cobalt', surface: 'outline' });
    expect(mirror.vars).toBeNull();
    expect(mirror).toMatchObject({ palette: 'cobalt', surface: 'outline', text: 'md' });
  });

  // The boot script cannot compute OKLCH, so both modes ride along resolved.
  it('carries both modes resolved for the custom palette', () => {
    const mirror = appearanceMirror({ palette: CUSTOM_PALETTE_ID, custom: { hue: 90 } });
    expect(Object.keys(mirror.vars)).toEqual(['dark', 'light']);
    expect(mirror.vars.dark['--bg']).not.toBe(mirror.vars.light['--bg']);
  });
});

describe('customPaletteVars', () => {
  const at = (custom, theme = 'dark') => customPaletteVars(custom, theme);

  it('produces all six tokens as oklch()', () => {
    const vars = at({ hue: 168 });
    expect(Object.keys(vars)).toHaveLength(6);
    for (const value of Object.values(vars)) expect(value).toMatch(/^oklch\(/);
  });

  it('puts the accents above the page in dark mode and below it in light', () => {
    const lightness = (value) => Number(value.match(/oklch\(([\d.]+)/)[1]);
    const dark = at({ hue: 168 }, 'dark');
    const light = at({ hue: 168 }, 'light');
    expect(lightness(dark['--accent'])).toBeGreaterThan(lightness(dark['--bg']));
    expect(lightness(light['--accent'])).toBeLessThan(lightness(light['--bg']));
  });

  // The whole point of choosing lightness rather than letting the user: text on
  // an accent fill has to be readable whichever way round the pair lands.
  it('flips --on-accent with the accent it sits on', () => {
    const lightness = (value) => Number(value.match(/oklch\(([\d.]+)/)[1]);
    expect(lightness(at({ hue: 30 }, 'dark')['--on-accent'])).toBeLessThan(0.3);
    expect(lightness(at({ hue: 30 }, 'light')['--on-accent'])).toBeGreaterThan(0.9);
  });

  it('spreads the accent roles across hues, except in monochrome', () => {
    const hues = (vars) => ['--accent', '--accent-2', '--accent-3', '--accent-4'].map((k) => vars[k].match(/([\d.]+)\)$/)[1]);
    expect(new Set(hues(at({ hue: 200, harmony: 'triadic' }))).size).toBe(4);
    expect(new Set(hues(at({ hue: 200, harmony: 'mono' }))).size).toBe(1);
  });

  it('separates the monochrome roles by lightness instead', () => {
    const lights = (vars) => ['--accent', '--accent-2', '--accent-3', '--accent-4'].map((k) => vars[k].match(/oklch\(([\d.]+)/)[1]);
    expect(new Set(lights(at({ hue: 200, harmony: 'mono' }))).size).toBe(4);
  });

  it('scales chroma with intensity', () => {
    const chroma = (vars) => Number(vars['--accent'].split(' ')[1]);
    expect(chroma(at({ hue: 200, intensity: 'muted' }))).toBeLessThan(chroma(at({ hue: 200, intensity: 'balanced' })));
    expect(chroma(at({ hue: 200, intensity: 'vivid' }))).toBeGreaterThan(chroma(at({ hue: 200, intensity: 'balanced' })));
  });

  it('tints the page background by the tint knob alone', () => {
    const chroma = (vars) => Number(vars['--bg'].split(' ')[1]);
    expect(chroma(at({ hue: 200, tint: 0 }))).toBeLessThan(chroma(at({ hue: 200, tint: 1 })));
  });

  it('wraps a hue past 360 rather than clamping it', () => {
    expect(normaliseCustom({ hue: 380 }).hue).toBe(20);
    expect(normaliseCustom({ hue: -20 }).hue).toBe(340);
  });

  it('names every harmony it offers', () => {
    for (const harmony of HARMONIES) expect(describeCustom({ hue: 168, harmony: harmony.id })).toContain(harmony.name);
  });
});
