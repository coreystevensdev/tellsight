export interface PlaidPersonalFinanceCategory {
  primary: string;
  detailed: string;
  confidence_level?: string;
}

export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  // Plaid's sign convention is the opposite of a bank statement's: a positive
  // amount is money leaving the account. normalize.ts is where that flips.
  amount: number;
  iso_currency_code: string | null;
  unofficial_currency_code: string | null;
  date: string;
  authorized_date: string | null;
  name: string;
  merchant_name: string | null;
  pending: boolean;
  pending_transaction_id: string | null;
  personal_finance_category: PlaidPersonalFinanceCategory | null;
}

export interface PlaidSyncResponse {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: { transaction_id: string }[];
  next_cursor: string;
  has_more: boolean;
}

export interface PlaidItemPublicTokenExchangeResponse {
  access_token: string;
  item_id: string;
}

export interface PlaidLinkTokenCreateResponse {
  link_token: string;
  expiration: string;
}

export interface PlaidInstitution {
  institution_id: string;
  name: string;
}

export interface PlaidAccountBalances {
  available: number | null;
  current: number | null;
  limit: number | null;
  iso_currency_code: string | null;
  unofficial_currency_code: string | null;
}

export interface PlaidAccount {
  account_id: string;
  name: string;
  mask: string | null;
  // 'depository' | 'credit' | 'loan' | 'investment' and others. Left as a string
  // rather than a union: Plaid adds types, and an unrecognised one must fall
  // through the depository filter in balances.ts rather than fail to parse.
  type: string;
  subtype: string | null;
  balances: PlaidAccountBalances;
}

export interface PlaidBalanceResponse {
  accounts: PlaidAccount[];
}

export interface PlaidErrorBody {
  error_type?: string;
  error_code?: string;
  error_message?: string;
  display_message?: string | null;
}

// 'initial' is the token exchange's first sync, distinct from the manual button
// even though both used to enqueue 'manual'. Conflating them meant the connector
// had no way to tell a first connect from a re-sync, which is why Plaid was the
// only one that never claimed the dashboard for an org's first real source
// (DW-296).
export type PlaidSyncTrigger = 'initial' | 'manual' | 'scheduled' | 'backfill';

export interface PlaidSyncOutcome {
  rowsSynced: number;
  removed: number;
  cursor: string;
}
