// The labeled set for the lookup-vs-interpretation scorer. Answers are
// hand-authored, not sampled from a live runQaLoop, because the tool loop's
// dispatch is hardcoded to DB-backed functions with no fixture-injection seam
// (qaLoop.ts:124-139). Cite tags mirror the shapes in qaAnswer.test.ts.

export interface QaEvalFixture {
  id: string;
  label: string;
  question: string;
  // Figures already present in the question, so the judge can tell a restated
  // figure from a genuinely new one.
  knownFigures: string[];
  answer: string;
  expectedVerdict: 'interpretive' | 'lookup';
}

export const QA_FIXTURES: QaEvalFixture[] = [
  {
    id: 'trend-comparison',
    label: 'New answer introduces a prior-period figure and a trend direction',
    question: 'How much did we spend on marketing this quarter?',
    knownFigures: [],
    answer:
      'Marketing spend was $2,400 this quarter <cite id="2:trend:Marketing:0"/>, down 18% from the $2,930 you spent last quarter, continuing a steady pullback since Q2.',
    expectedVerdict: 'interpretive',
  },
  {
    id: 'benchmark-comparison',
    label: 'New answer ties the figure to an external benchmark',
    question: "What's our runway right now?",
    knownFigures: [],
    answer:
      'You have about 4 months of runway left <cite id="1:runway:_:_"/>, shorter than the 6-month cushion most owners aim for at your current burn rate.',
    expectedVerdict: 'interpretive',
  },
  {
    id: 'bare-lookup',
    label: 'Raw figure only, no comparison',
    question: 'What was our total revenue in June?',
    knownFigures: [],
    answer: 'Total revenue in June was $18,400 <cite id="4:total:Revenue:0"/>.',
    expectedVerdict: 'lookup',
  },
  {
    id: 'restated-figure',
    label: 'Answer only affirms a figure already stated in the question',
    question: 'Was payroll $9,200 last month?',
    knownFigures: ['$9,200'],
    answer: 'Yes, payroll was $9,200 last month <cite id="3:trend:Payroll:0"/>.',
    expectedVerdict: 'lookup',
  },
  {
    id: 'verbose-padding',
    label: 'Trend language with zero numeric figures outside the cite tag',
    question: "How's cash flow trending?",
    knownFigures: [],
    answer:
      'Cash flow has been trending in a concerning direction lately, worth keeping an eye on as the pattern continues to develop over the coming months <cite id="5:cash_flow:_:_"/>.',
    expectedVerdict: 'lookup',
  },
];
