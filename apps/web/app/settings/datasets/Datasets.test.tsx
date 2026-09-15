import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// 382 lines and no test file, the largest untested surface in the app. Three of
// its four writes are optimistic, which is the part worth pinning: the list is
// updated locally and only reverted if the server disagrees, so a regression
// here shows the user a name or an active badge that was never saved.

const apiClient = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiClient: (...args: unknown[]) => apiClient(...args) }));

import Datasets from './Datasets';

function dataset(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    name: 'Q3 revenue',
    rowCount: 1234,
    sourceType: 'csv',
    uploadedBy: { id: 9, name: 'Corey' },
    createdAt: '2026-08-01T00:00:00Z',
    isActive: true,
    ...over,
  };
}

const TWO = [dataset(), dataset({ id: 2, name: 'Q2 revenue', rowCount: 900, isActive: false })];

/** Answers the list call, and hands anything else to `then`. */
function listReturns(rows: unknown[], then?: (path: string, init?: RequestInit) => unknown) {
  apiClient.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === '/datasets/manage') return { data: rows };
    if (then) return then(path, init);
    return { data: {} };
  });
}

/** Each dataset renders as one border-t-2 block, which is what scopes the queries. */
function card(name: string) {
  return screen.getByText(name).closest('div[class*="border-t-2"]') as HTMLElement;
}

beforeEach(() => {
  apiClient.mockReset();
});

describe('Datasets list', () => {
  it('shows a spinner until the list arrives', async () => {
    let release!: (v: unknown) => void;
    apiClient.mockReturnValue(new Promise((res) => { release = res; }));

    const { container } = render(<Datasets />);
    expect(container.querySelector('.animate-spin')).toBeInTheDocument();

    await act(async () => { release({ data: [] }); });
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Datasets' })).toBeInTheDocument());
  });

  it('renders each dataset with its row count', async () => {
    listReturns(TWO);
    render(<Datasets />);

    expect(await screen.findByText('Q3 revenue')).toBeInTheDocument();
    expect(screen.getByText('Q2 revenue')).toBeInTheDocument();
    expect(screen.getByText('1,234')).toBeInTheDocument();
    expect(screen.getByText('900')).toBeInTheDocument();
  });

  it('surfaces the reason the list failed rather than an empty page', async () => {
    apiClient.mockRejectedValue(new Error('Session expired'));
    render(<Datasets />);

    expect(await screen.findByText('Session expired')).toBeInTheDocument();
  });

  // The banner has a dismiss button, so every error it can show has to be one the
  // button can clear. A load failure is the easiest one to leave underivable by
  // accident, which strands the user with a banner that will not go away.
  it('lets the user dismiss a load failure', async () => {
    apiClient.mockRejectedValue(new Error('Session expired'));
    const user = userEvent.setup();
    render(<Datasets />);
    await screen.findByText('Session expired');

    await user.click(screen.getByRole('button', { name: 'Dismiss error' }));

    expect(screen.queryByText('Session expired')).not.toBeInTheDocument();
  });

  // The page can sit open in a background tab while a CSV is uploaded in another
  // one, so returning to it has to pick up the new dataset.
  it('reloads when the tab becomes visible again', async () => {
    listReturns(TWO);
    render(<Datasets />);
    await screen.findByText('Q3 revenue');
    const afterLoad = apiClient.mock.calls.filter(([p]) => p === '/datasets/manage').length;

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });

    await waitFor(() =>
      expect(apiClient.mock.calls.filter(([p]) => p === '/datasets/manage').length).toBe(afterLoad + 1),
    );
  });
});

describe('Datasets activate', () => {
  // Exactly one dataset feeds the dashboard, so activating one has to visibly
  // deactivate the other in the same beat, without waiting for a refetch.
  it('moves the active badge without reloading the list', async () => {
    listReturns(TWO);
    const user = userEvent.setup();
    render(<Datasets />);
    await screen.findByText('Q2 revenue');

    const before = apiClient.mock.calls.filter(([p]) => p === '/datasets/manage').length;
    await user.click(screen.getByRole('button', { name: 'Set active' }));

    await waitFor(() => expect(screen.getAllByText('Active')).toHaveLength(1));
    expect(within(card('Q2 revenue')).getByText('Active')).toBeInTheDocument();
    expect(apiClient.mock.calls.filter(([p]) => p === '/datasets/manage').length).toBe(before);
  });
});

