import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { addDays, addMonths, addWeeks, eachDayOfInterval, endOfMonth, endOfWeek, format, isSameDay, isSameMonth, startOfMonth, startOfWeek, subMonths } from 'date-fns';
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';

function parseValue(value) {
  if (!value) return new Date();
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export default function DateInput({ value, onChange, label = 'Date', disabled = false }) {
  const [open, setOpen] = useState(false);
  const [viewDate, setViewDate] = useState(() => parseValue(value));
  const [focusedDate, setFocusedDate] = useState(() => parseValue(value));
  const triggerRef = useRef(null);
  const popoverRef = useRef(null);
  const gridRef = useRef(null);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 300 });
  const selectedDate = useMemo(() => parseValue(value), [value]);
  const labelId = useId();

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
    if (!open) setViewDate(selectedDate);
  }, [selectedDate, open]);

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

  // Keep month view in sync with the keyboard cursor and move DOM focus to it.
  useEffect(() => {
    if (!open) return;
    if (!isSameMonth(focusedDate, viewDate)) setViewDate(startOfMonth(focusedDate));
    const el = gridRef.current?.querySelector(`[data-date="${format(focusedDate, 'yyyy-MM-dd')}"]`);
    el?.focus();
  }, [open, focusedDate, viewDate]);

  const days = useMemo(() => {
    const start = startOfWeek(startOfMonth(viewDate), { weekStartsOn: 1 });
    const end = endOfWeek(endOfMonth(viewDate), { weekStartsOn: 1 });
    return eachDayOfInterval({ start, end });
  }, [viewDate]);

  const openPicker = () => {
    updatePosition();
    setFocusedDate(selectedDate);
    setViewDate(startOfMonth(selectedDate));
    setOpen(true);
  };

  const closePicker = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const chooseDate = (date) => {
    onChange(format(date, 'yyyy-MM-dd'));
    setOpen(false);
    triggerRef.current?.focus();
  };

  const moveMonth = (amount) => {
    const shift = amount < 0 ? subMonths : addMonths;
    setViewDate(date => shift(date, 1));
    setFocusedDate(date => shift(date, 1));
  };

  const handleGridKeyDown = (e) => {
    switch (e.key) {
      case 'ArrowLeft': e.preventDefault(); setFocusedDate(d => addDays(d, -1)); break;
      case 'ArrowRight': e.preventDefault(); setFocusedDate(d => addDays(d, 1)); break;
      case 'ArrowUp': e.preventDefault(); setFocusedDate(d => addWeeks(d, -1)); break;
      case 'ArrowDown': e.preventDefault(); setFocusedDate(d => addWeeks(d, 1)); break;
      case 'Home': e.preventDefault(); setFocusedDate(d => startOfWeek(d, { weekStartsOn: 1 })); break;
      case 'End': e.preventDefault(); setFocusedDate(d => endOfWeek(d, { weekStartsOn: 1 })); break;
      case 'PageUp': e.preventDefault(); setFocusedDate(d => subMonths(d, 1)); break;
      case 'PageDown': e.preventDefault(); setFocusedDate(d => addMonths(d, 1)); break;
      case 'Enter':
      case ' ': e.preventDefault(); chooseDate(focusedDate); break;
      case 'Escape': e.preventDefault(); closePicker(); break;
      default: break;
    }
  };

  return (
    <div style={{ position: 'relative' }}>
      {label !== null && (
        <label id={labelId} className="field-label">{label}</label>
      )}
      <button
        ref={triggerRef}
        type="button"
        className="glass-input date-input-trigger"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label || 'Date'}: ${format(selectedDate, 'd MMMM yyyy')}`}
        onClick={() => (open ? setOpen(false) : openPicker())}
      >
        <CalendarDays size={14} color="var(--accent-blue)" />
        <span>{format(selectedDate, 'd MMM yyyy')}</span>
      </button>

      {open && createPortal(
        <div
          ref={popoverRef}
          className="date-picker-popover"
          role="dialog"
          aria-modal="false"
          aria-label="Choose date"
          style={{ position: 'fixed', top: position.top, left: position.left, width: position.width, right: 'auto', zIndex: 500 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 12 }}>
            <button type="button" className="btn-icon" onClick={() => moveMonth(-1)}
              style={{ width: 30, height: 30 }} aria-label="Previous month" title="Previous month">
              <ChevronLeft size={14} />
            </button>
            <div aria-live="polite" style={{ fontSize: 13, fontWeight: 700 }}>{format(viewDate, 'MMMM yyyy')}</div>
            <button type="button" className="btn-icon" onClick={() => moveMonth(1)}
              style={{ width: 30, height: 30 }} aria-label="Next month" title="Next month">
              <ChevronRight size={14} />
            </button>
          </div>

          <div className="date-picker-weekdays" aria-hidden="true">
            {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, index) => (
              <div key={`${day}-${index}`}>{day}</div>
            ))}
          </div>
          <div className="date-picker-grid" ref={gridRef} role="grid" aria-label="Calendar" onKeyDown={handleGridKeyDown}>
            {days.map(day => {
              const selected = isSameDay(day, selectedDate);
              const inMonth = isSameMonth(day, viewDate);
              const isFocusTarget = isSameDay(day, focusedDate);
              return (
                <button
                  key={day.toISOString()}
                  type="button"
                  data-date={format(day, 'yyyy-MM-dd')}
                  tabIndex={isFocusTarget ? 0 : -1}
                  aria-label={format(day, 'EEEE d MMMM yyyy')}
                  aria-pressed={selected}
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
