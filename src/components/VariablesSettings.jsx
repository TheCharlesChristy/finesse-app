import { useState } from 'react';
import { Check, Pencil, SlidersHorizontal, Trash2, X } from 'lucide-react';

import { fmt } from '../utils';
import { CardTitle, IconButton } from './ui';

const codeStyle = {
  fontFamily: 'monospace', background: 'rgba(79,255,176,0.1)',
  color: 'var(--accent-mint)', padding: '1px 6px', borderRadius: 5,
};

/**
 * Named values for category allowance formulas, as a Settings section.
 *
 * This was its own nav entry, which was a page for a feature most accounts use
 * two or three of. It is configuration — the same shape as the auto-categorise
 * rules and quick expenses it now sits beside — so it lives where the rest of
 * the configuration does, following `EncryptionSettings` in being a card
 * Settings renders rather than a view of its own.
 */
export default function VariablesSettings({ variables = [], onAddVariable, onUpdateVariable, onDeleteVariable }) {
  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editValue, setEditValue] = useState('');

  const handleAdd = () => {
    if (!newName.trim() || newValue === '') return;
    onAddVariable?.({ name: newName.trim(), value: parseFloat(newValue) || 0 });
    setNewName('');
    setNewValue('');
  };

  const startEdit = (variable) => {
    setEditingId(variable.id);
    setEditName(variable.name);
    setEditValue(String(variable.value));
  };

  const commitEdit = () => {
    if (!editName.trim()) return;
    onUpdateVariable?.(editingId, { name: editName.trim(), value: parseFloat(editValue) || 0 });
    setEditingId(null);
  };

  return (
    <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '24px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
        <SlidersHorizontal size={16} color="var(--accent-mint)" aria-hidden="true" />
        <CardTitle as="h2">Variables</CardTitle>
      </div>
      <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 14, lineHeight: 1.7 }}>
        Named values you can reference in category allowance formulas with{' '}
        <span style={codeStyle}>$name</span>. Set{' '}
        <span style={codeStyle}>$salary = 2500</span>, use{' '}
        <span style={codeStyle}>$salary * 0.2</span> as an allowance, and it follows the
        variable whenever you change it. Letters, numbers and underscores only — no spaces.
      </div>

      {variables.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
          {variables.map(variable => (
            editingId === variable.id ? (
              <div key={variable.id} className="mobile-row-stack"
                style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input className="glass-input" value={editName} aria-label="Variable name"
                  onChange={e => setEditName(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
                  style={{ flex: 2 }}
                  onKeyDown={e => e.key === 'Enter' && commitEdit()} />
                <input className="glass-input" type="number" step="0.01" value={editValue} aria-label="Variable value"
                  onChange={e => setEditValue(e.target.value)}
                  style={{ flex: 1 }}
                  onKeyDown={e => e.key === 'Enter' && commitEdit()} />
                <div className="mobile-list-actions" style={{ display: 'flex', gap: 8 }}>
                  <IconButton onClick={commitEdit} label="Save variable"><Check size={13} /></IconButton>
                  <IconButton onClick={() => setEditingId(null)} label="Cancel editing"><X size={13} /></IconButton>
                </div>
              </div>
            ) : (
              <div key={variable.id} className="mobile-list-row" style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '10px 12px', background: 'rgba(255,255,255,0.04)', borderRadius: 10,
              }}>
                <span className="mobile-list-main" style={{
                  ...codeStyle, fontSize: 13, flex: 1, minWidth: 0,
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>
                  ${variable.name}
                </span>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>
                  {fmt(variable.value)}
                </span>
                <IconButton onClick={() => startEdit(variable)} size={28} style={{ opacity: 0.6 }}
                  label={`Edit $${variable.name}`}>
                  <Pencil size={12} />
                </IconButton>
                <IconButton onClick={() => onDeleteVariable?.(variable.id)} size={28} style={{ opacity: 0.55 }}
                  label={`Delete $${variable.name}`}>
                  <Trash2 size={12} />
                </IconButton>
              </div>
            )
          ))}
        </div>
      )}

      <div className="mobile-row-stack" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div style={{ flex: '2 1 160px' }}>
          <label htmlFor="new-variable-name" className="field-label">Name</label>
          <input id="new-variable-name" className="glass-input" placeholder="e.g. salary"
            value={newName}
            onChange={e => setNewName(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
            onKeyDown={e => e.key === 'Enter' && handleAdd()} />
        </div>
        <div style={{ flex: '1 1 120px' }}>
          <label htmlFor="new-variable-value" className="field-label">Value (£)</label>
          <input id="new-variable-value" className="glass-input" type="number" step="0.01" placeholder="2500"
            value={newValue}
            onChange={e => setNewValue(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()} />
        </div>
        <button className="btn-primary mobile-full" onClick={handleAdd}
          style={{ flexShrink: 0 }}
          disabled={!newName.trim() || newValue === ''}>
          Add Variable
        </button>
      </div>
    </div>
  );
}
