'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { CreditCard, LogOut, User } from 'lucide-react';

export function AccountMenu() {
  const [open, setOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const signOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
    } catch {
      // network failure doesn't block sign-out, we're navigating away regardless
    } finally {
      // Hard navigation, a client-side push can leave stale authenticated
      // state in the Router Cache for pages we just lost the cookie for.
      window.location.assign('/login');
    }
  }, []);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className="flex h-8 w-8 items-center justify-center rounded-full bg-muted text-muted-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <User className="h-4 w-4" aria-hidden="true" />
      </button>

      {open && (
        <ul
          role="menu"
          aria-label="Account"
          className="absolute right-0 top-full z-50 mt-1 min-w-[160px] overflow-hidden rounded-md border border-border bg-card py-1 shadow-lg animate-fade-in"
        >
          <li role="none">
            <Link
              href="/billing"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 px-3 py-2 text-sm text-card-foreground transition-colors hover:bg-accent"
            >
              <CreditCard className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              Billing
            </Link>
          </li>
          <li role="none">
            <button
              type="button"
              role="menuitem"
              onClick={signOut}
              disabled={signingOut}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-card-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            >
              <LogOut className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
              {signingOut ? 'Signing out...' : 'Sign out'}
            </button>
          </li>
        </ul>
      )}
    </div>
  );
}
