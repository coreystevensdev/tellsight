import {
  SOI_BENCHMARKS,
  SOI_SOURCE,
  SOI_MARGIN_CAVEAT,
  netMarginPercent,
  payrollSharePercent,
  SCORP_BENCHMARKS,
  SCORP_SOURCE,
  SCORP_ENTITY_CAVEAT,
  employerNetMarginPercent,
  employerPayrollSharePercent,
  rentSharePercent,
  depreciationSharePercent,
  interestSharePercent,
  employerRentSharePercent,
  employerDepreciationSharePercent,
  employerInterestSharePercent,
  advertisingSharePercent,
  repairsSharePercent,
  employerAdvertisingSharePercent,
  employerRepairsSharePercent,
} from 'shared/benchmarks';
import type { BusinessProfile } from 'shared/schemas';

interface IndustryBenchmarkProps {
  businessType?: BusinessProfile['businessType'] | null;
  teamSize?: BusinessProfile['teamSize'] | null;
  className?: string;
}

/**
 * Picks the table whose population the reader is actually in.
 *
 * Sole proprietors take no salary, so SOI Table 1's net income still contains
 * the owner's entire pay. A business with employees is almost certainly an
 * S-corp or an LLC taxed as one, where that salary is deducted before net
 * income, and the two numbers are not measuring the same thing: services runs
 * 39.7% sole-proprietor against 12.9% here.
 *
 * teamSize is a proxy, not the entity type, which onboarding never asks for. A
 * one-person S-corp exists and gets the sole-proprietor figure. The caveat under
 * each number is what carries that, which is also why neither table is allowed
 * to draw a comparison against the reader's own margin.
 *
 * An unknown teamSize keeps the sole-proprietor table, because that was the
 * behaviour before this split and a missing answer is not evidence of employees.
 */
function pickBenchmark(
  businessType: BusinessProfile['businessType'],
  teamSize: BusinessProfile['teamSize'] | null | undefined,
) {
  const hasEmployees = teamSize != null && teamSize !== 'solo';
  if (!hasEmployees) {
    const b = SOI_BENCHMARKS[businessType];
    if (!b) return null;
    return {
      sector: b.sector,
      margin: netMarginPercent(b),
      payroll: payrollSharePercent(b),
      rent: rentSharePercent(b),
      depreciation: depreciationSharePercent(b),
      interest: interestSharePercent(b),
      advertising: advertisingSharePercent(b),
      repairs: repairsSharePercent(b),
      caveat: SOI_MARGIN_CAVEAT,
      source: SOI_SOURCE,
    };
  }
  const b = SCORP_BENCHMARKS[businessType];
  if (!b) return null;
  return {
    sector: b.sector,
    margin: employerNetMarginPercent(b),
    payroll: employerPayrollSharePercent(b),
    rent: employerRentSharePercent(b),
    depreciation: employerDepreciationSharePercent(b),
    interest: employerInterestSharePercent(b),
    advertising: employerAdvertisingSharePercent(b),
    repairs: employerRepairsSharePercent(b),
    caveat: SCORP_ENTITY_CAVEAT,
    source: SCORP_SOURCE,
  };
}

// Reference figures, deliberately not a scoreboard. There is no "you vs them"
// here and no arrow: the product cannot see how a given user books owner
// compensation, so comparing the two numbers would invent a verdict the data
// does not support. The figures are context and the reader draws their own
// conclusion.
export function IndustryBenchmark({ businessType, teamSize, className }: IndustryBenchmarkProps) {
  if (!businessType) return null;
  const picked = pickBenchmark(businessType, teamSize);
  if (!picked || picked.margin === null || picked.payroll === null) return null;

  // These are paid the same way whether or not the owner is on payroll, so
  // unlike the margin above they mean the same thing in both tables. Kept
  // smaller than the two headline figures rather than given equal weight,
  // because interest in particular runs under 1% for most sectors and carries
  // almost no signal at that size. Cash outlays first, then the non-cash and
  // financing lines.
  const costs = [
    { label: 'Rent', value: picked.rent },
    { label: 'Advertising', value: picked.advertising },
    { label: 'Repairs', value: picked.repairs },
    { label: 'Depreciation', value: picked.depreciation },
    { label: 'Interest', value: picked.interest },
  ].filter((c): c is { label: string; value: number } => c.value !== null);

  return (
    <section
      aria-labelledby="industry-benchmark-heading"
      className={`rounded-lg border border-border bg-card p-4 ${className ?? ''}`}
    >
      <h2 id="industry-benchmark-heading" className="font-serif text-sm font-medium text-foreground">
        How your industry reported
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">{picked.sector}</p>
      {/* Tax-return statistics run two to three years behind by construction, and
          the two tables are not even on the same year. The vintage belongs next to
          the figures rather than only in the source line, because the claim is
          about what was filed then, not about the reader's business now. */}
      <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        Tax year {picked.source.taxYear}
      </p>

      <dl className="mt-3 flex flex-wrap gap-x-8 gap-y-3">
        <div>
          <dt className="text-xs text-muted-foreground">Net margin</dt>
          <dd className="font-mono text-lg text-foreground">{picked.margin}%</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Payroll share of receipts</dt>
          <dd className="font-mono text-lg text-foreground">{picked.payroll}%</dd>
        </div>
      </dl>

      {costs.length > 0 && (
        <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-3">
          {costs.map(({ label, value }) => (
            <div key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="font-mono text-sm text-foreground">{value}%</dd>
            </div>
          ))}
        </dl>
      )}

      <p className="mt-3 text-[11px] leading-tight text-muted-foreground">{picked.caveat}</p>

      <p className="mt-2 text-[11px] leading-tight text-muted-foreground">
        {picked.source.publisher}, {picked.source.table}, tax year {picked.source.taxYear}.{' '}
        <a
          href={picked.source.url}
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
