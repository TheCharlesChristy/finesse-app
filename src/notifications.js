/**
 * Opt-in OS notifications for high-severity nudges.
 *
 * Finesse has no backend, and iOS only delivers notifications to an installed
 * home-screen app with no reliable background scheduling. So this cannot wake
 * you up — it fires when the app is opened or regains focus, which makes it an
 * enhancement to the in-app nudge centre rather than a replacement for it.
 *
 * Everything here degrades to a no-op where the API is unavailable, and
 * permission is only ever requested from an explicit user action in Settings —
 * never on load, where an unprompted permission dialog is just noise.
 */

const STORAGE_KEY = 'finesse.notifiedNudges';
const MAX_REMEMBERED = 200;

export function notificationsSupported() {
  return typeof window !== 'undefined' && 'Notification' in window;
}

export function notificationPermission() {
  if (!notificationsSupported()) return 'unsupported';
  return Notification.permission;
}

/** Request permission. Must be called from a user gesture to work on iOS. */
export async function requestNotificationPermission() {
  if (!notificationsSupported()) return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

// Which nudges have already been sent. This is presentation bookkeeping, not
// finance data, so localStorage is the right home for it — IndexedDB is
// reserved for the things that matter.
function loadNotified() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveNotified(ids) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids.slice(-MAX_REMEMBERED)));
  } catch {
    // Storage can be full or blocked; failing to remember just risks a repeat.
  }
}

/**
 * Notify about nudges not yet sent.
 *
 * Only `danger` and `warn` are worth interrupting for — an OS notification for
 * "you have unbudgeted income" would train the user to ignore all of them.
 * Returns how many were sent.
 */
export function notifyNudges(nudges = [], { enabled = false } = {}) {
  if (!enabled || notificationPermission() !== 'granted') return 0;

  const alreadySent = new Set(loadNotified());
  const worthSending = nudges.filter(
    nudge => nudge.severity !== 'info' && !alreadySent.has(nudge.id),
  );
  if (worthSending.length === 0) return 0;

  const sentIds = [...alreadySent];

  // One combined notification rather than a burst: five separate banners for
  // five overdue subscriptions is a reason to turn notifications off.
  if (worthSending.length === 1) {
    const [nudge] = worthSending;
    try {
      new Notification(nudge.title, { body: nudge.body, tag: nudge.id, icon: 'icons/icon-192.png' });
    } catch {
      return 0;
    }
  } else {
    try {
      new Notification(`${worthSending.length} things need a look`, {
        body: worthSending.slice(0, 3).map(nudge => nudge.title).join('\n'),
        tag: 'finesse-digest',
        icon: 'icons/icon-192.png',
      });
    } catch {
      return 0;
    }
  }

  for (const nudge of worthSending) sentIds.push(nudge.id);
  saveNotified(sentIds);
  return worthSending.length;
}
