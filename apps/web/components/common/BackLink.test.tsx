import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { BackLink } from './BackLink';

afterEach(cleanup);

describe('BackLink', () => {
  it('points at the dashboard by default', () => {
    render(<BackLink />);
    const link = screen.getByRole('link', { name: /back to dashboard/i });
    expect(link.getAttribute('href')).toBe('/dashboard');
  });

  it('takes a different parent when one is given', () => {
    render(<BackLink href="/admin" label="Back to admin" />);
    const link = screen.getByRole('link', { name: /back to admin/i });
    expect(link.getAttribute('href')).toBe('/admin');
  });

  // The arrow is decoration next to a label that already says where you are
  // going, so a screen reader announcing "left arrow back to dashboard" would
  // be reading punctuation aloud.
  it('hides the arrow from the accessible name', () => {
    render(<BackLink />);
    expect(screen.getByRole('link').textContent).toContain('←');
    expect(screen.getByRole('link', { name: 'Back to dashboard' })).toBeInTheDocument();
  });
});
