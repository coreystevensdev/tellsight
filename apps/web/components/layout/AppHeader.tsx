'use client';

import Link from 'next/link';
import { LogIn, Menu, User } from 'lucide-react';
import { useSidebar } from '@/app/dashboard/SidebarContext';
import { TellsightLogo } from '@/components/common/TellsightLogo';

interface AppHeaderProps {
  isAuthenticated: boolean;
}

export function AppHeader({ isAuthenticated }: AppHeaderProps) {
  const { setOpen } = useSidebar();

  return (
    <header className="flex h-14 items-center justify-between border-b border-border bg-background px-4 lg:px-6">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setOpen(true)}
          className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
          aria-label="Open navigation menu"
        >
          <Menu className="h-5 w-5" />
        </button>
        <div className="flex items-center gap-2 lg:hidden">
          <TellsightLogo size={20} />
          <span className="text-lg font-semibold">Tellsight</span>
        </div>
      </div>

      <div className="hidden lg:block" />

      <div className="flex items-center gap-3">
        {isAuthenticated ? (
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-muted">
            <User className="h-4 w-4 text-muted-foreground" />
          </div>
        ) : (
          <Link
            href="/login"
            className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
          >
            <LogIn className="h-4 w-4" />
            <span className="hidden md:inline">Sign in</span>
          </Link>
        )}
      </div>
    </header>
  );
}
