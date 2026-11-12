import { describe, it, expect, vi } from 'vitest';

import { safeRedirect } from './auth-utils';

// This backs three sign-in flows (password login, signup, OAuth callback), and
// in the callback the candidate comes out of sessionStorage, so anything able
// to write that key picks where a freshly authenticated user lands.
describe('safeRedirect', () => {
  it.each([
    '/dashboard',
    '/upload',
    '/settings/alerts',
    '/dashboard?dataset=3',
    '/settings/alerts?tab=email',
    '/dashboard#cash-flow',
    '/dashboard?a=1&b=2#stats',
  ])('keeps the same-origin path %s', (path) => {
    expect(safeRedirect(path)).toBe(path);
  });

  // The backslash is the one the prefix test missed: the URL parser treats it
  // as a separator, so these all resolve to a different origin.
  it.each([
    ['a backslash standing in for the second slash', '/\\evil.example'],
    ['a backslash followed by a real slash', '/\\/evil.example'],
    ['a backslash with a path', '/\\evil.example/steal'],
    ['mixed separators', '/\\\\evil.example'],
  ])('refuses %s', (_label, path) => {
    expect(safeRedirect(path)).toBe('/dashboard');
  });

  // Dot segments normalise AFTER resolution, so the candidate resolves
  // same-origin while the pathname it produces is itself protocol-relative.
  // The first version of this guard checked the input and returned a string it
  // never checked, which reopened the same hole through a different door.
  it.each([
    ['a dot segment before a double slash', '/.//evil.example'],
    ['a percent-encoded dot segment', '/%2e//evil.example'],
    ['a parent segment before a double slash', '/..//evil.example'],
    ['dot segments that climb past the root', '/a/../..//evil.example'],
  ])('refuses %s, which normalises to a protocol-relative path', (_label, path) => {
    expect(safeRedirect(path)).toBe('/dashboard');
  });

  it.each([
    ['a protocol-relative URL', '//evil.example'],
    ['an absolute http URL', 'http://evil.example/steal'],
    ['an absolute https URL', 'https://evil.example'],
    ['a bare host', 'evil.example'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['a data URL', 'data:text/html,<script>alert(1)</script>'],
    ['an empty string', ''],
    ['null', null],
    ['undefined', undefined],
  ])('refuses %s', (_label, path) => {
    expect(safeRedirect(path)).toBe('/dashboard');
  });

  // The invariant, asserted over the whole corpus rather than case by case:
  // whatever comes back has to resolve same-origin when the router re-parses it.
  // That is exactly what the first version of this guard broke.
  it('never returns a path that resolves off-origin', () => {
    const origin = 'https://app.example';
    const hostile = [
      '//evil.example', '/\\evil.example', '/\\/evil.example', '/\\\\evil.example',
      '/.//evil.example', '/..//evil.example', '/%2e//evil.example', '/%2E%2E//evil.example',
      '/a/../..//evil.example', '/./././/evil.example', '/.%2F/evil.example',
      '/\t//evil.example', '/\n//evil.example', '/\r//evil.example',
      '//evil.example/path?a=1#b', '/..//..//evil.example',
      'http://evil.example', 'https://evil.example', 'javascript:alert(1)',
      'data:text/html,x', 'evil.example', '', '/', '/dashboard', '/a?b=//evil.example',
    ];

    for (const candidate of hostile) {
      const out = safeRedirect(candidate);
      expect(new URL(out, origin).origin, `candidate ${JSON.stringify(candidate)} returned ${JSON.stringify(out)}`).toBe(origin);
    }
  });

  // auth-utils is imported by five server-component layouts for extractIsAdmin.
  // Reading window here would throw into the catch, which returns the fallback,
  // so every redirect would silently become /dashboard instead of failing loudly.
  it('works with no window, the way a server component sees it', () => {
    vi.stubGlobal('window', undefined);
    try {
      expect(safeRedirect('/upload')).toBe('/upload');
      expect(safeRedirect('/dashboard?dataset=3')).toBe('/dashboard?dataset=3');
      expect(safeRedirect('/\\evil.example')).toBe('/dashboard');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
