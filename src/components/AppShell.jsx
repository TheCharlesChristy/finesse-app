import { createElement, useEffect, useRef, useState } from 'react';
import { Menu, X } from 'lucide-react';

/**
 * The frame both apps live in — identical in Finesse and Finesse Fit.
 *
 * A persistent rail on a desktop and a floating tab bar on a phone, rather
 * than one drawer serving both. A drawer is a navigation you have to remember
 * exists: it costs a tap before every move, hides how many places there are to
 * go, and puts the app's structure behind a hamburger that tells you nothing.
 * The rail and the tab bar are always showing what the app contains, which is
 * most of what navigation is for.
 *
 * `nav` items are `{ id, label, short, icon, badge }` (`Icon` is accepted too,
 * since that is how the finance app's NAV was already written). `short` is the
 * tab-bar label — "Train" where the rail says "Training", because a five-slot
 * bar at 360px gives each label about six characters before it truncates.
 *
 * The tab bar takes at most five slots. Items flagged `mobile: true` claim them
 * in order; without flags the first four do, and everything left over goes to
 * the "More" sheet. Five is not a stylistic limit — below about 64px a target
 * stops being reliably hittable with a thumb, and six slots on the narrowest
 * phone in use lands under that.
 */
const MAX_TABS = 5;

function NavList({ items, view, onNavigate, onDone }) {
  return (
    <nav className="nav-list" aria-label="Primary">
      {items.map(({ id, label, icon, Icon, badge, key }) => (
        <button
          key={id}
          type="button"
          className={`nav-item ${view === id ? 'active' : ''}`.trim()}
          aria-current={view === id ? 'page' : undefined}
          onClick={() => { onNavigate(id); onDone?.(); }}
        >
          {(icon ?? Icon) && createElement(icon ?? Icon, { size: 18, 'aria-hidden': true })}
          <span className="truncate">{label}</span>
          {badge ? <span className="nav-item-badge">{badge}</span> : null}
          {key && !badge ? <span className="nav-key" aria-hidden="true">{key}</span> : null}
        </button>
      ))}
    </nav>
  );
}

function MobileNav({ nav, view, onNavigate }) {
  const [open, setOpen] = useState(false);
  const sheetRef = useRef(null);
  const moreRef = useRef(null);

  const flagged = nav.filter((item) => item.mobile);
  const primary = (flagged.length ? flagged : nav).slice(0, nav.length > MAX_TABS ? MAX_TABS - 1 : MAX_TABS);
  const overflow = nav.filter((item) => !primary.some((tab) => tab.id === item.id));
  const inOverflow = overflow.some((item) => item.id === view);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
      moreRef.current?.focus();
    };
    const onPointer = (event) => {
      if (!sheetRef.current?.contains(event.target) && !moreRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer);
    sheetRef.current?.querySelector('button')?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer);
    };
  }, [open]);

  return (
    <>
      {open && (
        <>
          <div className="more-scrim" aria-hidden="true" />
          <div className="more-sheet card-raised" ref={sheetRef}>
            <NavList items={overflow} view={view} onNavigate={onNavigate} onDone={() => setOpen(false)} />
          </div>
        </>
      )}
      <nav className="tabbar card-raised" aria-label="Sections">
        {primary.map(({ id, label, short, icon, Icon }) => (
          <button
            key={id}
            type="button"
            className={`tab-item ${view === id && !open ? 'active' : ''}`.trim()}
            aria-current={view === id ? 'page' : undefined}
            onClick={() => { onNavigate(id); setOpen(false); }}
          >
            {(icon ?? Icon) && createElement(icon ?? Icon, { size: 20, 'aria-hidden': true })}
            <span>{short ?? label}</span>
          </button>
        ))}
        {overflow.length > 0 && (
          <button
            ref={moreRef}
            type="button"
            className={`tab-item ${open || inOverflow ? 'active' : ''}`.trim()}
            aria-expanded={open}
            aria-label={open ? 'Close more sections' : 'More sections'}
            onClick={() => setOpen((value) => !value)}
          >
            {open ? <X size={20} aria-hidden="true" /> : <Menu size={20} aria-hidden="true" />}
            <span>More</span>
          </button>
        )}
      </nav>
    </>
  );
}

export default function AppShell({
  nav, view, onNavigate,
  brand, brandTag, brandSub,
  sidebarTop, sidebarFoot,
  children,
}) {
  return (
    <>
      <div className="app-bg" aria-hidden="true" />
      <div className="app">
        <aside className="sidebar card">
          <div className="brand">
            <div className="brand-mark">
              <span className="font-display brand-word">{brand}</span>
              {brandTag && <span className="brand-tag">{brandTag}</span>}
            </div>
            {brandSub && <div className="brand-sub">{brandSub}</div>}
          </div>
          {sidebarTop}
          <NavList items={nav} view={view} onNavigate={onNavigate} />
          {sidebarFoot && <div className="sidebar-foot">{sidebarFoot}</div>}
        </aside>
        <div className="app-main">
          {children}
        </div>
      </div>
      <MobileNav nav={nav} view={view} onNavigate={onNavigate} />
    </>
  );
}
