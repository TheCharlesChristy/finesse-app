import { useMemo, useState } from 'react';
import { Download, Upload, FileText, RefreshCcw, Trash2 } from 'lucide-react';

export default function Settings({ onExport, onImport, onExportCSV, onResetBudget, incomes = [], onResetIncome, onFullReset }) {
  const [resetIncomeId, setResetIncomeId] = useState('');
  const [resetStatus, setResetStatus] = useState('');
  const [fullResetStatus, setFullResetStatus] = useState('');
  const [isFullResetting, setIsFullResetting] = useState(false);

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

  const handleFullReset = async () => {
    if (!onFullReset) return;

    const typed = window.prompt('This permanently deletes all accounts, budgets, transactions, wishlist items, incomes, variables, transfers, and settings. Type DELETE to confirm.');
    if (typed !== 'DELETE') return;

    setIsFullResetting(true);
    setFullResetStatus('');
    try {
      await onFullReset();
      setResetIncomeId('');
      setResetStatus('');
      setFullResetStatus('All data was deleted. A blank Main Account has been created.');
    } finally {
      setIsFullResetting(false);
    }
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

        <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', marginTop: 18, paddingTop: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--danger)', marginBottom: 6 }}>Full Reset</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 12, lineHeight: 1.5 }}>
            Permanently deletes every account and all saved finance data from this browser.
          </div>
          <button className="btn-danger" onClick={handleFullReset} disabled={isFullResetting}
            style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Trash2 size={14} /> {isFullResetting ? 'Deleting...' : 'Delete All Data'}
          </button>
          {fullResetStatus && (
            <div style={{ color: 'var(--good)', fontSize: 12, marginTop: 10 }}>
              {fullResetStatus}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
