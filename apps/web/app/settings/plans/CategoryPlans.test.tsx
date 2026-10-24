import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CategoryPlans from './CategoryPlans';

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

// Load fires both requests through Promise.all, plans first.
function mockLoad(plans: { category: string; plannedMonthly: number }[], categories: string[]) {
  mockApiClient.mockResolvedValueOnce({ data: plans });
  mockApiClient.mockResolvedValueOnce({ data: { availableCategories: categories } });
}

function planField(category: string) {
  return screen.getByLabelText(new RegExp(`monthly plan for ${category}`, 'i'));
}

describe('CategoryPlans', () => {
  it('shows a row for every category in the data and pre-fills saved plans', async () => {
    mockLoad([{ category: 'Rent', plannedMonthly: 2400 }], ['Rent', 'Software']);

    render(<CategoryPlans />);

    await waitFor(() => expect(planField('Rent')).toHaveValue('2,400'));
    expect(planField('Software')).toHaveValue('');
  });

  it('keeps the save button inert until something actually changes', async () => {
    mockLoad([{ category: 'Rent', plannedMonthly: 2400 }], ['Rent']);

    render(<CategoryPlans />);

    await waitFor(() => expect(planField('Rent')).toHaveValue('2,400'));
    expect(screen.getByRole('button', { name: /save plans/i })).toBeDisabled();
  });

  it('sends only the categories that changed', async () => {
    const user = userEvent.setup({ delay: null });
    mockLoad([{ category: 'Rent', plannedMonthly: 2400 }], ['Rent', 'Software']);

    render(<CategoryPlans />);
    await waitFor(() => expect(planField('Rent')).toHaveValue('2,400'));

    mockApiClient.mockResolvedValueOnce({ data: [] });
    await user.type(planField('Software'), '300');
    await user.click(screen.getByRole('button', { name: /save plans/i }));

    await waitFor(() => {
      const put = mockApiClient.mock.calls.find((c) => (c[1] as { method?: string } | undefined)?.method === 'PUT');
      expect(JSON.parse((put![1] as { body: string }).body)).toEqual({
        plans: [{ category: 'Software', plannedMonthly: 300 }],
      });
    });
  });

  // PUT only upserts what it is given, so a cleared field has to be deleted or
  // the server keeps the old amount and the row silently survives.
  it('deletes a plan when its field is cleared', async () => {
    const user = userEvent.setup({ delay: null });
    mockLoad([{ category: 'Rent', plannedMonthly: 2400 }], ['Rent']);

    render(<CategoryPlans />);
    await waitFor(() => expect(planField('Rent')).toHaveValue('2,400'));

    mockApiClient.mockResolvedValueOnce(undefined);
    await user.clear(planField('Rent'));
    await user.click(screen.getByRole('button', { name: /save plans/i }));

    await waitFor(() => {
      expect(mockApiClient).toHaveBeenCalledWith('/org/category-plans/Rent', { method: 'DELETE' });
    });
    const put = mockApiClient.mock.calls.find((c) => (c[1] as { method?: string } | undefined)?.method === 'PUT');
    expect(put).toBeUndefined();
  });

  // Plans are not tied to a dataset, so one can outlive the category it was set
  // for. It still needs to be on screen or there is no way to remove it.
  it('still lists a planned category that is no longer in the data, and says so', async () => {
    mockLoad([{ category: 'Travel', plannedMonthly: 500 }], ['Rent']);

    render(<CategoryPlans />);

    await waitFor(() => expect(planField('Travel')).toHaveValue('500'));
    expect(screen.getByText(/not in your current data/i)).toBeInTheDocument();
  });

  it('explains a refusal rather than showing the raw failure', async () => {
    const user = userEvent.setup({ delay: null });
    mockLoad([], ['Rent']);

    render(<CategoryPlans />);
    await waitFor(() => expect(planField('Rent')).toHaveValue(''));

    const { ApiClientError } = await import('@/lib/api-client');
    mockApiClient.mockRejectedValueOnce(new ApiClientError('Forbidden', 403, null));
    await user.type(planField('Rent'), '100');
    await user.click(screen.getByRole('button', { name: /save plans/i }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/only organization owners/i);
    });
  });

  it('blocks saving an amount over the ceiling', async () => {
    const user = userEvent.setup({ delay: null });
    mockLoad([], ['Rent']);

    render(<CategoryPlans />);
    await waitFor(() => expect(planField('Rent')).toHaveValue(''));

    await user.type(planField('Rent'), '10000000');

    expect(screen.getByRole('button', { name: /save plans/i })).toBeDisabled();
    expect(screen.getByText(/up to 9,999,999/i)).toBeInTheDocument();
  });

  it('points at uploading when there is nothing to plan against', async () => {
    mockLoad([], []);

    render(<CategoryPlans />);

    await waitFor(() => {
      expect(screen.getByText(/upload data or connect an account first/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /save plans/i })).not.toBeInTheDocument();
  });
});
