import { Contrast, Monitor, Moon, Paintbrush, Sun, Type } from 'lucide-react';

import { Card, Field, Segmented } from './ui.jsx';
import { PALETTES, CUSTOM_PALETTE_ID } from '../theme/palettes.js';
import { HARMONIES, INTENSITIES, customPaletteVars, describeCustom } from '../theme/custom.js';
import { CONTRASTS, CORNERS, DENSITIES, MOTIONS, normaliseAppearance, SURFACES, TEXT_SCALES } from '../theme/appearance.js';

/**
 * The appearance panel — identical in Finesse and Finesse Fit.
 *
 * Every preview here is the real thing at a fifth of the size. A palette tile
 * is a card, a background and four accents rendered by scoping
 * `data-palette` / `data-theme` / `data-surface` onto the tile and letting the
 * cascade answer; a surface tile does the same with the finish. Nothing on this
 * screen holds a copy of a colour, which is the only way a picker can be
 * guaranteed to show what the setting will actually do.
 *
 * All three attributes have to be scoped together. Custom properties are
 * substituted at computed-value time, so a tile that set only `data-palette`
 * would still inherit `--card-bg` with the *current* palette's background
 * already baked into it, and every tile would preview the same card.
 */

function Preview({ palette, theme, surface, vars }) {
  return (
    <span
      className="theme-preview"
      data-palette={palette}
      data-theme={theme}
      data-surface={surface}
      style={vars}
      aria-hidden="true"
    >
      <span className="theme-preview-mesh" />
      <span className="theme-preview-card">
        <span className="theme-preview-bar" />
        <span className="theme-preview-dot" />
        <span className="theme-preview-dot three" />
        <span className="theme-preview-dot four" />
      </span>
    </span>
  );
}

function OptionTile({ active, name, note, onSelect, children }) {
  return (
    <button type="button" className="theme-card" aria-pressed={active} onClick={onSelect}>
      {children}
      <span className="theme-card-name">{name}</span>
      {note && <span className="theme-card-note">{note}</span>}
    </button>
  );
}

/** A plain choice with no preview — density, corners, text size, motion. */
function ChoiceRow({ label, hint, options, value, onChange }) {
  return (
    <Field label={label} hint={hint}>
      <div className="chip-row" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={value === option.id}
            className={`chip ${value === option.id ? 'active' : ''}`.trim()}
            onClick={() => onChange(option.id)}
          >
            {option.name}
          </button>
        ))}
      </div>
    </Field>
  );
}

const ROLE_COPY = [
  ['--accent', 'Primary', 'Actions, the current page, on-track progress'],
  ['--accent-2', 'Secondary', 'The second series on every chart'],
  ['--accent-3', 'Tertiary', 'The third series'],
  ['--accent-4', 'Highlight', 'Records, reference lines, "look here"'],
];

