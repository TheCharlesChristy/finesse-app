import { PiggyBank, ShoppingBag } from 'lucide-react';

import { Tabs } from '../components/ui';
import Goals from './Goals';
import Wishlist from './Wishlist';

/**
 * The two lists of things you want, side by side.
 *
 * A wishlist item and a savings goal are the same intention at different stages
 * — "I'd like this" and "I'm putting money aside for it" — and the app already
 * knew that: `onSaveForItem` turns one into the other. Having them on separate
 * pages meant crossing the nav to follow a decision you'd just made.
 */
const TABS = [
  { id: 'goals',    label: 'Goals',    Icon: PiggyBank },
  { id: 'wishlist', label: 'Wishlist', Icon: ShoppingBag },
];

export default function GoalsWishlist({
  tab = 'goals',
  onTabChange,
  goals = [],
  incomes = [],
  onAddGoal,
  onEditGoal,
  onDeleteGoal,
  onContribute,
  wishlistItems = [],
  wishlistCategories = [],
  categories = [],
  settings,
  onAddItem,
  onEditItem,
  onDeleteItem,
  onAddWishlistCat,
  onEditWishlistCat,
  onDeleteWishlistCat,
  onAddItemToFolder,
  onSaveForItem,
  showConfirm,
}) {
  return (
    <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <Tabs label="Goals and wishlist sections" tabs={TABS} value={tab} onChange={onTabChange} />

      {tab === 'goals' && (
        <Goals
          goals={goals}
          incomes={incomes}
          onAddGoal={onAddGoal}
          onEditGoal={onEditGoal}
          onDeleteGoal={onDeleteGoal}
          onContribute={onContribute}
        />
      )}

      {tab === 'wishlist' && (
        <Wishlist
          items={wishlistItems}
          wishlistCategories={wishlistCategories}
          expenseCategories={categories}
          settings={settings}
          incomes={incomes}
          goals={goals}
          onAddItem={onAddItem}
          onEditItem={onEditItem}
          onDeleteItem={onDeleteItem}
          onAddWishlistCat={onAddWishlistCat}
          onEditWishlistCat={onEditWishlistCat}
          onDeleteWishlistCat={onDeleteWishlistCat}
          onAddItemToFolder={onAddItemToFolder}
          onSaveForItem={onSaveForItem}
          showConfirm={showConfirm}
        />
      )}
    </div>
  );
}
