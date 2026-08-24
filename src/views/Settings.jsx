import { useEffect, useMemo, useState } from 'react';
import { Bell, Download, Upload, FileText, FileUp, FileCog, RefreshCcw, RefreshCw, Trash2, Sun, Moon, Monitor, Link2, FileJson, Plus, Wand2, Zap, Info, HardDrive, ShieldCheck, Lock, Undo2 } from 'lucide-react';
import { fmt } from '../utils';
import { notificationPermission, notificationsSupported, requestNotificationPermission } from '../notifications';
import { formatBytes, getStorageEstimate, STORAGE_BEST_EFFORT, STORAGE_PERSISTED, STORAGE_UNSUPPORTED } from '../storage';
import { buildPinSettings, isValidPin, lockSupported, DEFAULT_LOCK_DELAY_MS, LOCK_DELAYS, MAX_PIN_LENGTH, MIN_PIN_LENGTH } from '../lock';
import { APP_COMMIT, APP_VERSION, formatBuiltAt } from '../buildInfo';
import { isUpdatePending, updateApp } from '../pwa';
import CategorySelect from '../components/CategorySelect';
import EncryptionSettings from '../components/EncryptionSettings';
import VariablesSettings from '../components/VariablesSettings';
import { CardTitle, IconButton } from '../components/ui';

// What updateApp() found, in the user's terms. Anything unrecognised falls
// back to 'error' — silence is the one outcome a manual update mustn't have.
const UPDATE_MESSAGES = {
  current: 'You\u2019re already on the latest version.',
  unregistered: 'No service worker is running for this page, so there is nothing cached to update. That is normal in development, and before the app has been added to your home screen.',
  unsupported: 'This browser doesn\u2019t support service workers, so the app is never cached \u2014 a normal page refresh always gets the latest version.',
  error: 'Couldn\u2019t check for an update. Make sure you are online and try again.',
};

