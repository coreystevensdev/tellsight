import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { AccountMenu } from './AccountMenu';

const mockLocationAssign = vi.fn();

beforeEach(() => {
  vi.stubGlobal('location', { ...window.location, assign: mockLocationAssign });
  mockLocationAssign.mockClear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('AccountMenu', () => {
  it('renders a closed menu by default', () => {
    render(<AccountMenu />);

    expect(screen.getByLabelText('Account menu')).toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('opens the menu on trigger click and shows Billing and Sign out', () => {
    render(<AccountMenu />);

    fireEvent.click(screen.getByLabelText('Account menu'));

    expect(screen.getByRole('menuitem', { name: 'Billing' })).toHaveAttribute('href', '/billing');
    expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument();
  });

  it('closes the menu on Escape', () => {
    render(<AccountMenu />);

    fireEvent.click(screen.getByLabelText('Account menu'));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('closes the menu on an outside click', () => {
    render(
      <div>
        <AccountMenu />
        <button>outside</button>
      </div>,
    );

    fireEvent.click(screen.getByLabelText('Account menu'));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByText('outside'));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('posts to the logout endpoint and hard-navigates to /login on sign out', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', fetchMock);

    render(<AccountMenu />);
    fireEvent.click(screen.getByLabelText('Account menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: /sign out/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
    });
    await waitFor(() => {
      expect(mockLocationAssign).toHaveBeenCalledWith('/login');
    });
  });

  it('still redirects to /login if the logout request fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));

    render(<AccountMenu />);
    fireEvent.click(screen.getByLabelText('Account menu'));
    fireEvent.click(screen.getByRole('menuitem', { name: /sign out/i }));

    await waitFor(() => {
      expect(mockLocationAssign).toHaveBeenCalledWith('/login');
    });
  });
});
