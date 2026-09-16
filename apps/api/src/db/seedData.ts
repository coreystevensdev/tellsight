// Demo data for Sunrise Cafe, a fictional coffee shop. Shared by the seed script
// (which fills the public demo org) and signup (which gives every new org a copy).
// Lives apart from seed.ts because that file opens a postgres connection and can
// call process.exit at module load, which no request path can afford to import.

export const SEED_DATASET_NAME = 'Sunrise Cafe Sample Data';

export type SeedRow = {
  sourceType: 'csv';
  category: string;
  parentCategory: string;
  date: Date;
  amount: string;
  label: string | null;
};

// 12 months ending at the current month, so date presets always show recent data
// and a freshly seeded org never opens on data the staleness gate calls old.
// Anomalies baked in so the curation pipeline has something to interpret.
export function buildSeedRows(): SeedRow[] {
  const rows: SeedRow[] = [];

  const WEEKS_PER_MONTH = 4;
  const now = new Date();
  const endYear = now.getUTCFullYear();
  const endMonth = now.getUTCMonth();

  const startDate = new Date(Date.UTC(endYear, endMonth - 11, 1));
  const startYear = startDate.getUTCFullYear();
  const startMonth = startDate.getUTCMonth();

  for (let year = startYear; year <= endYear; year++) {
    const firstM = year === startYear ? startMonth : 0;
    const lastM = year === endYear ? endMonth : 11;
    const months = Array.from({ length: lastM - firstM + 1 }, (_, i) => firstM + i);

    for (const m of months) {
      const monthlyRevenue = m === 11 ? 28000 : parseFloat(lerp('12000.00', '18000.00', m));
      const monthlyPayroll = (year >= 2025 && m === 9) ? 9200 : parseFloat(lerp('5500.00', '6500.00', m));
      const isQ3Dip = year >= 2025 && m >= 6 && m <= 8;
      const monthlyMarketing = isQ3Dip
        ? parseFloat(lerp('200.00', '300.00', m - 6))
        : parseFloat(lerp('800.00', '1200.00', m));
      const monthlyRent = 3000;
      const monthlySupplies = parseFloat(lerp('1500.00', '2500.00', m));
      const monthlyUtilities = parseFloat(lerp('600.00', '400.00', m));

      for (let w = 0; w < WEEKS_PER_MONTH; w++) {
        const day = 1 + w * 7;
        const date = new Date(Date.UTC(year, m, day));
        const jitter = () => 0.9 + Math.random() * 0.2;
        const weekly = (monthly: number) => ((monthly / WEEKS_PER_MONTH) * jitter()).toFixed(2);

        rows.push({ sourceType: 'csv', category: 'Revenue', parentCategory: 'Income', date, amount: weekly(monthlyRevenue), label: null });
        rows.push({ sourceType: 'csv', category: 'Payroll', parentCategory: 'Expenses', date, amount: weekly(monthlyPayroll), label: null });
        rows.push({ sourceType: 'csv', category: 'Marketing', parentCategory: 'Expenses', date, amount: weekly(monthlyMarketing), label: null });

        // Rent: paid once per month on the 1st
        if (w === 0) {
          rows.push({ sourceType: 'csv', category: 'Rent', parentCategory: 'Expenses', date, amount: monthlyRent.toFixed(2), label: null });
        }

        rows.push({ sourceType: 'csv', category: 'Supplies', parentCategory: 'Expenses', date, amount: weekly(monthlySupplies), label: null });
        rows.push({ sourceType: 'csv', category: 'Utilities', parentCategory: 'Expenses', date, amount: weekly(monthlyUtilities), label: null });
      }
    }
  }

  return rows;
}

// Linear interpolation across 12 months, returns string amount.
// monthIndex 0 → minVal, monthIndex 11 → maxVal.
function lerp(minVal: string, maxVal: string, monthIndex: number): string {
  const min = parseFloat(minVal);
  const max = parseFloat(maxVal);
  const t = monthIndex / 11;
  return (min + (max - min) * t).toFixed(2);
}
