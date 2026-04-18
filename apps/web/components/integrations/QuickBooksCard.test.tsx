import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { mockApiClient, mockToast, ApiClientError } = vi.hoisted(() => {
  class ApiClientError extends Error {
    constructor(message: string, readonly status: number, readonly code: string | null) {
      super(message);
      this.name = 'ApiClientError';
    }
  }
  return {
    mockApiClient: vi.fn(),
    mockToast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
    ApiClientError,
  };
});

vi.mock('@/lib/api-client', () => ({
  apiClient: (...args: unknown[]) => mockApiClient(...args),
  ApiClientError,
}));

vi.mock('sonner', () => ({ toast: mockToast }));

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));

import { QuickBooksCard } from './QuickBooksCard';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('QuickBooksCard', () => {
  it('renders disconnected state with Connect button and value props', async () => {
    mockApiClient.mockResolvedValueOnce({ data: { connected: false } });

    render(<QuickBooksCard />);

    await waitFor(() => {
      expect(screen.getByText('Import from QuickBooks')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /connect quickbooks/i })).toBeInTheDocument();
    expect(screen.getByText(/daily sync/i)).toBeInTheDocument();
  });

  it('renders connected state with company name and Manage link', async () => {
    mockApiClient.mockResolvedValueOnce({
      data: {
        connected: true,
        companyName: 'Acme Coffee Co',
        syncStatus: 'idle',
        lastSyncedAt: '2026-04-17T14:30:00.000Z',
      },
    });

    render(<QuickBooksCard />);

    await waitFor(() => {
      expect(screen.getByText('QuickBooks connected')).toBeInTheDocument();
    });
    expect(screen.getByText('Acme Coffee Co')).toBeInTheDocument();
    expect(screen.getByText('idle')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /manage in settings/i })).toHaveAttribute(
      'href',
      '/settings/integrations',
    );
  });

  it('renders nothing when status endpoint returns 501 (QB not configured)', async () => {
    mockApiClient.mockRejectedValueOnce(
      new ApiClientError('QuickBooks integration is not configured', 501, 'INTEGRATION_NOT_CONFIGURED'),
    );

    const { container } = render(<QuickBooksCard />);

    await waitFor(() => {
      expect(container).toBeEmptyDOMElement();
    });
  });

  it('renders a retry view when status endpoint fails with non-501 error', async () => {
    mockApiClient.mockRejectedValueOnce(new ApiClientError('Internal server error', 500, null));

    render(<QuickBooksCard />);

    await waitFor(() => {
      expect(screen.getByText('QuickBooks is temporarily unavailable')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('renders retry view on network error (non-ApiClientError)', async () => {
    mockApiClient.mockRejectedValueOnce(new TypeError('NetworkError: Failed to fetch'));

    render(<QuickBooksCard />);

    await waitFor(() => {
      expect(screen.getByText('QuickBooks is temporarily unavailable')).toBeInTheDocument();
    });
  });

  it('Retry button re-fetches status locally without reloading the page', async () => {
    mockApiClient
      .mockRejectedValueOnce(new ApiClientError('Internal server error', 500, null))
      .mockResolvedValueOnce({ data: { connected: true, companyName: 'Acme Co', syncStatus: 'idle' } });

    render(<QuickBooksCard />);

    await waitFor(() => {
      expect(screen.getByText('QuickBooks is temporarily unavailable')).toBeInTheDocument();
    });

    await userEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => {
      expect(screen.getByText('QuickBooks connected')).toBeInTheDocument();
    });
    expect(screen.getByText('Acme Co')).toBeInTheDocument();
    expect(mockApiClient).toHaveBeenCalledTimes(2);
    expect(mockApiClient).toHaveBeenNthCalledWith(1, '/integrations/quickbooks/status');
    expect(mockApiClient).toHaveBeenNthCalledWith(2, '/integrations/quickbooks/status');
  });

  it('calls connect endpoint and redirects to authUrl on click', async () => {
    mockApiClient
      .mockResolvedValueOnce({ data: { connected: false } })
      .mockResolvedValueOnce({ data: { authUrl: 'https://oauth.intuit.test/auth?state=abc' } });

    const originalLocation = window.location;
    const hrefSetter = vi.fn();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        assign: vi.fn(),
        set href(url: string) {
          hrefSetter(url);
        },
      },
    });

    render(<QuickBooksCard />);

    const button = await screen.findByRole('button', { name: /connect quickbooks/i });
    await userEvent.click(button);

    await waitFor(() => {
      expect(mockApiClient).toHaveBeenCalledWith('/integrations/quickbooks/connect', {
        method: 'POST',
      });
    });
    expect(hrefSetter).toHaveBeenCalledWith('https://oauth.intuit.test/auth?state=abc');

    Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  });

  it('re-enables Connect button and fires error toast when connect endpoint fails', async () => {
    mockApiClient
      .mockResolvedValueOnce({ data: { connected: false } })
      .mockRejectedValueOnce(new ApiClientError('Internal error', 500, null));

    render(<QuickBooksCard />);

    const button = await screen.findByRole('button', { name: /connect quickbooks/i });
    await userEvent.click(button);

    await waitFor(() => {
      expect(button).not.toBeDisabled();
    });
    expect(button).toHaveTextContent(/connect quickbooks/i);
    expect(mockToast.error).toHaveBeenCalledWith(
      'Couldn\u2019t start QuickBooks connection',
      expect.any(Object),
    );
  });

  it('fires info toast on ALREADY_CONNECTED race', async () => {
    mockApiClient
      .mockResolvedValueOnce({ data: { connected: false } })
      .mockRejectedValueOnce(new ApiClientError('Already connected', 409, 'ALREADY_CONNECTED'));

    render(<QuickBooksCard />);

    const button = await screen.findByRole('button', { name: /connect quickbooks/i });
    await userEvent.click(button);

    await waitFor(() => {
      expect(mockToast.info).toHaveBeenCalledWith(
        'QuickBooks is already connected',
        expect.any(Object),
      );
    });
    expect(mockToast.error).not.toHaveBeenCalled();
  });

  it('omits Last synced row when lastSyncedAt is missing', async () => {
    mockApiClient.mockResolvedValueOnce({
      data: { connected: true, companyName: 'New Co', syncStatus: 'idle' },
    });

    render(<QuickBooksCard />);

    await waitFor(() => {
      expect(screen.getByText('QuickBooks connected')).toBeInTheDocument();
    });
    expect(screen.queryByText('Last synced')).not.toBeInTheDocument();
  });
});
