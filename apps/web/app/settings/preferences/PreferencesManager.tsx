'use client';

import { useTheme } from 'next-themes';
import { useSyncExternalStore } from 'react';
import { Sun, Moon, Monitor } from 'lucide-react';
import { cn } from '@/lib/utils';
import { trackClientEvent } from '@/lib/analytics';

const themes = [
  { value: 'light', label: 'Light', description: 'Always use light mode', icon: Sun },
  { value: 'dark', label: 'Dark', description: 'Always use dark mode', icon: Moon },
  { value: 'system', label: 'System', description: 'Match your OS setting', icon: Monitor },
] as const;

const noop = () => () => {};

export default function PreferencesManager() {
  const { theme, setTheme } = useTheme();
  const mounted = useSyncExternalStore(noop, () => true, () => false);
  const current = mounted ? (theme ?? 'system') : 'system';

  function handleChange(value: string) {
    setTheme(value);
    trackClientEvent('theme.changed', { theme: value });
  }

  return (
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-foreground">Preferences</h1>
        <p className="mt-1 text-sm text-muted-foreground">Customize your experience.</p>
      </div>

      <section>
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted-foreground">Appearance</h2>
        <div className="mt-3 grid grid-cols-3 gap-3">
          {themes.map(({ value, label, description, icon: Icon }) => (
            <button
              key={value}
              onClick={() => handleChange(value)}
              className={cn(
                'flex flex-col items-center gap-2 rounded-lg border p-5 text-center transition-colors',
                current === value
                  ? 'border-primary bg-primary/5 ring-1 ring-primary'
                  : 'border-border bg-card hover:border-primary/40 hover:bg-accent/50',
              )}
              aria-pressed={current === value}
            >
              <Icon className={cn(
                'h-6 w-6',
                current === value ? 'text-primary' : 'text-muted-foreground',
              )} />
              <span className="text-sm font-medium text-foreground">{label}</span>
              <span className="text-xs text-muted-foreground">{description}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="mt-8 border-t border-border pt-6">
        <a
          href="/dashboard"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          &larr; Back to dashboard
        </a>
      </div>
    </div>
  );
}
