'use client';

import { useTheme } from 'next-themes';
import { Sun, Moon, Monitor } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { trackClientEvent } from '@/lib/analytics';

const cycleOrder = ['light', 'dark', 'system'] as const;
const icons = { light: Sun, dark: Moon, system: Monitor } as const;
const labels = { light: 'Light mode', dark: 'Dark mode', system: 'System theme' } as const;

const noop = () => () => {};

export function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(noop, () => true, () => false);

  function cycle() {
    const idx = cycleOrder.indexOf(theme as (typeof cycleOrder)[number]);
    const next = cycleOrder[(idx + 1) % cycleOrder.length] ?? 'system';
    setTheme(next);
    trackClientEvent('theme.changed', { theme: next });
  }

  if (!mounted) {
    // SSR placeholder, same dimensions, no icon to avoid hydration mismatch
    return (
      <button className="inline-flex h-9 w-9 items-center justify-center rounded-md" disabled aria-hidden>
        <span className="h-4 w-4" />
      </button>
    );
  }

  const current = (theme ?? 'system') as keyof typeof icons;
  const Icon = icons[current] ?? Monitor;

  return (
    <button
      onClick={cycle}
      className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      aria-label={labels[current] ?? 'Toggle theme'}
      title={labels[current] ?? 'Toggle theme'}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}
