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

/**
 * Notify about nudges not yet sent.
 *
 * Which ids have already been sent is passed in and handed back rather than
 * stored here: it lives in `settings.notifiedNudges` alongside
 * `dismissedNudges`, so all nudge state sits in IndexedDB with everything else
 * and this module stays free of storage concerns.
 *
 * Only `danger` and `warn` are worth interrupting for — an OS notification for
 * "you have unbudgeted income" would train the user to ignore all of them.
 *
 * Returns `{ sent, notifiedIds }`, or null when nothing was sent, so the caller
 * only writes to the database when there's something to record.
 */
export function notifyNudges(nudges = [], { enabled = false, alreadyNotified = [] } = {}) {
  if (!enabled || notificationPermission() !== 'granted') return null;

  const sentSet = new Set(alreadyNotified);
  const worthSending = nudges.filter(
    nudge => nudge.severity !== 'info' && !sentSet.has(nudge.id),
  );
  if (worthSending.length === 0) return null;

  // One combined notification rather than a burst: five separate banners for
  // five overdue subscriptions is a reason to turn notifications off.
  try {
    if (worthSending.length === 1) {
      const [nudge] = worthSending;
      new Notification(nudge.title, { body: nudge.body, tag: nudge.id, icon: 'icons/icon-192.png' });
    } else {
      new Notification(`${worthSending.length} things need a look`, {
        body: worthSending.slice(0, 3).map(nudge => nudge.title).join('\n'),
        tag: 'finesse-digest',
        icon: 'icons/icon-192.png',
      });
    }
  } catch {
    return null;
  }

  return {
    sent: worthSending.length,
    notifiedIds: [...alreadyNotified, ...worthSending.map(nudge => nudge.id)].slice(-MAX_REMEMBERED),
  };
}
