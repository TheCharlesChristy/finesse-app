import { useState } from 'react';
import { Pencil, Trash2, Check, X } from 'lucide-react';
import { fmt } from '../utils';

export default function Variables({ variables, onAddVariable, onUpdateVariable, onDeleteVariable }) {
  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editValue, setEditValue] = useState('');

  const handleAdd = () => {
    if (!newName.trim() || newValue === '') return;
    onAddVariable({ name: newName.trim(), value: parseFloat(newValue) || 0 });
    setNewName('');
    setNewValue('');
  };

  const startEdit = (v) => {
    setEditingId(v.id);
    setEditName(v.name);
    setEditValue(String(v.value));
  };

  const commitEdit = () => {
    if (!editName.trim()) return;
    onUpdateVariable(editingId, { name: editName.trim(), value: parseFloat(editValue) || 0 });
    setEditingId(null);
  };

  const codeStyle = {
    fontFamily: 'monospace', background: 'rgba(79,255,176,0.1)',
    color: 'var(--accent-mint)', padding: '1px 6px', borderRadius: 5,
  };

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Intro */}
      <div className="glass" style={{ borderRadius: 18, padding: '22px 24px' }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>Variables</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 13, lineHeight: 1.7 }}>
          Define named values you can reference in category allowance formulas using{' '}
          <span style={codeStyle}>$varName</span>.{' '}
          For example, set <span style={codeStyle}>$salary = 2500</span> then use{' '}
          <span style={codeStyle}>$salary * 0.2</span> as a category allowance — it updates automatically when you change the variable.
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 10, lineHeight: 1.6 }}>
          Variable names: letters, numbers, and underscores only. No spaces.
        </div>
      </div>

      {/* Variable list + add form */}
      <div className="glass" style={{ borderRadius: 18, padding: '22px 24px' }}>
        {variables.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 14, textAlign: 'center', padding: '16px 0 20px' }}>
            No variables yet — add one below
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 20 }}>
            {variables.map(v => (
              editingId === v.id ? (
                <div key={v.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '8px 0' }}>
                  <input className="glass-input" value={editName}
                    onChange={e => setEditName(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
                    style={{ flex: 2 }}
                    onKeyDown={e => e.key === 'Enter' && commitEdit()} />
                  <input className="glass-input" type="number" step="0.01" value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    style={{ flex: 1 }}
                    onKeyDown={e => e.key === 'Enter' && commitEdit()} />
                  <button className="btn-icon" onClick={commitEdit} title="Save"><Check size={13} /></button>
                  <button className="btn-icon" onClick={() => setEditingId(null)} title="Cancel"><X size={13} /></button>
                </div>
              ) : (
                <div key={v.id} style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '12px 14px', background: 'rgba(255,255,255,0.04)', borderRadius: 12,
                }}>
                  <span style={{ ...codeStyle, fontSize: 13, flex: 1 }}>${v.name}</span>
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-secondary)' }}>
                    {fmt(v.value)}
                  </span>
                  <button className="btn-icon" onClick={() => startEdit(v)}
                    style={{ width: 28, height: 28, opacity: 0.6 }} title="Edit">
                    <Pencil size={12} />
                  </button>
                  <button className="btn-icon" onClick={() => onDeleteVariable(v.id)}
                    style={{ width: 28, height: 28, opacity: 0.5 }} title="Delete">
                    <Trash2 size={13} />
                  </button>
                </div>
              )
            ))}
          </div>
        )}

        {/* Add form */}
        <div style={{ borderTop: variables.length > 0 ? '1px solid rgba(255,255,255,0.06)' : 'none', paddingTop: variables.length > 0 ? 18 : 0 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
            Add Variable
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <div style={{ flex: '2 1 160px' }}>
              <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 5 }}>Name</label>
              <input className="glass-input" placeholder="e.g. salary"
                value={newName}
                onChange={e => setNewName(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
                onKeyDown={e => e.key === 'Enter' && handleAdd()} />
            </div>
            <div style={{ flex: '1 1 120px' }}>
              <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 5 }}>Value (£)</label>
              <input className="glass-input" type="number" step="0.01" placeholder="e.g. 2500"
                value={newValue}
                onChange={e => setNewValue(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAdd()} />
            </div>
            <button className="btn-primary" onClick={handleAdd}
              style={{ flexShrink: 0 }}
              disabled={!newName.trim() || newValue === ''}>
              Add
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
