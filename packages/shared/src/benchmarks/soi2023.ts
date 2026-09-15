import { BUSINESS_TYPES } from '../schemas/businessProfile.js';

export const SOI_SOURCE = {
  title: 'Nonfarm Sole Proprietorships: Business Receipts, Selected Deductions, Payroll, and Net Income, by Industrial Sectors',
  publisher: 'IRS Statistics of Income',
  table: 'Tables 1 and 2',
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
  // Rent arrives split across two columns in this table. Both are kept so the
  // total is checkable against the source instead of being a number only this
  // file knows how to reproduce.
  rentOnMachinery: number;
  rentOnProperty: number;
  depreciation: number;
  interestPaid: number;
  // Table 2 (income statements) rather than Table 1, which carries only the
  // selected deductions above. Both report the same receipts per sector, so the
  // percentages stay on one denominator.
  advertising: number;
  repairs: number;
}

// Taxes is deliberately absent. Schedule C's "Taxes paid" and Form 1120-S's
// "Taxes and licenses" are not the same quantity: an S-corp deducts employer
// payroll tax on the owner's salary, while a sole proprietor's self-employment
// tax is paid on the 1040 and never reaches Schedule C. The published figures
// differ threefold in services and health care for exactly that reason, and a
// row labelled Taxes would look comparable while silently not being.

// businessType from onboarding to a sector in the table. 'technology' is absent
// on purpose: SOI has no distinct technology sector, it falls inside
// professional/scientific/technical services alongside 'services', so any figure
// shown for it would be the other category's number wearing a different label.
export const SOI_BENCHMARKS: Partial<Record<(typeof BUSINESS_TYPES)[number], IndustryBenchmark>> = {
  restaurant: { sector: 'Restaurants (full & limited service) and drinking places', businessReceipts: 77_216_690, netIncomeLessDeficit: 2_610_484, payroll: 14_501_567, rentOnMachinery: 635_724, rentOnProperty: 4_213_600, depreciation: 2_345_007, interestPaid: 648_089, advertising: 945_878, repairs: 1_429_871 },
  retail: { sector: 'Retail trade', businessReceipts: 199_487_939, netIncomeLessDeficit: 8_219_358, payroll: 13_137_339, rentOnMachinery: 743_226, rentOnProperty: 6_210_708, depreciation: 3_774_546, interestPaid: 1_168_787, advertising: 2_992_420, repairs: 1_653_249 },
  services: { sector: 'Professional, scientific, and technical services', businessReceipts: 250_227_539, netIncomeLessDeficit: 99_328_388, payroll: 19_929_703, rentOnMachinery: 1_090_457, rentOnProperty: 5_306_271, depreciation: 6_747_717, interestPaid: 1_287_365, advertising: 4_156_983, repairs: 1_580_886 },
  construction: { sector: 'Construction', businessReceipts: 382_517_598, netIncomeLessDeficit: 56_728_544, payroll: 42_198_457, rentOnMachinery: 2_701_386, rentOnProperty: 2_923_716, depreciation: 15_410_656, interestPaid: 1_764_868, advertising: 1_959_207, repairs: 4_569_099 },
  healthcare: { sector: 'Health care and social assistance', businessReceipts: 147_497_660, netIncomeLessDeficit: 51_474_275, payroll: 20_652_555, rentOnMachinery: 943_114, rentOnProperty: 5_957_142, depreciation: 3_977_617, interestPaid: 909_963, advertising: 1_497_364, repairs: 1_663_561 },
  manufacturing: { sector: 'Manufacturing', businessReceipts: 46_156_294, netIncomeLessDeficit: 3_259_834, payroll: 6_111_269, rentOnMachinery: 380_116, rentOnProperty: 1_598_385, depreciation: 1_879_743, interestPaid: 366_167, advertising: 598_470, repairs: 691_272 },
  real_estate: { sector: 'Real estate and rental and leasing', businessReceipts: 109_020_119, netIncomeLessDeficit: 26_440_210, payroll: 4_903_571, rentOnMachinery: 486_500, rentOnProperty: 2_066_250, depreciation: 7_022_923, interestPaid: 1_767_036, advertising: 2_927_625, repairs: 2_003_822 },
  transportation: { sector: 'Transportation and warehousing', businessReceipts: 200_084_105, netIncomeLessDeficit: 16_493_885, payroll: 8_396_222, rentOnMachinery: 5_167_455, rentOnProperty: 2_151_376, depreciation: 12_706_775, interestPaid: 1_431_133, advertising: 686_481, repairs: 10_568_805 },
  other: { sector: 'All nonfarm industries', businessReceipts: 2_063_191_945, netIncomeLessDeficit: 377_210_993, payroll: 175_013_634, rentOnMachinery: 16_903_495, rentOnProperty: 51_396_884, depreciation: 79_465_351, interestPaid: 15_138_785, advertising: 24_294_438, repairs: 33_691_430 },
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

// Unlike net margin, these three are outlays whatever the owner's pay
// arrangement, so they stay comparable across both source tables.
export function rentSharePercent(b: IndustryBenchmark): number | null {
  return ratio(b.rentOnMachinery + b.rentOnProperty, b.businessReceipts);
}

export function depreciationSharePercent(b: IndustryBenchmark): number | null {
  return ratio(b.depreciation, b.businessReceipts);
}

export function interestSharePercent(b: IndustryBenchmark): number | null {
  return ratio(b.interestPaid, b.businessReceipts);
}

export function advertisingSharePercent(b: IndustryBenchmark): number | null {
  return ratio(b.advertising, b.businessReceipts);
}

export function repairsSharePercent(b: IndustryBenchmark): number | null {
  return ratio(b.repairs, b.businessReceipts);
}
