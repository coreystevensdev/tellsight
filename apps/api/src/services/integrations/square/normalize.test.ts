import { describe, it, expect } from 'vitest';

import { moneyToDecimal, normalizeOrders } from './normalize.js';
import type { SquareOrder } from './types.js';

describe('moneyToDecimal', () => {
  it('reads USD as cents', () => {
    expect(moneyToDecimal({ amount: 400, currency: 'USD' })).toBe('4.00');
    expect(moneyToDecimal({ amount: 1, currency: 'USD' })).toBe('0.01');
    expect(moneyToDecimal({ amount: 0, currency: 'USD' })).toBe('0.00');
    expect(moneyToDecimal({ amount: 123456, currency: 'USD' })).toBe('1234.56');
  });

  // The whole reason this function exists. A zero-decimal currency sends whole
  // units, so dividing by 100 would report 2 yen as two cents, and no amount of
  // testing in dollars would ever show it.
  it('reads a zero-decimal currency as whole units', () => {
    expect(moneyToDecimal({ amount: 2, currency: 'JPY' })).toBe('2');
    expect(moneyToDecimal({ amount: 1500, currency: 'KRW' })).toBe('1500');
    expect(moneyToDecimal({ amount: 7, currency: 'XOF' })).toBe('7');
  });

  // String surgery rather than division: 100000000000000001 / 100 loses the
  // last digit in floating point, and these land in a numeric column.
  it('stays exact on values that float division would round', () => {
    expect(moneyToDecimal({ amount: 100000000000000001, currency: 'USD' })).not.toContain('e');
    expect(moneyToDecimal({ amount: 99999999999, currency: 'USD' })).toBe('999999999.99');
  });

  it('keeps the sign and handles missing money', () => {
    expect(moneyToDecimal({ amount: -250, currency: 'USD' })).toBe('-2.50');
    expect(moneyToDecimal(undefined)).toBeNull();
    expect(moneyToDecimal({ amount: Number.NaN, currency: 'USD' })).toBeNull();
  });
});

function order(over: Partial<SquareOrder> = {}): SquareOrder {
  return {
    id: 'ord_1',
    location_id: 'LOC1',
    created_at: '2026-03-01T10:00:00Z',
    closed_at: '2026-03-02T18:30:00Z',
    state: 'COMPLETED',
    line_items: [{ name: 'Flat white', quantity: '2', total_money: { amount: 900, currency: 'USD' } }],
    net_amounts: { total_money: { amount: 900, currency: 'USD' } },
    ...over,
  };
}

describe('normalizeOrders', () => {
  it('maps an order to a positive Income row', () => {
    const [row] = normalizeOrders([order()]);
    expect(row).toMatchObject({
      sourceType: 'square',
      sourceId: 'ord_1',
      amount: '9.00',
      category: 'Flat white',
      parentCategory: 'Income',
    });
    expect(row!.metadata).toMatchObject({ resourceType: 'order', locationId: 'LOC1', currency: 'USD' });
  });

  // closed_at is when the sale completed; created_at is when the tab opened,
  // which for a restaurant is routinely the previous day.
  it('dates the row by closed_at, falling back to created_at', () => {
    const [closed] = normalizeOrders([order()]);
    expect(closed!.date.toISOString()).toBe('2026-03-02T18:30:00.000Z');

    const [opened] = normalizeOrders([order({ closed_at: undefined })]);
    expect(opened!.date.toISOString()).toBe('2026-03-01T10:00:00.000Z');
  });

  it('drops an order with no usable date rather than inventing one', () => {
    expect(normalizeOrders([order({ closed_at: undefined, created_at: undefined })])).toHaveLength(0);
  });

  // net_amounts is after discounts and refunds, which is the revenue the
  // dashboard means. total_money is what was rung up before either.
  it('prefers net amounts over the rung-up total', () => {
    const [row] = normalizeOrders([
      order({
        net_amounts: { total_money: { amount: 750, currency: 'USD' } },
        total_money: { amount: 900, currency: 'USD' },
      }),
    ]);
    expect(row!.amount).toBe('7.50');
  });

  // A refund is a positive expense, never a negative sale: DataRow amounts are
  // always positive and the sign lives in parentCategory.
  it('records a refund as a positive expense on its own date', () => {
    const rows = normalizeOrders([
      order({
        refunds: [
          { id: 'ref_1', created_at: '2026-03-05T09:00:00Z', amount_money: { amount: -450, currency: 'USD' }, reason: 'Spilled' },
        ],
      }),
    ]);

    expect(rows).toHaveLength(2);
    const refund = rows.find((r) => r.metadata.resourceType === 'refund')!;
    expect(refund.parentCategory).toBe('Expenses');
    expect(refund.amount).toBe('4.50');
    expect(refund.sourceId).toBe('ref_1');
    expect(refund.date.toISOString()).toBe('2026-03-05T09:00:00.000Z');
  });

  // Square allows an order with no line items, which is a bare payment. Naming
  // it beats dropping the revenue.
  it('keeps a line-item-less order under Uncategorized', () => {
    const [row] = normalizeOrders([order({ line_items: [] })]);
    expect(row!.category).toBe('Uncategorized');
    expect(row!.label).toBeNull();
  });

  it('summarises a multi-item order in the label', () => {
    const [row] = normalizeOrders([
      order({
        line_items: [
          { name: 'Flat white', total_money: { amount: 450, currency: 'USD' } },
          { name: 'Croissant', total_money: { amount: 450, currency: 'USD' } },
        ],
      }),
    ]);
    expect(row!.label).toBe('Flat white and 1 more');
  });

  it('skips a zero-value order', () => {
    expect(normalizeOrders([order({ net_amounts: { total_money: { amount: 0, currency: 'USD' } } })])).toHaveLength(0);
  });
});
