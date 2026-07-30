'use client';

import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { useSourceRows, type SourceRowView } from '@/lib/hooks/useSourceRows';
import { formatCurrency } from './charts/formatters';

const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export interface SourceRowsPanelProps {
  datasetId: number;
  statId: string;
}

function SkeletonRows() {
  return Array.from({ length: 3 }, (_, i) => (
    <TableRow key={i}>
      {Array.from({ length: 4 }, (_, j) => (
        <TableCell key={j}>
          <div className="h-4 w-16 animate-pulse rounded bg-muted motion-reduce:animate-none" />
        </TableCell>
      ))}
    </TableRow>
  ));
}

// In-sheet expand target for StatDetailSheet's "View source rows" toggle,
// the transaction-level evidence behind a cited number (NFR-12.2). Owns its
// own page state so re-opening a different citation resets to page 1.
export function SourceRowsPanel({ datasetId, statId }: SourceRowsPanelProps) {
  const [page, setPage] = useState(1);
  const key = `${datasetId}:${statId}`;
  const [priorKey, setPriorKey] = useState(key);

  // Re-opening a different citation's source rows should start back at page 1.
  if (key !== priorKey) {
    setPriorKey(key);
    setPage(1);
  }

  const { status, rows, meta, error } = useSourceRows(datasetId, statId, page);

  const totalPages = meta?.pagination.totalPages ?? 1;

  return (
    <div className="flex flex-col gap-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Label</TableHead>
            <TableHead className="text-right">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {status === 'loading' ? (
            <SkeletonRows />
          ) : status === 'error' ? (
            <TableRow>
              <TableCell colSpan={4} className="py-6 text-center text-sm text-destructive">
                {error}
              </TableCell>
            </TableRow>
          ) : rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="py-6 text-center text-sm text-muted-foreground">
                No source rows found
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row: SourceRowView) => (
              <TableRow key={row.id}>
                <TableCell>{dateFmt.format(new Date(row.date))}</TableCell>
                <TableCell>{row.category}</TableCell>
                <TableCell className="text-muted-foreground">{row.label ?? '-'}</TableCell>
                <TableCell className="text-right tabular-nums">{formatCurrency(Number(row.amount))}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground" role="status" aria-live="polite">
          {status === 'done' && meta ? `${meta.total} row${meta.total !== 1 ? 's' : ''}` : ' '}
        </p>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1 || status === 'loading' || status === 'error'}
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm tabular-nums" aria-label={`Page ${page} of ${totalPages}`}>
            {page} / {totalPages}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages || status === 'loading' || status === 'error'}
            aria-label="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
