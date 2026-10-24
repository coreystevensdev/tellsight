'use client';

import { useEffect, useState } from 'react';
import { apiClient, ApiClientError } from '@/lib/api-client';
import type { CategoryPlan, ChartData } from 'shared/types';
import { BackLink } from '@/components/common/BackLink';

// Amounts are held as the strings the owner typed, not as numbers, so a
// half-typed "2,4" survives a re-render and an empty field stays empty rather
// than becoming 0. Empty means no plan, which is what the table means too: a
// row exists or it does not.
type Draft = Record<string, string>;

function formatAmount(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function parseAmount(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export default function CategoryPlans() {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<string[]>([]);
  const [saved, setSaved] = useState<Draft>({});
  const [draft, setDraft] = useState<Draft>({});
  const [inData, setInData] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [flash, setFlash] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        // Both at once: the plans are the values, the chart payload is the only
        // place that knows which categories the owner's data actually contains.
        const [plansRes, chartRes] = await Promise.all([
          apiClient<CategoryPlan[]>('/org/category-plans'),
          apiClient<ChartData>('/dashboard/charts'),
        ]);

        const current: Draft = {};
        for (const p of plansRes.data) current[p.category] = formatAmount(p.plannedMonthly);

        const available = chartRes.data.availableCategories ?? [];
        setInData(new Set(available));

        // A plan can outlive the category it was set for, because plans are not
        // tied to a dataset. Those still belong on screen or there is no way to
        // remove them.
        const union = [...new Set([...available, ...Object.keys(current)])].sort();
        setRows(union);
        setSaved(current);
        setDraft(current);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Could not load spending plans.';
        setFlash({ kind: 'error', message: msg });
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const invalid = Object.entries(draft).filter(([, v]) => {
    if (!v.trim()) return false;
    const n = parseAmount(v);
    return n === null || n > 9_999_999;
  });

  const changed = rows.filter((c) => (draft[c] ?? '').trim() !== (saved[c] ?? '').trim());

  async function savePlans(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || invalid.length > 0 || changed.length === 0) return;

    setSubmitting(true);
    setFlash(null);

    // Clearing a field is a delete, not an empty plan. PUT only upserts what it
    // is given, so a cleared row has to be removed explicitly or it keeps its
    // old value on the server.
    const toSet = changed
      .filter((c) => (draft[c] ?? '').trim())
      .map((c) => ({ category: c, plannedMonthly: parseAmount(draft[c]!)! }));
    const toRemove = changed.filter((c) => !(draft[c] ?? '').trim() && (saved[c] ?? '').trim());

    try {
      if (toSet.length > 0) {
        await apiClient<CategoryPlan[]>('/org/category-plans', {
          method: 'PUT',
          body: JSON.stringify({ plans: toSet }),
        });
      }
      for (const category of toRemove) {
        await apiClient(`/org/category-plans/${encodeURIComponent(category)}`, { method: 'DELETE' });
      }

      const next: Draft = {};
      for (const c of rows) {
        const v = (draft[c] ?? '').trim();
        if (v) next[c] = formatAmount(parseAmount(v)!);
      }
      setSaved(next);
      setDraft(next);
      setFlash({ kind: 'ok', message: 'Spending plans saved.' });
    } catch (err) {
      const msg =
        err instanceof ApiClientError && err.status === 403
          ? 'Only organization owners can change spending plans.'
          : err instanceof Error
            ? err.message
            : 'Could not save spending plans.';
      setFlash({ kind: 'error', message: msg });
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-2xl px-6 py-8">
        <BackLink />
        <div className="mt-6 h-6 w-48 animate-pulse rounded bg-muted" />
        <div className="mt-6 space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-10 animate-pulse rounded bg-muted" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-6 py-8">
      <BackLink />
      <div className="mb-6">
        <h1 className="font-serif text-2xl font-medium text-foreground">Spending plans</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Set what you intend to spend each month in a category, and your weekly digest will tell you
          where you landed against it. Only organization owners can change these.
        </p>
      </div>

      {flash && (
        <p
          role="status"
          className={
            flash.kind === 'ok'
              ? 'mb-5 text-sm text-foreground'
              : 'mb-5 text-sm text-destructive'
          }
        >
          {flash.message}
        </p>
      )}

      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Upload data or connect an account first, and the categories you can plan against will show
          up here.
        </p>
      ) : (
        <form onSubmit={savePlans}>
          <div className="border-t border-border">
            {rows.map((category) => {
              const value = draft[category] ?? '';
              const bad = value.trim() !== '' && (parseAmount(value) === null || parseAmount(value)! > 9_999_999);
              const gone = !inData.has(category);
              return (
                <div
                  key={category}
                  className="flex items-baseline justify-between gap-4 border-b border-border py-3"
                >
                  <label htmlFor={`plan-${category}`} className="font-serif text-foreground">
                    {category}
                    {gone && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        not in your current data
                      </span>
                    )}
                  </label>
                  <div className="flex items-baseline gap-1.5">
                    <span aria-hidden="true" className="font-mono text-sm text-muted-foreground">
                      $
                    </span>
                    <input
                      id={`plan-${category}`}
                      type="text"
                      inputMode="decimal"
                      value={value}
                      onChange={(e) => setDraft({ ...draft, [category]: e.target.value })}
                      onBlur={() => {
                        const n = parseAmount(value);
                        if (n != null) setDraft({ ...draft, [category]: formatAmount(n) });
                      }}
                      disabled={submitting}
                      placeholder="none"
                      aria-invalid={bad ? 'true' : undefined}
                      aria-label={`Monthly plan for ${category}, in dollars`}
                      className="w-28 rounded-md border border-border bg-background px-2 py-1 text-right font-mono text-sm tabular-nums focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50 aria-invalid:border-destructive"
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-6 flex items-center gap-4">
            <button
              type="submit"
              disabled={submitting || invalid.length > 0 || changed.length === 0}
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
            >
              {submitting ? 'Saving' : 'Save plans'}
            </button>
            {invalid.length > 0 ? (
              <p className="text-sm text-destructive">
                Amounts must be a number up to 9,999,999.
              </p>
            ) : changed.length > 0 ? (
              <p className="text-sm text-muted-foreground">
                {changed.length} unsaved {changed.length === 1 ? 'change' : 'changes'}
              </p>
            ) : null}
          </div>
        </form>
      )}
    </div>
  );
}
