import { useMemo, useState } from 'react';
import { Download, Upload, FileText, RefreshCcw, Trash2, Sun, Moon, Monitor } from 'lucide-react';
import CategorySelect from '../components/CategorySelect';
import { CardTitle } from '../components/ui';

export default function Settings({
  onExport,
  onImport,
  onExportCSV,
  onResetBudget,
  incomes = [],
  categories = [],
  settings,
  onResetIncome,
  onSaveSettings,
  onFullReset,
  showConfirm,
  showAlert,
  showPrompt,
}) {
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
    reader.onload = async (ev) => {
      try {
        const data = JSON.parse(ev.target.result);
        const payload = (data?.data && typeof data.data === 'object' && !Array.isArray(data.data)) ? data.data : data;
        const tableKeys = [
          'accounts',
          'accountTransfers',
          'incomeEvents',
          'settings',
          'categories',
          'transactions',
          'wishlist',
          'wishlistCategories',
          'incomes',
          'subscriptions',
          'variables',
        ];
        const hasKnownTable = tableKeys.some(key => {
          const value = payload?.[key];
          return Array.isArray(value) || (value && typeof value === 'object');
        });
        if (!hasKnownTable) {
          await showAlert('The selected file does not look like a Finesse backup.', { title: 'Invalid backup format' });
          return;
        }
        onImport(payload);
      } catch {
        await showAlert('The selected file is not a valid Finesse backup.', { title: 'Invalid file' });
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const handleIncomeReset = async () => {
    if (!selectedIncome || !onResetIncome) return;

    const ok = await showConfirm(`Reset spending counters for categories funded by "${selectedIncome.name}"?`, {
      title: 'Reset by Income', confirmText: 'Reset',
    });
    if (!ok) return;

    const count = await onResetIncome(selectedIncome.id);
    setResetStatus(`${count} categor${count === 1 ? 'y' : 'ies'} reset for ${selectedIncome.name}.`);
  };

  const handleDefaultCategoryChange = (categoryId) => {
    onSaveSettings?.({
      ...(settings || {}),
      defaultCategoryId: categoryId ? Number(categoryId) : null,
    });
  };

  const handleThemeChange = (value) => {
    onSaveSettings?.({ ...(settings || {}), themeMode: value });
  };

  const handleFullReset = async () => {
    if (!onFullReset) return;

    const typed = await showPrompt(
      'This permanently deletes all accounts, budgets, transactions, wishlist items, incomes, variables, transfers, and settings from this browser.\n\nType DELETE to confirm.',
      {
        title: 'Delete all data',
        placeholder: 'Type DELETE',
        confirmText: 'Delete Everything',
        danger: true,
        validate: v => v === 'DELETE',
      },
    );
    if (!typed) return;

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
      {/* Appearance */}
      <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '24px' }}>
        <CardTitle as="h2" style={{ marginBottom: 8 }}>Appearance</CardTitle>
        <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 14 }}>Colour scheme</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {[
            { value: 'dark',   label: 'Dark',   Icon: Moon },
            { value: 'system', label: 'System', Icon: Monitor },
            { value: 'light',  label: 'Light',  Icon: Sun },
          ].map(({ value, label, Icon }) => (
            <button key={value} type="button"
              className={(settings?.themeMode ?? 'dark') === value ? 'btn-primary' : 'btn-secondary'}
              onClick={() => handleThemeChange(value)}
              style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 90 }}>
              <Icon size={14} aria-hidden="true" />{label}
            </button>
          ))}
        </div>
      </div>

      {/* Budget reset */}
      <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '24px' }}>
        <CardTitle as="h2" style={{ marginBottom: 8 }}>Manual Budget Reset</CardTitle>
        <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 14 }}>
          Resets every category spend counter to zero. Transactions are kept for history.
        </div>
        <button className="btn-danger" onClick={async () => {
          const ok = await showConfirm('Reset all category spending counters to zero? Transactions are kept for history.', {
            title: 'Reset budget', confirmText: 'Reset',
          });
          if (ok) onResetBudget();
        }}>
          Reset Budget Now
        </button>
      </div>

      {/* Preferences */}
      <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '24px' }}>
        <CardTitle as="h2" style={{ marginBottom: 8 }}>Expense Defaults</CardTitle>
        <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 14 }}>
          Choose which category is selected first when logging a new expense.
        </div>
        {categories.length > 0 ? (
          <div style={{ maxWidth: 360 }}>
            <CategorySelect
              categories={categories}
              value={settings?.defaultCategoryId ? String(settings.defaultCategoryId) : ''}
              onChange={handleDefaultCategoryChange}
              placeholder="No default selected"
              showAmounts
            />
          </div>
        ) : (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            Add categories on the Dashboard to choose a default expense category.
          </div>
        )}
      </div>

      {/* Income reset */}
      <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '24px' }}>
        <CardTitle as="h2" style={{ marginBottom: 8 }}>Reset by Income</CardTitle>
        <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 14 }}>
          Reset only the categories covered by a specific income source.
        </div>

        {incomes.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            Add income sources on the Dashboard to enable income-specific resets.
          </div>
        ) : (
          <>
            <div className="mobile-row-stack" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <select className="glass-input" aria-label="Income to reset" value={selectedIncomeId} onChange={e => { setResetIncomeId(e.target.value); setResetStatus(''); }}
                style={{ flex: '1 1 220px', maxWidth: 320 }}>
                {incomes.map(income => (
                  <option key={income.id} value={income.id}>{income.name}</option>
                ))}
              </select>
              <button className="btn-secondary mobile-full" onClick={handleIncomeReset}
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
      <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '24px' }}>
        <CardTitle as="h2" style={{ marginBottom: 8 }}>Data &amp; Sync</CardTitle>
        <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
          Export your data to transfer between devices or keep a backup. Import to restore.
        </div>
        <div className="mobile-actions mobile-actions-full" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
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
          <button className="btn-danger mobile-full" onClick={handleFullReset} disabled={isFullResetting}
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
