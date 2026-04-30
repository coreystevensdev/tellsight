import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FinancialsForm from './FinancialsForm';

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

function mockGetResponse(overrides: Partial<{ cashOnHand: number; monthlyFixedCosts: number; cashAsOfDate: string; businessStartedDate: string }> = {}) {
  mockApiClient.mockResolvedValueOnce({ data: overrides });
}

describe('FinancialsForm, monthlyFixedCosts field', () => {
  it('displays a pre-existing value masked as currency on load', async () => {
    mockGetResponse({ monthlyFixedCosts: 10_000 });

    render(<FinancialsForm />);

    await waitFor(() => {
      expect(screen.getByLabelText(/monthly fixed costs/i)).toHaveValue('$10,000');
    });
  });

  it('submits zero as a legitimate value (>= 0 path)', async () => {
    const user = userEvent.setup();
    mockGetResponse({ monthlyFixedCosts: undefined });
    mockApiClient.mockResolvedValueOnce({ data: {} }); // PUT response

    render(<FinancialsForm />);

    const input = await screen.findByLabelText(/monthly fixed costs/i);
    await user.type(input, '0');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(mockApiClient).toHaveBeenCalledWith(
        '/org/financials',
        expect.objectContaining({
          method: 'PUT',
          body: expect.stringContaining('"monthlyFixedCosts":0'),
        }),
      );
    });
  });

  it('skips the field entirely when input is blank (!= null gate)', async () => {
    const user = userEvent.setup();
    mockGetResponse({ businessStartedDate: '2024-01-01' });
    mockApiClient.mockResolvedValueOnce({ data: {} });

    render(<FinancialsForm />);

    await screen.findByLabelText(/monthly fixed costs/i);
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mockApiClient).toHaveBeenCalledTimes(2));
    const putCall = mockApiClient.mock.calls[1];
    if (!putCall) throw new Error('expected PUT call');
    const body = JSON.parse((putCall[1] as { body: string }).body) as Record<string, unknown>;
    expect(body).not.toHaveProperty('monthlyFixedCosts');
  });
});
