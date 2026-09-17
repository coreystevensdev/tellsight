'use client';

import { useState } from 'react';
import { BackLink } from '@/components/common/BackLink';

const CONFIRM_PHRASE = 'delete my account';

type Blocked = { organizations: Array<{ orgId: number; orgName: string }> };

export default function Account() {
  const [phrase, setPhrase] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<Blocked['organizations'] | null>(null);

  const armed = phrase.trim().toLowerCase() === CONFIRM_PHRASE;

  async function submit() {
    setPending(true);
    setError(null);
    setBlocked(null);

    try {
      const res = await fetch('/api/account', { method: 'DELETE' });
      const body = await res.json();

      if (!res.ok) {
        const orgs = (body?.error?.details as Blocked | undefined)?.organizations;
        if (orgs?.length) setBlocked(orgs);
        else setError(body?.error?.message ?? 'Could not delete your account.');
        return;
      }

      // The session cookies are gone, so a client-side route change would land
      // on a page that immediately bounces. Reload into the signed-out world.
      window.location.assign('/');
    } catch {
      setError('Could not reach the server. Your account has not been deleted.');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <BackLink />
      <div className="mb-6">
        <h1 className="font-serif text-2xl font-medium text-foreground">Account</h1>
        <p className="mt-1 text-sm text-muted-foreground">Close your account and remove your data.</p>
      </div>

      <section className="rounded-lg border border-destructive/30 bg-destructive/5 p-6">
        <h2 className="font-medium text-foreground">Delete your account</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Organizations where you are the last member are deleted with you, along with their
          datasets, summaries and history. Any Pro subscription is cancelled first. Organizations
          you share with other people stay, and your name comes off what you did in them.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">This cannot be undone.</p>

        {blocked && (
          <div role="alert" className="mt-4 rounded-md border border-border bg-background p-3 text-sm">
            <p className="text-foreground">
              Hand these over to another owner first, otherwise their members are left with nobody
              who can manage them:
            </p>
            <ul className="mt-2 list-disc pl-5 text-muted-foreground">
              {blocked.map((o) => <li key={o.orgId}>{o.orgName}</li>)}
            </ul>
          </div>
        )}

        {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}

        <label className="mt-5 block text-sm text-foreground" htmlFor="confirm-delete">
          Type <span className="font-mono font-medium">{CONFIRM_PHRASE}</span> to confirm
        </label>
        <input
          id="confirm-delete"
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          autoComplete="off"
          className="mt-2 w-full max-w-sm rounded-md border border-border bg-background px-3 py-2 text-sm"
        />

        <button
          type="button"
          onClick={submit}
          disabled={!armed || pending}
          className="mt-4 min-h-11 rounded-md bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {pending ? 'Deleting...' : 'Delete account'}
        </button>
      </section>
    </div>
  );
}
