import type { PlaidTransaction } from './types.js';

export type PlaidParentCategory = 'Income' | 'Expenses' | 'Other';

export interface NormalizedPlaidRow {
  sourceId: string;
  date: Date;
  amount: string;
  category: string;
  parentCategory: PlaidParentCategory;
  counterparty: string | null;
  label: string | null;
  metadata: { plaid_transaction_id: string; plaid_account_id: string; pfc_primary: string | null };
}

// Plaid's own taxonomy, the 16 documented `personal_finance_category.primary`
// values. A Record rather than a lookup with a default, for the reason
// SEES_OPERATING_COST is one in computationPrimitives.ts: when Plaid adds a
// primary, this should fail to compile rather than quietly classify it as a cost.
//
// TRANSFER_IN and TRANSFER_OUT are deliberately 'Other'. An owner moving money
// between their own accounts is not revenue and not a cost, and counting it as
// either inflates both sides of every margin the curation layer computes. This
// is the one mapping that would look harmless and ruin the numbers.
const SIDE_BY_PFC: Record<string, PlaidParentCategory> = {
  INCOME: 'Income',
  TRANSFER_IN: 'Other',
  TRANSFER_OUT: 'Other',
  LOAN_PAYMENTS: 'Expenses',
  BANK_FEES: 'Expenses',
  ENTERTAINMENT: 'Expenses',
  FOOD_AND_DRINK: 'Expenses',
  GENERAL_MERCHANDISE: 'Expenses',
  HOME_IMPROVEMENT: 'Expenses',
  MEDICAL: 'Expenses',
  PERSONAL_CARE: 'Expenses',
  GENERAL_SERVICES: 'Expenses',
  GOVERNMENT_AND_NON_PROFIT: 'Expenses',
  TRANSPORTATION: 'Expenses',
  TRAVEL: 'Expenses',
  RENT_AND_UTILITIES: 'Expenses',
};

// Plaid: positive means money left the account, negative means it arrived.
// That is the opposite of how the number reads, and it is the whole reason this
// function exists rather than the sync writing `amount` straight through.
function movedOut(tx: PlaidTransaction): boolean {
  return tx.amount > 0;
}

function side(tx: PlaidTransaction): PlaidParentCategory {
  const pfc = tx.personal_finance_category?.primary;
  const mapped = pfc ? SIDE_BY_PFC[pfc] : undefined;

  // No category, or one Plaid has added since this map was written: fall back to
  // the direction of the money, which is always present. Costs more precision
  // than it does correctness, since an unmapped inflow is still an inflow.
  if (!mapped) return movedOut(tx) ? 'Expenses' : 'Income';

  // A categorised inflow that actually moved money out is a reversal, and an
  // income reversal has no side of its own here. The house rule across the other
  // connectors is that money handed back is a positive Expenses row rather than
  // a negative sale, so it reads the same whichever connector wrote it.
  if (mapped === 'Income' && movedOut(tx)) return 'Expenses';

  // The mirror case: a cost that was refunded to the business. Not Income, which
  // revenueMetrics would report as growth, and 'Other' keeps it out of both
  // sides rather than understating costs by netting it off.
  if (mapped === 'Expenses' && !movedOut(tx)) return 'Other';

  return mapped;
}

function category(tx: PlaidTransaction, parent: PlaidParentCategory): string {
  const pfc = tx.personal_finance_category?.primary;
  if (parent === 'Expenses' && pfc === 'INCOME') return 'Refunds';
  if (!pfc) return 'Uncategorized';

  // Title Case from SCREAMING_SNAKE so the category reads like the ones a CSV
  // and QuickBooks write, which is what the dashboard groups on.
  return pfc
    .toLowerCase()
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Bank transactions to rows.
 *
 * Pending transactions are skipped. Plaid issues a settled transaction with its
 * own `transaction_id` that points back at the pending one through
 * `pending_transaction_id`, so keeping both counts the same purchase twice, and
 * a pending transaction can also vanish without ever settling.
 */
export function normalizePlaidTransactions(txns: PlaidTransaction[]): NormalizedPlaidRow[] {
  const rows: NormalizedPlaidRow[] = [];

  for (const tx of txns) {
    if (tx.pending) continue;

    const parent = side(tx);
    rows.push({
      sourceId: tx.transaction_id,
      date: new Date(`${tx.date}T00:00:00Z`),
      amount: Math.abs(tx.amount).toFixed(2),
      category: category(tx, parent),
      parentCategory: parent,
      // merchant_name only. `name` is the raw bank description, and DW-287's
      // lesson was that a counterparty column holding descriptions cannot be
      // grouped on; it goes in label instead.
      counterparty: tx.merchant_name,
      label: tx.name,
      metadata: {
        plaid_transaction_id: tx.transaction_id,
        plaid_account_id: tx.account_id,
        pfc_primary: tx.personal_finance_category?.primary ?? null,
      },
    });
  }

  return rows;
}
