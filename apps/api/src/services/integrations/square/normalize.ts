import type { NormalizedSquareRow, SquareMoney, SquareOrder, SquareResourceType } from './types.js';

// ISO 4217 currencies with no minor unit: the amount Square sends is already
// whole units. Everything else Square settles in has two, so 2 is the default.
// Three-decimal currencies (the Gulf dinars) would be wrong here, and are left
// out because Square does not onboard sellers in those countries; if that
// changes this set needs a sibling rather than a nudge.
const ZERO_DECIMAL = new Set([
  'BIF',
  'CLP',
  'DJF',
  'GNF',
  'JPY',
  'KMF',
  'KRW',
  'MGA',
  'PYG',
  'RWF',
  'UGX',
  'VND',
  'VUV',
  'XAF',
  'XOF',
  'XPF',
]);

/**
 * Square sends money as an integer in the currency's smallest unit, which is
 * cents for USD and the yen itself for JPY. Dividing by 100 unconditionally is
 * a hundredfold error on a zero-decimal currency and would never surface in
 * testing done in dollars.
 *
 * The conversion is string surgery rather than arithmetic on purpose: dividing
 * a large integer by 100 in floating point loses exactness, and these values
 * land in a numeric DB column where that shows up.
 */
export function moneyToDecimal(money: SquareMoney | undefined): string | null {
  if (!money || typeof money.amount !== 'number' || !Number.isFinite(money.amount)) return null;

  const exponent = ZERO_DECIMAL.has(money.currency) ? 0 : 2;
  const sign = money.amount < 0 ? '-' : '';
  const digits = Math.abs(Math.trunc(money.amount))
    .toString()
    .padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = exponent === 0 ? '' : `.${digits.slice(digits.length - exponent)}`;

  return `${sign}${whole}${fraction}`;
}

// An order's own category is whatever the seller sells, so the first line
// item's name is the most specific honest label available. Square allows an
// order with no line items (a bare payment), and calling that "Uncategorized"
// is better than dropping revenue on the floor.
function orderCategory(order: SquareOrder): string {
  const first = order.line_items?.[0];
  return first?.name?.trim() || 'Uncategorized';
}

function orderLabel(order: SquareOrder): string | null {
  const items = order.line_items ?? [];
  if (items.length === 0) return null;
  if (items.length === 1) return items[0]!.name?.trim() || null;
  return `${items[0]!.name?.trim() || 'Item'} and ${items.length - 1} more`;
}

// closed_at is when the sale actually completed; created_at is when the order
// was opened, which for a tab or a pickup can be a different day. Falling back
// matters because an order can be COMPLETED with closed_at absent.
function orderDate(order: SquareOrder): Date | null {
  const raw = order.closed_at ?? order.created_at;
  if (!raw) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

function row(
  order: SquareOrder,
  resourceType: SquareResourceType,
  sourceId: string,
  date: Date,
  amount: string,
  category: string,
  parentCategory: 'Income' | 'Expenses',
  label: string | null,
  currency: string,
): NormalizedSquareRow {
  return {
    sourceType: 'square',
    sourceId,
    date,
    amount,
    category,
    parentCategory,
    label,
    metadata: {
      square_id: sourceId,
      resourceType,
      locationId: order.location_id,
      currency,
    },
  };
}

export function normalizeOrders(orders: SquareOrder[]): NormalizedSquareRow[] {
  const out: NormalizedSquareRow[] = [];

  for (const order of orders) {
    const date = orderDate(order);
    if (!date) continue;

    // net_amounts is receipts after discounts and refunds; total_money is what
    // was rung up. Net is the revenue figure the dashboard means, so it wins
    // when Square provides it.
    const money = order.net_amounts?.total_money ?? order.total_money;
    const amount = moneyToDecimal(money);

    // Refunding a payment makes Square write a second order whose net is
    // negative, and the refund itself already arrives on the original order's
    // refunds[]. Taking both files the same event twice, once as negative
    // revenue and once as an expense. Only positive nets are sales.
    if (amount !== null && Number(amount) > 0) {
      out.push(
        row(
          order,
          'order',
          order.id,
          date,
          amount,
          orderCategory(order),
          'Income',
          orderLabel(order),
          money!.currency,
        ),
      );
    }

    for (const refund of order.refunds ?? []) {
      const refundAmount = moneyToDecimal(refund.amount_money);
      if (refundAmount === null) continue;

      const refundedAt = refund.created_at ? new Date(refund.created_at) : date;
      out.push(
        row(
          order,
          'refund',
          refund.id,
          Number.isNaN(refundedAt.getTime()) ? date : refundedAt,
          // A refund is recorded as a positive expense, never a negative sale.
          refundAmount.startsWith('-') ? refundAmount.slice(1) : refundAmount,
          'Refund',
          'Expenses',
          refund.reason?.trim() || null,
          refund.amount_money!.currency,
        ),
      );
    }
  }

  return out;
}
