import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

const mockPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush }),
}));

import ResetPasswordForm from './ResetPasswordForm';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('ResetPasswordForm', () => {
  it('shows a link to request a new one when the token is missing', () => {
    render(<ResetPasswordForm />);

    expect(screen.getByText(/missing its token/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /request a new link/i })).toHaveAttribute('href', '/forgot-password');
  });

  it('shows a link to request a new one when the reset fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({ error: { message: 'Reset link not found' } }),
    }));

    render(<ResetPasswordForm token="expired-token" />);

    fireEvent.change(screen.getByPlaceholderText(/new password/i), { target: { value: 'newpassword123' } });
    fireEvent.click(screen.getByRole('button', { name: /reset password/i }));

    await waitFor(() => {
      expect(screen.getByText('Reset link not found')).toBeInTheDocument();
    });
    expect(screen.getByRole('link', { name: /request a new link/i })).toHaveAttribute('href', '/forgot-password');
  });

  it('redirects to the dashboard on a successful reset', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: {} }),
    }));

    render(<ResetPasswordForm token="valid-token" />);

    fireEvent.change(screen.getByPlaceholderText(/new password/i), { target: { value: 'newpassword123' } });
    fireEvent.click(screen.getByRole('button', { name: /reset password/i }));

    await waitFor(() => {
      expect(mockPush).toHaveBeenCalledWith('/dashboard');
    });
    expect(screen.queryByRole('link', { name: /request a new link/i })).not.toBeInTheDocument();
  });
});
