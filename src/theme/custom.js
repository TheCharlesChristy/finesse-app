/**
 * The custom palette — four knobs, an unlimited number of usable themes.
 *
 * A colour picker per accent role is the obvious design and the wrong one: four
 * free colours give a user four chances to pick something illegible, and no way
 * to tell before they have committed to it. What matters about an accent here is
 * not its exact colour but the two jobs it has to do — carry meaning against the
 * page, and carry text on top of itself — and both of those are *lightness*
 * questions before they are hue questions.
 *
 * So the knobs are hue (what colour), harmony (how the other three relate to
 * it), intensity (how saturated) and tint (how much of the hue bleeds into the
 * page and its surfaces), and every colour is built in OKLCH at a lightness this
 * file chooses. OKLCH's L is perceptual, so a fixed L is a fixed contrast
 * whatever the hue: the accents land at the same readable distance from the
 * background at hue 20 as at hue 200, which is exactly what per-channel RGB
 * pickers cannot promise. `--on-accent` is then picked from the accent's own
 * lightness rather than guessed.
 *
 * The browser gamut-maps `oklch()` for us, so an intensity the display cannot
 * reach degrades to the nearest colour it can rather than clipping a channel.
 */

export const HARMONIES = [
  { id: 'analogous',     name: 'Analogous',     description: 'Neighbouring hues — calm and cohesive', offsets: [0, 36, -32, 72] },
  { id: 'complementary', name: 'Complementary', description: 'Opposite hues — high contrast between roles', offsets: [0, 178, 150, 34] },
  { id: 'triadic',       name: 'Triadic',       description: 'Three evenly spaced hues — lively', offsets: [0, 122, 242, 62] },
  { id: 'mono',          name: 'Monochrome',    description: 'One hue at four lightnesses — quiet', offsets: [0, 0, 0, 0], mono: true },
];

export const INTENSITIES = [
  { id: 'muted',    name: 'Muted',    factor: 0.55 },
  { id: 'balanced', name: 'Balanced', factor: 1 },
  { id: 'vivid',    name: 'Vivid',    factor: 1.4 },
];

export const DEFAULT_CUSTOM = { hue: 168, harmony: 'analogous', intensity: 'balanced', tint: 0.5 };

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const wrapHue = (hue) => ((hue % 360) + 360) % 360;
const round = (value, places = 4) => Number(value.toFixed(places));

/** `oklch(L C H)` — L as a 0–1 number, C absolute, H in degrees. */
const oklch = (l, c, h) => `oklch(${round(clamp(l, 0, 1), 4)} ${round(Math.max(0, c), 4)} ${round(wrapHue(h), 2)})`;

export function normaliseCustom(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const harmony = HARMONIES.some((item) => item.id === source.harmony) ? source.harmony : DEFAULT_CUSTOM.harmony;
  const intensity = INTENSITIES.some((item) => item.id === source.intensity) ? source.intensity : DEFAULT_CUSTOM.intensity;
  const hue = Number.isFinite(Number(source.hue)) ? wrapHue(Number(source.hue)) : DEFAULT_CUSTOM.hue;
  const tint = Number.isFinite(Number(source.tint)) ? clamp(Number(source.tint), 0, 1) : DEFAULT_CUSTOM.tint;
  return { hue, harmony, intensity, tint };
}

/*
 * The lightness ladders. Dark mode puts the accents well above the page and
 * light mode well below it; the numbers are the same distance from the
 * background in both directions, which is why a palette does not change
 * character when the user flips the mode.
 *
 * `roles` are [accent, accent-2, accent-3, accent-4]. accent-4 is the highlight
 * (personal records, reference lines) so it sits brightest in dark mode and is
 * the only role allowed to read as "louder" than the primary.
 */
const RAMPS = {
  dark: {
    bg: { l: 0.168, c: [0.004, 0.030] },
    roles: [
      { l: 0.800, c: 0.150 },
      { l: 0.762, c: 0.132 },
      { l: 0.740, c: 0.140 },
      { l: 0.845, c: 0.140 },
    ],
    monoRoles: [
      { l: 0.880, c: 0.030 },
      { l: 0.740, c: 0.026 },
      { l: 0.620, c: 0.022 },
      { l: 0.930, c: 0.038 },
    ],
  },
  light: {
    bg: { l: 0.962, c: [0.002, 0.018] },
    roles: [
      { l: 0.520, c: 0.165 },
      { l: 0.505, c: 0.150 },
      { l: 0.480, c: 0.160 },
      { l: 0.545, c: 0.150 },
    ],
    monoRoles: [
      { l: 0.300, c: 0.028 },
      { l: 0.430, c: 0.024 },
      { l: 0.560, c: 0.020 },
      { l: 0.250, c: 0.034 },
    ],
  },
};

/** Text that sits *on* an accent fill: dark ink on a light accent, and vice versa. */
const onAccent = (lightness, hue) => (lightness >= 0.62 ? oklch(0.16, 0.035, hue) : oklch(0.99, 0.008, hue));

/**
 * The six palette tokens for one mode. Returned as a plain object of custom
 * property names so callers can write it onto an element, mirror it to storage,
 * or paint a preview swatch with it — all from the same source.
 */
export function customPaletteVars(custom, theme) {
  const { hue, harmony, intensity, tint } = normaliseCustom(custom);
  const ramp = RAMPS[theme === 'light' ? 'light' : 'dark'];
  const spec = HARMONIES.find((item) => item.id === harmony) ?? HARMONIES[0];
  const factor = (INTENSITIES.find((item) => item.id === intensity) ?? INTENSITIES[1]).factor;
  const roles = spec.mono ? ramp.monoRoles : ramp.roles;

  const [bgMinChroma, bgMaxChroma] = ramp.bg.c;
  const accents = roles.map((role, index) => {
    const roleHue = spec.mono ? hue : hue + (spec.offsets[index] ?? 0);
    return { value: oklch(role.l, role.c * factor, roleHue), lightness: role.l };
  });

  return {
    '--bg': oklch(ramp.bg.l, (bgMinChroma + (bgMaxChroma - bgMinChroma) * tint) * (spec.mono ? 0.5 : 1), hue),
    '--accent': accents[0].value,
    '--accent-2': accents[1].value,
    '--accent-3': accents[2].value,
    '--accent-4': accents[3].value,
    '--on-accent': onAccent(accents[0].lightness, hue),
  };
}

/** Both modes at once — what gets mirrored to storage for the pre-paint boot script. */
export const customPaletteModes = (custom) => ({
  dark: customPaletteVars(custom, 'dark'),
  light: customPaletteVars(custom, 'light'),
});

/** A human-readable name for the current custom settings, for the picker's trigger. */
export function describeCustom(custom) {
  const { hue, harmony } = normaliseCustom(custom);
  const names = [
    [15, 'Red'], [45, 'Orange'], [75, 'Amber'], [105, 'Lime'], [145, 'Green'],
    [175, 'Teal'], [205, 'Cyan'], [240, 'Blue'], [275, 'Indigo'], [305, 'Violet'],
    [335, 'Magenta'], [360, 'Red'],
  ];
  const name = names.find(([limit]) => hue < limit)?.[1] ?? 'Red';
  const shape = HARMONIES.find((item) => item.id === harmony)?.name ?? '';
  return `${name} · ${shape}`;
}
