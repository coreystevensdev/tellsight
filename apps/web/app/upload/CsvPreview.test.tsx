import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { CsvPreview } from './CsvPreview';
import type { CsvPreviewData } from 'shared/types';

afterEach(() => cleanup());

function buildPreview(overrides: Partial<CsvPreviewData> = {}): CsvPreviewData {
  return {
    headers: ['date', 'amount', 'category'],
    sampleRows: [
      { date: '2025-01-15', amount: '1200.00', category: 'Revenue' },
      { date: '2025-01-16', amount: '450.50', category: 'Expenses' },
    ],
    rowCount: 100,
    validRowCount: 98,
    skippedRowCount: 2,
    columnTypes: { date: 'date', amount: 'number', category: 'text' },
    warnings: [],
    fileName: 'transactions.csv',
    previewToken: 'test-token',
    ...overrides,
  };
}

describe('CsvPreview', () => {
  it('renders table with headers and sample rows', () => {
    const preview = buildPreview();
    render(
      <CsvPreview previewData={preview} onConfirm={vi.fn()} onCancel={vi.fn()} isConfirming={false} />,
    );

    expect(screen.getByRole('table')).toBeInTheDocument();
    const columnHeaders = screen.getAllByRole('columnheader');
    expect(columnHeaders).toHaveLength(3);
    expect(columnHeaders[0]).toHaveTextContent('date');
    expect(columnHeaders[1]).toHaveTextContent('amount');
    expect(columnHeaders[2]).toHaveTextContent('category');
    expect(screen.getByText('1200.00')).toBeInTheDocument();
    expect(screen.getByText('Revenue')).toBeInTheDocument();
  });

  it('shows row count in table caption', () => {
    const preview = buildPreview({ validRowCount: 847 });
    render(
      <CsvPreview previewData={preview} onConfirm={vi.fn()} onCancel={vi.fn()} isConfirming={false} />,
    );

    expect(screen.getByText(/847 rows detected/)).toBeInTheDocument();
  });

  it('renders column type badges', () => {
    const preview = buildPreview();
    const { container } = render(
      <CsvPreview previewData={preview} onConfirm={vi.fn()} onCancel={vi.fn()} isConfirming={false} />,
    );

    // Type badges have the rounded/text-xs class, query by that to avoid colliding with header names
    const badges = container.querySelectorAll('.text-xs.font-normal');
    const badgeTexts = Array.from(badges).map((b) => b.textContent);
    expect(badgeTexts).toEqual(['date', 'number', 'text']);
  });

  it('shows warnings when present', () => {
    const preview = buildPreview({
      warnings: ['2 rows had invalid dates and were skipped.', 'Column "notes" was ignored.'],
    });
    render(
      <CsvPreview previewData={preview} onConfirm={vi.fn()} onCancel={vi.fn()} isConfirming={false} />,
    );

    expect(screen.getByText(/2 rows had invalid dates/)).toBeInTheDocument();
    expect(screen.getByText(/column "notes" was ignored/i)).toBeInTheDocument();
  });

  it('hides warnings section when none exist', () => {
    const preview = buildPreview({ warnings: [] });
    const { container } = render(
      <CsvPreview previewData={preview} onConfirm={vi.fn()} onCancel={vi.fn()} isConfirming={false} />,
    );

    expect(container.querySelector('.bg-yellow-50')).toBeNull();
  });

  it('fires onConfirm when confirm button clicked', () => {
    const onConfirm = vi.fn();
    const preview = buildPreview({ validRowCount: 50 });
    render(
      <CsvPreview previewData={preview} onConfirm={onConfirm} onCancel={vi.fn()} isConfirming={false} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /upload 50 rows/i }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it('fires onCancel when cancel clicked', () => {
    const onCancel = vi.fn();
    render(
      <CsvPreview previewData={buildPreview()} onConfirm={vi.fn()} onCancel={onCancel} isConfirming={false} />,
    );

    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it('disables both buttons and shows spinner during confirmation', () => {
    render(
      <CsvPreview previewData={buildPreview()} onConfirm={vi.fn()} onCancel={vi.fn()} isConfirming={true} />,
    );

    const confirmBtn = screen.getByRole('button', { name: /uploading/i });
    expect(confirmBtn).toBeDisabled();
    expect(screen.getByText('Cancel').closest('button')).toBeDisabled();
    expect(screen.getByText('Uploading...')).toBeInTheDocument();
  });

  it('uses th scope="col" for accessibility', () => {
    render(
      <CsvPreview previewData={buildPreview()} onConfirm={vi.fn()} onCancel={vi.fn()} isConfirming={false} />,
    );

    const headers = screen.getAllByRole('columnheader');
    for (const th of headers) {
      expect(th).toHaveAttribute('scope', 'col');
    }
  });
});