export default function AppearanceSettings({ appearance: stored, onChange, theme }) {
  // Normalised here rather than trusted from the caller: this panel is handed a
  // row straight out of the database in both apps, and a row written before the
  // appearance model existed has none of these fields.
  const appearance = normaliseAppearance(stored);
  const custom = appearance.palette === CUSTOM_PALETTE_ID;
  const customVars = customPaletteVars(appearance.custom, theme);
  const patch = (changes) => onChange(changes);

  return (
    <>
      <Card title="Theme" icon={theme === 'light' ? Sun : Moon}>
        <Segmented
          label="Colour scheme"
          value={appearance.themeMode}
          onChange={(themeMode) => patch({ themeMode })}
          options={[
            { value: 'dark', label: 'Dark', icon: <Moon size={15} aria-hidden="true" /> },
            { value: 'system', label: 'System', icon: <Monitor size={15} aria-hidden="true" /> },
            { value: 'light', label: 'Light', icon: <Sun size={15} aria-hidden="true" /> },
          ]}
        />
        <Field
          label="Contrast"
          hint="High contrast strengthens text, borders and separators across every palette — it is a correction applied over your theme, not a theme of its own."
        >
          <div className="chip-row" role="radiogroup" aria-label="Contrast">
            {CONTRASTS.map((option) => (
              <button
                key={option.id}
                type="button"
                role="radio"
                aria-checked={appearance.contrast === option.id}
                className={`chip ${appearance.contrast === option.id ? 'active' : ''}`.trim()}
                onClick={() => patch({ contrast: option.id })}
              >
                <Contrast size={14} aria-hidden="true" />
                {option.name}
              </button>
            ))}
          </div>
        </Field>
      </Card>

      <Card title="Colour" icon={Paintbrush}>
        <p className="field-hint" style={{ margin: 0 }}>
          A palette sets the page and four accent roles. Everything else — surfaces, borders,
          charts, the muscle map — is mixed from them, so one choice repaints the whole app.
        </p>
        <div className="palette-grid">
          {PALETTES.map((item) => (
            <OptionTile
              key={item.id}
              active={appearance.palette === item.id}
              name={item.name}
              note={item.description}
              onSelect={() => patch({ palette: item.id })}
            >
              <Preview palette={item.id} theme={theme} surface={appearance.surface} />
            </OptionTile>
          ))}
          <OptionTile
            active={custom}
            name="Custom"
            note={describeCustom(appearance.custom)}
            onSelect={() => patch({ palette: CUSTOM_PALETTE_ID })}
          >
            <Preview theme={theme} surface={appearance.surface} vars={customVars} />
          </OptionTile>
        </div>

        {custom && (
          <div className="card panel stack">
            <Field
              label={`Hue — ${Math.round(appearance.custom.hue)}°`}
              hint="Everything is built in OKLCH at a lightness chosen for you, so an accent stays equally readable against the page at any hue you land on."
            >
              {(id) => (
                <input
                  id={id}
                  className="hue-slider"
                  type="range"
                  min="0"
                  max="359"
                  step="1"
                  value={appearance.custom.hue}
                  onChange={(event) => patch({ custom: { ...appearance.custom, hue: Number(event.target.value) } })}
                />
              )}
            </Field>

            <ChoiceRow
              label="Harmony"
              hint={HARMONIES.find((item) => item.id === appearance.custom.harmony)?.description}
              options={HARMONIES}
              value={appearance.custom.harmony}
              onChange={(harmony) => patch({ custom: { ...appearance.custom, harmony } })}
            />

            <ChoiceRow
              label="Intensity"
              options={INTENSITIES}
              value={appearance.custom.intensity}
              onChange={(intensity) => patch({ custom: { ...appearance.custom, intensity } })}
            />

            <Field
              label="Background tint"
              hint="How much of the hue bleeds into the page and the surfaces mixed from it — none for a neutral grey, full for a page that is unmistakably the same colour family."
            >
              {(id) => (
                <input
                  id={id}
                  className="tint-slider"
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={Math.round(appearance.custom.tint * 100)}
                  onChange={(event) => patch({ custom: { ...appearance.custom, tint: Number(event.target.value) / 100 } })}
                />
              )}
            </Field>

            <div className="role-legend" style={customVars}>
              <span className="eyebrow">What each role does</span>
              {ROLE_COPY.map(([token, name, note]) => (
                <span className="role-legend-row" key={token}>
                  <i style={{ background: `var(${token})` }} />
                  <strong>{name}</strong>
                  <span className="truncate">{note}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </Card>

      <Card title="Surface" icon={Contrast}>
        <p className="field-hint" style={{ margin: 0 }}>
          How a card is painted. The same tokens drive all three, so every finish works with
          every palette, in both schemes.
        </p>
        <div className="option-grid">
          {SURFACES.map((item) => (
            <OptionTile
              key={item.id}
              active={appearance.surface === item.id}
              name={item.name}
              note={item.description}
              onSelect={() => patch({ surface: item.id })}
            >
              <Preview palette={custom ? undefined : appearance.palette} theme={theme} surface={item.id} vars={custom ? customVars : undefined} />
            </OptionTile>
          ))}
        </div>
      </Card>

      <Card title="Layout & type" icon={Type}>
        <ChoiceRow
          label="Density"
          hint="Scales spacing and control sizes. Touch targets never drop below 44px whatever you pick."
          options={DENSITIES}
          value={appearance.density}
          onChange={(density) => patch({ density })}
        />
        <ChoiceRow
          label="Corners"
          options={CORNERS}
          value={appearance.corners}
          onChange={(corners) => patch({ corners })}
        />
        <ChoiceRow
          label="Text size"
          options={TEXT_SCALES}
          value={appearance.textScale}
          onChange={(textScale) => patch({ textScale })}
        />
        <ChoiceRow
          label="Motion"
          hint="Your device's reduced-motion setting is always honoured; this turns animation off even where the device has not asked for it."
          options={MOTIONS}
          value={appearance.motion}
          onChange={(motion) => patch({ motion })}
        />
      </Card>
    </>
  );
}
