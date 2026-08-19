/**
 * Service worker registration, plus the manual "Update app" path in Settings.
 *
 * Imported for its side effect by main.jsx: importing this module registers the
 * worker. `registerType: 'autoUpdate'` means a new worker installs, skips
 * waiting and reloads the page on its own — but only once the browser has
 * bothered to re-fetch the worker, which on an installed iOS home-screen app
 * can be a long time. The hourly poll below narrows that window; `updateApp()`
 * closes it on demand, for "I just merged something, is it on my phone yet?".
 *
 * There is no service worker at all in `npm run dev`, so every export here
 * degrades to a result the UI can explain rather than throwing.
 */
import { registerSW } from 'virtual:pwa-register';

const POLL_INTERVAL_MS = 60 * 60 * 1000;
// A new worker that never activates shouldn't hang the button forever.
const ACTIVATION_TIMEOUT_MS = 15000;

let swRegistration = null;
let updatePending = false;

function serviceWorkerSupported() {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

/**
 * Whether a worker is currently serving this page.
 *
 * The distinction matters everywhere below: an uncontrolled page (first run, or
 * a hard reload) came straight from the network, so it can't be stale — and the
 * `installing` worker it has is a first install, not an update.
 */
function controlled() {
  return serviceWorkerSupported() && Boolean(navigator.serviceWorker.controller);
}

function track(registration) {
  swRegistration = registration;
  if (controlled() && (registration.waiting || registration.installing)) updatePending = true;
  registration.addEventListener('updatefound', () => { if (controlled()) updatePending = true; });
}

registerSW({
  onRegisteredSW(swUrl, registration) {
    if (!registration) return;
    track(registration);
    setInterval(() => {
      if (!navigator.onLine || registration.installing) return;
      fetch(swUrl, { cache: 'no-store', headers: { 'cache-control': 'no-cache' } })
        .then(r => { if (r?.status === 200) registration.update(); })
        .catch(() => {});
    }, POLL_INTERVAL_MS);
  },
});

/** True when a newer worker has been seen and is waiting to take over. */
export function isUpdatePending() {
  if (!controlled()) return false;
  return updatePending || Boolean(swRegistration?.waiting || swRegistration?.installing);
}

async function getRegistration() {
  if (swRegistration) return swRegistration;
  if (!serviceWorkerSupported()) return null;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration) track(registration);
    return registration ?? null;
  } catch {
    return null;
  }
}

function waitForActivation(worker) {
  return new Promise(resolve => {
    if (worker.state === 'activated') return resolve();
    const finish = () => {
      clearTimeout(timer);
      worker.removeEventListener('statechange', onStateChange);
      resolve();
    };
    const onStateChange = () => {
      if (worker.state === 'activated' || worker.state === 'redundant') finish();
    };
    const timer = setTimeout(finish, ACTIVATION_TIMEOUT_MS);
    worker.addEventListener('statechange', onStateChange);
  });
}

/**
 * Force a check for a new build.
 *
 * Resolves to `{ status }`, where status is one of:
 *   'updated'      — a new worker was found; the page is reloading
 *   'current'      — already on the latest build
 *   'unregistered' — no worker registered yet (normal in dev, or pre-install)
 *   'unsupported'  — the browser has no service workers
 *   'error'        — the check failed, usually because the device is offline
 */
export async function updateApp() {
  if (!serviceWorkerSupported()) return { status: 'unsupported' };

  const registration = await getRegistration();
  if (!registration) return { status: 'unregistered' };

  if (!controlled()) {
    // Nothing is serving this page from cache, so it is already the newest
    // build. Still kick the worker along so the *next* load has it.
    registration.update().catch(() => {});
    updatePending = false;
    return { status: 'current' };
  }

  // `update()` can resolve after a skip-waiting worker has already taken over,
  // leaving nothing in `installing`/`waiting` to look at — so watch the event
  // as well, or a real update gets reported as "you're up to date".
  let found = Boolean(registration.waiting || registration.installing);
  const onUpdateFound = () => { found = true; };
  registration.addEventListener('updatefound', onUpdateFound);
  try {
    await registration.update();
  } catch {
    return { status: 'error' };
  } finally {
    registration.removeEventListener('updatefound', onUpdateFound);
  }

  const worker = registration.installing || registration.waiting;
  if (!worker && !found) {
    updatePending = false;
    return { status: 'current' };
  }

  updatePending = true;
  if (worker) {
    // autoUpdate builds ship skipWaiting, so this is belt-and-braces for a
    // worker that stalls in `waiting` anyway.
    if (worker.state === 'installed') worker.postMessage({ type: 'SKIP_WAITING' });
    await waitForActivation(worker);
  }
  window.location.reload();
  return { status: 'updated' };
}
