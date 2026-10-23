import { describe, it, expect, vi } from 'vitest';

// Shopify refuses the WHOLE query with ACCESS_DENIED when it names one field
// outside the granted scopes. It does not omit the field, so a single stray
// one breaks every sync for every connected store.
//
// That shipped: the orders query asked for `customer { displayName }` while the
// app requests read_orders, read_products and read_inventory. It stayed hidden
// because a store with no orders never resolves the field, so the first two
// syncs passed and the failure arrived with the merchant's first real order.
// Nothing compared the query against the scopes, and the fetch is mocked
// everywhere else, so no test could see it.
vi.mock('../../../lib/db.js', () => ({ dbAdmin: {}, db: {} }));
vi.mock('../../../config.js', () => ({
  env: {
    SHOPIFY_CLIENT_ID: 'id',
    SHOPIFY_CLIENT_SECRET: 'secret',
    SHOPIFY_REDIRECT_URI: 'https://example.com/cb',
  },
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { ORDERS_QUERY, PRODUCTS_QUERY } = await import('./sync.js');
const { SHOPIFY_SCOPES } = await import('./oauth.js');

// Field name as it appears in a query, and the scope Shopify demands for it.
const SCOPE_GATED_FIELDS: Record<string, string> = {
  customer: 'read_customers',
  customers: 'read_customers',
  customerJourneySummary: 'read_customers',
  fulfillments: 'read_fulfillments',
  fulfillmentOrders: 'read_assigned_fulfillment_orders',
  draftOrders: 'read_draft_orders',
  priceRules: 'read_price_rules',
  discountApplications: 'read_discounts',
  inventoryItem: 'read_inventory',
  inventoryQuantity: 'read_inventory',
  totalInventory: 'read_inventory',
};

const granted = SHOPIFY_SCOPES.split(',').map((s) => s.trim());

function gatedFieldsIn(query: string): string[] {
  return Object.keys(SCOPE_GATED_FIELDS).filter((field) =>
    new RegExp(`\\b${field}\\b`).test(query),
  );
}

describe.each([
  ['orders', ORDERS_QUERY],
  ['products', PRODUCTS_QUERY],
])('the %s query stays inside the granted scopes', (_name, query) => {
  it('asks for nothing the app has not been granted', () => {
    const missing = gatedFieldsIn(query)
      .map((field) => ({ field, scope: SCOPE_GATED_FIELDS[field]! }))
      .filter(({ scope }) => !granted.includes(scope));

    expect(missing).toEqual([]);
  });
});

describe('the scope guard itself', () => {
  // Without this the test above passes on a query that happens to contain no
  // gated field, which is also what it would do if the regex never matched.
  it('detects a gated field when one is present', () => {
    expect(gatedFieldsIn('{ orders { customer { displayName } } }')).toContain('customer');
  });

  it('every gated field names a scope', () => {
    expect(Object.values(SCOPE_GATED_FIELDS).every(Boolean)).toBe(true);
  });
});
