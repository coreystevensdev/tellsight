// Reject garbage that V8's Date constructor would accept (e.g. "hello 1", "true")
const DATE_SHAPE = /\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/;

// D/M/Y-shaped dates (year last) are ambiguous, "03/10/2012" is March 10 in
// the US and 3 October everywhere else. JS's Date constructor always assumes
// US month-first, so a European export gets silently misread whenever the
// day is 12 or under, and rejected outright whenever it's over 12.
const AMBIGUOUS_DATE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/;

/**
 * Scans a date column for a value where one segment can only be a day
 * (>12), which proves the file's ordering. Genuinely ambiguous columns
 * (every value ≤12/≤12) keep the existing US month-first assumption rather
 * than guessing, so already-working uploads don't change behavior.
 */
export function detectDayFirst(values: string[]): boolean {
  for (const value of values) {
    const match = AMBIGUOUS_DATE.exec(value.trim());
    if (!match) continue;
    const first = Number(match[1]);
    const second = Number(match[2]);
    if (first > 12) return true;
    if (second > 12) return false;
  }
  return false;
}

const YEAR_FIRST = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/;

// Date.UTC happily rolls a bad component over (month 13 becomes next January,
// Feb 30 becomes March 2), so the parts have to survive a round trip or the
// value was not a real date.
function utcDate(year: number, month: number, day: number): Date | null {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return d;
}

// Everything here builds UTC midnight. It used to depend on which branch ran:
// the day-first branch assembled an ISO string, which the Date constructor reads
// as UTC, while the fallback handed a slash date straight to the constructor,
// which reads that as *local* midnight. Two calendar dates on two timelines, so
// the same CSV parsed differently depending on the server's TZ, and east of UTC
// a slash date landed on the previous day. On a UTC host both branches already
// produced UTC midnight, so this changes no existing data, only the dependence
// on the host being UTC.
export function parseDate(value: string, dayFirst: boolean): Date | null {
  const trimmed = value.trim();
  if (!trimmed || !DATE_SHAPE.test(trimmed)) return null;

  const yearFirst = YEAR_FIRST.exec(trimmed);
  if (yearFirst) {
    const [, year, month, day] = yearFirst as unknown as [string, string, string, string];
    return utcDate(Number(year), Number(month), Number(day));
  }

  const ambiguous = AMBIGUOUS_DATE.exec(trimmed);
  if (ambiguous) {
    const [, first, second, year] = ambiguous as unknown as [string, string, string, string];
    const fullYear = year.length === 2 ? Number(`20${year}`) : Number(year);
    const day = dayFirst ? Number(first) : Number(second);
    const month = dayFirst ? Number(second) : Number(first);
    return utcDate(fullYear, month, day);
  }

  // Anything else DATE_SHAPE let through, an ISO datetime for instance, keeps
  // the old path rather than being narrowed here.
  const parsed = new Date(trimmed);
  return isNaN(parsed.getTime()) ? null : parsed;
}

export function isValidDate(value: string, dayFirst = false): boolean {
  return parseDate(value, dayFirst) !== null;
}
