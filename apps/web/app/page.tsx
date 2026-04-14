import Link from 'next/link';
import { TellsightLogo } from '@/components/common/TellsightLogo';

function HeroGlow() {
  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden="true">
      <div
        className="absolute left-1/2 top-0 -translate-x-1/2 h-[600px] w-[900px] opacity-[0.08] dark:opacity-[0.06]"
        style={{
          background: 'radial-gradient(ellipse at center top, var(--color-primary), transparent 70%)',
        }}
      />
      <div
        className="absolute inset-0 opacity-[0.3] dark:opacity-[0.1]"
        style={{
          backgroundImage: 'radial-gradient(circle, var(--color-border) 1px, transparent 1px)',
          backgroundSize: '32px 32px',
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background: 'radial-gradient(ellipse at center, transparent 30%, var(--color-background) 70%)',
        }}
      />
    </div>
  );
}

function DashboardMockup() {
  return (
    <div className="relative">
      {/* glow behind mockup */}
      <div
        className="absolute -inset-8 rounded-3xl opacity-30 blur-2xl dark:opacity-15"
        style={{ background: 'linear-gradient(135deg, var(--color-primary), var(--color-chart-revenue))' }}
        aria-hidden="true"
      />
      <div
        className="relative rounded-2xl border border-border/40 bg-card shadow-2xl overflow-hidden"
        style={{ transform: 'perspective(1200px) rotateY(-4deg) rotateX(2deg)' }}
        aria-hidden="true"
      >
        <div className="p-4 md:p-5">
          {/* KPI row */}
          <div className="grid grid-cols-4 gap-2">
            {[
              { label: 'Revenue', value: '$87.2K', trend: '+12%', up: true },
              { label: 'Expenses', value: '$54.8K', trend: '+3%', up: false },
              { label: 'Net Profit', value: '$32.4K', trend: '+18%', up: true },
              { label: 'Top Expense', value: 'Fuel', trend: '', up: false },
            ].map((kpi) => (
              <div key={kpi.label} className="rounded-lg border border-border/30 bg-background/80 p-2.5">
                <div className="text-[8px] font-medium uppercase tracking-wider text-muted-foreground">{kpi.label}</div>
                <div className="mt-1 text-xs font-bold text-card-foreground" style={{ fontFeatureSettings: '"tnum"' }}>
                  {kpi.value}
                </div>
                {kpi.trend && (
                  <div className={`mt-0.5 text-[8px] font-medium ${kpi.up ? 'text-success' : 'text-destructive'}`}>
                    {kpi.trend}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* chart */}
          <div className="mt-3 rounded-lg border border-border/30 bg-background/80 p-3">
            <div className="flex items-center justify-between">
              <span className="text-[9px] font-semibold text-card-foreground">Revenue Trend</span>
              <span className="rounded-full bg-success/10 px-1.5 py-0.5 text-[7px] font-medium text-success">+12%</span>
            </div>
            <svg viewBox="0 0 300 70" className="mt-2 w-full" fill="none">
              <defs>
                <linearGradient id="rev-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-chart-revenue)" stopOpacity="0.15" />
                  <stop offset="100%" stopColor="var(--color-chart-revenue)" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path
                d="M0,55 C20,52 40,42 60,40 C80,38 100,45 120,30 C140,25 160,32 180,20 C200,22 220,15 240,12 C260,16 280,8 300,5 L300,70 L0,70Z"
                fill="url(#rev-fill)"
              />
              <path
                d="M0,55 C20,52 40,42 60,40 C80,38 100,45 120,30 C140,25 160,32 180,20 C200,22 220,15 240,12 C260,16 280,8 300,5"
                stroke="var(--color-chart-revenue)"
                strokeWidth="2"
                strokeLinecap="round"
              />
              <circle cx="300" cy="5" r="3" fill="var(--color-chart-revenue-dot)" stroke="var(--color-background)" strokeWidth="2" />
            </svg>
          </div>

          {/* AI summary */}
          <div className="mt-3 rounded-lg bg-ai-surface p-3">
            <div className="mb-1.5 text-[9px] font-semibold text-card-foreground">Analysis</div>
            <div className="text-[9px] leading-[1.7] text-card-foreground/80">
              <span className="font-semibold text-accent-warm">Revenue grew 12%</span> month-over-month,
              driven by residential jobs. Fuel costs up{' '}
              <span className="font-semibold text-accent-warm">15%</span> with flat job count —
              check vendor pricing.
            </div>
            <div className="mt-2 border-t border-border/20 pt-1.5">
              <span className="text-[8px] text-muted-foreground">How I reached this conclusion ▾</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function MobilePreview() {
  return (
    <div className="rounded-xl border border-border/40 bg-card p-4 shadow-xl" aria-hidden="true">
      <div className="text-[10px] font-semibold text-card-foreground">Analysis</div>
      <div className="mt-1.5 text-xs leading-[1.7] text-card-foreground/80">
        <span className="font-semibold text-accent-warm">Revenue grew 12%</span> month-over-month.
        Fuel costs up <span className="font-semibold text-accent-warm">15%</span> with flat job count —
        worth checking vendor pricing.
      </div>
      <div className="mt-2.5 flex items-center border-t border-border/20 pt-2">
        <span className="text-[9px] text-muted-foreground">How I reached this conclusion ▾</span>
      </div>
    </div>
  );
}

function FeatureIcon({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
      {children}
    </div>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background">
      {/* Nav */}
      <nav className="sticky top-0 z-40 border-b border-border/50 bg-background/80 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4 md:px-6">
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

      {/* Hero */}
      <section className="relative overflow-hidden pb-16 pt-20 md:pb-24 md:pt-28">
        <HeroGlow />
        <div className="relative mx-auto grid max-w-5xl items-center gap-10 px-4 md:grid-cols-[1fr_1.15fr] md:gap-14 md:px-6 lg:gap-20">
          <div>
            <h1 className="text-4xl font-bold tracking-tight text-foreground md:text-5xl lg:text-[3.5rem] lg:leading-[1.1]">
              Your business data,{' '}
              <span className="text-primary">explained</span>
            </h1>
            <p className="mt-5 max-w-[420px] text-lg leading-relaxed text-muted-foreground">
              Upload a CSV from Square, QuickBooks, or any spreadsheet.
              Get charts and a plain-English summary of what your numbers mean.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:gap-4">
              <Link
                href="/dashboard"
                className="rounded-lg bg-primary px-6 py-3 text-center text-base font-medium text-primary-foreground shadow-sm transition-all hover:bg-primary/90 hover:shadow-md"
              >
                See a live demo
              </Link>
              <Link
                href="/login"
                className="rounded-lg border border-border px-6 py-3 text-center text-base font-medium text-foreground transition-colors hover:bg-muted"
              >
                Sign in
              </Link>
            </div>
            <p className="mt-3 text-sm text-muted-foreground">
              No account needed to explore the demo
            </p>
          </div>

          <div className="hidden md:block">
            <DashboardMockup />
          </div>
          <div className="md:hidden">
            <MobilePreview />
          </div>
        </div>
      </section>

      {/* Insight showcase */}
      <section className="relative border-t border-border/50">
        <div
          className="absolute inset-0 opacity-50 dark:opacity-20"
          style={{ background: 'linear-gradient(to bottom, var(--color-muted), transparent 60%)' }}
          aria-hidden="true"
        />
        <div className="relative mx-auto max-w-5xl px-4 py-20 md:px-6 md:py-28">
          <div className="mx-auto max-w-2xl">
            <h2 className="text-2xl font-bold text-foreground md:text-3xl">
              Other dashboards show you a chart.
              <br />
              <span className="text-muted-foreground">Tellsight tells you what to do about it.</span>
            </h2>
            <p className="mt-4 text-muted-foreground">
              Here's the kind of insight a landscaping company got from
              12 months of Square data:
            </p>

            <div className="mt-8 rounded-2xl border border-border/40 bg-ai-surface p-6 shadow-lg md:p-8">
              <div className="text-base leading-[1.8] text-card-foreground md:text-lg md:leading-[1.85]">
                <p className="font-medium text-foreground">
                  Your November revenue dropped <span className="font-semibold text-accent-warm">23%</span> compared
                  to October, but this matches a seasonal pattern visible across the last two years.
                </p>
                <p className="mt-4 text-card-foreground/75">
                  The dip comes from residential landscaping jobs declining as temperatures drop.
                  Meanwhile, your snow removal revenue hasn't kicked in yet — it typically starts
                  in the second half of December. If you're planning crew schedules for winter,
                  the gap between late November and mid-December is where you'll feel the squeeze.
                </p>
              </div>
              <div className="mt-5 flex items-center border-t border-border/30 pt-4">
                <span className="text-xs text-muted-foreground">How I reached this conclusion ▾</span>
              </div>
            </div>

            <p className="mt-6 text-sm text-muted-foreground">
              This is from the live demo — you can{' '}
              <Link href="/dashboard" className="font-medium text-primary underline-offset-2 hover:underline">
                read the full analysis
              </Link>{' '}
              right now.
            </p>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="border-t border-border/50">
        <div className="mx-auto max-w-5xl px-4 py-20 md:px-6 md:py-28">
          <div className="grid gap-14 md:grid-cols-2 md:gap-x-16 md:gap-y-14">
            <div className="flex gap-4">
              <FeatureIcon>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </FeatureIcon>
              <div>
                <h3 className="text-base font-semibold text-foreground">Shows its work</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  Every insight comes with a transparency panel — the exact data points,
                  calculations, and reasoning. If the AI says fuel costs are up 15%, you can
                  see which months it compared.
                </p>
              </div>
            </div>

            <div className="flex gap-4">
              <FeatureIcon>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
                </svg>
              </FeatureIcon>
              <div>
                <h3 className="text-base font-semibold text-foreground">Plain English, not jargon</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  Written for business owners who avoid spreadsheets. If your accountant
                  would explain it one way, we explain it yours. No pivot tables, no formulas.
                </p>
              </div>
            </div>

            <div className="flex gap-4">
              <FeatureIcon>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 12v8a2 2 0 002 2h12a2 2 0 002-2v-8" />
                  <polyline points="16 6 12 2 8 6" />
                  <line x1="12" y1="2" x2="12" y2="15" />
                </svg>
              </FeatureIcon>
              <div>
                <h3 className="text-base font-semibold text-foreground">Share insights, not spreadsheets</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  Send your partner a PNG, a link, or a PDF. They see the chart, the AI summary,
                  and the data behind it — no login required.
                </p>
              </div>
            </div>

            <div className="flex gap-4">
              <FeatureIcon>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M3 9h18" />
                  <path d="M9 21V9" />
                </svg>
              </FeatureIcon>
              <div>
                <h3 className="text-base font-semibold text-foreground">Works with what you have</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  Export from Square, QuickBooks, or any tool that makes a CSV. Upload once a month.
                  Check your dashboard Sunday evening. Five minutes, not five hours.
                </p>
              </div>
            </div>
          </div>

          <p className="mt-20 text-center text-muted-foreground">
            Charts and visualizations are free forever. Full AI interpretation unlocks with Pro.
          </p>
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="relative overflow-hidden border-t border-border/50">
        <div className="absolute inset-0 overflow-hidden" aria-hidden="true">
          <div
            className="absolute left-1/2 bottom-0 -translate-x-1/2 h-[400px] w-[700px] opacity-[0.06] dark:opacity-[0.04]"
            style={{
              background: 'radial-gradient(ellipse at center bottom, var(--color-primary), transparent 70%)',
            }}
          />
        </div>
        <div className="relative mx-auto max-w-5xl px-4 py-20 text-center md:px-6 md:py-24">
          <h2 className="text-2xl font-bold text-foreground md:text-3xl">
            See it working. Right now.
          </h2>
          <p className="mx-auto mt-3 max-w-md text-muted-foreground">
            The demo runs on sample data from a landscaping business —
            12 months of revenue and expenses. No signup required.
          </p>
          <Link
            href="/dashboard"
            className="mt-8 inline-block rounded-lg bg-primary px-8 py-3.5 text-base font-medium text-primary-foreground shadow-sm transition-all hover:bg-primary/90 hover:shadow-md"
          >
            Explore the demo
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border/50">
        <div className="mx-auto max-w-5xl px-4 py-6 md:px-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <TellsightLogo size={16} />
              Tellsight
            </div>
            <p className="text-xs text-muted-foreground">
              AI-powered analytics for small business
            </p>
          </div>
          <p className="mt-3 text-center text-xs text-muted-foreground/60">
            Production-grade SaaS — real auth, real payments, real AI. 780+ tests, full CI pipeline, Docker-ready.
          </p>
        </div>
      </footer>
    </div>
  );
}
