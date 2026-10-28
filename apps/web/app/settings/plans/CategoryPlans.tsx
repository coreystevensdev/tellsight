'use client';

import { BackLink } from '@/components/common/BackLink';
import { formatPlanAmount, parsePlanAmount, useCategoryPlans } from './useCategoryPlans';

export default function CategoryPlans() {
  const plans = useCategoryPlans();

  if (plans.loading) {
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

      {plans.flash && (
        <p
          role="status"
          className={
            plans.flash.kind === 'ok'
              ? 'mb-5 text-sm text-foreground'
              : 'mb-5 text-sm text-destructive'
          }
        >
          {plans.flash.message}
        </p>
      )}

      {plans.rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Upload data or connect an account first, and the categories you can plan against will show
          up here.
        </p>
      ) : (
        <form onSubmit={plans.savePlans}>
          <div className="border-t border-border">
            {plans.rows.map((category) => {
              const value = plans.draft[category] ?? '';
              const bad =
                value.trim() !== '' &&
                (parsePlanAmount(value) === null || parsePlanAmount(value)! > 9_999_999);
              const gone = !plans.inData.has(category);
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
                      onChange={(event) =>
                        plans.setDraft({ ...plans.draft, [category]: event.target.value })
                      }
                      onBlur={() => {
                        const amount = parsePlanAmount(value);
                        if (amount != null) {
                          plans.setDraft({
                            ...plans.draft,
                            [category]: formatPlanAmount(amount),
                          });
                        }
                      }}
                      disabled={plans.submitting}
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
              disabled={
                plans.submitting || plans.invalid.length > 0 || plans.changed.length === 0
              }
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
            >
              {plans.submitting ? 'Saving' : 'Save plans'}
            </button>
            {plans.invalid.length > 0 ? (
              <p className="text-sm text-destructive">
                Amounts must be a number up to 9,999,999.
              </p>
            ) : plans.changed.length > 0 ? (
              <p className="text-sm text-muted-foreground">
                {plans.changed.length} unsaved{' '}
                {plans.changed.length === 1 ? 'change' : 'changes'}
              </p>
            ) : null}
          </div>
        </form>
      )}
    </div>
  );
}
