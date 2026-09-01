import { useEffect } from 'react';

/**
 * Freezes the page while an overlay is up.
 *
 * `overflow: hidden` on the body is not enough on iOS: a touch that starts on a
 * dialog which has nothing left to scroll — or nothing to scroll at all — keeps
 * dragging the document behind it, so the modal slides away from under the
 * finger and the buttons at its foot are never where they were a moment ago.
 * Pinning the body at its current offset is the only thing Safari honours.
 *
 * Ref-counted, because these nest: a receipt viewer opened from inside the
 * transaction modal must not hand the page back when it alone closes.
 */
let scrollLocks = 0;
let lockedScrollY = 0;
let lockedStyle = null;

function lockBodyScroll() {
  if (scrollLocks++ > 0) return;
  const { body } = document;
  lockedScrollY = window.scrollY || window.pageYOffset || 0;
  lockedStyle = {
    position: body.style.position,
    top: body.style.top,
    left: body.style.left,
    right: body.style.right,
    width: body.style.width,
    paddingRight: body.style.paddingRight,
  };
  // Removing the document scrollbar would shift every fixed element sideways on
  // a desktop window; hold its width open instead.
  const gutter = window.innerWidth - document.documentElement.clientWidth;
  body.style.position = 'fixed';
  body.style.top = `-${lockedScrollY}px`;
  body.style.left = '0';
  body.style.right = '0';
  body.style.width = '100%';
  if (gutter > 0) body.style.paddingRight = `${gutter}px`;
}

function unlockBodyScroll() {
  scrollLocks = Math.max(0, scrollLocks - 1);
  if (scrollLocks > 0 || !lockedStyle) return;
  Object.assign(document.body.style, lockedStyle);
  lockedStyle = null;
  window.scrollTo(0, lockedScrollY);
}

/** Holds the page still for as long as the calling component is mounted. */
export function useScrollLock() {
  useEffect(() => {
    lockBodyScroll();
    return unlockBodyScroll;
  }, []);
}
