import { useEffect, useRef, useState } from 'react';
import { AlertCircle, AlertTriangle, Bell, Info, X } from 'lucide-react';

const ICONS = {
  danger: AlertCircle,
  warn: AlertTriangle,
  info: Info,
};

const COLORS = {
  danger: 'var(--danger)',
  warn: 'var(--warn)',
  info: 'var(--accent-blue)',
};

/**
 * Everything the app wants to tell you, in one place.
 *
 * Finesse previously said nothing unless you went looking: an overdue
 * subscription, an unfunded category or a months-old backup would sit there
 * indefinitely. This surfaces them without interrupting.
 */
export default function NudgeCenter({ nudges = [], onDismiss, onNavigate }) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef(null);
  const buttonRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    const handlePointerDown = (event) => {
      if (panelRef.current?.contains(event.target) || buttonRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const urgent = nudges.filter(nudge => nudge.severity !== 'info').length;

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button
        ref={buttonRef}
        type="button"
        className="btn-icon"
        aria-label={nudges.length ? `${nudges.length} notifications` : 'No notifications'}
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
        style={{ width: 38, height: 38, position: 'relative' }}
      >
        <Bell size={16} aria-hidden="true" />
        {nudges.length > 0 && (
          <span aria-hidden="true" style={{
            position: 'absolute', top: 4, right: 4,
            minWidth: 15, height: 15, padding: '0 4px',
            borderRadius: 8, fontSize: 9, fontWeight: 700, lineHeight: '15px',
            background: urgent > 0 ? 'var(--danger)' : 'var(--accent-blue)',
            color: '#06121f',
          }}>
            {nudges.length}
          </span>
        )}
      </button>

      {open && (
        <div ref={panelRef} className="nudge-panel" role="dialog" aria-label="Notifications">
          <div className="nudge-panel-header">
            <span style={{ fontSize: 13, fontWeight: 700 }}>
              {nudges.length > 0 ? `${nudges.length} thing${nudges.length === 1 ? '' : 's'} to look at` : 'All clear'}
            </span>
            <button type="button" className="btn-icon" aria-label="Close notifications"
              onClick={() => setOpen(false)} style={{ width: 26, height: 26 }}>
              <X size={12} />
            </button>
          </div>

          {nudges.length === 0 ? (
            <div style={{ padding: '24px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>
              Nothing needs your attention.
            </div>
          ) : (
            <div className="nudge-panel-list">
              {nudges.map(nudge => {
                const Icon = ICONS[nudge.severity] || Info;
                return (
                  <div key={nudge.id} className="nudge-item">
                    <Icon size={14} aria-hidden="true" style={{ color: COLORS[nudge.severity], flexShrink: 0, marginTop: 2 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <button
                        type="button"
                        onClick={() => { onNavigate?.(nudge); setOpen(false); }}
                        style={{
                          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                          textAlign: 'left', fontFamily: 'DM Sans, sans-serif',
                          fontSize: 13, fontWeight: 600, color: 'var(--text-primary)',
                        }}>
                        {nudge.title}
                      </button>
                      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.5 }}>
                        {nudge.body}
                      </div>
                    </div>
                    <button type="button" className="btn-icon" aria-label={`Dismiss: ${nudge.title}`}
                      onClick={() => onDismiss(nudge)} style={{ width: 24, height: 24, flexShrink: 0 }}>
                      <X size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
