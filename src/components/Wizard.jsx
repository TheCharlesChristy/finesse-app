import { useState } from 'react';
import { Check, Sparkles } from 'lucide-react';

import { fmt, roundMoney } from '../utils';
import { Field } from './ui';

/**
 * Guided first run.
 *
 * The old onboarding was a static list of three things to do, which left a new
 * user staring at an empty Dashboard trying to work out what "funded category"
 * meant. This asks for an income, offers a starting set of categories that add
 * up to it, and creates both — so the first screen they see has real numbers.
 */

const FREQ_OPTIONS = [
  { value: 'monthly', label: 'Monthly' },
  { value: '4weekly', label: 'Every 4 weeks' },
  { value: 'fortnightly', label: 'Fortnightly' },
  { value: 'weekly', label: 'Weekly' },
];

// Percentages, so a pack works at any income. Each adds to 100.
const PACKS = [
  {
    id: 'balanced',
    name: '50 / 30 / 20',
    description: 'Needs, wants, and saving. A sensible default if you are unsure.',
    categories: [
      { name: 'Essentials', percent: 50, color: '#5db8ff' },
      { name: 'Lifestyle', percent: 30, color: '#c084fc' },
      { name: 'Savings', percent: 20, color: '#4fffb0' },
    ],
  },
  {
    id: 'household',
    name: 'Household',
    description: 'Rent and bills separated from food and everyday spending.',
    categories: [
      { name: 'Rent', percent: 35, color: '#ff6b8a' },
      { name: 'Bills', percent: 15, color: '#fbbf70' },
      { name: 'Groceries', percent: 20, color: '#4fffb0' },
      { name: 'Transport', percent: 10, color: '#5db8ff' },
      { name: 'Fun', percent: 10, color: '#c084fc' },
      { name: 'Savings', percent: 10, color: '#67e8f9' },
    ],
  },
  {
    id: 'simple',
    name: 'Just the basics',
    description: 'Two categories. Add more once you see where the money goes.',
    categories: [
      { name: 'Spending', percent: 70, color: '#5db8ff' },
      { name: 'Savings', percent: 30, color: '#4fffb0' },
    ],
  },
  {
    id: 'none',
    name: 'I will set my own up',
    description: 'Just create the income; categories are up to you.',
    categories: [],
  },
];

export default function Wizard({ onComplete, onSkip }) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState('Salary');
  const [amount, setAmount] = useState('');
  const [frequency, setFrequency] = useState('monthly');
  const [payDay, setPayDay] = useState('25');
  const [packId, setPackId] = useState('balanced');
  const [busy, setBusy] = useState(false);

  const amountValue = parseFloat(amount) || 0;
  const pack = PACKS.find(entry => entry.id === packId) || PACKS[0];
  const canContinue = name.trim() && amountValue > 0;

  const handleFinish = async () => {
    if (!canContinue || busy) return;
    setBusy(true);
    try {
      await onComplete({
        income: {
          name: name.trim(),
          amount: amountValue,
          resetFrequency: frequency,
          payDayOfMonth: frequency === 'monthly' ? (parseInt(payDay, 10) || null) : null,
          holdActive: false,
          lastPaid: null,
        },
        categories: pack.categories.map(category => ({
          name: category.name,
          allowance: roundMoney(amountValue * category.percent / 100),
          percent: category.percent,
          color: category.color,
        })),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="glass mobile-card-pad" style={{
      borderRadius: 18, padding: '24px',
      borderColor: 'rgba(79,255,176,0.28)', background: 'rgba(79,255,176,0.05)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <Sparkles size={18} color="var(--accent-mint)" aria-hidden="true" />
        <h2 style={{ fontSize: 16, fontWeight: 600, margin: 0 }}>
          {step === 1 ? 'Welcome to Finesse' : 'Choose a starting point'}
        </h2>
      </div>

      {step === 1 ? (
        <>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '0 0 18px', lineHeight: 1.6 }}>
            Finesse budgets from what you actually earn, so it starts with your
            income. Everything else is split out of it.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Field label="What do you call it?">
              {id => (
                <input id={id} className="glass-input" value={name} autoFocus
                  onChange={e => setName(e.target.value)} placeholder="e.g. Salary" />
              )}
            </Field>
            <Field label="How much, each time you're paid? (£)">
              {id => (
                <input id={id} className="glass-input" type="number" min="0" step="0.01" placeholder="0.00"
                  value={amount} onChange={e => setAmount(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && canContinue && setStep(2)} />
              )}
            </Field>
            <Field label="How often?">
              {id => (
                <select id={id} className="glass-input" value={frequency} onChange={e => setFrequency(e.target.value)}>
                  {FREQ_OPTIONS.map(option => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              )}
            </Field>
            {frequency === 'monthly' && (
              <Field label="Which day of the month?">
                {id => (
                  <input id={id} className="glass-input" type="number" min="1" max="31"
                    value={payDay} onChange={e => setPayDay(e.target.value)} />
                )}
              </Field>
            )}
          </div>

          <div className="modal-actions" style={{ display: 'flex', gap: 10, marginTop: 18 }}>
            <button className="btn-secondary" onClick={onSkip} style={{ flex: 1 }}>Set up manually</button>
            <button className="btn-primary" onClick={() => setStep(2)} disabled={!canContinue} style={{ flex: 2 }}>
              Continue
            </button>
          </div>
        </>
      ) : (
        <>
          <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '0 0 18px', lineHeight: 1.6 }}>
            Categories split your {fmt(amountValue)} into spending allowances.
            Pick a starting set — you can rename, re-split or delete any of them
            afterwards.
          </p>

          <div role="radiogroup" aria-label="Starting categories" style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            {PACKS.map(entry => {
              const selected = entry.id === packId;
              return (
                <button key={entry.id} type="button" role="radio" aria-checked={selected}
                  onClick={() => setPackId(entry.id)}
                  style={{
                    textAlign: 'left', cursor: 'pointer', padding: '13px 15px', borderRadius: 12,
                    fontFamily: 'DM Sans, sans-serif',
                    border: `1px solid ${selected ? 'var(--accent-mint)' : 'var(--glass-border)'}`,
                    background: selected ? 'rgba(79,255,176,0.1)' : 'rgba(255,255,255,0.04)',
                    color: 'var(--text-primary)',
                  }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                    <span style={{ fontSize: 13, fontWeight: 700 }}>{entry.name}</span>
                    {selected && <Check size={13} color="var(--accent-mint)" />}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.5 }}>{entry.description}</div>
                  {entry.categories.length > 0 && amountValue > 0 && (
                    <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                      {entry.categories.map(category => (
                        <span key={category.name} style={{
                          fontSize: 10, padding: '2px 8px', borderRadius: 20,
                          background: `${category.color}22`, color: category.color,
                        }}>
                          {category.name} {fmt(roundMoney(amountValue * category.percent / 100))}
                        </span>
                      ))}
                    </div>
                  )}
                </button>
              );
            })}
          </div>

          <div className="modal-actions" style={{ display: 'flex', gap: 10, marginTop: 18 }}>
            <button className="btn-secondary" onClick={() => setStep(1)} style={{ flex: 1 }}>Back</button>
            <button className="btn-primary" onClick={handleFinish} disabled={busy} style={{ flex: 2 }}>
              {busy ? 'Setting up…' : 'Start budgeting'}
            </button>
          </div>
        </>
      )}

      <div style={{ color: 'var(--text-muted)', fontSize: 11, marginTop: 14, lineHeight: 1.6 }}>
        Everything stays on this device. Your income, categories and spending are
        stored in this browser and never sent anywhere.
      </div>
    </div>
  );
}
