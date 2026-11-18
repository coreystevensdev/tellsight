// @vitest-environment node

import { describe, expect, it } from 'vitest';

// There was no test on the CSP until Plaid's origins went into it (ADR 0002
// amendment). A security header with no assertion is one careless edit from
// being gone, and it mattered less while every source was 'self'.
//
// Reads the config as text rather than importing it. next.config.ts builds the
// policy inside headers(), which Next calls, and the only stable way to assert
// the directives without standing up a Next server is the source itself. That
// makes this a pin on what the file says, not on what a response carries, which
// is the honest limit of it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = readFileSync(join(import.meta.dirname, 'next.config.ts'), 'utf8');

function directive(name: string): string {
  const line = source.split('\n').find((l) => l.includes(`${name} `) && !l.trimStart().startsWith('//'));
  if (!line) throw new Error(`no ${name} directive found in next.config.ts`);
  return line;
}

describe('Content-Security-Policy', () => {
  it('keeps default-src locked to self', () => {
    expect(source).toContain(`"default-src 'self'"`);
  });

  // The whole argument in ADR 0002 rests on these three still being present.
  it.each(['object-src \'none\'', 'base-uri \'none\'', 'form-action \'self\'', 'frame-ancestors \'none\''])(
    'keeps %s',
    (expected) => {
      expect(source).toContain(expected);
    },
  );

  it('allows exactly the Plaid Link script and nothing else external in script-src', () => {
    const line = directive('script-src');

    expect(line).toContain('PLAID_LINK_SCRIPT');
    // Any other https: origin in script-src is a widening that should fail here
    // rather than ship.
    expect(line).not.toMatch(/https:\/\/(?!cdn\.plaid\.com)/);
  });

  it('pins the Plaid origins to Plaid', () => {
    expect(source).toContain("const PLAID_CDN = 'https://cdn.plaid.com'");
    expect(source).toContain("'https://production.plaid.com'");
    expect(source).toContain("'https://sandbox.plaid.com'");
  });

  // Naming both at once was the first version and is unnecessary breadth: a
  // deployment talks to one of them. Defaults to sandbox so a missing variable
  // cannot silently allow the production origin.
  it('selects one Plaid API origin rather than allowing both', () => {
    expect(source).toContain('const PLAID_API_ORIGIN =');
    expect(source).toContain("NEXT_PUBLIC_PLAID_ENVIRONMENT === 'production'");
    expect(source).not.toMatch(/'https:\/\/production\.plaid\.com https:\/\/sandbox/);
  });

  // The directive that compensates for 'unsafe-inline'. Plaid's API origins are
  // the only third parties it may name; anything else breaks the ADR's argument
  // rather than bending it.
  it('keeps connect-src to self, Sentry and Plaid', () => {
    const line = directive('connect-src');

    expect(line).toContain("'self'");
    expect(line).toContain('PLAID_API_ORIGIN');
    expect(line).toContain('sentry');
    expect(line).not.toMatch(/https:\/\/(?!production\.plaid\.com|sandbox\.plaid\.com)/);
  });

  it('declares frame-src, without which Link falls through to default-src', () => {
    expect(directive('frame-src')).toContain('PLAID_CDN');
  });

  // 'unsafe-eval' is the dev bundler's and ADR 0002 is explicit that it must not
  // reach production.
  it('gates unsafe-eval on dev', () => {
    const line = directive('script-src');

    expect(line).toContain("dev ? \" 'unsafe-eval'\" : ''");
  });
});
