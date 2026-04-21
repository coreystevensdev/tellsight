import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { toast } from 'sonner';

const mockMutate = vi.fn();
const mockPush = vi.fn();
const mockReplace = vi.fn();
let mockSearchParams = new URLSearchParams();
let mockSwrReturn = {
  data: undefined as unknown,
  isLoading: false,
  mutate: mockMutate,
};

// Per-key overrides so tests can feed /org/financials data without changing
// the primary chart-data fallback. Keys starting with '/org/financials' look up
// this map; everything else falls back to mockSwrReturn.
let mockSwrByKey: Record<string, { data: unknown; mutate: ReturnType<typeof vi.fn> }> = {};

vi.mock('swr', () => ({
  default: (key: string | null, _fetcher: unknown, opts: { fallbackData: unknown }) => {
    if (typeof key === 'string' && key in mockSwrByKey) {
      return { ...mockSwrByKey[key], isLoading: false };
    }
    return {
      ...mockSwrReturn,
      data: mockSwrReturn.data ?? opts?.fallbackData,
    };
  },
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useSearchParams: () => mockSearchParams,
}));

vi.mock('@/lib/api-client', () => ({
  apiClient: vi.fn(),
}));

let shouldThrow = false;

vi.mock('./charts/RevenueChart', () => ({
  RevenueChart: () => {
    if (shouldThrow) throw new Error('Render failed');
    return <div data-testid="revenue-chart">Revenue</div>;
  },
}));

vi.mock('./charts/ExpenseChart', () => ({
  ExpenseChart: () => <div data-testid="expense-chart">Expense</div>,
}));

vi.mock('./charts/ChartSkeleton', () => ({
  ChartSkeleton: ({ variant }: { variant?: string }) => (
    <div data-testid={`skeleton-${variant ?? 'line'}`}>Skeleton</div>
  ),
}));

vi.mock('./charts/LazyChart', () => ({
  LazyChart: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('./contexts/SidebarContext', () => ({
  useSidebar: () => ({ setOrgName: vi.fn() }),
}));

vi.mock('./FilterBar', () => ({
  FilterBar: () => <div data-testid="filter-bar">FilterBar</div>,
  computeDateRange: () => null,
}));

vi.mock('./AiSummaryCard', () => ({
  AiSummaryCard: ({ datasetId, cachedContent, cachedStaleAt, className }: { datasetId: number | null; cachedContent?: string; cachedStaleAt?: string | null; className?: string }) => (
    <div
      data-testid="ai-summary-card"
      data-dataset-id={datasetId}
      data-cached-stale-at={cachedStaleAt ?? ''}
      className={className}
    >
      {cachedContent ?? 'AI Summary'}
    </div>
  ),
}));

vi.mock('./AiSummaryErrorBoundary', () => ({
  AiSummaryErrorBoundary: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div data-testid="ai-summary-error-boundary" className={className}>{children}</div>
  ),
}));

vi.mock('./TransparencyPanel', () => ({
  TransparencyPanel: () => <div data-testid="transparency-panel" />,
}));

vi.mock('./ShareMenu', () => ({
  ShareFab: () => <div data-testid="share-fab" />,
}));

vi.mock('@/lib/hooks/useShareInsight', () => ({
  useShareInsight: () => ({
    status: 'idle',
    generatePng: vi.fn(),
    downloadPng: vi.fn(),
    copyToClipboard: vi.fn(),
  }),
}));

vi.mock('@/components/ui/sheet', () => ({
  Sheet: ({ children, open }: { children: React.ReactNode; open: boolean }) =>
    open ? <div data-testid="bottom-sheet">{children}</div> : null,
  SheetContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

let mockIsMobile = false;
vi.mock('@/lib/hooks/useIsMobile', () => ({
  useIsMobile: () => mockIsMobile,
}));

vi.mock('@/lib/analytics', () => ({
  trackClientEvent: vi.fn(),
}));

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
  },
  Toaster: () => null,
}));

vi.mock('@/lib/hooks/useCreateShareLink', () => ({
  useCreateShareLink: () => ({
    status: 'idle',
    clipboardFailed: false,
    createLink: vi.fn(),
  }),
}));

let mockTier = 'free' as 'free' | 'pro';
vi.mock('@/lib/hooks/useSubscription', () => ({
  useSubscription: () => ({
    tier: mockTier,
    isPro: mockTier === 'pro',
    isLoading: false,
    mutate: vi.fn(),
  }),
}));

vi.mock('@/components/common/DemoModeBanner', () => ({
  DemoModeBanner: ({ demoState, onUploadClick }: { demoState: string; onUploadClick: () => void }) => (
    <div data-testid="demo-mode-banner" data-demo-state={demoState}>
      <button onClick={onUploadClick}>Upload CSV</button>
    </div>
  ),
}));

import { DashboardShell } from './DashboardShell';
import { apiClient } from '@/lib/api-client';
import type { ChartData } from 'shared/types';

const fullData: ChartData = {
  revenueTrend: [
    { month: 'Jan', revenue: 5000 },
    { month: 'Feb', revenue: 7000 },
  ],
  expenseBreakdown: [
    { category: 'Payroll', total: 3000 },
    { category: 'Rent', total: 1500 },
  ],
  expenseTrend: [
    { month: 'Jan', Payroll: 3000, Rent: 1500 },
    { month: 'Feb', Payroll: 3200, Rent: 1500 },
  ],
  monthlyComparison: [
    { month: 'Jan', revenue: 5000, expenses: 4500, profit: 500 },
    { month: 'Feb', revenue: 7000, expenses: 4700, profit: 2300 },
  ],
  yoyComparison: [],
  orgName: 'Acme Corp',
  isDemo: false,
  availableCategories: ['Payroll', 'Rent'],
  dateRange: { min: '2025-01-01', max: '2025-12-31' },
  demoState: 'user_only',
  datasetId: 42,
};

const emptyData: ChartData = {
  revenueTrend: [],
  expenseBreakdown: [],
  expenseTrend: [],
  monthlyComparison: [],
  yoyComparison: [],
  orgName: 'Dashboard',
  isDemo: true,
  availableCategories: [],
  dateRange: null,
  demoState: 'seed_only',
  datasetId: null,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  shouldThrow = false;
  mockIsMobile = false;
  mockTier = 'free';
  mockSearchParams = new URLSearchParams();
  mockSwrReturn = { data: undefined as unknown, isLoading: false, mutate: mockMutate };
  mockSwrByKey = {};
});

