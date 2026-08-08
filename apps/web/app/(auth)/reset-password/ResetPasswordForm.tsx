'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const inputClass =
  'w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary';

export default function ResetPasswordForm({ token }: { token?: string }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!token) {
      setError('This reset link is missing its token');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token, password }),
      });

      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error?.message ?? 'Failed to reset password');
      }

      router.push('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <div className="space-y-4 text-center">
        <p className="text-sm text-destructive">This reset link is missing its token.</p>
        <a href="/forgot-password" className="text-sm text-muted-foreground hover:text-foreground">
          Request a new link
        </a>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div>
        <label htmlFor="password" className="sr-only">New password</label>
        <input
          id="password"
          type="password"
          required
          minLength={8}
          autoComplete="new-password"
          placeholder="New password (min. 8 characters)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={inputClass}
        />
      </div>

      {error && (
        <div className="space-y-1">
          <p className="text-sm text-destructive">{error}</p>
          <a href="/forgot-password" className="text-sm text-muted-foreground hover:text-foreground">
            Request a new link
          </a>
        </div>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-md bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? 'Resetting...' : 'Reset password'}
      </button>
    </form>
  );
}
