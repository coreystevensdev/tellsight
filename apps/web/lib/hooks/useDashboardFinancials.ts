'use client';

import useSWR from 'swr';
import type { OrgFinancials } from 'shared/types';

import { apiClient } from '@/lib/api-client';

interface UseDashboardFinancialsOptions {
  hasAuth: boolean;
  hasAnyData: boolean;
  hasMarginSignal: boolean;
  onSaved: () => void;
}

export function useDashboardFinancials({
  hasAuth,
  hasAnyData,
  hasMarginSignal,
  onSaved,
}: UseDashboardFinancialsOptions) {
  // The public seed dashboard has data but no authenticated org. Gating on
  // both values prevents a 401 followed by an unnecessary token refresh.
  const { data: financials, mutate: refreshFinancials } = useSWR<OrgFinancials>(
    hasAuth && hasAnyData ? '/org/financials' : null,
    async (key: string) => (await apiClient<OrgFinancials>(key)).data,
    { revalidateOnFocus: false },
  );

  // History only contributes to the runway thumbnail once a balance exists.
  const { data: cashHistory, mutate: refreshCashHistory } = useSWR<
    { balance: number; asOfDate: string }[]
  >(
    hasAnyData && financials?.cashOnHand != null ? '/org/financials/cash-history?limit=24' : null,
    async (key: string) => (await apiClient<{ balance: number; asOfDate: string }[]>(key)).data,
    { revalidateOnFocus: false },
  );

  // The server still decides staleness and thin-history suppression; this
  // client gate only skips requests that cannot form a forecast at all.
  const { data: cashForecastResponse, mutate: refreshCashForecast } = useSWR<{
    forecast: { balance: number; asOfDate: string }[];
  } | null>(
    hasAnyData && financials?.cashOnHand != null && financials?.cashAsOfDate != null
      ? '/org/financials/cash-forecast?months=3'
      : null,
    async (key: string) =>
      (
        await apiClient<{
          forecast: { balance: number; asOfDate: string }[];
        } | null>(key)
      ).data,
    { revalidateOnFocus: false },
  );

  const needsCashBalance = hasAnyData && financials !== undefined && !financials.cashOnHand;
  const hasBalance = !!financials?.cashAsOfDate;
  const needsBreakEvenEnable =
    hasAnyData &&
    hasMarginSignal &&
    financials !== undefined &&
    financials.monthlyFixedCosts == null;

  async function saveFinancials(
    update: Partial<Pick<OrgFinancials, 'cashOnHand' | 'monthlyFixedCosts'>>,
  ) {
    await apiClient('/org/financials', {
      method: 'PUT',
      body: JSON.stringify(update),
    });
    await Promise.all([refreshFinancials(), refreshCashHistory(), refreshCashForecast()]);
    onSaved();
  }

  return {
    cashAsOfDate: financials?.cashAsOfDate ?? null,
    cashHistory,
    cashForecast: cashForecastResponse?.forecast,
    needsCashBalance,
    hasBalance,
    needsBreakEvenEnable,
    saveCashBalance: (cashOnHand: number) => saveFinancials({ cashOnHand }),
    saveMonthlyFixedCosts: (monthlyFixedCosts: number) => saveFinancials({ monthlyFixedCosts }),
  };
}
