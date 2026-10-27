const STEPS = [
  {
    title: 'Connect or upload',
    description:
      "Connect QuickBooks and it syncs automatically, or export a CSV from Square, Wave, or any tool. For CSVs we need date, amount, and category columns, that's it. Bad rows get flagged, not silently dropped.",
  },
  {
    title: 'See your charts',
    description:
      'Revenue trend, expense breakdown, profit margin, year-over-year comparison. Filter by date or category. Export a snapshot as PNG or PDF, or share a link. Charts are free forever.',
  },
  {
    title: 'Read what it means',
    description:
      "AI reads your trends, spots anomalies, and writes a summary your business partner would understand. Free tier gets a preview; Pro gets the full analysis, plus a weekly email digest so you don't have to remember to check.",
  },
];

const STORIES = [
  {
    title: 'Ask it directly, instead of hunting through charts.',
    paragraphs: [
      '"Why did payroll jump in March" gets a real answer, not a chatbot doing free association. The model has exactly two tools, both scoped to your own computed statistics, nothing else it can call. Every number in the answer carries a citation back to the row it came from, click it and the source data is right there.',
      'Ask something outside that, general knowledge, write me a poem, and it says so plainly instead of trying.',
    ],
  },
  {
    title: 'Every figure opens up.',
    paragraphs: [
      'Claude writes the interpretation, it does not invent the numbers. Each statistic behind a claim carries the method that produced it, named rather than paraphrased: trend analysis, anomaly detection, year-over-year comparison, margin trend, seasonal projection, cash forecast.',
      'From there you can read the rows the number came from, paginated, out of your own data. A figure that looks wrong is something you can check rather than something you have to take on faith.',
    ],
  },
  {
    title: "It also watches for what you'd otherwise miss.",
    paragraphs: [
      'A nightly pass reads the same computed statistics and flags what changed: a cost that broke its normal range, a reconciliation gap, a trend that crossed a threshold. Findings get a severity tier, info up to critical.',
      'Anything that would touch data or cross a dollar threshold waits for a person. Only an org owner can approve or reject it from an in-app drawer, and nothing sits there forever, unreviewed findings expire after 14 days instead of piling into an inbox nobody clears.',
    ],
  },
  {
    title: 'It arrives whether or not you log in.',
    paragraphs: [
      'Weekly, monthly, or off. The digest carries the same computed statistics as the dashboard plus what moved since the last one, so a number arrives meaning something relative to the last time you saw it instead of standing on its own.',
      'A period with nothing computable is skipped rather than sent. An email that exists to say there was nothing to say is worse than no email, and it teaches people not to open the next one.',
    ],
  },
];

export function LandingProductStory() {
  return (
    <>
      <section className="border-t border-border/40">
        <div className="mx-auto max-w-6xl px-4 py-16 md:px-6 md:py-24">
          <div className="grid gap-8 md:grid-cols-3 md:gap-12">
            {STEPS.map((step, index) => (
              <div key={step.title}>
                <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                  {index + 1}
                </div>
                <h3 className="mt-3 text-base font-semibold text-foreground">{step.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {step.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {STORIES.map((story) => (
        <section key={story.title} className="border-t border-border/40">
          <div className="mx-auto max-w-4xl px-4 py-14 md:px-6 md:py-20">
            <h2 className="font-serif text-2xl font-medium tracking-tight text-foreground md:text-3xl">
              {story.title}
            </h2>
            {story.paragraphs.map((paragraph, index) => (
              <p
                key={index}
                className={`${index === 0 ? 'mt-4' : 'mt-3'} font-serif text-muted-foreground md:text-lg`}
              >
                {paragraph}
              </p>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
