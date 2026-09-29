import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { SystemHealth } from './types';

const fakeHealth: SystemHealth = {
  services: {
    database: { status: 'ok', latencyMs: 3 },
    redis: { status: 'ok', latencyMs: 1 },
    claude: { status: 'error', latencyMs: 5000 },
  },
  uptime: { seconds: 90_000, formatted: '1d 1h 0m' },
  timestamp: '2026-03-30T12:00:00.000Z',
};

const degradedHealth: SystemHealth = {
  ...fakeHealth,
  services: {
    ...fakeHealth.services,
    redis: { status: 'degraded', latencyMs: 5000 },
  },
};

// vitest 5 types a bare vi.fn() as Mock<Procedure | Constructable>, which is
// not callable without narrowing, so name the signature.
let mockUseSWR: Mock<(...args: unknown[]) => unknown>;

vi.mock('swr', () => ({
  default: (...args: unknown[]) => mockUseSWR(...args),
}));

import { SystemHealthPanel } from './SystemHealthPanel';

beforeEach(() => {
  vi.clearAllMocks();
  mockUseSWR = vi.fn();
});

describe('SystemHealthPanel', () => {
  it('renders all three services with status indicators', () => {
    mockUseSWR.mockReturnValue({ data: fakeHealth, error: undefined, isLoading: false });
    render(<SystemHealthPanel />);

    expect(screen.getByText('Database')).toBeInTheDocument();
    expect(screen.getByText('Redis')).toBeInTheDocument();
    expect(screen.getByText('Claude API')).toBeInTheDocument();
  });

  it('shows Healthy label for ok status', () => {
    mockUseSWR.mockReturnValue({ data: fakeHealth, error: undefined, isLoading: false });
    render(<SystemHealthPanel />);

    const healthyLabels = screen.getAllByText('Healthy');
    expect(healthyLabels.length).toBe(2); // database + redis
  });

  it('shows Unavailable label for error status', () => {
    mockUseSWR.mockReturnValue({ data: fakeHealth, error: undefined, isLoading: false });
    render(<SystemHealthPanel />);

    expect(screen.getByText('Unavailable')).toBeInTheDocument();
  });

  it('shows Degraded label for degraded status', () => {
    mockUseSWR.mockReturnValue({ data: degradedHealth, error: undefined, isLoading: false });
    render(<SystemHealthPanel />);

    expect(screen.getByText('Degraded')).toBeInTheDocument();
  });

  it('displays latency values', () => {
    mockUseSWR.mockReturnValue({ data: fakeHealth, error: undefined, isLoading: false });
    render(<SystemHealthPanel />);

    expect(screen.getByText('3ms')).toBeInTheDocument();
    expect(screen.getByText('1ms')).toBeInTheDocument();
    expect(screen.getByText('5000ms')).toBeInTheDocument();
  });

  it('displays uptime', () => {
    mockUseSWR.mockReturnValue({ data: fakeHealth, error: undefined, isLoading: false });
    render(<SystemHealthPanel />);

    expect(screen.getByText(/Uptime: 1d 1h 0m/)).toBeInTheDocument();
  });

  it('renders skeleton rows during initial loading', () => {
    mockUseSWR.mockReturnValue({ data: undefined, error: undefined, isLoading: true });
    render(<SystemHealthPanel />);

    // skeleton rows don't have service names
    expect(screen.queryByText('Database')).not.toBeInTheDocument();
    // but the card header is visible
    expect(screen.getByText('System Health')).toBeInTheDocument();
  });

  it('shows stale data with warning on fetch error', () => {
    mockUseSWR.mockReturnValue({ data: fakeHealth, error: new Error('fetch failed'), isLoading: false });
    render(<SystemHealthPanel />);

    expect(screen.getByText(/Unable to refresh/)).toBeInTheDocument();
    // still shows last known data
    expect(screen.getByText('Database')).toBeInTheDocument();
    expect(screen.getByText('Redis')).toBeInTheDocument();
  });

  it('shows empty state when no data and error', () => {
    mockUseSWR.mockReturnValue({ data: undefined, error: new Error('fetch failed'), isLoading: false });
    render(<SystemHealthPanel />);

    expect(screen.getByText('Unable to load health data')).toBeInTheDocument();
  });

  it('has correct aria attributes for accessibility', () => {
    mockUseSWR.mockReturnValue({ data: fakeHealth, error: undefined, isLoading: false });
    render(<SystemHealthPanel />);

    const panel = screen.getByRole('status');
    expect(panel).toHaveAttribute('aria-live', 'polite');
    expect(panel).toHaveAttribute('aria-label', 'System health status');
  });

  it('passes correct SWR options', () => {
    mockUseSWR.mockReturnValue({ data: undefined, error: undefined, isLoading: true });
    render(<SystemHealthPanel />);

    expect(mockUseSWR).toHaveBeenCalledWith(
      '/api/admin/health',
      expect.any(Function),
      { refreshInterval: 30_000, revalidateOnFocus: false },
    );
  });
});
