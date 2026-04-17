import Link from 'next/link';
import { TellsightLogo } from '@/components/common/TellsightLogo';

function GridBg() {
  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden="true">
      <div
        className="absolute inset-0 opacity-[0.25] dark:opacity-[0.08]"
        style={{
          backgroundImage: 'radial-gradient(circle, var(--color-border) 1px, transparent 1px)',
          backgroundSize: '24px 24px',
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background: 'radial-gradient(ellipse at 70% 20%, transparent 20%, var(--color-background) 70%)',
        }}
      />
    </div>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background">
      {/* Nav */}
      <nav className="sticky top-0 z-40 border-b border-border/50 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 md:px-6">
          <Link href="/" className="flex items-center gap-2 text-lg font-semibold text-foreground">
            <TellsightLogo size={24} />
            Tellsight
          </Link>
          <div className="flex items-center gap-4">
            <Link
              href="/dashboard"
              className="text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Demo
            </Link>
            <Link
              href="/login"
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
            >
              Sign in
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero — oversized headline with live transformation visual */}
      <section className="relative overflow-hidden">
        <GridBg />
        <div className="relative mx-auto max-w-6xl px-4 pt-16 md:px-6 md:pt-28">
          <div className="flex items-center gap-2 text-sm font-medium text-primary">
            <span className="inline-flex h-2 w-2 rounded-full bg-success animate-pulse" aria-hidden="true" />
            Live demo — no signup needed
          </div>

          <h1 className="mt-5 max-w-4xl text-[2.75rem] font-bold leading-[1.05] tracking-[-0.025em] text-foreground md:text-6xl lg:text-7xl">
            Your spreadsheet,
            <br />
            <span className="relative inline-block">
              <span className="relative z-10">actually</span>
              <span
                className="absolute inset-x-0 bottom-[0.08em] -z-0 h-[0.35em] bg-primary/25 dark:bg-primary/30"
                aria-hidden="true"
              />
            </span>{' '}
            explained.
          </h1>

          <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted-foreground md:text-xl">
            Upload a CSV from Square, QuickBooks, or your bank. Get charts in seconds —
            and an AI summary that reads your numbers like a financial analyst.
          </p>

          <div className="mt-9 flex flex-wrap items-center gap-3">
            <Link
              href="/dashboard"
              className="group inline-flex items-center gap-2 rounded-lg bg-foreground px-5 py-3 text-sm font-medium text-background shadow-sm transition-all hover:shadow-md"
            >
              See the demo
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                className="transition-transform group-hover:translate-x-0.5"
                aria-hidden="true"
              >
                <path d="M5 12h14M13 5l7 7-7 7" />
              </svg>
            </Link>
            <Link
              href="/login"
              className="rounded-lg border border-border px-5 py-3 text-sm font-medium text-foreground transition-colors hover:bg-muted"
            >
              Sign in with Google
            </Link>
          </div>

          {/* Transformation preview — shows what the product actually does */}
          <div className="relative mt-16 pb-20 md:mt-20 md:pb-28">
            <div className="grid gap-6 md:grid-cols-[1fr_auto_1.1fr] md:items-center md:gap-4">
              {/* CSV row */}
              <div className="rounded-lg border border-border/60 bg-card p-4 shadow-sm">
                <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M14 3v4a1 1 0 001 1h4" />
                    <path d="M17 21H7a2 2 0 01-2-2V5a2 2 0 012-2h7l5 5v11a2 2 0 01-2 2z" />
                  </svg>
                  revenue.csv
                </div>
                <div className="mt-3 space-y-1 font-mono text-xs leading-relaxed text-card-foreground">
                  <div className="text-muted-foreground">date,amount,category</div>
                  <div>2026-03-12,4820.00,Revenue</div>
                  <div>2026-03-12,1247.50,Payroll</div>
                  <div>2026-03-13,890.00,Supplies</div>
                  <div className="text-muted-foreground">… 247 more rows</div>
                </div>
              </div>

              {/* Arrow connector */}
              <div className="flex justify-center" aria-hidden="true">
                <div className="relative flex items-center justify-center">
                  <svg
                    width="44"
                    height="44"
                    viewBox="0 0 44 44"
                    fill="none"
                    className="rotate-90 text-primary md:rotate-0"
                  >
                    <circle cx="22" cy="22" r="21" stroke="currentColor" strokeWidth="1" strokeDasharray="3 4" opacity="0.3" />
                    <path
                      d="M14 22h16M24 16l6 6-6 6"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
              </div>

              {/* AI insight */}
              <div className="relative rounded-lg border border-border/40 bg-ai-surface p-5 shadow-md">
                <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-wider text-accent-warm">
                  <span className="inline-flex h-1.5 w-1.5 rounded-full bg-accent-warm animate-pulse" aria-hidden="true" />
                  AI analysis
                </div>
                <p className="mt-3 text-sm leading-[1.7] text-card-foreground md:text-[15px]">
                  Revenue grew <span className="font-semibold text-foreground">18%</span> in March —
                  driven by a surge in catering orders on weekends. Payroll held steady, so{' '}
                  <span className="font-semibold text-foreground">margin expanded to 34%</span>.
                  If you&apos;re planning April hires, the weekend volume is your signal.
                </p>
                <p className="mt-4 text-[11px] text-muted-foreground">
                  Every insight links back to the exact numbers it came from.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Deeper insight example — longer, more specific */}
      <section className="relative">
        <div className="mx-auto max-w-6xl px-4 py-16 md:px-6 md:py-24">
          <div className="grid gap-10 md:grid-cols-[1fr_1.3fr] md:items-start md:gap-16">
            <div>
              <p className="text-sm font-medium text-primary">A longer example</p>
              <h2 className="mt-2 text-2xl font-bold text-foreground md:text-3xl">
                It spots patterns you&apos;d miss at a glance.
              </h2>
              <p className="mt-4 text-muted-foreground">
                Real output from a landscaping company&apos;s 12 months of Square data.
                The AI flagged the seasonal dip and connected it to their snow
                removal revenue gap — something a chart alone wouldn&apos;t tell you.
              </p>
              <p className="mt-3 text-sm text-muted-foreground">
                Every insight links back to the exact numbers. Click
                &quot;How I reached this conclusion&quot; to see the statistical basis.
              </p>
            </div>

            <div className="rounded-xl border border-border/40 bg-ai-surface p-5 shadow-lg md:p-7">
              <div className="text-sm font-medium text-foreground/60">AI Analysis</div>
              <div className="mt-3 space-y-3 text-[15px] leading-[1.8] text-card-foreground">
                <p>
                  November revenue dropped <span className="font-semibold text-accent-warm">23%</span> compared
                  to October, but this lines up with a seasonal pattern visible in both years of data.
                </p>
                <p className="text-card-foreground/70">
                  The dip comes from residential landscaping jobs declining as temperatures drop.
                  Snow removal revenue typically starts in the second half of December. If you&apos;re
                  planning crew schedules, the gap between late November and mid-December is
                  where you&apos;ll feel the squeeze.
                </p>
              </div>
              <div className="mt-4 flex items-center gap-2 border-t border-border/30 pt-3">
                <span className="text-xs text-muted-foreground">Based on 847 transactions across 5 expense categories</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* How it works — 3 steps, not 4 features */}
      <section className="border-t border-border/40">
        <div className="mx-auto max-w-6xl px-4 py-16 md:px-6 md:py-24">
          <div className="grid gap-8 md:grid-cols-3 md:gap-12">
            <div>
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">1</div>
              <h3 className="mt-3 text-base font-semibold text-foreground">Upload your CSV</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Export from Square, QuickBooks, Wave, or any tool.
                We need date, amount, and category columns — that&apos;s it.
                Bad rows get flagged, not silently dropped.
              </p>
            </div>

            <div>
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">2</div>
              <h3 className="mt-3 text-base font-semibold text-foreground">See your charts</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Revenue trend, expense breakdown, profit margin,
                year-over-year comparison. Filter by date or category.
                Charts are free forever.
              </p>
            </div>

            <div>
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">3</div>
              <h3 className="mt-3 text-base font-semibold text-foreground">Read what it means</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                AI reads your trends, spots anomalies, and writes a summary
                your business partner would understand. Free tier gets a preview;
                Pro gets the full analysis.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Trust strip — concrete details, not marketing */}
      <section className="border-t border-border/40 bg-muted/30">
        <div className="mx-auto grid max-w-6xl grid-cols-2 gap-px md:grid-cols-4">
          {[
            { label: 'Setup time', value: 'Under 5 minutes' },
            { label: 'Sign in', value: 'Google account' },
            { label: 'Privacy', value: 'Raw data never reaches AI' },
            { label: 'Charts', value: 'Free forever' },
          ].map((stat) => (
            <div key={stat.label} className="bg-background px-6 py-5 text-center">
              <div className="text-sm font-semibold text-foreground">{stat.value}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{stat.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Bottom CTA — short */}
      <section className="border-t border-border/40">
        <div className="mx-auto max-w-6xl px-4 py-16 text-center md:px-6 md:py-20">
          <h2 className="text-2xl font-bold text-foreground">
            The demo is live. Go look at it.
          </h2>
          <p className="mx-auto mt-3 max-w-md text-muted-foreground">
            No signup, no credit card, no &quot;book a call.&quot; It runs on sample data
            from a coffee shop — 12 months of revenue and expenses.
          </p>
          <Link
            href="/dashboard"
            className="mt-7 inline-block rounded-lg bg-primary px-6 py-3 text-sm font-medium text-primary-foreground shadow-sm transition-all hover:bg-primary/90 hover:shadow-md"
          >
            Explore the demo
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border/50">
        <div className="mx-auto max-w-6xl px-4 py-5 md:px-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <TellsightLogo size={16} />
              Tellsight
            </div>
            <p className="text-xs text-muted-foreground">
              AI-powered analytics for small business
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
