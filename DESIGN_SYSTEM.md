# The Finesse Design System

One design system, two apps. This file is **identical in `finesse-app` and
`finesse-fit`**, and so is everything it describes: the token layers in
`src/index.css` above the app-specific marker, `src/theme/`,
`src/components/ui.jsx`, `src/components/AppShell.jsx` and
`src/components/AppearanceSettings.jsx`.

If you change any of those in one repository, copy the change to the other in
the same commit. They are not "similar" files; they are the same file.

---

## The one rule

**No component ever names a colour, a radius, or a spacing value.**

A view that writes `#4fffb0` has opted itself out of eleven palettes, two
schemes, three surface finishes and the high-contrast setting in one keystroke,
and nothing will tell you it happened — it will simply look wrong in ten of the
sixty-six combinations and right in the one you were looking at.

Use a token, or a `color-mix()` of one. The same goes for `borderRadius: 18`,
which quietly ignores the corner-style setting, and for a hard-coded `16px` gap,
which ignores density.

The one exception is genuine *data*: a category's colour in Finesse is chosen by
the user and stored on the row. Even there the swatch list offers token
references (`var(--accent-2)`) rather than hex, so a category keeps its role in
the palette rather than a fixed colour.

---

## Token layers

Seven layers on `<html>`, each answering exactly one question, each driven by one
`data-*` attribute that `theme/appearance.js` writes.

| Layer | Attribute | What it decides |
|---|---|---|
| 1. Structure | — | Radii, spacing, control sizes, motion timings |
| 2. Palette | `data-palette` | `--bg` and the four accent roles |
| 3. Mode | `data-theme` | Surfaces, lines, text, status colours |
| 4. Surface | `data-surface` | How a card is *painted* — the finish |
| 5. Contrast | `data-contrast` | How hard edges and text push |
| 6. Density | `data-density` | How much air |
| 7. Shape & type | `data-corners`, `data-text`, `data-motion` | Roundness, type scale, animation |

### The accent roles are semantic

Keep these straight or charts and progress bars stop agreeing with each other
across palettes:

- `--accent` — primary action, active state, "on track"
- `--accent-2` — the second data series
- `--accent-3` — the third
- `--accent-4` — highlight: personal records, reference lines, "look here"

`--good` / `--warn` / `--danger` / `--info` are **not** palette colours. They
mean something, and they mean the same thing in every palette.

### Surfaces are mixed from the palette

`--surface`, `--surface-2`, `--surface-hover` and the rest are `color-mix()`ed
from `--bg`, not fixed greys. That is what makes eleven palettes feel like
eleven designs rather than one design with the buttons repainted: Ember's cards
are warm, Cobalt's are cold, and neither needed a line of CSS to say so.

### Three finishes, one card

`.card` reads five tokens — `--card-bg`, `--card-border`, `--card-shadow`,
`--card-blur`, `--card-bg-2` — and each `[data-surface]` block writes them:

- **Islands** — solid surface, hairline border, soft shadow. The default.
- **Glass** — translucent surface over a palette-built gradient mesh, with a
  `backdrop-filter`. This is the finance app's original look, kept as a setting.
- **Outline** — page-coloured, strong border, no shadow, no compositing.

Nothing below that line knows which finish is active, which is how two apps with
opposite visual languages became one app with a preference.

**Glass has one trap.** An element with a `backdrop-filter` becomes the
containing block for `position: fixed` descendants. Any popover positioned by
script must therefore render through `Portal` from `ui.jsx`, or it will anchor
to the card that opened it — silently, and only under that one setting.

---

## The custom palette

`theme/custom.js` builds a palette from four knobs — hue, harmony, intensity and
background tint — in OKLCH, at lightnesses this file chooses.

A colour picker per accent role would be the obvious design and the wrong one:
four free colours give a user four chances to pick something illegible and no way
to know before committing. What matters about an accent is not its exact colour
but the two jobs it does — carry meaning against the page, carry text on top of
itself — and both are *lightness* questions before they are hue questions.
OKLCH's L is perceptual, so a fixed L is a fixed contrast whatever the hue.

The custom palette is the one thing with no CSS block. `applyAppearance` writes
its six tokens onto `<html>` as inline custom properties and **clears them again
when a curated palette is chosen** — a stale inline `--accent` outranks every
`[data-palette]` block forever.

