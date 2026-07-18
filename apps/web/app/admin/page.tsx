import { cookies } from 'next/headers';
import { AUTH } from 'shared/constants';
import { apiServer } from '@/lib/api-server';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Building2, Users, CreditCard } from 'lucide-react';
import { AdminOrgTable } from './AdminOrgTable';
import { AdminUserTable } from './AdminUserTable';
import { SystemHealthPanel } from './SystemHealthPanel';
import { AiUsageTile } from './AiUsageTile';
import { EmailCompliancePanel } from './EmailCompliancePanel';
import { AlertsCompliancePanel } from './AlertsCompliancePanel';
import type { AdminOrgRow, AdminUserRow, AdminStats, EmailComplianceMetrics, AlertComplianceMetrics } from './types';

const EMPTY_STATS: AdminStats = {
  totalOrgs: 0,
  totalUsers: 0,
  proSubscribers: 0,
  aiUsage: { inputTokens: 0, outputTokens: 0, requestCount: 0, estimatedCostUsd: 0 },
};

async function fetchAdminOrgs(cookieHeader: string) {
  const res = await apiServer<AdminOrgRow[]>('/admin/orgs', { cookies: cookieHeader });
  return { orgs: res.data, stats: (res.meta?.stats as AdminStats) ?? EMPTY_STATS };
}

async function fetchAdminUsers(cookieHeader: string) {
  const res = await apiServer<AdminUserRow[]>('/admin/users', { cookies: cookieHeader });
  return res.data;
}

async function fetchEmailCompliance(cookieHeader: string): Promise<EmailComplianceMetrics | null> {
  try {
    const res = await apiServer<EmailComplianceMetrics>('/admin/email-compliance', { cookies: cookieHeader });
    return res.data;
  } catch {
    return null;
  }
}

async function fetchAlertCompliance(cookieHeader: string): Promise<AlertComplianceMetrics | null> {
  try {
    const res = await apiServer<AlertComplianceMetrics>('/admin/alert-compliance', { cookies: cookieHeader });
    return res.data;
  } catch {
    return null;
  }
}

export default async function AdminPage() {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore.get(AUTH.COOKIE_NAMES.ACCESS_TOKEN)
    ? cookieStore.toString()
    : '';

  const [{ orgs, stats }, users, emailCompliance, alertCompliance] = await Promise.all([
    fetchAdminOrgs(cookieHeader),
    fetchAdminUsers(cookieHeader),
    fetchEmailCompliance(cookieHeader),
    fetchAlertCompliance(cookieHeader),
  ]);

  return (
    <div className="space-y-6 p-4 md:p-6 lg:p-8">
      <h1 className="text-2xl font-semibold tracking-tight">Platform Admin</h1>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4" role="group" aria-label="Platform statistics">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Organizations</CardTitle>
            <Building2 className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" style={{ fontFeatureSettings: '"tnum"' }} aria-label={`${stats.totalOrgs} organizations`}>
              {stats.totalOrgs}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Users</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" style={{ fontFeatureSettings: '"tnum"' }} aria-label={`${stats.totalUsers} users`}>
              {stats.totalUsers}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Pro Subscribers</CardTitle>
            <CreditCard className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" style={{ fontFeatureSettings: '"tnum"' }} aria-label={`${stats.proSubscribers} pro subscribers`}>
              {stats.proSubscribers}
            </div>
          </CardContent>
        </Card>

        <AiUsageTile usage={stats.aiUsage} />
      </div>

      <SystemHealthPanel />

      <EmailCompliancePanel metrics={emailCompliance} />

      <AlertsCompliancePanel metrics={alertCompliance} />

      <div className="space-y-6">
        <AdminOrgTable orgs={orgs} />
        <AdminUserTable users={users} />
      </div>
    </div>
  );
}
