import type { ReactElement } from 'react';
import { describe, expect, it, vi } from 'vitest';

// next/font returns a generated class that *defines* the custom property.
// Standing in the property name for that class keeps the assertions readable.
vi.mock('next/font/google', () => {
  const font = (opts: { variable: string }) => ({
    variable: opts.variable,
    className: '',
  });
  return { Inter: font, Newsreader: font, JetBrains_Mono: font };
});

vi.mock('@/components/ThemeProvider', () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@/components/common/ResponsiveToaster', () => ({
  ResponsiveToaster: () => null,
}));

import RootLayout from './layout';

const FONT_VARIABLES = ['--font-inter', '--font-newsreader', '--font-jetbrains-mono'];

function render() {
  return RootLayout({ children: null }) as ReactElement<{
    className?: string;
    children?: unknown;
  }>;
}

describe('RootLayout', () => {
  // globals.css declares --font-serif and friends inside @theme, which compiles
  // to :root. A custom property set on a descendant is invisible there, so the
  // whole family silently resolves to the generic fallback.
  it('declares the font variables on <html>, where :root reads them', () => {
    const html = render();

    expect(html.type).toBe('html');
    for (const variable of FONT_VARIABLES) {
      expect(html.props.className ?? '').toContain(variable);
    }
  });

  it('keeps the font variables off <body>', () => {
    const body = render().props.children as ReactElement<{ className?: string }>;

    expect(body.type).toBe('body');
    for (const variable of FONT_VARIABLES) {
      expect(body.props.className ?? '').not.toContain(variable);
    }
  });
});
