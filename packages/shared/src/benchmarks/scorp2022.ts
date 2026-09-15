import { BUSINESS_TYPES } from '../schemas/businessProfile.js';

export const SCORP_SOURCE = {
  title: 'Returns of Active Corporations, Form 1120-S: Balance Sheet and Income Statement Items, by Major Industry',
  publisher: 'IRS Statistics of Income',
  table: 'Table 6.1',
  taxYear: 2022,
  url: 'https://www.irs.gov/pub/irs-soi/22co61ccr.xlsx',
  retrievedOn: '2026-09-15',
} as const;

// Why a second source exists at all.
//
// SOI Table 1 covers nonfarm sole proprietorships, whose owners take no W-2
// salary, so its net income still contains the owner's entire pay. That is fine
// for a one-person business and wrong for one with employees, which is almost
// certainly an S-corp or an LLC taxed as one, where the owner is on payroll and
// their salary is deducted before net income.
//
// The gap is not small. Services margin is 39.7% for sole proprietors and 12.9%
// here; health care is 34.9% against 11.4%. That difference is the owner's pay,
// and an S-corp owner measured against 39.7% would conclude something untrue
// about their own business.
export const SCORP_ENTITY_CAVEAT =
  'These are S-corporations, whose owners are paid a salary that is already deducted here. If you do not pay yourself through payroll, your own margin is not measuring the same thing.';

export interface EmployerBenchmark {
  // The exact column label in the published table, so any figure can be checked
  // against the file without guessing which column was read.
  sector: string;
  // Thousands of dollars, verbatim from the table rows named below. Percentages
  // are derived rather than stored, so a transcription error shows up as
  // arithmetic that stops reproducing instead of as a plausible number.
  businessReceipts: number; // row 43, Business receipts
  netIncomeLessDeficit: number; // row 65, Net income (less deficit) from a trade or business
  // Split rather than pre-summed. Officer compensation is the owner's own
  // salary and is frequently the largest payroll line in a small S-corp, so
  // folding it in silently would hide the thing that makes this table
  // comparable in the first place.
  compensationOfOfficers: number; // row 49
  salariesAndWages: number; // row 50
  returns: number; // row 9, sample size behind the estimate
}

export type EmployerBenchmarks = Partial<Record<(typeof BUSINESS_TYPES)[number], EmployerBenchmark>>;

// technology is absent for the same reason it is absent from the sole-proprietor
// table. This source does have an Information sector, but an SMB calling itself
// "technology" is usually a consultancy sitting in professional/scientific/
// technical services, so publishing Information under a technology label would
// be a different industry's number wearing the wrong name.
export const SCORP_BENCHMARKS: EmployerBenchmarks = {
  restaurant: { sector: 'Food services and drinking places', businessReceipts: 362_077_956, netIncomeLessDeficit: 15_703_202, compensationOfOfficers: 10_846_381, salariesAndWages: 72_507_809, returns: 249_020 },
  retail: { sector: 'Retail trade', businessReceipts: 2_025_349_298, netIncomeLessDeficit: 90_152_733, compensationOfOfficers: 23_638_436, salariesAndWages: 145_288_726, returns: 424_367 },
  services: { sector: 'Professional, scientific, and technical services', businessReceipts: 830_357_657, netIncomeLessDeficit: 106_870_087, compensationOfOfficers: 66_094_466, salariesAndWages: 162_185_438, returns: 863_664 },
  construction: { sector: 'Construction', businessReceipts: 1_844_259_491, netIncomeLessDeficit: 97_571_091, compensationOfOfficers: 46_455_220, salariesAndWages: 113_740_216, returns: 690_444 },
  healthcare: { sector: 'Health care and social assistance', businessReceipts: 497_871_955, netIncomeLessDeficit: 56_627_013, compensationOfOfficers: 53_994_172, salariesAndWages: 138_733_096, returns: 487_580 },
  manufacturing: { sector: 'Manufacturing', businessReceipts: 1_083_781_824, netIncomeLessDeficit: 88_041_078, compensationOfOfficers: 22_242_226, salariesAndWages: 81_040_427, returns: 162_216 },
  real_estate: { sector: 'Real estate and rental and leasing', businessReceipts: 202_179_543, netIncomeLessDeficit: 30_470_620, compensationOfOfficers: 17_150_557, salariesAndWages: 43_833_232, returns: 595_687 },
  transportation: { sector: 'Transportation and warehousing', businessReceipts: 418_504_611, netIncomeLessDeficit: 25_627_323, compensationOfOfficers: 8_601_005, salariesAndWages: 49_729_068, returns: 269_711 },
  other: { sector: 'All industries', businessReceipts: 10_429_590_929, netIncomeLessDeficit: 763_268_999, compensationOfOfficers: 349_956_774, salariesAndWages: 1_164_295_039, returns: 5_266_702 },
};

export function employerNetMarginPercent(b: EmployerBenchmark): number | null {
  if (b.businessReceipts <= 0) return null;
  return Math.round((b.netIncomeLessDeficit / b.businessReceipts) * 1000) / 10;
}

/** Officer compensation included: for an S-corp the owner's salary is payroll. */
export function employerPayrollSharePercent(b: EmployerBenchmark): number | null {
  if (b.businessReceipts <= 0) return null;
  const payroll = b.compensationOfOfficers + b.salariesAndWages;
  return Math.round((payroll / b.businessReceipts) * 1000) / 10;
}
