'use client';

import { useState } from 'react';
import { Mail } from 'lucide-react';
import type { DigestCadence, EmailPreferencesResponse, UpdateEmailPreferencesInput } from 'shared/schemas';
import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';

interface Props {
  initial: EmailPreferencesResponse;
}

const CADENCE_OPTIONS: { value: DigestCadence; label: string; description: string }[] = [
  { value: 'weekly', label: 'Weekly', description: 'Every Sunday' },
  { value: 'monthly', label: 'Monthly', description: 'First Sunday of the month' },
  { value: 'off', label: 'Off', description: 'Pause digest emails' },
];

function detectTimezone(fallback: string): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || fallback;
  } catch {
    return fallback;
  }
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return null;
  }
}

export default function EmailSettings({ initial }: Props) {
  const [cadence, setCadence] = useState<DigestCadence>(initial.cadence);
  const [timezone, setTimezone] = useState(initial.timezone || detectTimezone('UTC'));
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const showUnsubscribedBanner = initial.cadence === 'off' && initial.unsubscribedAt !== null;
  const unsubscribedOn = formatDate(initial.unsubscribedAt);

  async function saveEmailPreferences(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);

    const payload: UpdateEmailPreferencesInput = { cadence, timezone };

    try {
      await apiClient<{ cadence: DigestCadence; timezone: string }>('/preferences/email/digest', {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      setSavedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save preferences');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-foreground">Email</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Control digest cadence and the timezone we use for date formatting.
        </p>
      </div>

      {showUnsubscribedBanner && (
        <div className="mb-6 flex items-start gap-3 rounded-lg border border-border bg-muted/30 px-4 py-3">
          <Mail className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <p className="text-sm text-foreground">
            You unsubscribed{unsubscribedOn ? ` on ${unsubscribedOn}` : ''}. Choose a cadence below to resume.
          </p>
        </div>
      )}

      <form onSubmit={saveEmailPreferences} className="space-y-8">
        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Digest cadence</h2>
          <fieldset className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
            <legend className="sr-only">Choose how often you receive the weekly digest</legend>
            {CADENCE_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={cn(
                  'flex cursor-pointer flex-col gap-1 rounded-lg border p-4 transition-colors',
                  cadence === opt.value
                    ? 'border-primary bg-primary/5 ring-1 ring-primary'
                    : 'border-border bg-card hover:border-primary/40 hover:bg-accent/50',
                )}
              >
                <input
                  type="radio"
                  name="cadence"
                  value={opt.value}
                  checked={cadence === opt.value}
                  onChange={() => setCadence(opt.value)}
                  className="sr-only"
                />
                <span className="text-sm font-medium text-foreground">{opt.label}</span>
                <span className="text-xs text-muted-foreground">{opt.description}</span>
              </label>
            ))}
          </fieldset>
        </section>

        <section>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Timezone</h2>
          <input
            type="text"
            value={timezone}
            onChange={(e) => setTimezone(e.target.value)}
            className="mt-3 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            aria-describedby="tz-help"
            required
          />
          <p id="tz-help" className="mt-2 text-xs text-muted-foreground">
            Used for date formatting in the email. Digests always send Sunday 18:00 UTC, regardless of timezone.
          </p>
        </section>

        {error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3" role="alert">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        <div className="flex items-center gap-4">
          <button
            type="submit"
            disabled={saving}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save preferences'}
          </button>
          {savedAt !== null && !saving && (
            <span className="text-sm text-muted-foreground" role="status">Saved.</span>
          )}
        </div>
      </form>
    </div>
  );
}
