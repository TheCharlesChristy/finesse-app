import { useMemo, useState } from 'react';
import { ArrowLeftRight, Check, Pencil, Plus, Trash2, Wallet, X } from 'lucide-react';
import { fmt } from '../utils';
import { CardTitle, IconButton } from '../components/ui';

const ACCOUNT_COLORS = ['#4fffb0', '#5db8ff', '#c084fc', '#fbbf70', '#ff6b8a', '#67e8f9'];

export default function Accounts({
  accounts = [],
  activeAccountId,
  transfers = [],
  incomeEvents = [],
  categories = [],
  onSelectAccount,
  onAddAccount,
  onUpdateAccount,
  onDeleteAccount,
  onTransfer,
  onDeleteIncomeEvent,
}) {
  const [newName, setNewName] = useState('');
  const [newBalance, setNewBalance] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editBalance, setEditBalance] = useState('');
  // Deliberately starts empty and falls back to the active account at render:
  // syncing it in an effect meant a wasted render and a stale value whenever
  // the active account changed.
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');

  const accountMap = useMemo(
    () => new Map(accounts.map(account => [Number(account.id), account])),
    [accounts]
  );
  const categoryMap = useMemo(
    () => new Map(categories.map(category => [Number(category.id), category])),
    [categories]
  );
  const totalBalance = accounts.reduce((sum, account) => sum + (Number(account.balance) || 0), 0);
  const activeAccount = accountMap.get(Number(activeAccountId));
  const recentIncomeEvents = [...incomeEvents]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 8);
  const recentTransfers = [...transfers]
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 8);

  const effectiveFromId = fromId || activeAccountId || '';

  const startEdit = (account) => {
    setEditingId(account.id);
    setEditName(account.name || '');
    setEditBalance(String(account.balance ?? 0));
  };

  const commitEdit = () => {
    if (!editName.trim()) return;
    onUpdateAccount(editingId, {
      name: editName.trim(),
      balance: parseFloat(editBalance) || 0,
    });
    setEditingId(null);
  };

  const handleAddAccount = async () => {
    if (!newName.trim()) return;
    const id = await onAddAccount({
      name: newName.trim(),
      balance: parseFloat(newBalance) || 0,
      color: ACCOUNT_COLORS[accounts.length % ACCOUNT_COLORS.length],
    });
    if (id) onSelectAccount(id);
    setNewName('');
    setNewBalance('');
  };

  const handleTransfer = async () => {
    const transferAmount = parseFloat(amount) || 0;
    if (!effectiveFromId || !toId || Number(effectiveFromId) === Number(toId) || transferAmount <= 0) return;

    await onTransfer({
      fromAccountId: Number(effectiveFromId),
      toAccountId: Number(toId),
      amount: transferAmount,
      note,
      date: new Date().toISOString(),
    });
    setAmount('');
    setNote('');
  };

  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 14 }}>
        <div className="glass" style={{ borderRadius: 18, padding: '20px 22px' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
            Accounts
          </div>
          <div className="font-display" style={{ fontSize: 32, color: 'var(--accent-mint)' }}>{accounts.length}</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>separate workspaces</div>
        </div>
        <div className="glass" style={{ borderRadius: 18, padding: '20px 22px' }}>
          <div style={{ color: 'var(--text-muted)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 8 }}>
            Total Balance
          </div>
          <div className="font-display" style={{ fontSize: 32, color: totalBalance < 0 ? 'var(--danger)' : 'var(--text-primary)' }}>{fmt(totalBalance)}</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 4 }}>across all accounts</div>
        </div>
      </div>

      <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '22px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <Wallet size={17} color="var(--accent-blue)" aria-hidden="true" />
          <CardTitle as="h2">Your Accounts</CardTitle>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {accounts.map(account => {
            const active = Number(account.id) === Number(activeAccountId);
            const editing = editingId === account.id;
            return (
              <div key={account.id} className="mobile-stack" style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(160px, 1fr) minmax(120px, auto)',
                gap: 12,
                alignItems: 'center',
                padding: '12px 14px',
                borderRadius: 12,
                background: active ? 'rgba(93,184,255,0.1)' : 'rgba(255,255,255,0.04)',
                border: active ? '1px solid rgba(93,184,255,0.24)' : '1px solid transparent',
              }}>
                {editing ? (
                  <>
                    <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: 'minmax(120px, 1fr) minmax(100px, 140px)', gap: 8 }}>
                      <input className="glass-input" value={editName} aria-label="Account name" onChange={e => setEditName(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && commitEdit()} autoFocus />
                      <input className="glass-input" type="number" step="0.01" value={editBalance} aria-label="Account balance"
                        onChange={e => setEditBalance(e.target.value)}
                        onKeyDown={e => e.key === 'Enter' && commitEdit()} />
                    </div>
                    <div className="mobile-actions" style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                      <IconButton onClick={commitEdit} label="Save account"><Check size={13} /></IconButton>
                      <IconButton onClick={() => setEditingId(null)} label="Cancel editing"><X size={13} /></IconButton>
                    </div>
                  </>
                ) : (
                  <>
                    <button onClick={() => onSelectAccount(account.id)} style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      minWidth: 0,
                      background: 'transparent',
                      border: 0,
                      color: 'var(--text-primary)',
                      textAlign: 'left',
                      cursor: 'pointer',
                      fontFamily: 'DM Sans, sans-serif',
                    }}>
                      <span style={{ width: 10, height: 10, borderRadius: '50%', background: account.color || 'var(--accent-blue)', flexShrink: 0 }} />
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 13, fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {account.name}
                        </span>
                        <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                          {active ? 'Active account' : 'Switch to account'}
                        </span>
                      </span>
                    </button>
                    <div className="mobile-actions" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
                      <span className="font-display" style={{ fontSize: 20, color: (account.balance || 0) < 0 ? 'var(--danger)' : 'var(--text-primary)' }}>
                        {fmt(account.balance || 0)}
                      </span>
                      <IconButton onClick={() => startEdit(account)} label={`Edit ${account.name}`} size={28} style={{ opacity: 0.65 }}>
                        <Pencil size={12} />
                      </IconButton>
                      <IconButton onClick={() => onDeleteAccount(account)} label={`Delete ${account.name}`} size={28} style={{ opacity: 0.5 }}>
                        <Trash2 size={12} />
                      </IconButton>
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', marginTop: 16, paddingTop: 16 }}>
          <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: 'minmax(140px, 1fr) minmax(100px, 140px) auto', gap: 10, alignItems: 'center' }}>
            <input className="glass-input" placeholder="New account name" value={newName} aria-label="New account name"
              onChange={e => setNewName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAddAccount()} />
            <input className="glass-input" type="number" step="0.01" placeholder="Balance" value={newBalance} aria-label="Starting balance"
              onChange={e => setNewBalance(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && handleAddAccount()} />
            <button className="btn-primary" onClick={handleAddAccount} disabled={!newName.trim()}
              style={{ display: 'flex', alignItems: 'center', gap: 7, whiteSpace: 'nowrap' }}>
              <Plus size={14} /> Add
            </button>
          </div>
        </div>
      </div>

      <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '22px 24px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <ArrowLeftRight size={17} color="var(--accent-mint)" aria-hidden="true" />
          <CardTitle as="h2">Transfer Money</CardTitle>
        </div>

        <div className="mobile-stack" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
          <div>
            <label htmlFor="transfer-from" className="field-label">From</label>
            <select id="transfer-from" className="glass-input" value={effectiveFromId} onChange={e => setFromId(e.target.value)}>
              <option value="">Select account</option>
              {accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="transfer-to" className="field-label">To</label>
            <select id="transfer-to" className="glass-input" value={toId || ''} onChange={e => setToId(e.target.value)}>
              <option value="">Select account</option>
              {accounts.map(account => <option key={account.id} value={account.id}>{account.name}</option>)}
            </select>
          </div>
          <div>
            <label htmlFor="transfer-amount" className="field-label">Amount (£)</label>
            <input id="transfer-amount" className="glass-input" type="number" min="0" step="0.01" placeholder="0.00" value={amount}
              onChange={e => setAmount(e.target.value)} />
          </div>
        </div>
        <div className="mobile-row-stack" style={{ display: 'flex', gap: 10, marginTop: 10, flexWrap: 'wrap' }}>
          <input className="glass-input" placeholder="Note" value={note} aria-label="Transfer note"
            onChange={e => setNote(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleTransfer()}
            style={{ flex: '1 1 220px' }} />
          <button className="btn-primary mobile-full" onClick={handleTransfer}
            disabled={!effectiveFromId || !toId || Number(effectiveFromId) === Number(toId) || (parseFloat(amount) || 0) <= 0}
            style={{ display: 'flex', alignItems: 'center', gap: 7, flexShrink: 0 }}>
            <ArrowLeftRight size={14} /> Transfer
          </button>
        </div>
      </div>

      {recentIncomeEvents.length > 0 && (
        <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '20px 22px' }}>
          <CardTitle as="h2" style={{ marginBottom: 12 }}>
            Recent Income{activeAccount ? ` for ${activeAccount.name}` : ''}
          </CardTitle>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {recentIncomeEvents.map(event => (
              <div key={event.id} className="mobile-stack" style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(160px, 1fr) minmax(90px, auto)',
                gap: 12,
                alignItems: 'center',
                padding: '10px 12px',
                borderRadius: 12,
                background: 'rgba(255,255,255,0.04)',
              }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {event.name || 'Income'}
                  </div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 2 }}>
                    {new Date(event.date).toLocaleDateString('en-GB')}
                    {' · '}
                    {event.type === 'one-off' ? 'One-off' : 'Recurring'}
                    {event.note ? ` · ${event.note}` : ''}
                    {event.allocatedCategoryId != null && categoryMap.get(Number(event.allocatedCategoryId))
                      ? ` · Boosted ${categoryMap.get(Number(event.allocatedCategoryId)).name}`
                      : ''}
                  </div>
                </div>
                <div className="mobile-actions" style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 14, fontWeight: 700, color: 'var(--accent-mint)' }}>+{fmt(event.amount || 0)}</span>
                  {event.type === 'one-off' && (
                    <IconButton onClick={() => onDeleteIncomeEvent?.(event)}
                      label={`Delete one-off income ${event.name || ''}`.trim()} size={28} style={{ opacity: 0.55 }}>
                      <Trash2 size={12} />
                    </IconButton>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {recentTransfers.length > 0 && (
        <div className="glass mobile-card-pad" style={{ borderRadius: 18, padding: '20px 22px' }}>
          <CardTitle as="h2" style={{ marginBottom: 12 }}>Recent Transfers</CardTitle>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {recentTransfers.map(transfer => {
              const from = accountMap.get(Number(transfer.fromAccountId));
              const to = accountMap.get(Number(transfer.toAccountId));
              return (
                <div key={transfer.id} className="mobile-stack" style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(160px, 1fr) minmax(90px, auto)',
                  gap: 12,
                  alignItems: 'center',
                  padding: '10px 12px',
                  borderRadius: 12,
                  background: 'rgba(255,255,255,0.04)',
                }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {from?.name || 'Deleted account'}{' → '}{to?.name || 'Deleted account'}
                    </div>
                    <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 2 }}>
                      {new Date(transfer.date).toLocaleDateString('en-GB')}{transfer.note ? ` · ${transfer.note}` : ''}
                    </div>
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--accent-mint)' }}>{fmt(transfer.amount || 0)}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
