import { describe, it, expect } from 'vitest';

import { normalizeOrder, normalizeOrders, normalizeProduct, normalizeProducts } from './normalize.js';
import type { ShopifyOrder, ShopifyProduct } from './types.js';

function makeOrder(overrides: Partial<ShopifyOrder> = {}): ShopifyOrder {
  return {
    id: 'gid://shopify/Order/1',
    name: '#1001',
    createdAt: '2026-04-10T12:00:00Z',
    updatedAt: '2026-04-10T12:00:00Z',
    displayFinancialStatus: 'PAID',
    currentTotalPriceSet: { shopMoney: { amount: '120.00', currencyCode: 'USD' } },
    customer: { displayName: 'Jane Doe' },
    lineItems: {
      edges: [
        {
          node: {
            id: 'gid://shopify/LineItem/1',
            title: 'Ceramic Mug',
            quantity: 2,
            originalTotalSet: { shopMoney: { amount: '80.00', currencyCode: 'USD' } },
          },
        },
        {
          node: {
            id: 'gid://shopify/LineItem/2',
            title: 'Tote Bag',
            quantity: 1,
            originalTotalSet: { shopMoney: { amount: '40.00', currencyCode: 'USD' } },
          },
        },
      ],
    },
    refunds: [],
    ...overrides,
  };
}

describe('normalizeOrder', () => {
  it('fans out one row per line item, matching the QuickBooks per-line convention', () => {
    const rows = normalizeOrder(makeOrder());
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      sourceId: 'order-gid://shopify/Order/1-gid://shopify/LineItem/1',
      category: 'Ceramic Mug',
      amount: '80.00',
      parentCategory: 'Income',
      label: 'Jane Doe',
    });
    expect(rows[1]).toMatchObject({ category: 'Tote Bag', amount: '40.00' });
  });

  it('falls back to a single synthetic row for an order with no line items', () => {
    const rows = normalizeOrder(makeOrder({ lineItems: { edges: [] } }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceId: 'order-gid://shopify/Order/1',
      category: 'Sales',
      amount: '120.00',
      parentCategory: 'Income',
    });
  });

  it('falls back to the order name as the label when there is no customer', () => {
    const rows = normalizeOrder(makeOrder({ customer: null }));
    expect(rows[0]!.label).toBe('#1001');
  });

  it('lands a refund on the Expenses side, not as negative Income', () => {
    const rows = normalizeOrder(
      makeOrder({
        refunds: [
          {
            id: 'gid://shopify/Refund/1',
            createdAt: '2026-04-12T09:00:00Z',
            totalRefundedSet: { shopMoney: { amount: '40.00', currencyCode: 'USD' } },
          },
        ],
      }),
    );

    const refundRow = rows.find((r) => r.metadata.resourceType === 'refund');
    expect(refundRow).toMatchObject({
      sourceId: 'refund-gid://shopify/Refund/1',
      category: 'Refunds',
      amount: '40.00',
      parentCategory: 'Expenses',
      label: '#1001',
    });
    expect(Number(refundRow!.amount)).toBeGreaterThan(0);
  });

  it('skips a zero-amount refund (e.g. a restock-only refund with no money moved)', () => {
    const rows = normalizeOrder(
      makeOrder({
        refunds: [
          {
            id: 'gid://shopify/Refund/2',
            createdAt: '2026-04-12T09:00:00Z',
            totalRefundedSet: { shopMoney: { amount: '0.00', currencyCode: 'USD' } },
          },
        ],
      }),
    );
    expect(rows.some((r) => r.metadata.resourceType === 'refund')).toBe(false);
  });
});

describe('normalizeOrders', () => {
  it('flattens multiple orders into one row array', () => {
    const rows = normalizeOrders([makeOrder({ id: 'a' }), makeOrder({ id: 'b' })]);
    expect(rows).toHaveLength(4);
  });
});

function makeProduct(overrides: Partial<ShopifyProduct> = {}): ShopifyProduct {
  return {
    id: 'gid://shopify/Product/1',
    title: 'Ceramic Mug',
    updatedAt: '2026-04-10T12:00:00Z',
    productType: 'Drinkware',
    totalInventory: 50,
    variants: {
      edges: [
        { node: { id: 'gid://shopify/ProductVariant/1', title: 'Default', price: '20.00', inventoryQuantity: 50 } },
      ],
    },
    ...overrides,
  };
}

describe('normalizeProduct', () => {
  const syncedAt = new Date('2026-04-15T00:00:00Z');

  it('values a single-variant product as price times inventory quantity', () => {
    const rows = normalizeProduct(makeProduct(), syncedAt);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceId: 'product-gid://shopify/ProductVariant/1',
      amount: '1000.00',
      category: 'Drinkware',
      parentCategory: 'Other',
      label: 'Ceramic Mug',
      date: syncedAt,
    });
  });

  it('includes the variant title in the label when a product has more than one variant', () => {
    const rows = normalizeProduct(
      makeProduct({
        variants: {
          edges: [
            { node: { id: 'v1', title: 'Small', price: '15.00', inventoryQuantity: 10 } },
            { node: { id: 'v2', title: 'Large', price: '20.00', inventoryQuantity: 5 } },
          ],
        },
      }),
      syncedAt,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.label).toBe('Ceramic Mug (Small)');
    expect(rows[1]!.label).toBe('Ceramic Mug (Large)');
  });

  it('falls back to "Inventory" as the category when productType is empty', () => {
    const rows = normalizeProduct(makeProduct({ productType: null }), syncedAt);
    expect(rows[0]!.category).toBe('Inventory');
  });

  it('skips a variant with no inventory tracking (inventoryQuantity is null)', () => {
    const rows = normalizeProduct(
      makeProduct({ variants: { edges: [{ node: { id: 'v1', title: 'Default', price: '20.00', inventoryQuantity: null } }] } }),
      syncedAt,
    );
    expect(rows).toHaveLength(0);
  });

  it('uses a stable sourceId across syncs, so a later sync updates the row instead of duplicating it', () => {
    const firstSync = normalizeProduct(makeProduct(), new Date('2026-04-15T00:00:00Z'));
    const secondSync = normalizeProduct(makeProduct(), new Date('2026-04-16T00:00:00Z'));
    expect(firstSync[0]!.sourceId).toBe(secondSync[0]!.sourceId);
  });
});

describe('normalizeProducts', () => {
  it('flattens multiple products into one row array', () => {
    const rows = normalizeProducts([makeProduct({ id: 'a' }), makeProduct({ id: 'b' })], new Date());
    expect(rows).toHaveLength(2);
  });
});
