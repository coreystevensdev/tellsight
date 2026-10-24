import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import EmailSettings from './EmailSettings';
import type { EmailPreferencesResponse } from 'shared/schemas';

const mockApiClient = vi.fn();

vi.mock('@/lib/api-client', () => ({
  apiClient: (...args: unknown[]) => mockApiClient(...args),
  ApiClientError: class ApiClientError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
}));

beforeEach(() => {
  mockApiClient.mockReset();
});

function defaultsResponse(overrides: Partial<EmailPreferencesResponse> = {}): EmailPreferencesResponse {
  return {
    cadence: 'weekly',
    timezone: 'UTC',
    unsubscribedAt: null,
    lastSentAt: null,
    ...overrides,
  };
}

describe('EmailSettings', () => {
  it('renders the initial cadence and timezone passed in', () => {
    render(<EmailSettings initial={defaultsResponse({ cadence: 'monthly', timezone: 'America/Los_Angeles' })} />);

    const monthlyRadio = screen.getByRole('radio', { name: /monthly/i });
    expect(monthlyRadio).toBeChecked();
    expect((screen.getByDisplayValue('America/Los_Angeles') as HTMLInputElement).value).toBe('America/Los_Angeles');
  });

  it('shows the unsubscribed banner only when cadence is off AND unsubscribedAt is set', () => {
    const { unmount } = render(<EmailSettings initial={defaultsResponse({ cadence: 'off', unsubscribedAt: '2026-05-01T00:00:00Z' })} />);
    expect(screen.getByText(/you unsubscribed/i)).toBeInTheDocument();
    unmount();

    render(<EmailSettings initial={defaultsResponse({ cadence: 'weekly', unsubscribedAt: null })} />);
    expect(screen.queryByText(/you unsubscribed/i)).not.toBeInTheDocument();
  });

  it('does not show the banner when cadence is off but unsubscribedAt is null (defaults case)', () => {
    render(<EmailSettings initial={defaultsResponse({ cadence: 'off', unsubscribedAt: null })} />);
    expect(screen.queryByText(/you unsubscribed/i)).not.toBeInTheDocument();
  });

  it('submits cadence + timezone via PUT (analytics emit lives on the server)', async () => {
    const user = userEvent.setup({ delay: null });
    mockApiClient.mockResolvedValueOnce({ data: { cadence: 'monthly', timezone: 'UTC' } });

    render(<EmailSettings initial={defaultsResponse()} />);

    await user.click(screen.getByRole('radio', { name: /monthly/i }));
    await user.click(screen.getByRole('button', { name: /save preferences/i }));

    await waitFor(() => {
      expect(mockApiClient).toHaveBeenCalledWith('/preferences/email/digest', expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ cadence: 'monthly', timezone: 'UTC' }),
      }));
    });
  });

  it('shows an error message when the save fails', async () => {
    const user = userEvent.setup({ delay: null });
    mockApiClient.mockRejectedValueOnce(new Error('Network down'));

    render(<EmailSettings initial={defaultsResponse()} />);
    await user.click(screen.getByRole('button', { name: /save preferences/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/network down/i);
  });
});
