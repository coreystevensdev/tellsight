'use client';

import { useEffect, useState, type FormEvent } from 'react';

import type { OrgFinancials } from 'shared/types';
import { apiClient, ApiClientError } from '@/lib/api-client';

export function formatCurrency(amount: number | undefined | null): string {
  if (amount == null) return '';
  return `$${amount.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export function parseCurrency(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const amount = Number(cleaned);
  return Number.isFinite(amount) ? amount : null;
}

function formatDateForInput(iso: string | undefined): string {
  return iso ? iso.slice(0, 10) : '';
}

export function useFinancialsForm() {
  const [loading, setLoading] = useState(true);
  const [cash, setCash] = useState('');
  const [fixedCosts, setFixedCosts] = useState('');
  const [started, setStarted] = useState('');
  const [asOf, setAsOf] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const response = await apiClient<OrgFinancials>('/org/financials');
        setCash(formatCurrency(response.data.cashOnHand));
        setFixedCosts(formatCurrency(response.data.monthlyFixedCosts));
        setAsOf(formatDateForInput(response.data.cashAsOfDate));
        setStarted(formatDateForInput(response.data.businessStartedDate));
      } catch (loadError) {
        setFlash({
          kind: 'error',
          message: loadError instanceof Error ? loadError.message : 'Could not load financials.',
        });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const parsedCash = parseCurrency(cash);
  const parsedFixedCosts = parseCurrency(fixedCosts);

  async function saveFinancials(event: FormEvent) {
    event.preventDefault();
    if (submitting || (parsedFixedCosts != null && parsedFixedCosts > 9_999_999)) return;

    setSubmitting(true);
    setFlash(null);
    const updates: Record<string, unknown> = {};
    if (parsedCash != null && parsedCash > 0) updates.cashOnHand = parsedCash;
    if (parsedFixedCosts != null && parsedFixedCosts >= 0 && parsedFixedCosts <= 9_999_999) {
      updates.monthlyFixedCosts = parsedFixedCosts;
    }
    if (started) updates.businessStartedDate = started;
    if (updates.cashOnHand != null) updates.cashAsOfDate = new Date().toISOString();

    try {
      await apiClient('/org/financials', {
        method: 'PUT',
        body: JSON.stringify(updates),
      });
      setFlash({ kind: 'ok', message: 'Financial baseline updated.' });
      if (updates.cashAsOfDate) setAsOf(formatDateForInput(updates.cashAsOfDate as string));
    } catch (saveError) {
      if (saveError instanceof ApiClientError && saveError.status === 403) {
        setFlash({
          kind: 'error',
          message: 'Only organization owners can edit the financial baseline.',
        });
      } else {
        setFlash({
          kind: 'error',
          message: saveError instanceof Error ? saveError.message : 'Could not save.',
        });
      }
    } finally {
      setSubmitting(false);
    }
  }

  return {
    loading,
    cash,
    setCash,
    fixedCosts,
    setFixedCosts,
    started,
    setStarted,
    asOf,
    submitting,
    flash,
    parsedFixedCosts,
    saveFinancials,
  };
}
