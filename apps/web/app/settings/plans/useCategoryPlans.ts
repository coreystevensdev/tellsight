'use client';

import { useEffect, useState, type FormEvent } from 'react';

import type { CategoryPlan, ChartData } from 'shared/types';
import { apiClient, ApiClientError } from '@/lib/api-client';

type PlanDraft = Record<string, string>;

export function formatPlanAmount(amount: number): string {
  return amount.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function parsePlanAmount(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const amount = Number(cleaned);
  return Number.isFinite(amount) && amount >= 0 ? amount : null;
}

export function useCategoryPlans() {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<string[]>([]);
  const [saved, setSaved] = useState<PlanDraft>({});
  const [draft, setDraft] = useState<PlanDraft>({});
  const [inData, setInData] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const [plansResponse, chartResponse] = await Promise.all([
          apiClient<CategoryPlan[]>('/org/category-plans'),
          apiClient<ChartData>('/dashboard/charts'),
        ]);

        const current: PlanDraft = {};
        for (const plan of plansResponse.data) {
          current[plan.category] = formatPlanAmount(plan.plannedMonthly);
        }

        const available = chartResponse.data.availableCategories ?? [];
        setInData(new Set(available));
        setRows([...new Set([...available, ...Object.keys(current)])].sort());
        setSaved(current);
        setDraft(current);
      } catch (loadError) {
        setFlash({
          kind: 'error',
          message:
            loadError instanceof Error ? loadError.message : 'Could not load spending plans.',
        });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const invalid = Object.entries(draft).filter(([, value]) => {
    if (!value.trim()) return false;
    const amount = parsePlanAmount(value);
    return amount === null || amount > 9_999_999;
  });
  const changed = rows.filter(
    (category) => (draft[category] ?? '').trim() !== (saved[category] ?? '').trim(),
  );

  async function savePlans(event: FormEvent) {
    event.preventDefault();
    if (submitting || invalid.length > 0 || changed.length === 0) return;

    setSubmitting(true);
    setFlash(null);
    const toSet = changed
      .filter((category) => (draft[category] ?? '').trim())
      .map((category) => ({
        category,
        plannedMonthly: parsePlanAmount(draft[category]!)!,
      }));
    const toRemove = changed.filter(
      (category) => !(draft[category] ?? '').trim() && (saved[category] ?? '').trim(),
    );

    try {
      if (toSet.length > 0) {
        await apiClient<CategoryPlan[]>('/org/category-plans', {
          method: 'PUT',
          body: JSON.stringify({ plans: toSet }),
        });
      }
      for (const category of toRemove) {
        await apiClient(`/org/category-plans/${encodeURIComponent(category)}`, {
          method: 'DELETE',
        });
      }

      const next: PlanDraft = {};
      for (const category of rows) {
        const value = (draft[category] ?? '').trim();
        if (value) next[category] = formatPlanAmount(parsePlanAmount(value)!);
      }
      setSaved(next);
      setDraft(next);
      setFlash({ kind: 'ok', message: 'Spending plans saved.' });
    } catch (saveError) {
      const message =
        saveError instanceof ApiClientError && saveError.status === 403
          ? 'Only organization owners can change spending plans.'
          : saveError instanceof Error
            ? saveError.message
            : 'Could not save spending plans.';
      setFlash({ kind: 'error', message });
    } finally {
      setSubmitting(false);
    }
  }

  return {
    loading,
    rows,
    draft,
    setDraft,
    inData,
    submitting,
    flash,
    invalid,
    changed,
    savePlans,
  };
}
