import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { addMonths, eachDayOfInterval, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, startOfMonth, startOfWeek, subMonths } from 'date-fns';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';

function parseValue(value) {
  if (!value) return new Date();
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export default function DateInput({ value, onChange, label = 'Date', disabled = false }) {
  const [open, setOpen] = useState(false);
  const [viewDate, setViewDate] = useState(() => parseValue(value));
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 300 });
  const selectedDate = useMemo(() => parseValue(value), [value]);

  const updatePosition = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const width = Math.min(300, window.innerWidth - 24);
    const left = Math.min(Math.max(12, rect.left), window.innerWidth - width - 12);
    const belowTop = rect.bottom + 6;
    const aboveTop = rect.top - 318;
    const top = belowTop + 318 > window.innerHeight && aboveTop > 12 ? aboveTop : belowTop;
    setPosition({ top, left, width });
  };

  useEffect(() => {
    setViewDate(selectedDate);
  }, [selectedDate]);

  useEffect(() => {
    const handleClick = (event) => {
      if (triggerRef.current?.contains(event.target) || popoverRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open]);

  const days = useMemo(() => {
    const start = startOfWeek(startOfMonth(viewDate), { weekStartsOn: 1 });
    const end = endOfWeek(endOfMonth(viewDate), { weekStartsOn: 1 });
    return eachDayOfInterval({ start, end });
  }, [viewDate]);

  const chooseDate = (date) => {
    onChange(format(date, 'yyyy-MM-dd'));
    setOpen(false);
  };

  return (
    <div style={{ position: 'relative' }}>
      {label !== null && (
        <label style={{ fontSize: 12, color: 'var(--text-muted)', display: 'block', marginBottom: 6 }}>{label}</label>
      )}
      <button
        ref={triggerRef}
        type="button"
        className="glass-input date-input-trigger"
        disabled={disabled}
        onClick={() => {
          updatePosition();
          setOpen(current => !current);
        }}
      >
        <CalendarDays size={14} color="var(--accent-blue)" />
        <span>{format(selectedDate, 'd MMM yyyy')}</span>
      </button>

      {open && createPortal(
        <div
          ref={popoverRef}
          className="date-picker-popover"
          style={{ position: 'fixed', top: position.top, left: position.left, width: position.width, right: 'auto', zIndex: 500 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
            <button type="button" className="btn-icon" onClick={() => setViewDate(date => subMonths(date, 1))}
              style={{ width: 30, height: 30 }} title="Previous month">
              <ChevronLeft size={14} />
            </button>
            <div style={{ fontSize: 13, fontWeight: 700 }}>{format(viewDate, 'MMMM yyyy')}</div>
            <button type="button" className="btn-icon" onClick={() => setViewDate(date => addMonths(date, 1))}
              style={{ width: 30, height: 30 }} title="Next month">
              <ChevronRight size={14} />
            </button>
          </div>

          <div className="date-picker-weekdays">
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, index) => (
              <div key={`${day}-${index}`}>{day}</div>
            ))}
          </div>
          <div className="date-picker-grid">
            {days.map(day => {
              const selected = isSameDay(day, selectedDate);
              const inMonth = isSameMonth(day, viewDate);
              return (
                <button
                  key={day.toISOString()}
                  type="button"
                  className={`date-picker-day${selected ? ' selected' : ''}${inMonth ? '' : ' muted'}`}
                  onClick={() => chooseDate(day)}
                >
                  {format(day, 'd')}
                </button>
              );
            })}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
