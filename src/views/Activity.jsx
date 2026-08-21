import { CalendarDays, CreditCard, ListOrdered } from 'lucide-react';

import { Tabs } from '../components/ui';
import Transactions from './Transactions';
import Calendar from './Calendar';
import Subscriptions from './Subscriptions';

/**
 * Everything that is money moving, in one place.
 *
 * These were three nav entries, and the split never held up: a subscription is
 * a transaction that hasn't happened yet, and the calendar is the same set of
 * events on a grid instead of a list. Reading one usually meant wanting
 * another, which on a phone is two taps through a drawer each way.
 *
 * The tab bar is the whole of this file's job. Each panel is the view it always
 * was, rendered unchanged — the point was to stop them being three destinations,
 * not to rewrite them.
 */
const TABS = [
  { id: 'transactions',  label: 'Transactions',  Icon: ListOrdered },
  { id: 'calendar',      label: 'Calendar',      Icon: CalendarDays },
  { id: 'subscriptions', label: 'Subscriptions', Icon: CreditCard },
];

export default function Activity({
  tab = 'transactions',
  onTabChange,
  categories = [],
  transactions = [],
  subscriptions = [],
  incomes = [],
  onDeleteTransaction,
  onEditTransaction,
  onAddTransaction,
  onRepeatTransaction,
  onBulkAdd,
  onImportStatement,
  onAddSubscription,
  onEditSubscription,
  onDeleteSubscription,
  onToggleSubscription,
  onAddExpenseOn,
}) {
  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Tabs label="Activity sections" tabs={TABS} value={tab} onChange={onTabChange} />

      {tab === 'transactions' && (
        <Transactions
          transactions={transactions}
          categories={categories}
          onDelete={onDeleteTransaction}
          onEdit={onEditTransaction}
          onAdd={onAddTransaction}
          onRepeat={onRepeatTransaction}
          onBulkAdd={onBulkAdd}
          onImportStatement={onImportStatement}
          onAddSubscription={onAddSubscription}
        />
      )}

      {tab === 'calendar' && (
        <Calendar
          categories={categories}
          incomes={incomes}
          subscriptions={subscriptions}
          transactions={transactions}
          onAddSubscription={onAddSubscription}
          onEditSubscription={onEditSubscription}
          onDeleteSubscription={onDeleteSubscription}
          onToggleSubscription={onToggleSubscription}
          onAddExpenseOn={onAddExpenseOn}
          onEditTransaction={onEditTransaction}
        />
      )}

      {tab === 'subscriptions' && (
        <Subscriptions
          categories={categories}
          subscriptions={subscriptions}
          onAddSubscription={onAddSubscription}
          onEditSubscription={onEditSubscription}
          onDeleteSubscription={onDeleteSubscription}
          onToggleSubscription={onToggleSubscription}
        />
      )}
    </div>
  );
}
