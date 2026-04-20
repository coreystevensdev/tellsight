'use client';

import { useEffect, useCallback, useRef } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LayoutDashboard, Upload, ShieldCheck, Activity, X, Users, Database, SlidersHorizontal, Plug, DollarSign } from 'lucide-react';
import { TellsightLogo } from '@/components/common/TellsightLogo';
import { cn } from '@/lib/utils';
import { useSidebar } from '@/app/dashboard/contexts/SidebarContext';
import { ThemeToggle } from '@/components/common/ThemeToggle';

const NAV_ITEMS = [
  { href: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { href: '/upload', label: 'Upload', icon: Upload },
] as const;

const SETTINGS_ITEMS = [
  { href: '/settings/invites', label: 'Invites', icon: Users },
  { href: '/settings/datasets', label: 'Datasets', icon: Database },
  { href: '/settings/integrations', label: 'Integrations', icon: Plug },
  { href: '/settings/financials', label: 'Financial baseline', icon: DollarSign },
  { href: '/settings/preferences', label: 'Preferences', icon: SlidersHorizontal },
] as const;

function SidebarNav({ orgName, isAdmin, onNavigate }: { orgName?: string; isAdmin?: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center justify-between border-b border-border px-6">
        <Link
          href="/dashboard"
          className="flex items-center gap-2 text-lg font-semibold text-foreground"
          onClick={onNavigate}
        >
          <TellsightLogo size={20} />
          Tellsight
        </Link>
        {onNavigate && (
          <button
            onClick={onNavigate}
            className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
            aria-label="Close navigation"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {orgName && (
        <div className="border-b border-border px-6 py-3">
          <p className="truncate text-sm font-medium text-foreground">{orgName}</p>
        </div>
      )}

      <nav className="flex-1 space-y-1 px-3 py-4" aria-label="Main navigation">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const isActive = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              onClick={onNavigate}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                isActive
                  ? 'border-l-4 border-primary bg-accent text-foreground'
                  : 'border-l-4 border-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
              aria-current={isActive ? 'page' : undefined}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </Link>
          );
        })}
        <div className="mt-4 pt-4 border-t border-border">
          <p className="px-3 mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Settings</p>
          {SETTINGS_ITEMS.map(({ href, label, icon: Icon }) => {
            const isActive = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={href}
                href={href}
                onClick={onNavigate}
                className={cn(
                  'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                  isActive
                    ? 'border-l-4 border-primary bg-accent text-foreground'
                    : 'border-l-4 border-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
                aria-current={isActive ? 'page' : undefined}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {label}
              </Link>
            );
          })}
        </div>
        {isAdmin && (
          <>
            <Link
              href="/admin"
              onClick={onNavigate}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                pathname === '/admin'
                  ? 'border-l-4 border-primary bg-accent text-foreground'
                  : 'border-l-4 border-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
              aria-current={pathname === '/admin' ? 'page' : undefined}
            >
              <ShieldCheck className="h-4 w-4 shrink-0" />
              Admin
            </Link>
            <Link
              href="/admin/analytics"
              onClick={onNavigate}
              className={cn(
                'flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                pathname === '/admin/analytics'
                  ? 'border-l-4 border-primary bg-accent text-foreground'
                  : 'border-l-4 border-transparent text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
              aria-current={pathname === '/admin/analytics' ? 'page' : undefined}
            >
              <Activity className="h-4 w-4 shrink-0" />
              Analytics
            </Link>
          </>
        )}
      </nav>

      <div className="mt-auto border-t border-border px-3 py-3">
        <ThemeToggle />
      </div>
    </div>
  );
}

export function Sidebar() {
  const { open, setOpen, orgName, isAdmin } = useSidebar();
  const pathname = usePathname();
  const close = useCallback(() => setOpen(false), [setOpen]);
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    setOpen(false);
  }, [pathname, setOpen]);

  useEffect(() => {
    if (!open) return;

    const dialog = dialogRef.current;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusableSelector = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusables = dialog?.querySelectorAll<HTMLElement>(focusableSelector) ?? [];
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    first?.focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { close(); return; }
      if (e.key !== 'Tab' || !first || !last) return;

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    document.body.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.body.style.overflow = '';
      previouslyFocused?.focus();
    };
  }, [open, close]);

  return (
    <>
      <aside className="hidden lg:flex lg:w-60 lg:flex-col lg:border-r lg:border-border lg:bg-background">
        <SidebarNav orgName={orgName} isAdmin={isAdmin} />
      </aside>

      {open && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="fixed inset-0 bg-black/50 animate-fade-in"
            onClick={close}
            aria-hidden="true"
          />
          <aside
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation menu"
            className="fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-background shadow-xl animate-slide-in-left"
          >
            <SidebarNav orgName={orgName} isAdmin={isAdmin} onNavigate={close} />
          </aside>
        </div>
      )}
    </>
  );
}
