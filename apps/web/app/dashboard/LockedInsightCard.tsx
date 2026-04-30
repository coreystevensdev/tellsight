'use client';

import { useId, useState } from 'react';
import { Lock } from 'lucide-react';
import { cn } from '@/lib/utils';

interface LockedInsightCardProps {
  title: string;
  description: string;
  inputLabel: string;
  inputPlaceholder?: string;
  inputMask?: 'currency' | 'number';
  inputMax?: number;
  submitLabel?: string;
  onSubmit: (value: number) => Promise<void>;
  className?: string;
}

function formatCurrency(n: number): string {
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function parseMaskedInput(raw: string): number | null {
  // raw is already sanitized at input time to digits, ',', '$', '.', see onChange.
  // Strip display formatting only; no sign handling needed (input rejects '-').
  const cleaned = raw.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Allow only digits, comma, dollar sign, decimal point. Minus sign is rejected
// at input time so users don't silently submit a positive value after typing '-'.
function sanitizeInput(raw: string): string {
  return raw.replace(/[^0-9.,$]/g, '');
}

/**
 * Shared scaffold for owner-input-gated insights. Runway is the first consumer;
 * break-even and future gated stats reuse this component.
 *
 * Deliberately raw Tailwind + semantic HTML, shadcn Card/Button aren't fully
 * installed in this codebase yet (Epic 3 retro). The design tokens (border,
 * bg-card, radius) match AiSummaryCard so the feed stays visually coherent.
 */
export function LockedInsightCard({
  title,
  description,
  inputLabel,
  inputPlaceholder,
  inputMask = 'currency',
  inputMax = 999_999_999,
  submitLabel = 'Save',
  onSubmit,
  className,
}: LockedInsightCardProps) {
  const [raw, setRaw] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const inputId = useId();
  const descId = useId();
  const errorId = useId();

  const parsed = parseMaskedInput(raw);
  const valid = parsed !== null && parsed > 0 && parsed <= inputMax;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || submitting) return;

    setSubmitting(true);
    setError(null);

    try {
      await onSubmit(parsed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not save. Please try again.';
      setError(msg);
      setSubmitting(false);
    }
  }

  function handleBlur() {
    if (parsed !== null && inputMask === 'currency') {
      setRaw(formatCurrency(parsed));
    }
  }

  function handleFocus() {
    if (parsed !== null) {
      setRaw(String(parsed));
    }
  }

  return (
    <div
      className={cn(
        'rounded-xl border border-dashed border-border bg-card p-5 shadow-sm',
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 rounded-md bg-muted p-2 text-muted-foreground" aria-hidden="true">
          <Lock className="h-4 w-4" />
        </div>
        <div className="flex-1">
          <h3 className="text-base font-semibold text-foreground">{title}</h3>
          <p id={descId} className="mt-1 text-sm text-muted-foreground">
            {description}
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="mt-4">
        <label htmlFor={inputId} className="block text-sm font-medium text-foreground">
          {inputLabel}
        </label>
        <div className="mt-1.5 flex gap-2">
          <input
            id={inputId}
            type="text"
            inputMode="decimal"
            value={raw}
            placeholder={inputPlaceholder ?? (inputMask === 'currency' ? '$0' : '0')}
            aria-describedby={error ? errorId : descId}
            aria-invalid={error ? 'true' : undefined}
            disabled={submitting}
            onChange={(e) => {
              setRaw(sanitizeInput(e.target.value));
              if (error) setError(null);
            }}
            onBlur={handleBlur}
            onFocus={handleFocus}
            className={cn(
              'flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm',
              'focus:outline-none focus:ring-2 focus:ring-primary/40',
              'disabled:opacity-50',
            )}
          />
          <button
            type="submit"
            disabled={!valid || submitting}
            className={cn(
              'rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground',
              'hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-primary/40',
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
          >
            {submitting ? 'Saving...' : submitLabel}
          </button>
        </div>
        {error && (
          <p id={errorId} role="alert" aria-live="polite" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
