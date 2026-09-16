import type { NormalizedShopifyRow, ShopifyOrder, ShopifyProduct } from './types.js';

// One row per line item (matches QuickBooks' per-line fan-out), so revenue
// breaks out by product rather than landing as one opaque "Sales" total per
// order.
export function normalizeOrder(order: ShopifyOrder): NormalizedShopifyRow[] {
  const date = new Date(order.createdAt);
  const label = order.customer?.displayName ?? order.name;
  const lineItems = order.lineItems?.edges ?? [];

  const orderRows: NormalizedShopifyRow[] =
    lineItems.length > 0
      ? lineItems.map(({ node: line }) => ({
          sourceType: 'shopify' as const,
          sourceId: `order-${order.id}-${line.id}`,
          date,
          amount: line.originalTotalSet?.shopMoney.amount ?? '0',
          category: line.title,
          parentCategory: 'Income' as const,
          label,
          metadata: {
            shopify_id: order.id,
            resourceType: 'order' as const,
            orderName: order.name,
            financialStatus: order.displayFinancialStatus ?? null,
          },
        }))
      : [
          {
            sourceType: 'shopify' as const,
            sourceId: `order-${order.id}`,
            date,
            amount: order.currentTotalPriceSet?.shopMoney.amount ?? '0',
            category: 'Sales',
            parentCategory: 'Income' as const,
            label,
            metadata: {
              shopify_id: order.id,
              resourceType: 'order' as const,
              orderName: order.name,
              financialStatus: order.displayFinancialStatus ?? null,
            },
          },
        ];

  // Refunds reduce revenue, they land on the Expenses side of the dashboard's
  // breakdown, not as a negative Income row, DataRow amounts are always
  // positive (see types.ts).
  const refundRows: NormalizedShopifyRow[] = (order.refunds ?? [])
    .filter((refund) => refund.totalRefundedSet && Number(refund.totalRefundedSet.shopMoney.amount) > 0)
    .map((refund) => ({
      sourceType: 'shopify' as const,
      sourceId: `refund-${refund.id}`,
      date: new Date(refund.createdAt),
      amount: refund.totalRefundedSet!.shopMoney.amount,
      category: 'Refunds',
      parentCategory: 'Expenses' as const,
      label: order.name,
      metadata: {
        shopify_id: refund.id,
        resourceType: 'refund' as const,
        orderName: order.name,
        financialStatus: order.displayFinancialStatus ?? null,
      },
    }));

  return [...orderRows, ...refundRows];
}

export function normalizeOrders(orders: ShopifyOrder[]): NormalizedShopifyRow[] {
  return orders.flatMap(normalizeOrder);
}

// Inventory has no transaction date of its own, it's a snapshot. Each
// variant gets one row keyed on a stable sourceId (not one per sync), so a
// daily sync updates the existing row's valuation and date instead of
// accumulating a new one, this is "value as of last sync", not a ledger.
export function normalizeProduct(product: ShopifyProduct, syncedAt: Date): NormalizedShopifyRow[] {
  const variants = product.variants?.edges ?? [];

  return variants
    .filter(({ node: variant }) => variant.inventoryQuantity != null)
    .map(({ node: variant }) => {
      const quantity = variant.inventoryQuantity ?? 0;
      const value = Number(variant.price) * quantity;

      return {
        sourceType: 'shopify' as const,
        sourceId: `product-${variant.id}`,
        date: syncedAt,
        amount: value.toFixed(2),
        category: product.productType?.trim() || 'Inventory',
        parentCategory: 'Other' as const,
        label: variants.length > 1 ? `${product.title} (${variant.title})` : product.title,
        metadata: {
          shopify_id: variant.id,
          resourceType: 'product' as const,
          orderName: null,
          financialStatus: null,
        },
      };
    });
}

export function normalizeProducts(products: ShopifyProduct[], syncedAt: Date): NormalizedShopifyRow[] {
  return products.flatMap((product) => normalizeProduct(product, syncedAt));
}