export default function Settings({
  onExport,
  onImport,
  onExportCSV,
  onGenerateShareUrl,
  onOpenExportChatSummary,
  onResetBudget,
  incomes = [],
  categories = [],
  settings,
  onResetIncome,
  onSaveSettings,
  onFullReset,
  variables = [],
  onAddVariable,
  onUpdateVariable,
  onDeleteVariable,
  rules = [],
  onAddRule,
  onDeleteRule,
  templates = [],
  onAddTemplate,
  onDeleteTemplate,
  nudgeCount = 0,
  onRecalculate,
  storageState = null,
  onRequestPersistence,
  onImportStatement,
  onImportBudgetConfig,
  stagedBudgetConfig = null,
  stagedBudgetLabel = null,
  budgetConfigUndo = null,
  onCancelStagedBudgetConfig,
  onUndoBudgetConfig,
  showConfirm,
  showAlert,
  showPrompt,
  onVaultUnlocked,
  onPinSet,
  encryptionEnabled = false,
}) {
  const [ruleMatch, setRuleMatch] = useState('');
  const [ruleCategoryId, setRuleCategoryId] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [templateAmount, setTemplateAmount] = useState('');
  const [templateCategoryId, setTemplateCategoryId] = useState('');
  const [permission, setPermission] = useState(() => notificationPermission());
  const [integrityStatus, setIntegrityStatus] = useState(null);
  const [estimate, setEstimate] = useState(null);
  const [isRequestingPersistence, setIsRequestingPersistence] = useState(false);
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [pinError, setPinError] = useState('');
  const [isSavingPin, setIsSavingPin] = useState(false);
  const [isRecalculating, setIsRecalculating] = useState(false);
  const [isUpdatingApp, setIsUpdatingApp] = useState(false);
  const [updateReady, setUpdateReady] = useState(() => isUpdatePending());

  const handleRecalculate = async () => {
    if (!onRecalculate) return;
    setIsRecalculating(true);
    try {
      setIntegrityStatus(await onRecalculate());
    } finally {
      setIsRecalculating(false);
    }
  };

  // The estimate is only read here, where it is shown — it costs a promise and
  // nothing outside this card uses it. Re-read after a persistence request so
  // the figures and the state never disagree.
  useEffect(() => {
    let cancelled = false;
    getStorageEstimate().then(result => { if (!cancelled) setEstimate(result); });
    return () => { cancelled = true; };
  }, [storageState]);

  const handleRequestPersistence = async () => {
    if (!onRequestPersistence) return;
    setIsRequestingPersistence(true);
    try {
      const state = await onRequestPersistence();
      if (state === STORAGE_BEST_EFFORT) {
        await showAlert(
          'The browser declined for now. This usually changes once the app has been used a few times, or added to your home screen — try again later.\n\nIn the meantime, an exported backup is the reliable protection.',
          { title: 'Not granted yet' },
        );
      }
    } finally {
      setIsRequestingPersistence(false);
    }
  };

  const pinIsSet = Boolean(settings?.pinHash && settings?.pinSalt);

  const handleSetPin = async () => {
    setPinError('');
    if (!isValidPin(newPin)) {
      setPinError(`Use ${MIN_PIN_LENGTH} to ${MAX_PIN_LENGTH} digits.`);
      return;
    }
    if (newPin !== confirmPin) {
      setPinError('The two PINs don’t match.');
      return;
    }

    setIsSavingPin(true);
    try {
      const patch = await buildPinSettings(newPin);
      if (!patch) {
        setPinError('This browser can’t derive a PIN securely.');
        return;
      }
      onSaveSettings?.(patch);
      // The lock gate reads straight from the database, so without this the
      // PIN you just chose would lock you out of the page you chose it on.
      onPinSet?.();
      setNewPin('');
      setConfirmPin('');
    } finally {
      setIsSavingPin(false);
    }
  };

  const handleRemovePin = async () => {
    const ok = await showConfirm(
      'Remove the PIN? The app will open straight to your finances again.',
      { title: 'Remove PIN', confirmText: 'Remove', danger: true },
    );
    if (!ok) return;
    onSaveSettings?.({ pinHash: null, pinSalt: null });
  };

  const handleUpdateApp = async () => {
    setIsUpdatingApp(true);
    try {
      const { status } = await updateApp();
      setUpdateReady(isUpdatePending());
      // 'updated' reloads the page from updateApp, so there is nobody left to
      // tell — every other outcome needs saying out loud.
      if (status !== 'updated') {
        await showAlert(UPDATE_MESSAGES[status] ?? UPDATE_MESSAGES.error, { title: 'App update' });
      }
    } finally {
      setIsUpdatingApp(false);
    }
  };

  const notificationsOn = Boolean(settings?.notificationsEnabled) && permission === 'granted';

  const handleToggleNotifications = async () => {
    if (notificationsOn) {
      onSaveSettings?.({ notificationsEnabled: false });
      return;
    }
    // Requested from a click, never on load: iOS only grants from a gesture,
    // and an unprompted permission dialog is just noise.
    const result = await requestNotificationPermission();
    setPermission(result);
    if (result === 'granted') {
      onSaveSettings?.({ notificationsEnabled: true });
    }
  };

  const categoryName = (id) => categories.find(c => Number(c.id) === Number(id))?.name || 'Missing category';

  const handleAddRule = () => {
    const match = ruleMatch.trim();
    const categoryId = ruleCategoryId || categories[0]?.id;
    if (!match || !categoryId) return;
    onAddRule?.({ match, categoryId: Number(categoryId) });
    setRuleMatch('');
  };

  const handleAddTemplate = () => {
    const name = templateName.trim();
    const amount = parseFloat(templateAmount);
    const categoryId = templateCategoryId || categories[0]?.id;
    if (!name || !(amount > 0) || !categoryId) return;
    onAddTemplate?.({ name, amount, categoryId: Number(categoryId), note: name });
    setTemplateName('');
    setTemplateAmount('');
  };
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
    onSaveSettings?.({ defaultCategoryId: categoryId ? Number(categoryId) : null });
  };

  const handleThemeChange = (value) => {
    onSaveSettings?.({ themeMode: value });
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
              aria-label="Default expense category"
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

      <VariablesSettings
        variables={variables}
        onAddVariable={onAddVariable}
        onUpdateVariable={onUpdateVariable}
        onDeleteVariable={onDeleteVariable}
      />

      {/* Reminders */}
      <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
          <Bell size={16} color="var(--accent-blue)" aria-hidden="true" />
          <CardTitle as="h2">Reminders</CardTitle>
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 14, lineHeight: 1.6 }}>
          Finesse always collects what needs your attention — due subscriptions,
          over-budget categories, goals slipping, a stale backup — under the bell
          at the top of the page.
          {nudgeCount > 0
            ? ` There ${nudgeCount === 1 ? 'is 1 item' : `are ${nudgeCount} items`} there now.`
            : ' Nothing is outstanding right now.'}
        </div>

        {!notificationsSupported() ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            This browser doesn&rsquo;t support notifications, so the bell is the only channel.
          </div>
        ) : (
          <>
            <button className={notificationsOn ? 'btn-primary' : 'btn-secondary'}
              onClick={handleToggleNotifications}
              disabled={permission === 'denied'}
              style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <Bell size={14} /> {notificationsOn ? 'Notifications on' : 'Also notify me'}
            </button>
            <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 10, lineHeight: 1.6 }}>
              {permission === 'denied'
                ? 'Notifications are blocked for this site in your browser settings.'
                : 'Finesse has no server, so notifications appear when you open the app or return to it — they can\u2019t wake your phone. On iPhone this needs the app added to your home screen.'}
            </div>
          </>
        )}
      </div>

      {/* Auto-categorisation rules */}
      <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
          <Wand2 size={16} color="var(--accent-mint)" aria-hidden="true" />
          <CardTitle as="h2">Auto-Categorise</CardTitle>
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 14, lineHeight: 1.6 }}>
          When a note contains your text, that category gets picked automatically.
          Rules beat the app&rsquo;s own guesses from your history.
        </div>

        {categories.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            Add categories on the Dashboard first.
          </div>
        ) : (
          <>
            {rules.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                {rules.map(rule => (
                  <div key={rule.id} className="mobile-list-row" style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 12px', background: 'rgba(255,255,255,0.04)', borderRadius: 10,
                  }}>
                    <span className="mobile-list-main" style={{ flex: 1, minWidth: 0, fontSize: 13 }}>
                      Note contains <strong>&ldquo;{rule.match}&rdquo;</strong> &rarr; {categoryName(rule.categoryId)}
                    </span>
                    <IconButton onClick={() => onDeleteRule?.(rule.id)} size={28} style={{ opacity: 0.55 }}
                      label={`Delete rule for ${rule.match}`}>
                      <Trash2 size={12} />
                    </IconButton>
                  </div>
                ))}
              </div>
            )}

            <div className="mobile-row-stack" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ flex: '2 1 160px' }}>
                <label htmlFor="rule-match" className="field-label">If the note contains</label>
                <input id="rule-match" className="glass-input" placeholder="e.g. Tesco" value={ruleMatch}
                  onChange={e => setRuleMatch(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddRule()} />
              </div>
              <div style={{ flex: '2 1 160px' }}>
                <div className="field-label">Use category</div>
                <CategorySelect categories={categories}
                  value={String(ruleCategoryId || categories[0]?.id || '')}
                  onChange={setRuleCategoryId} aria-label="Rule category" />
              </div>
              <button className="btn-primary mobile-full" onClick={handleAddRule} disabled={!ruleMatch.trim()}
                style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Plus size={14} /> Add Rule
              </button>
            </div>
          </>
        )}
      </div>

      {/* Expense templates */}
      <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
          <Zap size={16} color="var(--accent-warm)" aria-hidden="true" />
          <CardTitle as="h2">Quick Expenses</CardTitle>
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 14, lineHeight: 1.6 }}>
          Spending that repeats at the same price. Your three most-used appear
          above the add button on mobile, and all of them in the command palette.
        </div>

        {categories.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            Add categories on the Dashboard first.
          </div>
        ) : (
          <>
            {templates.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                {templates.map(template => (
                  <div key={template.id} className="mobile-list-row" style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 12px', background: 'rgba(255,255,255,0.04)', borderRadius: 10,
                  }}>
                    <span className="mobile-list-main" style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600 }}>
                      {template.name}
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {categoryName(template.categoryId)} · {fmt(template.amount)}
                      {template.useCount > 0 ? ` · ${template.useCount}×` : ''}
                    </span>
                    <IconButton onClick={() => onDeleteTemplate?.(template.id)} size={28} style={{ opacity: 0.55 }}
                      label={`Delete quick expense ${template.name}`}>
                      <Trash2 size={12} />
                    </IconButton>
                  </div>
                ))}
              </div>
            )}

            <div className="mobile-row-stack" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div style={{ flex: '2 1 140px' }}>
                <label htmlFor="template-name" className="field-label">Name</label>
                <input id="template-name" className="glass-input" placeholder="e.g. Coffee" value={templateName}
                  onChange={e => setTemplateName(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddTemplate()} />
              </div>
              <div style={{ flex: '1 1 100px' }}>
                <label htmlFor="template-amount" className="field-label">Amount (£)</label>
                <input id="template-amount" className="glass-input" type="number" min="0" step="0.01" placeholder="3.20"
                  value={templateAmount} onChange={e => setTemplateAmount(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddTemplate()} />
              </div>
              <div style={{ flex: '2 1 150px' }}>
                <div className="field-label">Category</div>
                <CategorySelect categories={categories}
                  value={String(templateCategoryId || categories[0]?.id || '')}
                  onChange={setTemplateCategoryId} aria-label="Quick expense category" />
              </div>
              <button className="btn-primary mobile-full" onClick={handleAddTemplate}
                disabled={!templateName.trim() || !(parseFloat(templateAmount) > 0)}
                style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Plus size={14} /> Add
              </button>
            </div>
          </>
        )}
      </div>

      {/* Privacy */}
      <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
          <Lock size={16} color="var(--accent-purple)" aria-hidden="true" />
          <CardTitle as="h2">Privacy</CardTitle>
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16, lineHeight: 1.6 }}>
          Hides your finances from whoever is holding the phone. Neither option
          here encrypts anything &mdash; they are a curtain, not a safe. The safe
          is under Encryption below, and the two work together: a PIN keeps the
          screen covered between glances, encryption keeps the data unreadable.
        </div>

        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer', marginBottom: 18 }}>
          <input
            type="checkbox"
            checked={settings?.privacyScreenEnabled !== false}
            onChange={e => onSaveSettings?.({ privacyScreenEnabled: e.target.checked })}
            style={{ marginTop: 2, width: 16, height: 16, accentColor: 'var(--accent-mint)' }}
          />
          <span>
            <span style={{ fontSize: 13, fontWeight: 600, display: 'block' }}>Cover the screen in the app switcher</span>
            <span style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6 }}>
              Blanks the app the moment it goes to the background, so the preview
              your phone keeps doesn&rsquo;t show your balances.
            </span>
          </span>
        </label>

        {!lockSupported() ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 12, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 16 }}>
            A PIN needs a secure connection (https), which this page isn&rsquo;t using — so it isn&rsquo;t offered here.
          </div>
        ) : pinIsSet ? (
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--good)', fontSize: 13, marginBottom: 12 }}>
              <ShieldCheck size={15} aria-hidden="true" /> A PIN is set.
            </div>
            <div className="field" style={{ marginBottom: 14 }}>
              <label className="field-label" htmlFor="lock-delay">Ask for it again</label>
              <select id="lock-delay" className="glass-input"
                value={String(settings?.lockDelayMs ?? DEFAULT_LOCK_DELAY_MS)}
                onChange={e => onSaveSettings?.({ lockDelayMs: Number(e.target.value) })}>
                {LOCK_DELAYS.map(([ms, label]) => (
                  <option key={ms} value={ms}>{label} in the background</option>
                ))}
              </select>
            </div>
            <button className="btn-secondary" onClick={handleRemovePin}
              style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <Trash2 size={14} /> Remove PIN
            </button>
          </div>
        ) : (
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 16 }}>
            <div className="mobile-actions" style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div className="field" style={{ flex: 1, minWidth: 140 }}>
                <label className="field-label" htmlFor="new-pin">New PIN</label>
                <input
                  id="new-pin"
                  className="glass-input"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  placeholder={`${MIN_PIN_LENGTH}–${MAX_PIN_LENGTH} digits`}
                  value={newPin}
                  onChange={e => setNewPin(e.target.value.replace(/\D/g, '').slice(0, MAX_PIN_LENGTH))}
                />
              </div>
              <div className="field" style={{ flex: 1, minWidth: 140 }}>
                <label className="field-label" htmlFor="confirm-pin">Confirm</label>
                <input
                  id="confirm-pin"
                  className="glass-input"
                  type="password"
                  inputMode="numeric"
                  autoComplete="new-password"
                  placeholder="Repeat it"
                  value={confirmPin}
                  onChange={e => setConfirmPin(e.target.value.replace(/\D/g, '').slice(0, MAX_PIN_LENGTH))}
                />
              </div>
              <button className="btn-primary mobile-full" onClick={handleSetPin}
                disabled={!isValidPin(newPin) || isSavingPin}
                style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Lock size={14} /> {isSavingPin ? 'Saving…' : 'Set PIN'}
              </button>
            </div>
            {pinError && (
              <div style={{ color: 'var(--danger)', fontSize: 11, marginTop: 10 }}>{pinError}</div>
            )}
            <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 10, lineHeight: 1.6 }}>
              Stored as a salted hash, never as the digits themselves. Forgetting it
              costs you nothing but the lock &mdash; clear the PIN by importing a
              backup, or by clearing this site&rsquo;s data. That is only true while
              the data is unencrypted; once it is, the secret that opens it is the
              one thing no backup can replace.
            </div>
          </div>
        )}
      </div>

      <EncryptionSettings
        onBackup={onExport}
        onUnlocked={onVaultUnlocked}
        showConfirm={showConfirm}
        showAlert={showAlert}
      />

      {/* Storage durability */}
      <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
          <HardDrive size={16} color="var(--accent-purple)" aria-hidden="true" />
          <CardTitle as="h2">Storage</CardTitle>
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 14, lineHeight: 1.6 }}>
          By default a browser treats app data as disposable and may clear it to
          reclaim space, or after a long enough gap between visits. Persistent
          storage asks it not to &mdash; then only you can clear it.
        </div>

        {storageState === STORAGE_UNSUPPORTED ? (
          <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>
            This browser doesn&rsquo;t expose storage persistence, so there is nothing to ask for.
            Keep exporting backups.
          </div>
        ) : storageState === STORAGE_PERSISTED ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--good)', fontSize: 13 }}>
            <ShieldCheck size={15} aria-hidden="true" /> Storage is persistent — this browser won&rsquo;t evict your data.
          </div>
        ) : (
          <>
            <button className="btn-primary" onClick={handleRequestPersistence}
              disabled={isRequestingPersistence || storageState === null}
              style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <ShieldCheck size={14} /> {isRequestingPersistence ? 'Asking…' : 'Keep my data'}
            </button>
            <div style={{ color: 'var(--warn)', fontSize: 11, marginTop: 10, lineHeight: 1.6 }}>
              {storageState === null
                ? 'Checking…'
                : 'Your data is currently evictable. Browsers decide this themselves — being installed to your home screen and using the app regularly both make a yes more likely.'}
            </div>
          </>
        )}

        {estimate && (
          <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', marginTop: 16, paddingTop: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 7 }}>
              <span style={{ color: 'var(--text-muted)' }}>Used</span>
              <span style={{ color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
                {formatBytes(estimate.usage)} of {formatBytes(estimate.quota)}
              </span>
            </div>
            <div style={{ height: 6, borderRadius: 4, background: 'rgba(255,255,255,0.07)', overflow: 'hidden' }}>
              <div style={{
                width: `${Math.max(1, Math.min(100, estimate.percent))}%`, height: '100%',
                background: estimate.percent > 85 ? 'var(--danger)' : 'var(--accent-purple)',
                borderRadius: 4,
              }} />
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 8, lineHeight: 1.6 }}>
              Browsers round these figures deliberately, so treat them as a rough guide.
              Receipt photos are by far the largest thing Finesse stores.
            </div>
          </div>
        )}
      </div>

      {/* Data management */}
      <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '24px' }}>
        <CardTitle as="h2" style={{ marginBottom: 8 }}>Data &amp; Sync</CardTitle>
        <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 16 }}>
          Export your data to transfer between devices or keep a backup. Import to restore.
        </div>
        {encryptionEnabled && (
          <div style={{
            border: '1px solid rgba(251,191,112,0.3)', background: 'rgba(251,191,112,0.06)',
            borderRadius: 12, padding: '12px 14px', marginBottom: 16,
            fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6,
            display: 'flex', gap: 8,
          }}>
            <Info size={14} style={{ flexShrink: 0, marginTop: 2, color: 'var(--warn)' }} aria-hidden="true" />
            <span>
              A backup file is <strong>not encrypted</strong>. This device is, but
              the export is plain JSON so it can be read and restored anywhere —
              which means anywhere you leave it can be read too. Keep backups
              somewhere you would be happy putting your bank statements.
            </span>
          </div>
        )}
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
          <button className="btn-secondary" onClick={onImportStatement} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <FileUp size={14} /> Import Bank Statement (.csv)
          </button>
        </div>
        <div style={{ color: settings?.lastBackupAt ? 'var(--text-muted)' : 'var(--warn)', fontSize: 11, marginTop: 10 }}>
          {settings?.lastBackupAt
            ? `Last backup ${new Date(settings.lastBackupAt).toLocaleDateString('en-GB')}. `
            : 'You have never exported a backup. Your data exists only in this browser. '}
          Where your device supports it, exporting opens the share sheet so the file can go
          straight to Files, iCloud or another device. Import will ask whether to replace or
          merge existing data.
        </div>

        <div className="mobile-actions mobile-actions-full" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 16 }}>
          <button className="btn-secondary" onClick={onGenerateShareUrl} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <Link2 size={14} /> Copy Share Link
          </button>
          <button className="btn-secondary" onClick={onOpenExportChatSummary} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <FileJson size={14} /> Chat Summary (.json)
          </button>
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 10 }}>
          Share Link carries your accounts, categories, incomes, subscriptions and wishlist to a new device — it excludes transaction history. Chat Summary lets you pick exactly which data and fields to include before generating a JSON export with computed spending insights, meant for sharing with a financial advisor or an AI assistant for analysis.
        </div>

        <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', marginTop: 18, paddingTop: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Budget Config</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 12, lineHeight: 1.5 }}>
            Redefine every category and variable from a JSON file in one go. Changing a
            budget category by category, mid-cycle, corrupts that cycle&rsquo;s pacing and
            every comparison drawn from it — so an import is checked and previewed now,
            then applied at your next reset. Nothing is written until then, and an import
            never deletes a category.
          </div>

          {stagedBudgetConfig ? (
            <div style={{
              background: 'rgba(93,184,255,0.08)', borderRadius: 12, padding: '12px 14px',
              marginBottom: 12, fontSize: 12, lineHeight: 1.5,
            }}>
              <div style={{ fontWeight: 600, marginBottom: 3 }}>
                {stagedBudgetLabel ? `A new budget applies on ${stagedBudgetLabel}` : 'A new budget is staged'}
              </div>
              <div style={{ color: 'var(--text-muted)' }}>
                {stagedBudgetConfig.plan?.categories?.length || 0} categories and{' '}
                {stagedBudgetConfig.plan?.variables?.length || 0} variables, from{' '}
                {stagedBudgetConfig.fileName || 'an imported config'}. Nothing has changed yet.
              </div>
              {stagedBudgetConfig.lastAttemptErrors?.length > 0 && (
                <div style={{ color: 'var(--danger)', marginTop: 8 }}>
                  It could not be applied at the last reset: {stagedBudgetConfig.lastAttemptErrors[0].message}
                </div>
              )}
            </div>
          ) : null}

          {budgetConfigUndo?.appliedAt && (
            <div style={{
              background: 'rgba(79,255,176,0.08)', borderRadius: 12, padding: '12px 14px',
              marginBottom: 12, fontSize: 12, lineHeight: 1.5,
            }}>
              <div style={{ fontWeight: 600, marginBottom: 3 }}>
                A budget config was applied on{' '}
                {new Date(budgetConfigUndo.appliedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}
              </div>
              <div style={{ color: 'var(--text-muted)' }}>
                It can be undone until your next reset. Undoing restores your categories
                and variables as they were; any spending logged since is kept.
              </div>
            </div>
          )}

          <div className="mobile-actions mobile-actions-full" style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button className="btn-secondary" onClick={onImportBudgetConfig}
              style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <FileCog size={14} /> {stagedBudgetConfig ? 'Replace Budget Config' : 'Import Budget Config (.json)'}
            </button>
            {stagedBudgetConfig && (
              <button className="btn-secondary" onClick={onCancelStagedBudgetConfig}>
                Cancel Staged Budget
              </button>
            )}
            {budgetConfigUndo?.appliedAt && (
              <button className="btn-secondary" onClick={onUndoBudgetConfig}
                style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <Undo2 size={14} /> Undo Applied Budget
              </button>
            )}
          </div>
        </div>

        <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', marginTop: 18, paddingTop: 18 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Data Integrity</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginBottom: 12, lineHeight: 1.5 }}>
            Each category&rsquo;s spend is a running counter rather than a fresh
            sum of its transactions — fast, but it can drift if a write is
            interrupted. This rebuilds every counter from the transaction log,
            which is the real record.
          </div>
          <button className="btn-secondary" onClick={handleRecalculate} disabled={isRecalculating}
            style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <RefreshCcw size={14} /> {isRecalculating ? 'Checking…' : 'Recalculate Spend Counters'}
          </button>
          {integrityStatus && (
            <div style={{ color: integrityStatus.repaired > 0 ? 'var(--warn)' : 'var(--good)', fontSize: 12, marginTop: 10, lineHeight: 1.6 }}>
              {integrityStatus.repaired > 0
                ? `Repaired ${integrityStatus.repaired} of ${integrityStatus.checked}: ${integrityStatus.categories
                    .filter(row => Math.abs(row.drift) >= 0.01)
                    .map(row => `${row.name} ${fmt(row.stored)} → ${fmt(row.actual)}`)
                    .join(', ')}`
                : `Checked ${integrityStatus.checked} categor${integrityStatus.checked === 1 ? 'y' : 'ies'} — all counters match the transaction log.`}
            </div>
          )}
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

      {/* About / build */}
      <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 8 }}>
          <Info size={16} color="var(--accent-blue)" aria-hidden="true" />
          <CardTitle as="h2">About</CardTitle>
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: 13, marginBottom: 14, lineHeight: 1.6 }}>
          Which build this device is running. Finesse checks for a new one hourly
          and installs it in the background, but an app on your home screen can sit
          on a cached copy for a while &mdash; update now if you are waiting on a change.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 }}>
          {[
            ['Version', APP_VERSION],
            ['Build', APP_COMMIT],
            ['Built', formatBuiltAt() ?? 'Unknown'],
          ].map(([label, value]) => (
            <div key={label} style={{ display: 'flex', gap: 12, fontSize: 12 }}>
              <span style={{ color: 'var(--text-muted)', minWidth: 70 }}>{label}</span>
              <span style={{ color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
            </div>
          ))}
        </div>

        <button className="btn-secondary" onClick={handleUpdateApp} disabled={isUpdatingApp}
          style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <RefreshCw size={14} /> {isUpdatingApp ? 'Checking\u2026' : 'Update App'}
        </button>
        <div style={{ color: updateReady ? 'var(--warn)' : 'var(--text-muted)', fontSize: 11, marginTop: 10, lineHeight: 1.6 }}>
          {updateReady
            ? 'A newer build is already downloaded \u2014 update now to switch to it.'
            : 'Checks for a newer build and reloads straight into it if there is one.'}
        </div>
      </div>
    </div>
  );
}
