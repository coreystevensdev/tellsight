'use client';

import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { useStatCorrections } from '@/lib/hooks/useStatCorrections';

export interface StatCorrectionFormProps {
  datasetId: number;
  statId: string;
}

function statusLabel(status: string | null): string {
  if (status === null) return 'Note';
  if (status === 'pending') return 'Pending review';
  if (status === 'approved') return 'Applied going forward';
  if (status === 'rejected') return 'Rejected';
  return 'Expired';
}

// Both tiers from the auto-learn intent-contract go through this one form:
// a plain note is always saved as a Tier 1 annotation, the checkbox opts
// into the Tier 2 admin-reviewed "apply going forward" request. Neither
// path ever touches the AI prompt, Tier 1 is UI-only and Tier 2 only takes
// effect after admin approval flips it into scoreInsights' exclusion set.
export function StatCorrectionForm({ datasetId, statId }: StatCorrectionFormProps) {
  const { corrections, submitStatus, submitError, submitCorrection } = useStatCorrections(datasetId, statId);
  const [note, setNote] = useState('');
  const [appliesGoingForward, setAppliesGoingForward] = useState(false);

  const existing = corrections.filter((c) => c.statInstanceId === statId);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!note.trim()) return;

    const ok = await submitCorrection(note.trim(), appliesGoingForward);
    if (ok) {
      setNote('');
      setAppliesGoingForward(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4">
      <h3 className="text-sm font-medium text-card-foreground">Something look wrong?</h3>

      {existing.length > 0 && (
        <ul className="flex flex-col gap-2">
          {existing.map((c) => (
            <li key={c.id} className="rounded-md border border-border bg-card px-3 py-2 text-sm">
              <p className="text-card-foreground">{c.note}</p>
              <p className="mt-1 text-xs text-muted-foreground">{statusLabel(c.status)}</p>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleSubmit} className="flex flex-col gap-2">
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What's wrong with this number?"
          rows={3}
          maxLength={1000}
          className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />

        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            checked={appliesGoingForward}
            onChange={(e) => setAppliesGoingForward(e.target.checked)}
            className="h-4 w-4 rounded border-border text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          Apply this going forward (reviewed by an admin before it takes effect)
        </label>

        {submitStatus === 'error' && submitError && (
          <p className="text-sm text-destructive">{submitError}</p>
        )}

        <Button type="submit" size="sm" disabled={!note.trim() || submitStatus === 'submitting'}>
          {submitStatus === 'submitting' ? 'Saving...' : 'Save correction'}
        </Button>
      </form>
    </div>
  );
}
