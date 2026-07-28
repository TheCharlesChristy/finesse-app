import { Plus } from 'lucide-react';

/**
 * Always-reachable "log an expense" button.
 *
 * Logging a spend is the one thing a user does every day, and it previously
 * required navigating to the Dashboard or Transactions first. This floats above
 * every view on small screens; on desktop the keyboard shortcut covers it.
 */
export default function QuickAdd({ onClick, templates = [], onLogTemplate }) {
  return (
    <div className="quick-add">
      {templates.length > 0 && (
        <div className="quick-add-templates">
          {templates.slice(0, 3).map(template => (
            <button
              key={template.id}
              type="button"
              className="quick-add-template"
              onClick={() => onLogTemplate(template.id)}
              title={`Log ${template.name}`}
            >
              {template.name}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        className="quick-add-button"
        onClick={onClick}
        aria-label="Log an expense"
        title="Log an expense (A)"
      >
        <Plus size={22} aria-hidden="true" />
      </button>
    </div>
  );
}
