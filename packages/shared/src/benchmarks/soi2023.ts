import { BUSINESS_TYPES } from '../schemas/businessProfile.js';

export const SOI_SOURCE = {
  title: 'Nonfarm Sole Proprietorships: Business Receipts, Selected Deductions, Payroll, and Net Income, by Industrial Sectors',
  publisher: 'IRS Statistics of Income',
  table: 'Table 1',
  taxYear: 2023,
  url: 'https://www.irs.gov/pub/irs-soi/23sp01br.xls',
  retrievedOn: '2026-09-14',
} as const;

// The caveat is part of the data, not a footnote someone can forget to render.
// A sole proprietor takes no W-2 salary, so what SOI reports as net income is
// the owner's own compensation plus whatever is left. A business that books an
// owner draw as an expense is not measuring the same thing, and the gap between
// the two is the owner's entire pay.
//
// This is why the figure ships as context and never as a verdict. Tellsight
// cannot see how a user books owner compensation, so it cannot say whether a
// given margin is good, and any wording that implies it would be inventing a
// comparison the data does not support.
export const SOI_MARGIN_CAVEAT =
  'These are sole proprietors and single-member LLCs, who take draws rather than a salary, so this net income still includes the owner pay. If you pay yourself through payroll, your own margin is not measuring the same thing.';

export interface IndustryBenchmark {
  // The exact row label in the source table, so any figure here can be checked
  // against the published file without guessing which row was used.
  sector: string;
  // Thousands of dollars, verbatim from the table. The percentages are derived
  // rather than stored, so a transcription error shows up as arithmetic that
  // does not reproduce instead of hiding in a rounded number.
  businessReceipts: number;
  netIncomeLessDeficit: number;
  payroll: number;
}

// businessType from onboarding to a sector in the table. 'technology' is absent
// on purpose: SOI has no distinct technology sector, it falls inside
// professional/scientific/technical services alongside 'services', so any figure
// shown for it would be the other category's number wearing a different label.
export const SOI_BENCHMARKS: Partial<Record<(typeof BUSINESS_TYPES)[number], IndustryBenchmark>> = {
  restaurant: { sector: 'Restaurants (full & limited service) and drinking places', businessReceipts: 77_216_690, netIncomeLessDeficit: 2_610_484, payroll: 14_501_567 },
  retail: { sector: 'Retail trade', businessReceipts: 199_487_939, netIncomeLessDeficit: 8_219_358, payroll: 13_137_339 },
  services: { sector: 'Professional, scientific, and technical services', businessReceipts: 250_227_539, netIncomeLessDeficit: 99_328_388, payroll: 19_929_703 },
  construction: { sector: 'Construction', businessReceipts: 382_517_598, netIncomeLessDeficit: 56_728_544, payroll: 42_198_457 },
  healthcare: { sector: 'Health care and social assistance', businessReceipts: 147_497_660, netIncomeLessDeficit: 51_474_275, payroll: 20_652_555 },
  manufacturing: { sector: 'Manufacturing', businessReceipts: 46_156_294, netIncomeLessDeficit: 3_259_834, payroll: 6_111_269 },
  real_estate: { sector: 'Real estate and rental and leasing', businessReceipts: 109_020_119, netIncomeLessDeficit: 26_440_210, payroll: 4_903_571 },
  transportation: { sector: 'Transportation and warehousing', businessReceipts: 200_084_105, netIncomeLessDeficit: 16_493_885, payroll: 8_396_222 },
  other: { sector: 'All nonfarm industries', businessReceipts: 2_063_191_945, netIncomeLessDeficit: 377_210_993, payroll: 175_013_634 },
};

function ratio(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

export function netMarginPercent(b: IndustryBenchmark): number | null {
  return ratio(b.netIncomeLessDeficit, b.businessReceipts);
}

export function payrollSharePercent(b: IndustryBenchmark): number | null {
  return ratio(b.payroll, b.businessReceipts);
}
