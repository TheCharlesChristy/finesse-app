import { Download, Upload, FileText } from 'lucide-react';

export default function Settings({ onExport, onImport, onExportCSV, onResetBudget }) {
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

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Budget reset */}
      <div className="glass" style={{ borderRadius: 18, padding: '24px' }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Manual Budget Reset</div>
        <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 14 }}>
          Resets all category spend counters to zero. Transactions are kept for history.
        </div>
        <button className="btn-danger" onClick={() => { if (window.confirm('Reset all category spending counters to zero?')) onResetBudget(); }}>
          Reset Budget Now
        </button>
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
