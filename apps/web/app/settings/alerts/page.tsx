import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { AUTH } from 'shared/constants';
import { apiServer } from '@/lib/api-server';
import AlertRules, { type AlertRule } from './AlertRules';

export const metadata: Metadata = {
  title: 'Alerts, Tellsight',
};

export default async function AlertRulesPage() {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get(AUTH.COOKIE_NAMES.ACCESS_TOKEN)?.value;

  if (!accessToken) {
    redirect('/login?next=/settings/alerts');
  }

  let initial: AlertRule[] = [];
  try {
    const res = await apiServer<AlertRule[]>('/org/alert-rules', {
      cookies: cookieStore.toString(),
    });
    initial = res.data;
  } catch {
    // Fall through to an empty list; the client component can still create a rule.
  }

  return <AlertRules initial={initial} />;
}
