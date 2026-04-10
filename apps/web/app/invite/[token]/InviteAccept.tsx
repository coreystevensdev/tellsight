'use client';

import { useEffect, useState } from 'react';

interface InviteInfo {
  orgName: string;
  expiresAt: string;
}

export default function InviteAccept({ token }: { token: string }) {
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    async function validate() {
      try {
        const res = await fetch(`/api/invites/${token}`);
        const body = await res.json();

        if (!res.ok) {
          setError(body.error?.message ?? 'This invite link is no longer valid');
          return;
        }

        setInvite(body.data);
      } catch {
        setError('Failed to validate invite link');
      } finally {
        setLoading(false);
      }
    }

    validate();
  }, [token]);

  async function handleJoin() {
    setJoining(true);

    try {
      // stash the invite token so the callback handler picks it up
      sessionStorage.setItem('pending_invite_token', token);

      const res = await fetch('/api/auth/login');
      if (!res.ok) throw new Error('Failed to start sign-in');

      const { data } = await res.json();
      window.location.href = data.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setJoining(false);
    }
  }

  if (loading) {
    return (
      <div className="w-full max-w-sm space-y-4 rounded-lg bg-card p-8 text-center shadow-sm">
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-border border-t-foreground" />
        <p className="text-sm text-muted-foreground">Checking invite...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="w-full max-w-sm space-y-4 rounded-lg bg-card p-8 text-center shadow-sm">
        <h1 className="text-lg font-semibold text-foreground">Invite Link Invalid</h1>
        <p className="text-sm text-destructive">{error}</p>
        <p className="text-xs text-muted-foreground">
          Ask the organization owner to send you a new invite link.
        </p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-sm space-y-6 rounded-lg bg-card p-8 shadow-sm">
      <div className="text-center">
        <h1 className="text-2xl font-semibold text-foreground">Join {invite?.orgName}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          You&apos;ve been invited to collaborate on this organization&apos;s analytics.
        </p>
      </div>

      <button
        onClick={handleJoin}
        disabled={joining}
        className="flex w-full items-center justify-center gap-3 rounded-md border border-border bg-card px-4 py-3 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
      >
        <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
            fill="#4285F4"
          />
          <path
            d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
            fill="#34A853"
          />
          <path
            d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
            fill="#FBBC05"
          />
          <path
            d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
            fill="#EA4335"
          />
        </svg>
        {joining ? 'Redirecting...' : 'Join with Google'}
      </button>

      <p className="text-center text-xs text-muted-foreground">
        Sign in with your Google account to join this organization.
      </p>
    </div>
  );
}
