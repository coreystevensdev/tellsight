'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function CallbackHandler({
  code,
  state,
}: {
  code?: string;
  state?: string;
}) {
  const router = useRouter();
  const [exchangeError, setExchangeError] = useState<string | null>(null);

  // Missing params are a property of the URL we were handed, so there is
  // nothing to remember. Storing it meant the first render painted a spinner
  // for a request that was never going to be made.
  const error = !code || !state ? 'Missing authentication parameters' : exchangeError;

  useEffect(() => {
    if (!code || !state) return;

    let cancelled = false;

    async function exchangeCode() {
      try {
        const inviteToken = sessionStorage.getItem('pending_invite_token') ?? undefined;
        sessionStorage.removeItem('pending_invite_token');

        const response = await fetch('/api/auth/callback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ code, state, inviteToken }),
        });

        if (!cancelled) {
          if (!response.ok) {
            const body = await response.json();
            throw new Error(body.error?.message ?? 'Authentication failed');
          }

          const stored = sessionStorage.getItem('auth_redirect') ?? '/dashboard';
          sessionStorage.removeItem('auth_redirect');
          // guard against open redirect, only allow relative paths starting with /
          const redirect = stored.startsWith('/') && !stored.startsWith('//') ? stored : '/dashboard';
          router.push(redirect);
        }
      } catch (err) {
        if (!cancelled) {
          setExchangeError(err instanceof Error ? err.message : 'Authentication failed');
        }
      }
    }

    exchangeCode();

    return () => {
      cancelled = true;
    };
  }, [code, state, router]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="w-full max-w-sm space-y-4 rounded-lg bg-card p-8 text-center shadow-sm">
          <h1 className="font-serif text-lg font-medium text-foreground">Sign In Failed</h1>
          <p className="text-sm text-destructive">{error}</p>
          <a
            href="/login"
            className="inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Try Again
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="w-full max-w-sm space-y-4 rounded-lg bg-card p-8 text-center shadow-sm">
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-border border-t-foreground" />
        <p className="text-sm text-muted-foreground">Signing you in...</p>
      </div>
    </div>
  );
}
