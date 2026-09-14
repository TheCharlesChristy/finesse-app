import { useEffect, useMemo, useState } from 'react';

import { applyAppearance, normaliseAppearance, resolveTheme, syncThemeColor, writeAppearanceMirror } from './appearance.js';

/**
 * Applies the user's appearance to <html> and reports which theme it resolved
 * to — identical in Finesse and Finesse Fit.
 *
 * `ready` exists because the profile (or settings) row arrives a tick after the
 * first render. Until it does, whatever the boot script in index.html painted
 * is the best answer available, and overwriting it with the defaults would
 * produce exactly the flash of the wrong theme the boot script exists to
 * prevent.
 *
 * The effect keys on a serialised copy rather than the object itself: the row
 * comes from a live query and is a new object on every render, so an object
 * identity dependency would re-apply and re-write the mirror on every keystroke
 * anywhere in the app.
 */
export function useAppearance(appearance, mirrorKey, ready = true) {
  const settings = useMemo(() => normaliseAppearance(appearance), [appearance]);
  const key = useMemo(() => JSON.stringify(settings), [settings]);
  const [theme, setTheme] = useState(() => (typeof document === 'undefined' ? 'dark' : document.documentElement.dataset.theme || 'dark'));

  useEffect(() => {
    if (!ready) return undefined;
    const current = JSON.parse(key);
    const media = window.matchMedia?.('(prefers-color-scheme: light)');
    const apply = () => {
      setTheme(applyAppearance(document.documentElement, current, resolveTheme(current.themeMode, media)));
      syncThemeColor();
      writeAppearanceMirror(mirrorKey, current);
    };
    apply();
    // Only a "system" choice has to keep listening; a fixed choice is answered.
    if (current.themeMode !== 'system' || !media) return undefined;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [ready, key, mirrorKey]);

  return theme;
}
