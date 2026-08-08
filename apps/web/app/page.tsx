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

      {/* Hero, oversized headline with live transformation visual */}
      <section className="relative overflow-hidden">
        <GridBg />
        <div className="relative mx-auto max-w-6xl px-4 pt-16 md:px-6 md:pt-28">
          <p className="text-xs font-medium uppercase tracking-[0.15em] text-muted-foreground">
            Live demo &middot; no signup needed
          </p>

          <h1 className="mt-5 max-w-4xl font-serif text-[2.75rem] font-medium leading-[1.05] tracking-[-0.01em] text-foreground md:text-6xl lg:text-7xl">
            Your spreadsheet,
            <br />
            <span className="relative inline-block italic">
              <span className="relative z-10">actually</span>
              <span
                className="absolute inset-x-0 bottom-[0.08em] -z-0 h-[0.3em] bg-primary/20 dark:bg-primary/25"
                aria-hidden="true"
              />
            </span>{' '}
            explained.
          </h1>

          <p className="mt-6 max-w-xl font-serif text-lg leading-relaxed text-muted-foreground md:text-xl">
            Connect QuickBooks directly, or upload a CSV from Square, your bank,
            or anywhere else. Get charts in seconds and an AI summary that reads
            your numbers like a financial analyst.
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

          {/* Transformation preview, shows what the product actually does */}
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
                <div className="text-[10px] font-medium uppercase tracking-wider text-accent-warm">
                  AI analysis
                </div>
                <p className="mt-3 font-serif text-[15px] leading-[1.7] text-card-foreground first-letter:float-left first-letter:mr-1 first-letter:font-serif first-letter:text-[2.6em] first-letter:font-medium first-letter:leading-[0.8] first-letter:text-primary md:text-base">
                  Revenue grew <span className="font-mono font-medium text-foreground">18%</span> in March
                  driven by a surge in catering orders on weekends. Payroll held steady, so{' '}
                  <span className="font-mono font-medium text-foreground">margin expanded to 34%</span>.
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

      {/* How it works, 3 steps, not 4 features */}
      <section className="border-t border-border/40">
        <div className="mx-auto max-w-6xl px-4 py-16 md:px-6 md:py-24">
          <div className="grid gap-8 md:grid-cols-3 md:gap-12">
            <div>
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">1</div>
              <h3 className="mt-3 text-base font-semibold text-foreground">Connect or upload</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Connect QuickBooks and it syncs automatically, or export a CSV
                from Square, Wave, or any tool. For CSVs we need date, amount,
                and category columns, that&apos;s it. Bad rows get flagged, not
                silently dropped.
              </p>
            </div>

            <div>
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">2</div>
              <h3 className="mt-3 text-base font-semibold text-foreground">See your charts</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                Revenue trend, expense breakdown, profit margin,
                year-over-year comparison. Filter by date or category.
                Export a snapshot as PNG or PDF, or share a link. Charts
                are free forever.
              </p>
            </div>

            <div>
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">3</div>
              <h3 className="mt-3 text-base font-semibold text-foreground">Read what it means</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                AI reads your trends, spots anomalies, and writes a summary
                your business partner would understand. Free tier gets a preview;
                Pro gets the full analysis, plus a weekly email digest so you
                don&apos;t have to remember to check.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Ask a question, natural-language Q&A over the same computed stats */}
      <section className="border-t border-border/40">
        <div className="mx-auto max-w-4xl px-4 py-14 md:px-6 md:py-20">
          <h2 className="font-serif text-2xl font-medium tracking-tight text-foreground md:text-3xl">
            Ask it directly, instead of hunting through charts.
          </h2>
          <p className="mt-4 font-serif text-muted-foreground md:text-lg">
            &quot;Why did payroll jump in March&quot; gets a real answer, not a
            chatbot doing free association. The model has exactly two tools,
            both scoped to your own computed statistics, nothing else it can
            call. Every number in the answer carries a citation back to the
            row it came from, click it and the source data is right there.
          </p>
          <p className="mt-3 font-serif text-muted-foreground md:text-lg">
            Ask something outside that, general knowledge, write me a poem,
            and it says so plainly instead of trying.
          </p>
        </div>
      </section>

      {/* Proactive alerts, agentic pass with a human-approval gate */}
      <section className="border-t border-border/40">
        <div className="mx-auto max-w-4xl px-4 py-14 md:px-6 md:py-20">
          <h2 className="font-serif text-2xl font-medium tracking-tight text-foreground md:text-3xl">
            It also watches for what you&apos;d otherwise miss.
          </h2>
          <p className="mt-4 font-serif text-muted-foreground md:text-lg">
            A nightly pass reads the same computed statistics and flags what
            changed: a cost that broke its normal range, a reconciliation
            gap, a trend that crossed a threshold. Findings get a severity
            tier, info up to critical.
          </p>
          <p className="mt-3 font-serif text-muted-foreground md:text-lg">
            Anything that would touch data or cross a dollar threshold waits
            for a person. Only an org owner can approve or reject it from an
            in-app drawer, and nothing sits there forever, unreviewed
            findings expire after 14 days instead of piling into an inbox
            nobody clears.
          </p>
        </div>
      </section>

      {/* Privacy section */}
      <section className="border-t border-border/40">
        <div className="mx-auto max-w-4xl px-4 py-14 md:px-6 md:py-20">
          <h2 className="font-serif text-2xl font-medium tracking-tight text-foreground md:text-3xl">
            Your raw numbers never reach the AI.
          </h2>
          <p className="mt-4 font-serif text-muted-foreground md:text-lg">
            Whether your data comes from a CSV upload or a QuickBooks sync,
            Tellsight computes the stats (totals, trends, anomalies,
            year-over-year) and sends only those summaries to Claude. Claude
            never sees your individual transactions.
          </p>
          <p className="mt-3 font-serif text-muted-foreground md:text-lg">
            The function that builds the AI prompt has a signature that
            won&apos;t accept raw rows. Try to pass them and TypeScript refuses
            to compile. The privacy boundary is enforced by the type system,
            not by code-review discipline.
          </p>

          <details className="mt-6 rounded-lg border border-border/60 bg-card p-4 text-sm">
            <summary className="cursor-pointer select-none font-medium text-foreground">
              For engineers, how it&apos;s enforced
            </summary>
            <div className="mt-3 space-y-2 text-muted-foreground">
              <p>
                The prompt-assembly function in{' '}
                <a
                  href="https://github.com/coreystevensdev/tellsight/blob/main/apps/api/src/services/curation/assembly.ts"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-xs underline underline-offset-4 hover:text-primary"
                >
                  apps/api/src/services/curation/assembly.ts
                </a>{' '}
                takes <code className="font-mono text-xs">
                  ScoredInsight[]
                </code>
                , not <code className="font-mono text-xs">DataRow[]</code>.
                Trying to pass raw transactions is a TypeScript compile
                error.
              </p>
              <p>
                The pipeline is three layers: compute statistics, score them,
                assemble the prompt. Only the third layer talks to Claude, and
                its input type is structurally unable to carry raw user data.
              </p>
              <p>
                Side benefit of the same boundary: the cost ceiling in{' '}
                <a
                  href="https://github.com/coreystevensdev/tellsight/blob/main/apps/api/src/lib/cost.ts"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-xs underline underline-offset-4 hover:text-primary"
                >
                  apps/api/src/lib/cost.ts
                </a>{' '}
                catches anomalously expensive AI calls before they pollute the
                rolling-median baseline.
              </p>
              <p>
                The summaries themselves are graded, not just trusted. An
                offline eval harness runs three labeled fixtures (healthy
                growth, cash crunch, seasonal anomaly) through the real
                pipeline and scores faithfulness and completeness. Last
                measured run: 0.99 faithfulness, 1.00 completeness. It has
                caught a real slip, one sampled summary generated the literal
                banned phrase &quot;you need to,&quot; which the legal-posture
                checker flagged.
              </p>
            </div>
          </details>
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
              Plain-English analytics for small business
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
