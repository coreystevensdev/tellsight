'use client';

import { cn } from '@/lib/utils';

interface UpgradeCtaProps {
  variant: 'overlay' | 'inline';
  onUpgrade: () => void;
  disabled?: boolean;
  disabledTooltip?: string;
}

export function UpgradeCta({ variant, onUpgrade, disabled, disabledTooltip }: UpgradeCtaProps) {
  const isOverlay = variant === 'overlay';

  return (
    <div
      className={cn(
        'rounded-lg bg-card p-6 text-center shadow-lg',
        isOverlay && 'mx-auto max-w-sm',
        !isOverlay && 'border border-border border-l-4 border-l-primary w-full',
      )}
    >
      <h3 className="text-lg font-semibold text-foreground">
        Unlock full analysis
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Full AI insights, no word limits — <span className="font-medium text-foreground">$29/mo</span>
      </p>
      <button
        type="button"
        aria-label="Upgrade to Pro subscription for $29 per month"
        aria-disabled={disabled || undefined}
        aria-describedby={disabled && disabledTooltip ? 'upgrade-tooltip' : undefined}
        title={disabled ? disabledTooltip : undefined}
        onClick={onUpgrade}
        className={cn(
          'mt-4 inline-flex min-h-11 min-w-11 items-center justify-center rounded-md bg-primary px-6 py-2.5 text-sm font-medium text-primary-foreground',
          disabled
            ? 'opacity-60 cursor-not-allowed'
            : 'hover:bg-primary/90',
        )}
      >
        Upgrade to Pro
      </button>
      {disabled && disabledTooltip && (
        <p id="upgrade-tooltip" className="mt-2 text-xs text-muted-foreground">
          {disabledTooltip}
        </p>
      )}
    </div>
  );
}
