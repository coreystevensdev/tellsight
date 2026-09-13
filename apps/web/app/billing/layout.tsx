import { cookies } from 'next/headers';
import { AUTH } from 'shared/constants';
import { AppShell } from '@/components/layout/AppShell';
import { SidebarProvider } from '@/app/dashboard/SidebarContext';
import { extractIsAdmin } from '@/lib/auth-utils';

export default async function BillingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const accessToken = cookieStore.get(AUTH.COOKIE_NAMES.ACCESS_TOKEN)?.value;
  const isAdmin = extractIsAdmin(accessToken);

  return (
    <SidebarProvider isAdmin={isAdmin}>
      <AppShell isAuthenticated={!!accessToken}>{children}</AppShell>
    </SidebarProvider>
  );
}
