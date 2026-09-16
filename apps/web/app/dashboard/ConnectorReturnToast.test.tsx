import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

// No test existed, which is how this stayed wrong. It only ever read `qb`, so
// Shopify and Square both returned from a completed OAuth flow, stored the
// connection, enqueued the first sync, and said nothing on screen.

// vi.mock factories are hoisted above every const in this file, so the spies
// have to be created inside vi.hoisted or the factory reads them before they
// exist.
const h = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  replace: vi.fn(),
  params: { current: new URLSearchParams() },
}));
const { success, info, error, replace } = h;

vi.mock('sonner', () => ({ toast: { success: h.success, info: h.info, error: h.error } }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => h.params.current,
  useRouter: () => ({ replace: h.replace }),
}));

import { ConnectorReturnToast } from './ConnectorReturnToast';

beforeEach(() => {
  vi.clearAllMocks();
  h.params.current = new URLSearchParams();
});

describe('ConnectorReturnToast', () => {
  it.each([
    ['qb', 'QuickBooks'],
    ['shopify', 'Shopify'],
    ['square', 'Square'],
  ])('names %s correctly on a successful return', (param, label) => {
    h.params.current = new URLSearchParams(`${param}=connected`);
    render(<ConnectorReturnToast />);
    expect(success).toHaveBeenCalledWith(`${label} connected`, expect.anything());
  });

  it.each([
    ['qb', 'QuickBooks'],
    ['shopify', 'Shopify'],
    ['square', 'Square'],
  ])('reports a failed %s return as an error', (param, label) => {
    h.params.current = new URLSearchParams(`${param}=error`);
    render(<ConnectorReturnToast />);
    expect(error).toHaveBeenCalledWith(`${label} connection failed`, expect.anything());
  });

  it('treats a cancelled authorization as information, not failure', () => {
    h.params.current = new URLSearchParams('square=denied');
    render(<ConnectorReturnToast />);
    expect(info).toHaveBeenCalledWith('Square connection cancelled', expect.anything());
    expect(error).not.toHaveBeenCalled();
  });

  // The flag has to come off the URL, or a refresh re-fires the toast and a
  // shared link carries someone else's connection result.
  it('strips the flag from the URL after firing', () => {
    h.params.current = new URLSearchParams('square=connected');
    render(<ConnectorReturnToast />);
    expect(replace).toHaveBeenCalledWith('/dashboard', { scroll: false });
  });

  it('does nothing on an ordinary dashboard visit', () => {
    render(<ConnectorReturnToast />);
    expect(success).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it('ignores a value it does not recognise but still clears it', () => {
    h.params.current = new URLSearchParams('square=wat');
    render(<ConnectorReturnToast />);
    expect(success).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalled();
  });
});
