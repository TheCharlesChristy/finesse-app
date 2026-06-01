import { useMemo, useState } from 'react';
import { Download, Upload, FileText, RefreshCcw } from 'lucide-react';

export default function Settings({ onExport, onImport, onExportCSV, onResetBudget, incomes = [], onResetIncome }) {
  const [resetIncomeId, setResetIncomeId] = useState('');
  const [resetStatus, setResetStatus] = useState('');

  const selectedIncomeId = useMemo(() => {
    if (incomes.some(income => String(income.id) === String(resetIncomeId))) return resetIncomeId;
    return incomes[0]?.id ? String(incomes[0].id) : '';
  }, [incomes, resetIncomeId]);
  const selectedIncome = useMemo(
    () => incomes.find(income => String(income.id) === String(selectedIncomeId)),
    [incomes, selectedIncomeId]
  );

  const handleFileImport = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        onImport(data);
      } catch {
        alert('Invalid backup file.');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleIncomeReset = async () => {
    if (!selectedIncome || !onResetIncome) return;

    if (!window.confirm(`Reset spending counters for categories funded by "${selectedIncome.name}"?`)) return;

    const count = await onResetIncome(selectedIncome.id);
    setResetStatus(`${count} categor${count === 1 ? 'y' : 'ies'} reset for ${selectedIncome.name}.`);
  };

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Budget reset */}
      <div className="glass" style={{ borderRadius: 18, padding: '24px' }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Manual Budget Reset</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 14 }}>
          Resets every category spend counter to zero. Transactions are kept for history.
        </div>
        <button className="btn-danger" onClick={() => { if (window.confirm('Reset all category spending counters to zero?')) onResetBudget(); }}>
          Reset Budget Now
        </button>
      </div>

      {/* Income reset */}
      <div className="glass" style={{ borderRadius: 18, padding: '24px' }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Reset by Income</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 14 }}>
          Reset only the categories covered by a specific income source.
        </div>

        {incomes.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            Add income sources on the Dashboard to enable income-specific resets.
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <select className="glass-input" value={selectedIncomeId} onChange={e => { setResetIncomeId(e.target.value); setResetStatus(''); }}
                style={{ flex: '1 1 220px', maxWidth: 320 }}>
                {incomes.map(income => (
                  <option key={income.id} value={income.id}>{income.name}</option>
                ))}
              </select>
              <button className="btn-secondary" onClick={handleIncomeReset}
                style={{ display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>
                <RefreshCcw size={14} /> Reset Funded Categories
              </button>
            </div>
            {resetStatus && (
              <div style={{ color: 'var(--good)', fontSize: 12, marginTop: 10 }}>
                {resetStatus}
              </div>
            )}
          </>
        )}
      </div>

      {/* Data management */}
      <div className="glass" style={{ borderRadius: 18, padding: '24px' }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Data & Sync</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
          Export your data to transfer between devices or keep a backup. Import to restore.
        </div>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn-primary" onClick={onExport} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Download size={14} /> Export Backup (.json)
          </button>
          <button className="btn-secondary" onClick={onExportCSV} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <FileText size={14} /> Export Transactions (.csv)
          </button>
          <label className="btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}>
            <Upload size={14} /> Import Backup
            <input type="file" accept=".json" onChange={handleFileImport} style={{ display: 'none' }} />
          </label>
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 10 }}>
          Import will ask whether to replace or merge existing data.
        </div>
      </div>
    </div>
  );
}
