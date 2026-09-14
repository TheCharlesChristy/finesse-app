import { Component } from 'react';

import { isDatabaseClosedError, reopenDatabase } from '../db';
import { updateApp } from '../pwa';

/**
 * The last thing between a thrown error and a blank screen.
 *
 * Finesse had nothing here, and a React tree that throws during render unmounts
 * itself — so every crash looked identical from the outside: the app "just
 * broke", showing white, with no message, no stack and nothing to do but force
 * quit. On a phone with no devtools that is indistinguishable from the site
 * being down, which is exactly how it got reported.
 *
 * Two failures account for almost all of it, and both are recoverable:
 *
 * - **The database connection closed.** iOS Safari does this to a backgrounded
 *   PWA without explanation. Dexie then rejects every read, `useLiveQuery`
 *   re-throws it during render, and the tree goes. `db.js` reopens on `close`,
 *   so this only has to hold the screen and try again.
 * - **A chunk that no longer exists.** A deploy replaces the hashed asset
 *   files, and a page that has been open since before it went out asks for one
 *   by its old name. The answer is to reload onto the new build — once, because
 *   a reload that doesn't fix it must not become a loop.
 *
 * Anything else gets the honest version: what broke, and the stack. The
 * production build writes a hidden sourcemap for precisely this — a trace
 * copied out of here maps back to real source for whoever has the matching
 * `dist`, which is the only debugging channel a home-screen app has.
 */

const RELOAD_FLAG = 'finesse:recovering-from-chunk-error';

/** A dynamic import that 404'd, across the wording of the three engines. */
function isStaleChunkError(error) {
  const text = `${error?.name || ''} ${error?.message || ''}`;
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|ChunkLoadError/i.test(text);
}

export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, retrying: false, updating: false };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Logged as well as rendered: a console a developer can reach still beats
    // a screenshot of a phone.
    console.error('Finesse crashed', error, info?.componentStack);

    if (isStaleChunkError(error)) {
      // One automatic reload, remembered for the session so a build that is
      // genuinely broken shows the message instead of reloading forever.
      let alreadyTried = true;
      try {
        alreadyTried = sessionStorage.getItem(RELOAD_FLAG) === '1';
        if (!alreadyTried) sessionStorage.setItem(RELOAD_FLAG, '1');
      } catch { /* storage blocked: fall through to the manual button */ }
      if (!alreadyTried) {
        window.location.reload();
        return;
      }
    }

    if (isDatabaseClosedError(error)) {
      reopenDatabase().then(reopened => { if (reopened) this.retry(); });
    }
  }

  componentDidMount() {
    // Reaching a render at all means the last reload worked.
    try { sessionStorage.removeItem(RELOAD_FLAG); } catch { /* nothing to clear */ }
  }

  retry = () => {
    this.setState({ error: null, retrying: false, updating: false });
  };

  handleUpdate = async () => {
    this.setState({ updating: true });
    try {
      await updateApp();
    } catch {
      window.location.reload();
    }
  };

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    const closed = isDatabaseClosedError(error);
    const stale = isStaleChunkError(error);

    const headline = closed
      ? 'Finesse lost its connection to your data'
      : stale
        ? 'Finesse has been updated'
        : 'Finesse hit a problem';

    const detail = closed
      ? 'Your browser closed the database, which it sometimes does to an app that has been in the background. Nothing has been lost — reopening usually fixes it.'
      : stale
        ? 'This page was loaded from an older version that is no longer on the server. Reloading picks up the new one.'
        : 'Nothing was written, and your data is untouched. Reloading will usually clear it; if it keeps happening, the details below are what a developer needs.';

    return (
      <>
        <div className="app-bg" aria-hidden="true" />
        {/* `.app-boot` centres a single child, so the column lives inside it
            rather than being imposed on the shared class from here. */}
        <div className="app-boot" role="alert">
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16,
            textAlign: 'center', maxWidth: 520, width: '100%',
          }}>
          <div>
            <div className="font-display" style={{ fontSize: 20, marginBottom: 8 }}>{headline}</div>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6, maxWidth: 420 }}>
              {detail}
            </div>
          </div>

          <div className="form-actions" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
            <button className="btn-primary" type="button" onClick={() => window.location.reload()}>
              Reload Finesse
            </button>
            <button className="btn-secondary" type="button" onClick={this.retry}>
              Try again
            </button>
            <button className="btn-secondary" type="button" onClick={this.handleUpdate} disabled={this.state.updating}>
              {this.state.updating ? 'Checking…' : 'Check for an update'}
            </button>
          </div>

          {/* Kept, not tidied away: with a hidden sourcemap from the matching
              build this maps back to real source, and it is the only thing a
              phone with no devtools can hand over. */}
          <details style={{ maxWidth: 520, width: '100%', textAlign: 'left' }}>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: 'var(--text-muted)' }}>
              Technical details
            </summary>
            <pre style={{
              fontSize: 10, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              color: 'var(--text-muted)', marginTop: 8, maxHeight: 220, overflowY: 'auto',
            }}>
              {String(error?.stack || error?.message || error)}
            </pre>
          </details>
          </div>
        </div>
      </>
    );
  }
}