### Adding a curated palette

1. Add both token blocks to `index.css` — dark and light. Check `--on-accent`
   against `--accent`: it is the text that sits on every primary button.
2. Add `{ id, name, description }` to `theme/palettes.js`.
3. There is no step three. The picker renders swatches by scoping
   `data-palette` / `data-theme` / `data-surface` onto the tile and reading the
   real tokens back out, so a swatch can never drift from the palette it claims
   to show.

All three attributes have to be scoped together. Custom properties are
substituted at computed-value time, so a tile setting only `data-palette` still
inherits `--card-bg` with the *current* palette's background baked into it.

---

## Storage

The appearance object lives in each app's own database — the profile row in Fit,
the account's settings row in Finesse — and is **mirrored** to one small
localStorage key so the boot script in `index.html` can paint before React
loads. The mirror is a cache of a decision, never the decision itself.

The mirror carries the *resolved* custom-palette tokens for both schemes rather
than the four knobs, so the boot script stays a dozen lines instead of a second
copy of the OKLCH generator that could fall out of step with the first.

---

## Layout

- **1100px** — two-column pages fold to one.
- **860px** — the sidebar becomes a floating bottom tab bar; dialogs become
  sheets. This is the *navigation* breakpoint.
- **700px** — inline content rows stack (Finesse's `.mobile-*` helpers). A
  filter row that stacks the moment the sidebar disappears wastes the width a
  tablet still has.
- **430px** — the narrowest phone in use.

The shell is `AppShell`: a persistent rail on a desktop, a floating tab bar on a
phone. Not a drawer — a navigation you have to summon costs a tap before every
move and hides how many places there are to go.

The tab bar takes at most five slots, which is not a stylistic limit: below about
64px a target stops being reliably hittable with a thumb, and six slots on the
narrowest phone lands under that. Extra entries go to the "More" sheet.

---

## Non-negotiables

- **44px minimum touch target.** Density scales control sizes, but
  `@media (pointer: coarse)` floors them. A missed tap is a defect, not a
  preference.
- **A visible focus ring on everything.** One ring, drawn in the accent, so it is
  always visible against the surface the palette generated.
- **One scroll container per screen.** The dialog scrolls, or the page does —
  never both. A scroll box inside a scroll box on a phone swallows the gesture.
- **Reduced motion is honoured** from the OS *and* from the app's own setting.
- **Every empty state says what is missing and what to do about it.** For most
  features it is the first screen anyone sees.
- **16px minimum on form controls.** iOS Safari zooms the page below that and
  offers no way back.

---

## Components

`src/components/ui.jsx` — `Modal`, `Field`, `IconButton`, `CardTitle`,
`PageHeader`, `Card`, `Stat`, `StatGrid`, `Meter`, `Banner`, `SearchInput`,
`EmptyState`, `Segmented`, `Tabs`, `OverflowMenu`, `Listbox`, `Portal`.

Reach for one of these before writing a `<div style={{ display: 'flex' }}>`. A
flex row written inline is a rule nobody can restyle.

### Dialogs

`Modal` puts actions in `footer`, outside the scrolling body, which is what keeps
Save reachable on a form long enough to scroll. A footer outside the body is also
outside the `<form>`, so `footer` may be a function and is handed the form's id:

```jsx
<Modal title="Add food" onSubmit={save} footer={({ formId }) => (
  <>
    <span className="spacer" />
    <button className="btn-secondary" type="button" onClick={onClose}>Cancel</button>
    <button className="btn-primary" type="submit" form={formId}>Save</button>
  </>
)}>
```

---

## Testing it

`theme.test.js` (both repos) covers the model: normalisation, the legacy
migration, what `applyAppearance` writes and clears, and the OKLCH ramps.

What it cannot cover is whether the attributes it writes are *answered* by a
stylesheet. A palette whose CSS block was never written, or a finish whose
tokens nothing reads, passes every unit test and paints exactly the same page.
That is what the appearance step in `scripts/smoke.mjs` (finance) is for: it
drives a real browser and asserts that the painted `--accent`, the painted
`--bg` and a real card's `box-shadow` actually change.
