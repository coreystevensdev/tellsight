export interface ShopifyMoney {
  amount: string;
  currencyCode: string;
}

export interface ShopifyLineItem {
  id: string;
  title: string;
  quantity: number;
  originalTotalSet?: { shopMoney: ShopifyMoney };
}

export interface ShopifyRefund {
  id: string;
  createdAt: string;
  totalRefundedSet?: { shopMoney: ShopifyMoney };
  note?: string | null;
}

export interface ShopifyOrder {
  id: string;
  name: string; // e.g. "#1001"
  createdAt: string;
  updatedAt: string;
  displayFinancialStatus?: string;
  currentTotalPriceSet?: { shopMoney: ShopifyMoney };
  customer?: { displayName?: string } | null;
  lineItems?: { edges: { node: ShopifyLineItem }[] };
  refunds?: ShopifyRefund[];
}

export interface ShopifyProductVariant {
  id: string;
  title: string;
  price: string;
  inventoryQuantity?: number | null;
}

export interface ShopifyProduct {
  id: string;
  title: string;
  updatedAt: string;
  productType?: string | null;
  totalInventory?: number | null;
  variants?: { edges: { node: ShopifyProductVariant }[] };
}

export type ShopifyResourceType = 'order' | 'refund' | 'product';

export interface NormalizedShopifyRow {
  sourceType: 'shopify';
  sourceId: string;
  date: Date;
  amount: string;
  category: string;
  // Orders are revenue; refunds reduce it, so they land on the Expenses side
  // of the dashboard's breakdown rather than as negative Income (DataRow
  // amounts are always positive, sign lives entirely in parentCategory).
  // Inventory is a point-in-time valuation, not a transaction, so it lands
  // under Other rather than pretending it's income or an expense.
  parentCategory: 'Income' | 'Expenses' | 'Other';
  label: string | null;
  metadata: {
    shopify_id: string;
    resourceType: ShopifyResourceType;
    orderName: string | null;
    financialStatus: string | null;
  };
}
