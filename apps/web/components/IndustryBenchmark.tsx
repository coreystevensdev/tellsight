import {
  SOI_BENCHMARKS,
  SOI_SOURCE,
  SOI_MARGIN_CAVEAT,
  netMarginPercent,
  payrollSharePercent,
} from 'shared/benchmarks';
import type { BusinessProfile } from 'shared/schemas';

interface IndustryBenchmarkProps {
  businessType?: BusinessProfile['businessType'] | null;
  className?: string;
}

// Reference figures, deliberately not a scoreboard. There is no "you vs them"
// here and no arrow: the source reports sole proprietorships, whose net income
// still contains the owner's own pay, and Tellsight cannot see whether a given
// user books owner draw as an expense. Comparing the two numbers would invent a
// verdict the data does not support, so the figures are shown as context and the
// reader draws their own conclusion.
export function IndustryBenchmark({ businessType, className }: IndustryBenchmarkProps) {
  const benchmark = businessType ? SOI_BENCHMARKS[businessType] : undefined;
  if (!benchmark) return null;

  const margin = netMarginPercent(benchmark);
  const payroll = payrollSharePercent(benchmark);
  if (margin === null || payroll === null) return null;

  return (
    <section
      aria-labelledby="industry-benchmark-heading"
      className={`rounded-lg border border-border bg-card p-4 ${className ?? ''}`}
    >
      <h2 id="industry-benchmark-heading" className="font-serif text-sm font-medium text-foreground">
        How your industry reported
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">{benchmark.sector}</p>

      <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-3">
        <div>
          <dt className="text-xs text-muted-foreground">Net margin</dt>
          <dd className="font-mono text-lg text-foreground">{margin}%</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Payroll share of receipts</dt>
          <dd className="font-mono text-lg text-foreground">{payroll}%</dd>
        </div>
      </dl>

      <p className="mt-3 text-[11px] leading-tight text-muted-foreground">{SOI_MARGIN_CAVEAT}</p>

      <p className="mt-2 text-[11px] leading-tight text-muted-foreground">
        {SOI_SOURCE.publisher}, {SOI_SOURCE.table}, tax year {SOI_SOURCE.taxYear}.{' '}
        <a
          href={SOI_SOURCE.url}
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 transition-colors hover:text-foreground"
        >
          Source data
        </a>
      </p>
    </section>
  );
}