describe('DashboardShell', () => {
  it('renders org name as heading', () => {
    render(<DashboardShell initialData={fullData} />);

    expect(screen.getByRole('heading', { name: 'Acme Corp' })).toBeInTheDocument();
  });

  it('passes demoState to DemoModeBanner', () => {
    render(<DashboardShell initialData={{ ...fullData, demoState: 'seed_only' }} />);

    expect(screen.getByTestId('demo-mode-banner')).toHaveAttribute('data-demo-state', 'seed_only');
  });

  it('passes user_only demoState when not demo', () => {
    render(<DashboardShell initialData={fullData} />);

    expect(screen.getByTestId('demo-mode-banner')).toHaveAttribute('data-demo-state', 'user_only');
  });

  it('navigates to /upload when banner upload is clicked', () => {
    render(<DashboardShell initialData={{ ...fullData, demoState: 'seed_only' }} />);

    fireEvent.click(screen.getByRole('button', { name: /upload csv/i }));
    expect(mockPush).toHaveBeenCalledWith('/upload');
  });

  it('renders both charts when data exists', () => {
    render(<DashboardShell initialData={fullData} />);

    expect(screen.getByTestId('revenue-chart')).toBeInTheDocument();
    expect(screen.getByTestId('expense-chart')).toBeInTheDocument();
  });

  it('shows FilterBar when data exists', () => {
    render(<DashboardShell initialData={fullData} />);

    expect(screen.getByTestId('filter-bar')).toBeInTheDocument();
  });

  it('hides FilterBar when no data', () => {
    render(<DashboardShell initialData={emptyData} />);

    expect(screen.queryByTestId('filter-bar')).not.toBeInTheDocument();
  });

  it('shows FilterBar skeleton during loading when data exists', () => {
    mockSwrReturn = { data: emptyData, isLoading: true, mutate: mockMutate };

    render(<DashboardShell initialData={fullData} />);

    expect(screen.getByTestId('filter-bar-skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('filter-bar')).not.toBeInTheDocument();
  });

  it('shows empty state with upload CTA when no data', () => {
    render(<DashboardShell initialData={emptyData} />);

    expect(screen.getByText('Your data is waiting')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Upload a CSV' })).toHaveAttribute('href', '/upload');
  });

  it('shows chart skeletons during loading with no data', () => {
    mockSwrReturn = { data: emptyData, isLoading: true, mutate: mockMutate };

    render(<DashboardShell initialData={emptyData} />);

    expect(screen.getByTestId('skeleton-line')).toBeInTheDocument();
    expect(screen.getByTestId('skeleton-bar')).toBeInTheDocument();
  });

  it('passes cachedStaleAt through to AiSummaryCard', () => {
    const staleAt = '2026-04-17T10:00:00.000Z';
    render(
      <DashboardShell
        initialData={fullData}
        cachedSummary="Prior summary"
        cachedStaleAt={staleAt}
      />,
    );

    const card = screen.getByTestId('ai-summary-card');
    expect(card).toHaveAttribute('data-cached-stale-at', staleAt);
  });

  it('passes empty data-cached-stale-at when null', () => {
    render(
      <DashboardShell
        initialData={fullData}
        cachedSummary="Fresh summary"
        cachedStaleAt={null}
      />,
    );

    const card = screen.getByTestId('ai-summary-card');
    expect(card).toHaveAttribute('data-cached-stale-at', '');
  });

  it('renders AiSummaryCard with datasetId', () => {
    render(<DashboardShell initialData={fullData} />);

    const card = screen.getByTestId('ai-summary-card');
    expect(card).toBeInTheDocument();
    expect(card).toHaveAttribute('data-dataset-id', '42');
  });

  it('renders AiSummaryCard with null datasetId when no data', () => {
    render(<DashboardShell initialData={emptyData} />);

    const card = screen.getByTestId('ai-summary-card');
    expect(card).toBeInTheDocument();
  });

  it('only renders revenue chart when expense data is empty', () => {
    render(
      <DashboardShell initialData={{ ...fullData, expenseBreakdown: [] }} />,
    );

    expect(screen.getByTestId('revenue-chart')).toBeInTheDocument();
    expect(screen.queryByTestId('expense-chart')).not.toBeInTheDocument();
  });

  it('only renders expense chart when revenue data is empty', () => {
    render(
      <DashboardShell initialData={{ ...fullData, revenueTrend: [] }} />,
    );

    expect(screen.queryByTestId('revenue-chart')).not.toBeInTheDocument();
    expect(screen.getByTestId('expense-chart')).toBeInTheDocument();
  });

  describe('downgrade toast', () => {
    it('shows toast when tier transitions from pro to free', () => {
      mockTier = 'pro';
      const { rerender } = render(
        <DashboardShell initialData={fullData} tier="pro" />,
      );

      expect(toast.warning).not.toHaveBeenCalled();

      mockTier = 'free';
      rerender(<DashboardShell initialData={fullData} tier="free" />);

      expect(toast.warning).toHaveBeenCalledWith(
        "Your Pro subscription has ended. You're now on the free plan.",
      );
    });

    it('does not show toast on initial load as free', () => {
      mockTier = 'free';
      render(<DashboardShell initialData={fullData} />);

      expect(toast.warning).not.toHaveBeenCalled();
    });

    it('does not show toast when tier stays pro', () => {
      mockTier = 'pro';
      const { rerender } = render(
        <DashboardShell initialData={fullData} tier="pro" />,
      );

      rerender(<DashboardShell initialData={fullData} tier="pro" />);

      expect(toast.warning).not.toHaveBeenCalled();
    });
  });

  describe('QuickBooks OAuth return', () => {
    it('fires success toast and strips ?qb=connected', () => {
      mockSearchParams = new URLSearchParams('qb=connected');
      render(<DashboardShell initialData={fullData} />);

      expect(toast.success).toHaveBeenCalledWith(
        'QuickBooks connected',
        expect.objectContaining({ description: expect.stringContaining('syncing') }),
      );
      expect(mockReplace).toHaveBeenCalledWith('/dashboard', { scroll: false });
    });

    it('fires info toast for ?qb=denied', () => {
      mockSearchParams = new URLSearchParams('qb=denied');
      render(<DashboardShell initialData={fullData} />);

      expect(toast.info).toHaveBeenCalledWith(
        'QuickBooks connection cancelled',
        expect.any(Object),
      );
      expect(mockReplace).toHaveBeenCalledWith('/dashboard', { scroll: false });
    });

    it('fires error toast for ?qb=error', () => {
      mockSearchParams = new URLSearchParams('qb=error');
      render(<DashboardShell initialData={fullData} />);

      expect(toast.error).toHaveBeenCalledWith(
        'QuickBooks connection failed',
        expect.any(Object),
      );
      expect(mockReplace).toHaveBeenCalledWith('/dashboard', { scroll: false });
    });

    it('does not fire any toast when qb param is absent', () => {
      mockSearchParams = new URLSearchParams();
      render(<DashboardShell initialData={fullData} />);

      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.info).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
      expect(mockReplace).not.toHaveBeenCalled();
    });
  });

  describe('break-even locked insight', () => {
    const marginSignalData: ChartData = {
      ...fullData,
      hasMarginSignal: true,
    };

    it('renders the Locked card when hasMarginSignal is true and monthlyFixedCosts is null', () => {
      mockSwrByKey = {
        '/org/financials': { data: { cashOnHand: 15000, cashAsOfDate: '2026-04-15T00:00:00.000Z' }, mutate: vi.fn() },
      };

      render(<DashboardShell initialData={marginSignalData} />);

      expect(screen.getByRole('heading', { name: /enable break-even analysis/i })).toBeInTheDocument();
      expect(screen.getByLabelText(/monthly fixed costs/i)).toBeInTheDocument();
    });

    it('does NOT render when hasMarginSignal is false', () => {
      mockSwrByKey = {
        '/org/financials': { data: { cashOnHand: 15000, cashAsOfDate: '2026-04-15T00:00:00.000Z' }, mutate: vi.fn() },
      };

      render(<DashboardShell initialData={{ ...fullData, hasMarginSignal: false }} />);

      expect(screen.queryByRole('heading', { name: /enable break-even analysis/i })).not.toBeInTheDocument();
    });

    it('does NOT render when monthlyFixedCosts is already set', () => {
      mockSwrByKey = {
        '/org/financials': {
          data: { cashOnHand: 15000, cashAsOfDate: '2026-04-15T00:00:00.000Z', monthlyFixedCosts: 5000 },
          mutate: vi.fn(),
        },
      };

      render(<DashboardShell initialData={marginSignalData} />);

      expect(screen.queryByRole('heading', { name: /enable break-even analysis/i })).not.toBeInTheDocument();
    });

    it('submits PUT /org/financials with the exact monthlyFixedCosts numeric value', async () => {
      const refreshFn = vi.fn();
      mockSwrByKey = {
        '/org/financials': { data: { cashOnHand: 15000, cashAsOfDate: '2026-04-15T00:00:00.000Z' }, mutate: refreshFn },
      };
      vi.mocked(apiClient).mockResolvedValue({ data: {} as unknown });

      render(<DashboardShell initialData={marginSignalData} />);

      const input = screen.getByLabelText(/monthly fixed costs/i);
      fireEvent.change(input, { target: { value: '15000' } });

      const saveBtn = screen.getAllByRole('button', { name: /save/i })[0]!;
      fireEvent.click(saveBtn);

      await vi.waitFor(() => {
        expect(apiClient).toHaveBeenCalledWith('/org/financials', {
          method: 'PUT',
          body: JSON.stringify({ monthlyFixedCosts: 15000 }),
        });
      });
    });
  });

  describe('error boundary', () => {
    it('shows "Unable to load charts" with retry button when a chart throws', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      shouldThrow = true;

      render(<DashboardShell initialData={fullData} />);

      expect(screen.getByText('Unable to load charts')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    });

    it('recovers on retry click', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      shouldThrow = true;

      render(<DashboardShell initialData={fullData} />);
      expect(screen.getByText('Unable to load charts')).toBeInTheDocument();

      shouldThrow = false;
      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

      expect(screen.queryByText('Unable to load charts')).not.toBeInTheDocument();
      expect(screen.getByTestId('revenue-chart')).toBeInTheDocument();
    });
  });
});
