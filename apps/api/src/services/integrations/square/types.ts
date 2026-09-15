// Square returns money as an integer in the currency's smallest unit together
// with the currency code, never as a decimal string. Both fields are needed to
// read it, which is why this is one type rather than a bare number.
export interface SquareMoney {
  amount: number;
  currency: string;
}

export interface SquareLocation {
  id: string;
  name?: string;
  status?: string;
  currency?: string;
}

export interface SquareLineItem {
  uid?: string;
  name?: string;
  quantity?: string;
  catalog_object_id?: string;
  variation_name?: string;
  total_money?: SquareMoney;
}

export interface SquareRefund {
  id: string;
  created_at?: string;
  amount_money?: SquareMoney;
  reason?: string | null;
}

export interface SquareOrder {
  id: string;
  location_id: string;
  created_at?: string;
  updated_at?: string;
  closed_at?: string;
  state?: string;
  line_items?: SquareLineItem[];
  refunds?: SquareRefund[];
  net_amounts?: {
    total_money?: SquareMoney;
    tax_money?: SquareMoney;
    discount_money?: SquareMoney;
  };
  total_money?: SquareMoney;
}

export type SquareResourceType = 'order' | 'refund';

export interface NormalizedSquareRow {
  sourceType: 'square';
  sourceId: string;
  date: Date;
  amount: string;
  category: string;
  // Orders are revenue; refunds reduce it, so they land on the Expenses side of
  // the breakdown rather than as negative Income. DataRow amounts are always
  // positive and the sign lives entirely in parentCategory, which is the same
  // convention the Shopify connector uses.
  parentCategory: 'Income' | 'Expenses';
  label: string | null;
  metadata: {
    square_id: string;
    resourceType: SquareResourceType;
    locationId: string;
    currency: string;
  };
}
