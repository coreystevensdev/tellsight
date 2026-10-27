'use client';

import { useEffect, useRef } from 'react';
import { Check, Database, Loader2, Pencil, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface DatasetItem {
  id: number;
  name: string;
  rowCount: number;
  sourceType: string;
  uploadedBy: { id: number; name: string } | null;
  createdAt: string;
  isActive: boolean;
}

export interface DatasetDetail extends DatasetItem {
  summaryCount: number;
  shareCount: number;
}

export interface DatasetCardState {
  renaming: boolean;
  draftName: string;
  deleting: boolean;
  deleteDetail: DatasetDetail | null;
  loadingDetail: boolean;
  saving: boolean;
}

interface DatasetCardProps {
  dataset: DatasetItem;
  state: DatasetCardState;
  onActivate: () => void;
  onRenameStart: () => void;
  onRenameChange: (value: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
  onDeleteStart: () => void;
  onDeleteConfirm: () => void;
  onDeleteCancel: () => void;
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export function DatasetCard({
  dataset,
  state,
  onActivate,
  onRenameStart,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
  onDeleteStart,
  onDeleteConfirm,
  onDeleteCancel,
}: DatasetCardProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (state.renaming) inputRef.current?.focus();
  }, [state.renaming]);

  return (
    <div
      className={cn(
        'border-t-2 px-5 py-4 transition-colors',
        dataset.isActive ? 'border-primary bg-primary/5' : 'border-border bg-card',
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <Database className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            {state.renaming ? (
              <input
                ref={inputRef}
                value={state.draftName}
                onChange={(event) => onRenameChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') onRenameSubmit();
                  if (event.key === 'Escape') onRenameCancel();
                }}
                onBlur={onRenameSubmit}
                disabled={state.saving}
                maxLength={255}
                className="w-full rounded border border-border bg-background px-2 py-0.5 text-sm font-medium text-foreground focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
              />
            ) : (
              <p className="truncate text-sm font-medium text-foreground">{dataset.name}</p>
            )}
            <p className="mt-0.5 text-xs text-muted-foreground">
              <span className="font-mono tabular-nums">{dataset.rowCount.toLocaleString()}</span> rows &middot; uploaded {formatDate(dataset.createdAt)}
              {dataset.uploadedBy && ` by ${dataset.uploadedBy.name}`}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {dataset.isActive ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
              <Check className="h-3 w-3" />
              Active
            </span>
          ) : (
            <button
              onClick={onActivate}
              className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent"
            >
              Set active
            </button>
          )}
          <button
            onClick={onRenameStart}
            disabled={state.renaming || state.deleting}
            className="rounded-md border border-border bg-background p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Rename dataset"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <button
            onClick={onDeleteStart}
            disabled={state.renaming || state.deleting}
            className="rounded-md border border-border bg-background p-1.5 text-muted-foreground transition-colors hover:border-destructive hover:bg-destructive/10 hover:text-destructive disabled:cursor-not-allowed disabled:opacity-40"
            aria-label="Delete dataset"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {state.deleting && (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3">
          {state.loadingDetail ? (
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="text-sm text-muted-foreground">Loading details...</span>
            </div>
          ) : state.deleteDetail ? (
            <>
              <p className="text-sm text-foreground">
                This will permanently remove{' '}
                <span className="font-medium"><span className="font-mono tabular-nums">{state.deleteDetail.rowCount.toLocaleString()}</span> data rows</span>,{' '}
                <span className="font-medium"><span className="font-mono tabular-nums">{state.deleteDetail.summaryCount}</span> AI summaries</span>, and{' '}
                <span className="font-medium"><span className="font-mono tabular-nums">{state.deleteDetail.shareCount}</span> share links</span>.
              </p>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={onDeleteConfirm}
                  disabled={state.saving}
                  className="rounded-md bg-destructive px-3 py-1.5 text-xs font-medium text-destructive-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {state.saving ? 'Deleting...' : 'Yes, delete'}
                </button>
                <button
                  onClick={onDeleteCancel}
                  disabled={state.saving}
                  className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Cancel
                </button>
              </div>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
