import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Bell, BellOff, Send, ShieldAlert } from 'lucide-react';
import type { AlertComplianceMetrics, AlertFireWindowCounts } from './types';

interface Props {
  metrics: AlertComplianceMetrics | null;
}

const numFmt = new Intl.NumberFormat('en-US');

function ratePct(num: number, denom: number): number | null {
  if (denom <= 0) return null;
  return num / denom;
}

function formatRate(rate: number | null, num: number, denom: number): string {
  if (rate === null) return `n/a (${numFmt.format(num)} of 0)`;
  return `${(rate * 100).toFixed(1)}% (${numFmt.format(num)} of ${numFmt.format(denom)})`;
}

// Mirrors apps/api/src/jobs/alerts/ruleKindLabels.ts's RULE_KIND_NOUN_LABELS
// so the admin panel names a rule kind the same way the mute confirmation
// page and CAN-SPAM footer do ("cash runway", not "Runway runs short"). Not
// imported directly, apps/web can't import apps/api code.
const RULE_KIND_NOUN_LABELS: Record<string, string> = {
  runway_runs_short: 'cash runway',
  margin_drops: 'profit margin',
  cash_burn_spikes: 'cash burn rate',
  breakeven_gap_widens: 'break-even gap',
  anomaly_fires: 'unusual transactions',
};

function formatRuleKind(ruleKind: string): string {
  return RULE_KIND_NOUN_LABELS[ruleKind] ?? ruleKind.replace(/_/g, ' ');
}

interface WindowRowProps {
  label: string;
  counts: AlertFireWindowCounts;
  totalRules: number;
}

function WindowRow({ label, counts, totalRules }: WindowRowProps) {
  const suppressedRate = ratePct(counts.quotaSuppressed, counts.fired + counts.quotaSuppressed);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Fired ({label})</CardTitle>
          <Send className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </CardHeader>
        <CardContent>
          <div className="text-xl font-bold" style={{ fontFeatureSettings: '"tnum"' }}>
            {numFmt.format(counts.fired)}
          </div>
          <p className="mt-1 text-xs text-muted-foreground">across {numFmt.format(totalRules)} rules</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle className="text-sm font-medium">Quota-suppressed ({label})</CardTitle>
          <ShieldAlert className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
        </CardHeader>
        <CardContent>
          <div className="text-xl font-bold" style={{ fontFeatureSettings: '"tnum"' }}>
            {formatRate(suppressedRate, counts.quotaSuppressed, counts.fired + counts.quotaSuppressed)}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export function AlertsCompliancePanel({ metrics }: Props) {
  if (!metrics) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Alerts</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Metrics unavailable, the compliance endpoint returned an error or has not been configured yet.
          </p>
        </CardContent>
      </Card>
    );
  }

  const { totalRules, mutedRules, d7, d30, byRuleKind, computedAt } = metrics;
  const mutedRate = ratePct(mutedRules, totalRules);

  return (
    <section aria-labelledby="alerts-compliance-heading" className="space-y-4">
      <div className="flex items-baseline justify-between">
        <h2 id="alerts-compliance-heading" className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">
          Alerts
        </h2>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total rules</CardTitle>
            <Bell className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold" style={{ fontFeatureSettings: '"tnum"' }}>
              {numFmt.format(totalRules)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Muted</CardTitle>
            <BellOff className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </CardHeader>
          <CardContent>
            <div className="text-xl font-bold" style={{ fontFeatureSettings: '"tnum"' }}>
              {formatRate(mutedRate, mutedRules, totalRules)}
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="space-y-3">
        <Card className="bg-muted/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Last 7 days</CardTitle>
          </CardHeader>
          <CardContent>
            <WindowRow label="7d" counts={d7} totalRules={totalRules} />
          </CardContent>
        </Card>

        <Card className="bg-muted/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">Last 30 days</CardTitle>
          </CardHeader>
          <CardContent>
            <WindowRow label="30d" counts={d30} totalRules={totalRules} />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium">Per-rule-kind effectiveness (30d)</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="pb-2 pr-4 font-medium">Rule kind</th>
                <th className="pb-2 pr-4 font-medium">Rules</th>
                <th className="pb-2 pr-4 font-medium">Fired</th>
                <th className="pb-2 pr-4 font-medium">Clicked</th>
                <th className="pb-2 pr-4 font-medium">Click rate</th>
                <th className="pb-2 font-medium">Review</th>
              </tr>
            </thead>
            <tbody>
              {byRuleKind.map((row) => {
                const clickRate = ratePct(row.clicked, row.fired);
                return (
                  <tr key={row.ruleKind} className="border-b border-border/60 last:border-0">
                    <td className="py-2 pr-4">{formatRuleKind(row.ruleKind)}</td>
                    <td className="py-2 pr-4" style={{ fontFeatureSettings: '"tnum"' }}>
                      {numFmt.format(row.totalRules)}
                    </td>
                    <td className="py-2 pr-4" style={{ fontFeatureSettings: '"tnum"' }}>
                      {numFmt.format(row.fired)}
                    </td>
                    <td className="py-2 pr-4" style={{ fontFeatureSettings: '"tnum"' }}>
                      {numFmt.format(row.clicked)}
                    </td>
                    <td className="py-2 pr-4" style={{ fontFeatureSettings: '"tnum"' }}>
                      {formatRate(clickRate, row.clicked, row.fired)}
                    </td>
                    <td className="py-2">
                      {row.candidateDefaultOffRules > 0 ? (
                        <span className="rounded-full bg-warning/10 px-2 py-0.5 text-xs font-medium text-warning">
                          {row.candidateDefaultOffRules} candidate{row.candidateDefaultOffRules === 1 ? '' : 's'} for default-off
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">None</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Computed {new Date(computedAt).toLocaleString()}
      </p>
    </section>
  );
}
