'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DemoModeState } from 'shared/types';

interface DemoModeBannerProps {
  demoState: DemoModeState;
  onUploadClick: () => void;
}

const MESSAGES: Partial<Record<DemoModeState, string>> = {
  seed_only: "You're viewing sample data, upload your own CSV to see real insights",
  empty: 'Get started, upload a CSV to see AI-powered insights',
};

export function DemoModeBanner({ demoState, onUploadClick }: DemoModeBannerProps) {
  const [dismissed, setDismissed] = useState(false);
  const [dissolving, setDissolving] = useState(false);
  const [prevDemoState, setPrevDemoState] = useState(demoState);
  const [dissolveMessage, setDissolveMessage] = useState<string | null>(null);

  if (prevDemoState !== demoState) {
    setPrevDemoState(demoState);
    if (prevDemoState === 'seed_only' && !dissolving) {
      setDissolving(true);
      setDissolveMessage(MESSAGES[prevDemoState] ?? null);
    }
  }

  if (dismissed) return null;

  // Dissolving, show old message with fade-out, no interactive elements
  if (dissolving && dissolveMessage) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="border-b border-primary/20 bg-primary/5 px-4 py-3 md:px-6 lg:px-8 animate-banner-dissolve motion-reduce:hidden"
        onAnimationEnd={() => setDismissed(true)}
      >
        <div className="mx-auto flex max-w-7xl items-center justify-center gap-3">
          <p className="text-sm text-foreground">{dissolveMessage}</p>
        </div>
      </div>
    );
  }

  if (demoState === 'seed_plus_user' || demoState === 'user_only') return null;

  const message = MESSAGES[demoState];
  if (!message) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'border-b border-primary/20 bg-primary/5 px-4 py-3 md:px-6 lg:px-8',
        'motion-reduce:transition-none',
      )}
    >
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-center gap-2 text-center sm:flex-row sm:gap-3 sm:text-left">
        <p className="text-sm text-foreground">{message}</p>
        <button
          type="button"
          onClick={onUploadClick}
          className="shrink-0 rounded-md bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground hover:bg-primary/90"
        >
          Upload CSV
        </button>
        {demoState === 'seed_only' && (
          <button
            type="button"
            onClick={() => setDismissed(true)}
            aria-label="Dismiss sample data notice"
            className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
