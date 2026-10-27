'use client';

import { useState, useEffect, useCallback } from 'react';
import { Loader2, AlertCircle, X } from 'lucide-react';
import { apiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';
import { BackLink } from '@/components/common/BackLink';
import { isShopifyShopDomain } from 'shared/constants';
import { IntegrationCard, type IntegrationAction, type IntegrationStatus } from './IntegrationCard';

interface QbStatus extends IntegrationStatus {
  provider?: string;
  companyName?: string;
  connectedAt?: string;
}

interface SquareStatus extends IntegrationStatus {
  provider?: string;
  merchantId?: string;
  connectedAt?: string;
}

interface ShopifyStatus extends IntegrationStatus {
  provider?: string;
  shopDomain?: string;
  connectedAt?: string;
}

export default function Integrations() {
  const [qb, setQb] = useState<QbStatus | null>(null);
  const [shopify, setShopify] = useState<ShopifyStatus | null>(null);
  const [square, setSquare] = useState<SquareStatus | null>(null);
  const [shopDomain, setShopDomain] = useState('');
  const trimmedShop = shopDomain.trim();
  // Same rule the server enforces, from shared so the two cannot drift. Without
  // it the button is disabled on an invalid domain for a reason it never says.
  const shopDomainOk = isShopifyShopDomain(trimmedShop);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [qbAction, setQbAction] = useState<IntegrationAction>(null);
  const [shopifyAction, setShopifyAction] = useState<IntegrationAction>(null);
  const [squareAction, setSquareAction] = useState<IntegrationAction>(null);

  const load = useCallback(async () => {
    try {
      // A provider with no credentials answers 501 INTEGRATION_NOT_CONFIGURED.
      // Collapsing that into connected:false draws a Connect button that cannot
      // work, so a visitor is invited to try and then shown an error. Switched
      // off and broken are different things and the card should say which.
      // Read the code rather than instanceof ApiClientError. Any test that mocks
      // @/lib/api-client without re-exporting the class turns the check into
      // `instanceof undefined`, which throws inside the very catch meant to
      // handle the failure.
      const notConfigured = (err: unknown) =>
        (err as { code?: string } | null)?.code === 'INTEGRATION_NOT_CONFIGURED';

      const [qbRes, shopifyRes, squareRes] = await Promise.all([
        apiClient<QbStatus>('/integrations/quickbooks/status').catch((err: unknown) => ({
          data: { connected: false, configured: !notConfigured(err) } as QbStatus,
        })),
        apiClient<ShopifyStatus>('/integrations/shopify/status').catch((err: unknown) => ({
          data: { connected: false, configured: !notConfigured(err) } as ShopifyStatus,
        })),
        // An unconfigured provider answers 501, which is not an error worth
        // showing: it just means this deployment has no Square credentials.
        apiClient<SquareStatus>('/integrations/square/status').catch((err: unknown) => ({
          data: { connected: false, configured: !notConfigured(err) } as SquareStatus,
        })),
      ]);
      // A 200 means the gate let it through, so the provider is configured.
      setQb({ configured: true, ...qbRes.data });
      setShopify({ configured: true, ...shopifyRes.data });
      setSquare({ configured: true, ...squareRes.data });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load integrations');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

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

  // No input to collect, unlike Shopify: a Square authorize URL is the same for
  // every seller and the merchant only becomes known at the callback.
  async function connectSquare() {
    setSquareAction('connecting');
    try {
      const { data } = await apiClient<{ authUrl: string }>('/integrations/square/connect', {
        method: 'POST',
      });
      window.location.assign(data.authUrl);
    } catch (err) {
      setSquareAction(null);
      setError(err instanceof Error ? err.message : 'Failed to start Square connection');
    }
  }

  async function syncSquare() {
    setSquareAction('syncing');
    try {
      await apiClient('/integrations/square/sync', { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start Square sync');
    } finally {
      setSquareAction(null);
    }
  }

  async function disconnectSquare() {
    setSquareAction('disconnecting');
    try {
      await apiClient('/integrations/square', { method: 'DELETE' });
      setSquare({ connected: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect Square');
    } finally {
      setSquareAction(null);
    }
  }

  async function connectShopify() {
    setShopifyAction('connecting');
    try {
      const { data } = await apiClient<{ authUrl: string }>('/integrations/shopify/connect', {
        method: 'POST',
        body: JSON.stringify({ shop: trimmedShop }),
      });
      window.location.href = data.authUrl;
    } catch (err) {
      setShopifyAction(null);
      setError(err instanceof Error ? err.message : 'Failed to start Shopify connection');
    }
  }

  async function syncShopify() {
    setShopifyAction('syncing');
    try {
      await apiClient('/integrations/shopify/sync', { method: 'POST' });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setShopifyAction(null);
    }
  }

  async function disconnectShopify() {
    setShopifyAction('disconnecting');
    try {
      await apiClient('/integrations/shopify', { method: 'DELETE' });
      setShopify({ connected: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disconnect');
    } finally {
      setShopifyAction(null);
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
      <BackLink />
      <div className="mb-6">
        <h1 className="font-serif text-2xl font-medium text-foreground">Integrations</h1>
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
        <IntegrationCard
          connector="quickbooks"
          title="QuickBooks Online"
          description={
            qb?.connected
              ? `Connected to ${qb.companyName ?? 'your company'}`
              : 'Sync your accounting data for automated insights.'
          }
          status={qb}
          action={qbAction}
          onConnect={connectQb}
          onSync={syncQb}
          onDisconnect={disconnectQb}
        />

        <IntegrationCard
          connector="shopify"
          title="Shopify"
          description={
            shopify?.connected
              ? `Connected to ${shopify.shopDomain ?? 'your store'}`
              : 'Sync orders, refunds, and inventory for automated insights.'
          }
          status={shopify}
          action={shopifyAction}
          onConnect={connectShopify}
          onSync={syncShopify}
          onDisconnect={disconnectShopify}
          connectDisabled={!shopDomainOk}
        >
          {!shopify?.connected && shopify?.configured !== false && (
            <>
              <input
                type="text"
                value={shopDomain}
                onChange={(event) => setShopDomain(event.target.value)}
                placeholder="your-store.myshopify.com"
                aria-label="Shopify store domain"
                aria-invalid={trimmedShop.length > 0 && !shopDomainOk}
                aria-describedby="shopify-domain-hint"
                className={cn(
                  'mt-2 w-full max-w-xs rounded-md border bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1',
                  trimmedShop.length > 0 && !shopDomainOk
                    ? 'border-destructive focus:border-destructive focus:ring-destructive'
                    : 'border-border focus:border-primary focus:ring-primary',
                )}
              />
              <p
                id="shopify-domain-hint"
                className={cn(
                  'mt-1 text-xs',
                  trimmedShop.length > 0 && !shopDomainOk
                    ? 'text-destructive'
                    : 'text-muted-foreground',
                )}
              >
                {trimmedShop.length === 0
                  ? 'Enter your store domain to connect.'
                  : shopDomainOk
                    ? 'Looks right. Shopify will ask you to approve the connection.'
                    : 'That is not a store domain. It ends in .myshopify.com, with no https:// and no /admin.'}
              </p>
            </>
          )}
        </IntegrationCard>

        <IntegrationCard
          connector="square"
          title="Square"
          description={
            square?.connected
              ? `Connected to merchant ${square.merchantId ?? 'account'}`
              : 'Sync sales and refunds from every location you run.'
          }
          status={square}
          action={squareAction}
          onConnect={connectSquare}
          onSync={syncSquare}
          onDisconnect={disconnectSquare}
          iconClassName="bg-slate-100 dark:bg-slate-800"
        />
      </div>
    </div>
  );
}
