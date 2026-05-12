'use client';

import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Loader2, AlertCircle, X, Link2, Link2Off } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';

interface QbStatus {
  connected: boolean;
  provider?: string;
  companyName?: string;
  syncStatus?: string;
  lastSyncedAt?: string;
  syncError?: string;
  connectedAt?: string;
}

export default function Integrations() {
  const [qb, setQb] = useState<QbStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [qbAction, setQbAction] = useState<'connecting' | 'syncing' | 'disconnecting' | null>(null);

  const load = useCallback(async () => {
    try {
      const qbRes = await apiClient<QbStatus>('/integrations/quickbooks/status').catch(() => ({
        data: { connected: false } as QbStatus,
      }));
      setQb(qbRes.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load integrations');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function connectQb() {
    setQbAction('connecting');
    try {
      const { data } = await apiClient<{ authUrl: string }>('/integrations/quickbooks/connect', {
        method: 'POST',
      });
      window.location.href = data.authUrl;
    } catch (err) {
      setQbAction(null);
      setError(err instanceof Error ? err.message : 'Failed to start QuickBooks connection');
    }
  }

  async function syncQb() {
    setQbAction('syncing');
    try {
      await apiClient('/integrations/quickbooks/sync', { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setQbAction(null);
    }
  }

  async function disconnectQb() {
    setQbAction('disconnecting');
    try {
      await apiClient('/integrations/quickbooks', { method: 'DELETE' });
      setQb({ connected: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect');
    } finally {
      setQbAction(null);
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
    <div className="mx-auto max-w-3xl px-6 py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-foreground">Integrations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect services and manage how Tellsight works with your data.
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

      <div className="flex flex-col gap-4">
        {/* QuickBooks */}
        <section className="rounded-lg border border-border bg-card px-5 py-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-100 dark:bg-emerald-900/30">
                {qb?.connected ? (
                  <Link2 className="h-4.5 w-4.5 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <Link2Off className="h-4.5 w-4.5 text-muted-foreground" />
                )}
              </div>
              <div>
                <h2 className="text-sm font-semibold text-foreground">QuickBooks Online</h2>
                <p className="mt-0.5 text-sm text-muted-foreground">
                  {qb?.connected
                    ? `Connected to ${qb.companyName ?? 'your company'}`
                    : 'Sync your accounting data for automated insights.'}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {qb?.connected ? (
                <>
                  <button
                    onClick={syncQb}
                    disabled={!!qbAction || qb.syncStatus === 'syncing'}
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <RefreshCw className={cn('h-3.5 w-3.5', (qbAction === 'syncing' || qb.syncStatus === 'syncing') && 'animate-spin')} />
                    {qbAction === 'syncing' ? 'Syncing...' : 'Sync now'}
                  </button>
                  <button
                    onClick={disconnectQb}
                    disabled={!!qbAction}
                    className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:border-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {qbAction === 'disconnecting' ? 'Disconnecting...' : 'Disconnect'}
                  </button>
                </>
              ) : (
                <button
                  onClick={connectQb}
                  disabled={!!qbAction}
                  className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {qbAction === 'connecting' ? 'Connecting...' : 'Connect'}
                </button>
              )}
            </div>
          </div>
          {qb?.connected && (
            <div className="mt-3 ml-12 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {qb.lastSyncedAt && (
                <span>Last synced: {new Date(qb.lastSyncedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
              )}
              {qb.syncStatus && (
                <span className={cn(
                  'inline-flex items-center gap-1',
                  qb.syncStatus === 'error' && 'text-destructive',
                )}>
                  Status: {qb.syncStatus}
                </span>
              )}
              {qb.syncError && (
                <span className="text-destructive">Error: {qb.syncError}</span>
              )}
            </div>
          )}
        </section>
      </div>

      <div className="mt-8 border-t border-border pt-6">
        <a
          href="/dashboard"
          className="text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          &larr; Back to dashboard
        </a>
      </div>
    </div>
  );
}
