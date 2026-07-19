import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { SourceRowsPanel } from './SourceRowsPanel';

const mockUseSourceRows = vi.fn();
vi.mock('@/lib/hooks/useSourceRows', () => ({
  useSourceRows: (...args: unknown[]) => mockUseSourceRows(...args),
}));

afterEach(cleanup);

describe('SourceRowsPanel', () => {
  it('shows a loading skeleton', () => {
    mockUseSourceRows.mockReturnValue({ status: 'loading', rows: [], meta: null, error: null });

    render(<SourceRowsPanel datasetId={1} statId="1:total:Sales:category" />);

    expect(screen.getAllByRole('row').length).toBeGreaterThan(1);
    expect(screen.queryByText('No source rows found')).not.toBeInTheDocument();
  });

  it('shows an error state', () => {
    mockUseSourceRows.mockReturnValue({ status: 'error', rows: [], meta: null, error: 'Request failed' });

    render(<SourceRowsPanel datasetId={1} statId="1:total:Sales:category" />);

    expect(screen.getByText('Request failed')).toBeInTheDocument();
  });

  it('shows an empty state when no rows match', () => {
    mockUseSourceRows.mockReturnValue({
      status: 'done',
      rows: [],
      meta: { total: 0, pagination: { page: 1, pageSize: 25, totalPages: 1 } },
      error: null,
    });

    render(<SourceRowsPanel datasetId={1} statId="1:total:Sales:category" />);

    expect(screen.getByText('No source rows found')).toBeInTheDocument();
  });

  it('renders rows with a formatted date, category, label, and amount', () => {
    mockUseSourceRows.mockReturnValue({
      status: 'done',
      rows: [
        { id: 1, date: '2026-01-15T00:00:00.000Z', category: 'Sales', parentCategory: null, amount: '1234.00', label: 'Widget A' },
      ],
      meta: { total: 1, pagination: { page: 1, pageSize: 25, totalPages: 1 } },
      error: null,
    });

    render(<SourceRowsPanel datasetId={1} statId="1:total:Sales:category" />);

    expect(screen.getByText('Sales')).toBeInTheDocument();
    expect(screen.getByText('Widget A')).toBeInTheDocument();
    expect(screen.getByText('$1,234')).toBeInTheDocument();
    expect(screen.getByText('1 row')).toBeInTheDocument();
  });

  it('renders a dash for a null label', () => {
    mockUseSourceRows.mockReturnValue({
      status: 'done',
      rows: [{ id: 1, date: '2026-01-15T00:00:00.000Z', category: 'Sales', parentCategory: null, amount: '50.00', label: null }],
      meta: { total: 1, pagination: { page: 1, pageSize: 25, totalPages: 1 } },
      error: null,
    });

    render(<SourceRowsPanel datasetId={1} statId="1:total:Sales:category" />);

    expect(screen.getByText('-')).toBeInTheDocument();
  });

  it('disables prev at the first page, enables next when more pages exist, and advances on click', () => {
    mockUseSourceRows.mockReturnValue({
      status: 'done',
      rows: [{ id: 1, date: '2026-01-15T00:00:00.000Z', category: 'Sales', parentCategory: null, amount: '100.00', label: null }],
      meta: { total: 3, pagination: { page: 1, pageSize: 1, totalPages: 3 } },
      error: null,
    });

    render(<SourceRowsPanel datasetId={1} statId="1:total:Sales:category" />);

    const prev = screen.getByRole('button', { name: 'Previous page' });
    const next = screen.getByRole('button', { name: 'Next page' });

    expect(prev).toBeDisabled();
    expect(next).not.toBeDisabled();

    fireEvent.click(next);

    expect(mockUseSourceRows).toHaveBeenLastCalledWith(1, '1:total:Sales:category', 2);
  });

  it('disables next at the last page', () => {
    mockUseSourceRows.mockReturnValue({
      status: 'done',
      rows: [{ id: 3, date: '2026-01-15T00:00:00.000Z', category: 'Sales', parentCategory: null, amount: '100.00', label: null }],
      meta: { total: 3, pagination: { page: 3, pageSize: 1, totalPages: 3 } },
      error: null,
    });

    render(<SourceRowsPanel datasetId={1} statId="1:total:Sales:category" />);

    // the panel's own page state starts at 1 regardless of what the mocked
    // meta claims, so drive it to the last page via the button before asserting
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));

    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });
});