describe('Datasets rename', () => {
  // The optimistic write is not visible while the PATCH is in flight, because the
  // input is still covering the name. What it buys is the frame after: the new
  // name is already in the list, so it appears without a round trip back for it.
  it('shows the new name without refetching the list', async () => {
    listReturns(TWO);
    const user = userEvent.setup();
    render(<Datasets />);
    await screen.findByText('Q3 revenue');
    const before = apiClient.mock.calls.filter(([p]) => p === '/datasets/manage').length;

    await user.click(within(card('Q3 revenue')).getByRole('button', { name: 'Rename dataset' }));
    const input = screen.getByRole('textbox');
    await user.clear(input);
    await user.type(input, 'Q3 revenue final');
    await user.keyboard('{Enter}');

    expect(await screen.findByText('Q3 revenue final')).toBeInTheDocument();
    expect(apiClient.mock.calls.filter(([p]) => p === '/datasets/manage').length).toBe(before);
    expect(apiClient.mock.calls.some(([p, i]) => p === '/datasets/manage/1' && (i as RequestInit)?.method === 'PATCH')).toBe(true);
  });

  // The optimistic update above is only safe because of this: a rejected PATCH
  // has to put the old name back, or the user is looking at a name that exists
  // nowhere but their screen.
  it('puts the old name back when the server rejects it', async () => {
    listReturns(TWO, () => Promise.reject(new Error('Name already taken')));
    const user = userEvent.setup();
    render(<Datasets />);
    await screen.findByText('Q3 revenue');

    await user.click(within(card('Q3 revenue')).getByRole('button', { name: 'Rename dataset' }));
    const input = screen.getByRole('textbox');
    await user.clear(input);
    await user.type(input, 'Something else');
    await user.keyboard('{Enter}');

    expect(await screen.findByText('Name already taken')).toBeInTheDocument();
    expect(screen.getByText('Q3 revenue')).toBeInTheDocument();
    expect(screen.queryByText('Something else')).not.toBeInTheDocument();
  });

  it('does not call the API when the name comes back unchanged', async () => {
    listReturns(TWO);
    const user = userEvent.setup();
    render(<Datasets />);
    await screen.findByText('Q3 revenue');

    await user.click(within(card('Q3 revenue')).getByRole('button', { name: 'Rename dataset' }));
    await user.keyboard('{Enter}');

    expect(apiClient.mock.calls.filter(([, init]) => (init as RequestInit)?.method === 'PATCH')).toHaveLength(0);
  });
});

describe('Datasets delete', () => {
  // The confirm step exists to show what else goes with the dataset. Deleting
  // one silently takes its AI summaries and every share link already handed out.
  it('names what else will be destroyed before asking to confirm', async () => {
    listReturns(TWO, (path) =>
      path === '/datasets/manage/1'
        ? { data: { ...dataset(), summaryCount: 4, shareCount: 2 } }
        : { data: {} },
    );
    const user = userEvent.setup();
    render(<Datasets />);
    await screen.findByText('Q3 revenue');

    await user.click(within(card('Q3 revenue')).getByRole('button', { name: 'Delete dataset' }));

    expect(await screen.findByText(/permanently remove/)).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('removes the card once the delete succeeds', async () => {
    listReturns(TWO, (path, init) => {
      if (path === '/datasets/manage/1' && init?.method !== 'DELETE') {
        return { data: { ...dataset(), summaryCount: 0, shareCount: 0 } };
      }
      return { data: {} };
    });
    const user = userEvent.setup();
    render(<Datasets />);
    await screen.findByText('Q3 revenue');

    await user.click(within(card('Q3 revenue')).getByRole('button', { name: 'Delete dataset' }));
    await user.click(await screen.findByRole('button', { name: 'Yes, delete' }));

    await waitFor(() => expect(screen.queryByText('Q3 revenue')).not.toBeInTheDocument());
    expect(screen.getByText('Q2 revenue')).toBeInTheDocument();
  });

  // The backend enforces owner-only. Its raw message is not something a member
  // can act on, so the component rewrites that one case and passes the rest through.
  it('explains an owner-only refusal in plain terms', async () => {
    listReturns(TWO, (path, init) => {
      if (path === '/datasets/manage/1' && init?.method !== 'DELETE') {
        return { data: { ...dataset(), summaryCount: 0, shareCount: 0 } };
      }
      return Promise.reject(new Error('Forbidden: owner role required'));
    });
    const user = userEvent.setup();
    render(<Datasets />);
    await screen.findByText('Q3 revenue');

    await user.click(within(card('Q3 revenue')).getByRole('button', { name: 'Delete dataset' }));
    await user.click(await screen.findByRole('button', { name: 'Yes, delete' }));

    expect(await screen.findByText('Only org owners can delete datasets.')).toBeInTheDocument();
    expect(screen.getByText('Q3 revenue')).toBeInTheDocument();
  });
});
