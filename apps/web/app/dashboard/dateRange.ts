// Clamp the day instead of letting it carry: new Date(2026, 1, 30) rolls into
// March and would make a relative range one month too short.
function monthsBefore(now: Date, months: number): Date {
  const target = new Date(now.getFullYear(), now.getMonth() - months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(now.getDate(), lastDay));
  return target;
}

// These dates are built from local parts. Formatting through toISOString()
// converts to UTC first and can shift the answer a day for users east of GMT.
function toIsoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function computeDateRange(preset: string): { from: string; to: string } | null {
  if (preset === 'all') return null;

  const now = new Date();
  const to = toIsoDate(now);
  let from: Date;

  switch (preset) {
    case 'last-month':
      from = monthsBefore(now, 1);
      break;
    case 'last-3-months':
      from = monthsBefore(now, 3);
      break;
    case 'last-6-months':
      from = monthsBefore(now, 6);
      break;
    case 'last-year':
      from = monthsBefore(now, 12);
      break;
    default:
      return null;
  }

  return { from: toIsoDate(from), to };
}
