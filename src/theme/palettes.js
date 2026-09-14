/**
 * The curated palette catalogue — shared verbatim by Finesse and Finesse Fit.
 *
 * The *colours* live in `index.css` as `[data-palette="<id>"]` token blocks, one
 * for dark and one for light. This file only names them, so nothing is ever
 * defined twice: the picker's swatches render a palette by scoping
 * `data-palette` + `data-theme` onto the swatch element and reading the real
 * tokens back out, which means a swatch can never drift from the palette it
 * claims to show.
 *
 * `custom` is the exception and is deliberately not in this list — it has no CSS
 * block at all. `theme/custom.js` computes its six tokens in OKLCH and
 * `theme/appearance.js` writes them onto <html> as inline custom properties.
 */
export const PALETTES = [
  { id: 'tide',      name: 'Tide',      description: 'Mint and sky on deep ocean blue' },
  { id: 'mint',      name: 'Glacier',   description: 'Mint and ice blue on graphite navy' },
  { id: 'aurora',    name: 'Aurora',    description: 'Violet and cyan on midnight indigo' },
  { id: 'cobalt',    name: 'Cobalt',    description: 'Azure and indigo on slate' },
  { id: 'evergreen', name: 'Evergreen', description: 'Leaf and lime on forest black' },
  { id: 'ember',     name: 'Ember',     description: 'Coral and amber on warm charcoal' },
  { id: 'marigold',  name: 'Marigold',  description: 'Saffron and olive on burnt umber' },
  { id: 'oxide',     name: 'Oxide',     description: 'Rust and sand on deep clay' },
  { id: 'rose',      name: 'Rosé',      description: 'Rose and peach on plum' },
  { id: 'sakura',    name: 'Sakura',    description: 'Blossom and lilac on mulberry' },
  { id: 'neon',      name: 'Neon',      description: 'Electric cyan and magenta on true black' },
  { id: 'graphite',  name: 'Graphite',  description: 'Monochrome with a single gold accent' },
];

export const CUSTOM_PALETTE_ID = 'custom';

export const DEFAULT_PALETTE = 'tide';

export const paletteExists = (id) => id === CUSTOM_PALETTE_ID || PALETTES.some((palette) => palette.id === id);

export const findPalette = (id) => PALETTES.find((palette) => palette.id === id) ?? null;
