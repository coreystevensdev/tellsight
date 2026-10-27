import type { ReactNode } from 'react';
import { RefreshCw } from 'lucide-react';

import { ConnectorMark, type ConnectorName } from '@/components/common/ConnectorMark';
import { cn } from '@/lib/utils';

export interface IntegrationStatus {
  connected: boolean;
  configured?: boolean;
  syncStatus?: string;
  lastSyncedAt?: string;
  syncError?: string;
}

export type IntegrationAction = 'connecting' | 'syncing' | 'disconnecting' | null;

interface IntegrationCardProps {
  connector: ConnectorName;
  title: string;
  description: string;
  status: IntegrationStatus | null;
  action: IntegrationAction;
  onConnect: () => void;
  onSync: () => void;
  onDisconnect: () => void;
  connectDisabled?: boolean;
  iconClassName?: string;
  children?: ReactNode;
}

export function IntegrationCard({
  connector,
  title,
  description,
  status,
  action,
  onConnect,
  onSync,
  onDisconnect,
  connectDisabled,
  iconClassName = 'bg-emerald-100 dark:bg-emerald-900/30',
  children,
}: IntegrationCardProps) {
  const upstreamSyncing = status?.syncStatus === 'syncing';

  return (
    <section className="border-t-2 border-border bg-card px-5 py-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="flex min-w-0 flex-1 basis-full items-start gap-3 sm:basis-auto">
          <div
            className={cn(
              'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
              iconClassName,
            )}
          >
            <ConnectorMark
              name={connector}
              className={cn(
                'h-4.5 w-4.5',
                status?.connected ? 'text-foreground' : 'text-muted-foreground',
              )}
            />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="font-serif text-sm font-medium text-foreground">{title}</h2>
            <p className="mt-0.5 break-words text-sm text-muted-foreground">{description}</p>
            {children}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
          {status?.connected ? (
            <>
              <button
                onClick={onSync}
                disabled={!!action || upstreamSyncing}
                className="inline-flex items-center gap-1.5 rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw
                  className={cn(
                    'h-3.5 w-3.5',
                    (action === 'syncing' || upstreamSyncing) && 'animate-spin',
                  )}
                />
                {action === 'syncing' ? 'Syncing...' : 'Sync now'}
              </button>
              <button
                onClick={onDisconnect}
                disabled={!!action}
                className="rounded-md border border-border bg-background px-3 py-1.5 text-xs font-medium text-destructive transition-colors hover:border-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {action === 'disconnecting' ? 'Disconnecting...' : 'Disconnect'}
              </button>
            </>
          ) : status?.configured === false ? (
            <span className="text-xs text-muted-foreground">Not available in this deployment</span>
          ) : (
            <button
              onClick={onConnect}
              disabled={!!action || connectDisabled}
              className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {action === 'connecting' ? 'Connecting...' : 'Connect'}
            </button>
          )}
        </div>
      </div>

      {status?.connected && (
        <div className="mt-3 ml-12 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {status.lastSyncedAt && (
            <span>
              Last synced:{' '}
              {new Date(status.lastSyncedAt).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </span>
          )}
          {status.syncStatus && (
            <span
              className={cn(
                'inline-flex items-center gap-1',
                status.syncStatus === 'error' && 'text-destructive',
              )}
            >
              Status: {status.syncStatus}
            </span>
          )}
          {status.syncError && <span className="text-destructive">Error: {status.syncError}</span>}
        </div>
      )}
    </section>
  );
}
