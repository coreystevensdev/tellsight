import { cookies } from 'next/headers';
import { AUTH } from 'shared/constants';
import { Sidebar } from '@/components/layout/Sidebar';
import { AppHeader } from '@/components/layout/AppHeader';
import { SidebarProvider } from './contexts/SidebarContext';

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const isAuthenticated = !!cookieStore.get(AUTH.COOKIE_NAMES.ACCESS_TOKEN)?.value;

  return (
    <SidebarProvider>
      <div className="flex h-screen overflow-hidden bg-background">
        <a
          href="#main-content"
          className="sr-only z-50 rounded-md bg-primary px-4 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:left-4 focus:top-4"
        >
          Skip to main content
        </a>
        <Sidebar />
        <div className="flex flex-1 flex-col overflow-hidden">
          <AppHeader isAuthenticated={isAuthenticated} />
          <main id="main-content" className="flex-1 overflow-y-auto">
            {children}
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}
