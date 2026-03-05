'use client';

import { Loader2 } from 'lucide-react';
import type { CsvPreviewData } from 'shared/types';
import { cn } from '@/lib/utils';

interface CsvPreviewProps {
  previewData: CsvPreviewData;
  onConfirm: () => void;
  onCancel: () => void;
  isConfirming: boolean;
}

const typeBadgeColors: Record<string, string> = {
  date: 'bg-blue-100 text-blue-700',
  number: 'bg-green-100 text-green-700',
  text: 'bg-gray-100 text-gray-700',
};

export function CsvPreview({ previewData, onConfirm, onCancel, isConfirming }: CsvPreviewProps) {
  const { headers, sampleRows, validRowCount, columnTypes, warnings } = previewData;

  return (
    <div className="w-full space-y-4">
      {warnings.length > 0 && (
        <div className="rounded-md border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
          <ul className="space-y-1">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <caption className="px-4 py-2 text-left text-sm font-medium text-muted-foreground">
            Preview of uploaded data &mdash; {validRowCount.toLocaleString()} rows detected
          </caption>
          <thead>
            <tr className="border-b bg-muted/50">
              {headers.map((header) => (
                <th key={header} scope="col" className="px-3 py-2 text-left font-medium text-primary">
                  <span className="mr-2">{header}</span>
                  {columnTypes[header] && (
                    <span
                      className={cn(
                        'inline-block rounded px-1.5 py-0.5 text-xs font-normal',
                        typeBadgeColors[columnTypes[header]] ?? typeBadgeColors.text,
                      )}
                    >
                      {columnTypes[header]}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sampleRows.map((row, rowIdx) => (
              <tr key={rowIdx} className={cn('border-b', rowIdx % 2 === 0 && 'bg-muted/20')}>
                {headers.map((header) => (
                  <td key={header} className="px-3 py-2 text-muted-foreground">
                    {row[header] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={onCancel}
          disabled={isConfirming}
          className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={isConfirming}
          className={cn(
            'inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm',
            'hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
            'disabled:pointer-events-none disabled:opacity-50',
          )}
        >
          {isConfirming ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Uploading...
            </>
          ) : (
            `Upload ${validRowCount.toLocaleString()} rows`
          )}
        </button>
      </div>
    </div>
  );
}
