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
  info: 'var(--accent-2)',
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
        className="btn-icon nudge-trigger"
        aria-label={nudges.length ? `${nudges.length} notifications` : 'No notifications'}
        aria-expanded={open}
        onClick={() => setOpen(value => !value)}
      >
        <Bell size={16} aria-hidden="true" />
        {nudges.length > 0 && (
          <span aria-hidden="true" style={{
            position: 'absolute', top: 4, right: 4,
            minWidth: 15, height: 15, padding: '0 4px',
            borderRadius: 'var(--radius-xs)', fontSize: 9, fontWeight: 700, lineHeight: '15px',
            background: urgent > 0 ? 'var(--danger)' : 'var(--accent-2)',
            color: 'var(--on-accent)',
          }}>
            {nudges.length}
          </span>
        )}
      </button>

      {open && (
        <div ref={panelRef} className="nudge-panel card-raised" role="dialog" aria-label="Notifications">
          <div className="nudge-panel-header">
            <span className="nudge-panel-title">
              {nudges.length > 0 ? `${nudges.length} thing${nudges.length === 1 ? '' : 's'} to look at` : 'All clear'}
            </span>
            <button type="button" className="btn-icon btn-sm btn-icon-quiet nudge-dismiss" aria-label="Close notifications"
              onClick={() => setOpen(false)}>
              <X size={14} />
            </button>
          </div>

          {nudges.length === 0 ? (
            <div className="nudge-empty">
              Nothing needs your attention.
            </div>
          ) : (
            <div className="nudge-panel-list">
              {nudges.map(nudge => {
                const Icon = ICONS[nudge.severity] || Info;
                return (
                  <div key={nudge.id} className="nudge-item">
                    <Icon size={14} aria-hidden="true" style={{ color: COLORS[nudge.severity], flexShrink: 0, marginTop: 2 }} />
                    <div className="nudge-copy">
                      <button
                        type="button"
                        className="nudge-title"
                        onClick={() => { onNavigate?.(nudge); setOpen(false); }}
                      >
                        {nudge.title}
                      </button>
                      <div className="nudge-body">
                        {nudge.body}
                      </div>
                    </div>
                    <button type="button" className="btn-icon btn-sm btn-icon-quiet nudge-dismiss" aria-label={`Dismiss: ${nudge.title}`}
                      onClick={() => onDismiss(nudge)}>
                      <X size={14} />
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
