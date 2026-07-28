import { useState } from 'react';
import { Modal } from '../ui';
import { EXPORT_COMPUTED_SECTIONS, buildDefaultExportSelection } from '../../db';

// ── Import Mode Modal ────────────────────────────────────────────────────────
export function ImportModeModal({ onConfirm, onClose }) {
  return (
    <Modal title="Import Data" subtitle="How should the imported data be handled?" onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <button className="btn-primary" onClick={() => onConfirm('replace')} style={{ textAlign: 'left', padding: '14px 16px' }}>
          <div style={{ fontWeight: 600, marginBottom: 3 }}>Replace everything</div>
          <div style={{ fontSize: 12, opacity: 0.7, fontWeight: 400 }}>Clears all current data and replaces with the backup. Best for syncing from another device.</div>
        </button>
        <button className="btn-secondary" onClick={() => onConfirm('merge')} style={{ textAlign: 'left', padding: '14px 16px' }}>
          <div style={{ fontWeight: 600, marginBottom: 3 }}>Merge</div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Adds imported items alongside existing data. May create duplicates.</div>
        </button>
        <button className="btn-secondary" onClick={onClose}>Cancel</button>
      </div>
    </Modal>
  );
}

// ── Export Chat Summary Options Modal ────────────────────────────────────────
const EXPORT_TABLE_LABELS = {
  categories: 'Categories & Budgets',
  transactions: 'Transactions',
  incomes: 'Incomes',
  incomeEvents: 'Income Events',
  subscriptions: 'Subscriptions',
  wishlist: 'Wishlist',
  wishlistCategories: 'Wishlist Lists',
  variables: 'Variables',
  accountTransfers: 'Account Transfers',
};

function humanizeFieldKey(key) {
  const spaced = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function ExportChatSummaryOptionsModal({ schema, onConfirm, onClose }) {
  const [selection, setSelection] = useState(() => buildDefaultExportSelection(schema));

  const toggleField = (table, key) => {
    setSelection(prev => {
      const current = prev.tables[table] || [];
      const next = current.includes(key) ? current.filter(k => k !== key) : [...current, key];
      return { ...prev, tables: { ...prev.tables, [table]: next } };
    });
  };

  const toggleTable = (table, allKeys) => {
    setSelection(prev => {
      const current = prev.tables[table] || [];
      const next = current.length === allKeys.length ? [] : allKeys;
      return { ...prev, tables: { ...prev.tables, [table]: next } };
    });
  };

  const toggleComputed = (key) => {
    setSelection(prev => {
      const has = prev.computed.includes(key);
      return { ...prev, computed: has ? prev.computed.filter(k => k !== key) : [...prev.computed, key] };
    });
  };

  const tableEntries = Object.entries(schema || {}).filter(([, fields]) => fields.length > 0);

  return (
    <Modal title="Chat Summary Export"
      subtitle="Choose what to include. Free-text fields are unchecked by default since they may contain personal detail."
      onClose={onClose}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18, maxHeight: '55vh', overflowY: 'auto', paddingRight: 4 }}>
        {tableEntries.map(([table, fields]) => {
          const allKeys = fields.map(f => f.key);
          const selected = selection.tables[table] || [];
          const allSelected = selected.length === allKeys.length && allKeys.length > 0;
          return (
            <div key={table}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, marginBottom: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={allSelected} onChange={() => toggleTable(table, allKeys)} />
                {EXPORT_TABLE_LABELS[table] || table}
              </label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 26 }}>
                {fields.map(field => (
                  <label key={field.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>
                    <input type="checkbox" checked={selected.includes(field.key)} onChange={() => toggleField(table, field.key)} />
                    {humanizeFieldKey(field.key)}
                    {field.sensitive && <span style={{ color: 'var(--warn)', fontSize: 11 }}>(free text)</span>}
                  </label>
                ))}
              </div>
            </div>
          );
        })}

        <div>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Computed Insights</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {EXPORT_COMPUTED_SECTIONS.map(section => (
              <label key={section.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary)', cursor: 'pointer' }}>
                <input type="checkbox" checked={selection.computed.includes(section.key)} onChange={() => toggleComputed(section.key)} />
                {section.label}
              </label>
            ))}
          </div>
        </div>
      </div>

      <div className="modal-actions" style={{ display: 'flex', gap: 10, marginTop: 18 }}>
        <button className="btn-secondary" onClick={onClose} style={{ flex: 1 }}>Cancel</button>
        <button className="btn-primary" onClick={() => onConfirm(selection)} style={{ flex: 2 }}>Generate Export</button>
      </div>
    </Modal>
  );
}
