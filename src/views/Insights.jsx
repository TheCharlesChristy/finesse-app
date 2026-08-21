import { CalendarRange, History, TrendingUp, Wallet } from 'lucide-react';

import { Tabs } from '../components/ui';
import Forecasting from './Forecasting';
import Review from './Review';

/**
 * Everything the app has to say about time, forward and back.
 *
 * Forecasting already carried three tabs of its own; "Looking Back" was a
 * separate nav entry answering the fourth question in the same family — what
 * actually happened, over months rather than a cycle. Folding it in makes one
 * bar of four rather than a bar and a sibling page, and puts the projection and
 * the record of what really occurred a tap apart, which is where they're most
 * useful.
 *
 * The bar lives here rather than in `Forecasting` so there is exactly one of
 * them; `Forecasting` takes its section as a prop and renders only that panel.
 */
const TABS = [
  { id: 'outlook', label: 'Outlook',      Icon: TrendingUp },
  { id: 'budget',  label: 'Budget',       Icon: Wallet },
  { id: 'history', label: 'History',      Icon: History },
  { id: 'review',  label: 'Looking Back', Icon: CalendarRange },
];

export default function Insights({
  tab = 'outlook',
  onTabChange,
  categories = [],
  settings,
  transactions = [],
  incomes = [],
  incomeEvents = [],
  transfers = [],
  subscriptions = [],
  account = null,
  netWorth = null,
  accountCount = 1,
}) {
  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <Tabs label="Insights sections" tabs={TABS} value={tab} onChange={onTabChange} />

      {tab === 'review' ? (
        <Review
          categories={categories}
          transactions={transactions}
          incomeEvents={incomeEvents}
          subscriptions={subscriptions}
        />
      ) : (
        <Forecasting
          tab={tab}
          categories={categories}
          settings={settings}
          transactions={transactions}
          incomes={incomes}
          incomeEvents={incomeEvents}
          transfers={transfers}
          subscriptions={subscriptions}
          account={account}
          netWorth={netWorth}
          accountCount={accountCount}
        />
      )}
    </div>
  );
}
