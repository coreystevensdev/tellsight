import { Sidebar } from './Sidebar';
import { AppHeader } from './AppHeader';

interface AppShellProps {
  isAuthenticated: boolean;
  children: React.ReactNode;
}

// The dashboard keeps its own copy of this tree because it also mounts the
// action drawer and needs different overflow handling on <main>.
export function AppShell({ isAuthenticated, children }: AppShellProps) {
  return (
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
  );
}
