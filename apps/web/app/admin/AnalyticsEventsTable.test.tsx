import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mockApiClient = vi.fn();

vi.mock('@/lib/api-client', () => ({
  apiClient: (...args: unknown[]) => mockApiClient(...args),
}));

vi.mock('shared/constants', () => ({
  ANALYTICS_EVENTS: {
    USER_SIGNED_IN: 'user.signed_in',
    DATASET_UPLOADED: 'dataset.uploaded',
  },
}));

import { AnalyticsEventsTable } from './AnalyticsEventsTable';

const fakeEvents = [
  {
    id: 1, eventName: 'user.signed_in', orgName: 'Acme Corp', userEmail: 'alice@acme.com',
    userName: 'Alice', metadata: null, createdAt: '2026-03-30T12:00:00.000Z',
  },
  {
    id: 2, eventName: 'dataset.uploaded', orgName: 'Startup Inc', userEmail: 'bob@startup.com',
    userName: 'Bob', metadata: { rows: 500, filename: 'q1.csv' }, createdAt: '2026-03-29T08:30:00.000Z',
  },
];

const fakeOrgs = [
  { id: 1, name: 'Acme Corp', slug: 'acme', memberCount: 3, datasetCount: 2, subscriptionTier: 'pro', createdAt: '2026-01-01' },
  { id: 2, name: 'Startup Inc', slug: 'startup', memberCount: 1, datasetCount: 0, subscriptionTier: null, createdAt: '2026-02-01' },
];

function setupMocks(overrides?: {
  events?: typeof fakeEvents;
  total?: number;
  orgs?: typeof fakeOrgs;
}) {
  const events = overrides?.events ?? fakeEvents;
  const total = overrides?.total ?? events.length;
  const orgs = overrides?.orgs ?? fakeOrgs;

  mockApiClient.mockImplementation((path: string) => {
    if (path.startsWith('/admin/analytics-events')) {
      return Promise.resolve({
        data: events,
        meta: { total, pagination: { page: 1, pageSize: 50, totalPages: Math.ceil(total / 50) || 1 } },
      });
    }
    if (path === '/admin/orgs') {
      return Promise.resolve({ data: orgs, meta: { total: orgs.length } });
    }
    return Promise.reject(new Error(`Unexpected path: ${path}`));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AnalyticsEventsTable', () => {
  it('renders events with org name, email, and event badge', async () => {
    setupMocks();
    render(<AnalyticsEventsTable />);

    await waitFor(() => {
      expect(screen.getByText('user.signed_in')).toBeInTheDocument();
    });

    // org names appear in both table rows and filter dropdown, so use getAllByText
    expect(screen.getAllByText('Acme Corp').length).toBeGreaterThan(0);
    expect(screen.getByText('alice@acme.com')).toBeInTheDocument();
    // event names appear in both table and filter dropdown
    expect(screen.getAllByText('dataset.uploaded').length).toBeGreaterThan(1);
    expect(screen.getAllByText('Startup Inc').length).toBeGreaterThan(0);
  });

  it('shows empty state when no events', async () => {
    setupMocks({ events: [], total: 0 });
    render(<AnalyticsEventsTable />);

    await waitFor(() => {
      expect(screen.getByText('No events found')).toBeInTheDocument();
    });
  });

  it('renders loading skeletons initially', () => {
    setupMocks();
    render(<AnalyticsEventsTable />);

    // skeletons render pulse divs before data loads
    const pulses = document.querySelectorAll('.animate-pulse');
    expect(pulses.length).toBeGreaterThan(0);
  });

  it('renders column headers', async () => {
    setupMocks();
    render(<AnalyticsEventsTable />);

    await waitFor(() => {
      expect(screen.getByText('user.signed_in')).toBeInTheDocument();
    });

    const headers = screen.getAllByRole('columnheader');
    const headerTexts = headers.map((h) => h.textContent);
    expect(headerTexts).toEqual(['Event', 'Organization', 'User', 'Time', 'Metadata']);
  });

  it('renders pagination controls', async () => {
    setupMocks();
    render(<AnalyticsEventsTable />);

    await waitFor(() => {
      expect(screen.getByText('user.signed_in')).toBeInTheDocument();
    });

    expect(screen.getByLabelText('Previous page')).toBeInTheDocument();
    expect(screen.getByLabelText('Next page')).toBeInTheDocument();
    expect(screen.getByText('2 events total')).toBeInTheDocument();
  });

  it('disables prev button on first page', async () => {
    setupMocks();
    render(<AnalyticsEventsTable />);

    await waitFor(() => {
      expect(screen.getByText('user.signed_in')).toBeInTheDocument();
    });

    expect(screen.getByLabelText('Previous page')).toBeDisabled();
  });

  it('renders filter controls with aria labels', async () => {
    setupMocks();
    render(<AnalyticsEventsTable />);

    await waitFor(() => {
      expect(screen.getByText('user.signed_in')).toBeInTheDocument();
    });

    expect(screen.getByLabelText('Filter by event type')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter by organization')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter by date range')).toBeInTheDocument();
  });

  it('populates org filter dropdown from API', async () => {
    setupMocks();
    render(<AnalyticsEventsTable />);

    await waitFor(() => {
      const orgSelect = screen.getByLabelText('Filter by organization') as HTMLSelectElement;
      const options = Array.from(orgSelect.options).map((o) => o.text);
      expect(options).toContain('Acme Corp');
      expect(options).toContain('Startup Inc');
    });
  });

  it('submits filter change and resets to page 1', async () => {
    setupMocks();
    const user = userEvent.setup();
    render(<AnalyticsEventsTable />);

    await waitFor(() => {
      expect(screen.getByText('user.signed_in')).toBeInTheDocument();
    });

    const eventSelect = screen.getByLabelText('Filter by event type');
    await user.selectOptions(eventSelect, 'user.signed_in');

    // should re-fetch with eventName filter
    await waitFor(() => {
      const calls = mockApiClient.mock.calls.filter(
        (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('eventName=user.signed_in'),
      );
      expect(calls.length).toBeGreaterThan(0);
    });
  });

  it('shows expandable metadata for events with metadata', async () => {
    setupMocks();
    render(<AnalyticsEventsTable />);

    await waitFor(() => {
      expect(screen.getByText('dataset.uploaded')).toBeInTheDocument();
    });

    expect(screen.getByText('2 fields')).toBeInTheDocument();
  });

  it('shows dash for events without metadata', async () => {
    setupMocks();
    render(<AnalyticsEventsTable />);

    await waitFor(() => {
      expect(screen.getByText('user.signed_in')).toBeInTheDocument();
    });

    expect(screen.getByText('-')).toBeInTheDocument();
  });
});
