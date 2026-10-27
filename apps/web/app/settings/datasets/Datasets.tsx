'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2, AlertCircle, X } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { BackLink } from '@/components/common/BackLink';
import {
  DatasetCard,
  type DatasetCardState,
  type DatasetDetail,
  type DatasetItem,
} from './DatasetCard';

function emptyCardState(name: string): DatasetCardState {
  return {
    renaming: false,
    draftName: name,
    deleting: false,
    deleteDetail: null,
    loadingDetail: false,
    saving: false,
  };
}

export default function Datasets() {
  const [datasets, setDatasets] = useState<DatasetItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Per-card UI state keyed by dataset id
  const [cardStates, setCardStates] = useState<Record<number, DatasetCardState>>({});

  const patchCard = (id: number, patch: Partial<DatasetCardState>) =>
    setCardStates((prev) => ({
      ...prev,
      [id]: { ...prev[id], ...patch } as DatasetCardState,
    }));

  const load = useCallback(async () => {
    try {
      const { data } = await apiClient<DatasetItem[]>('/datasets/manage');
      setDatasets(data);
      setCardStates((prev) => {
        const next: Record<number, DatasetCardState> = {};
        for (const ds of data) {
          next[ds.id] = prev[ds.id] ?? emptyCardState(ds.name);
        }
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load datasets');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') load();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [load]);

  async function handleActivate(id: number) {
    try {
      await apiClient(`/datasets/manage/${id}/activate`, { method: 'POST' });
      setDatasets((prev) => prev.map((ds) => ({ ...ds, isActive: ds.id === id })));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to activate dataset');
    }
  }

  async function handleRenameSubmit(ds: DatasetItem) {
    const state = cardStates[ds.id];
    const trimmed = state?.draftName.trim();
    if (!trimmed || trimmed === ds.name) {
      patchCard(ds.id, { renaming: false, draftName: ds.name });
      return;
    }

    patchCard(ds.id, { saving: true });
    // Optimistic update
    setDatasets((prev) => prev.map((d) => (d.id === ds.id ? { ...d, name: trimmed } : d)));

    try {
      await apiClient(`/datasets/manage/${ds.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: trimmed }),
      });
      patchCard(ds.id, { renaming: false, saving: false, draftName: trimmed });
    } catch (err) {
      // Revert on failure
      setDatasets((prev) => prev.map((d) => (d.id === ds.id ? { ...d, name: ds.name } : d)));
      patchCard(ds.id, { renaming: false, saving: false, draftName: ds.name });
      setError(err instanceof Error ? err.message : 'Rename failed');
    }
  }

  async function handleDeleteStart(id: number) {
    patchCard(id, { loadingDetail: true, deleting: true });
    try {
      const { data } = await apiClient<DatasetDetail>(`/datasets/manage/${id}`);
      patchCard(id, { deleteDetail: data, loadingDetail: false });
    } catch (err) {
      patchCard(id, { deleting: false, loadingDetail: false });
      setError(err instanceof Error ? err.message : 'Failed to load dataset details');
    }
  }

  async function handleDeleteConfirm(id: number) {
    patchCard(id, { saving: true });
    try {
      await apiClient(`/datasets/manage/${id}`, { method: 'DELETE' });
      setDatasets((prev) => prev.filter((ds) => ds.id !== id));
      setCardStates((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } catch (err) {
      patchCard(id, { saving: false, deleting: false, deleteDetail: null });
      // backend enforces owner-only, surface a clear message instead of a generic one
      const msg = err instanceof Error ? err.message : 'Delete failed';
      setError(msg.toLowerCase().includes('owner')
        ? 'Only org owners can delete datasets.'
        : msg);
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-3xl px-6 py-8">
        <BackLink />
        <div className="mb-6">
          <h1 className="font-serif text-2xl font-medium text-foreground">Datasets</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {datasets.length} dataset{datasets.length !== 1 ? 's' : ''}
          </p>
        </div>

        {error && (
          <div className="mb-4 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <p className="flex-1 text-sm text-destructive">{error}</p>
            <button
              onClick={() => setError(null)}
              className="shrink-0 rounded-md p-0.5 text-destructive/60 transition-colors hover:text-destructive"
              aria-label="Dismiss error"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {datasets.length === 0 ? (
          <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border/60 bg-muted/30 px-8 py-16 text-center">
            <svg width="64" height="64" viewBox="0 0 64 64" fill="none" aria-hidden="true" className="mb-1">
              <rect x="12" y="10" width="30" height="36" rx="3" className="stroke-muted-foreground/40" strokeWidth="1.5" fill="none" />
              <line x1="18" y1="20" x2="36" y2="20" className="stroke-muted-foreground/30" strokeWidth="1.5" />
              <line x1="18" y1="26" x2="32" y2="26" className="stroke-muted-foreground/30" strokeWidth="1.5" />
              <line x1="18" y1="32" x2="34" y2="32" className="stroke-muted-foreground/30" strokeWidth="1.5" />
              <rect x="32" y="28" width="22" height="22" rx="3" className="stroke-primary/50" strokeWidth="1.5" fill="none" />
              <path d="M39 39h8M43 35v8" className="stroke-primary" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <p className="text-sm font-medium text-foreground">No datasets yet</p>
            <p className="max-w-[280px] text-sm text-muted-foreground">
              Upload a CSV and we&apos;ll organize it here so you can manage, rename, and switch between datasets.
            </p>
            <a
              href="/upload"
              className="mt-2 rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Upload a CSV
            </a>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {datasets.map((ds) => {
              const state = cardStates[ds.id] ?? emptyCardState(ds.name);
              return (
                <DatasetCard
                  key={ds.id}
                  dataset={ds}
                  state={state}
                  onActivate={() => handleActivate(ds.id)}
                  onRenameStart={() => patchCard(ds.id, { renaming: true, draftName: ds.name })}
                  onRenameChange={(v) => patchCard(ds.id, { draftName: v })}
                  onRenameSubmit={() => handleRenameSubmit(ds)}
                  onRenameCancel={() => patchCard(ds.id, { renaming: false, draftName: ds.name })}
                  onDeleteStart={() => handleDeleteStart(ds.id)}
                  onDeleteConfirm={() => handleDeleteConfirm(ds.id)}
                  onDeleteCancel={() => patchCard(ds.id, { deleting: false, deleteDetail: null })}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
