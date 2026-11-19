'use client';

import { useCallback, useEffect, useState } from 'react';

import { isShopifyShopDomain } from 'shared/constants';
import { apiClient } from '@/lib/api-client';
import { usePlaidConnect } from './usePlaidConnect';
import type { IntegrationAction, IntegrationStatus } from './IntegrationCard';

interface QuickBooksStatus extends IntegrationStatus {
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

interface PlaidStatus extends IntegrationStatus {
  provider?: string;
  institutionName?: string | null;
  connectedAt?: string;
}

interface XeroStatus extends IntegrationStatus {
  provider?: string;
  companyName?: string;
  connectedAt?: string;
}

function isNotConfigured(error: unknown) {
  return (error as { code?: string } | null)?.code === 'INTEGRATION_NOT_CONFIGURED';
}

export function useIntegrations() {
  const [quickBooks, setQuickBooks] = useState<QuickBooksStatus | null>(null);
  const [shopify, setShopify] = useState<ShopifyStatus | null>(null);
  const [square, setSquare] = useState<SquareStatus | null>(null);
  const [plaid, setPlaid] = useState<PlaidStatus | null>(null);
  const [xero, setXero] = useState<XeroStatus | null>(null);
  const [shopDomain, setShopDomain] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [quickBooksAction, setQuickBooksAction] = useState<IntegrationAction>(null);
  const [shopifyAction, setShopifyAction] = useState<IntegrationAction>(null);
  const [squareAction, setSquareAction] = useState<IntegrationAction>(null);
  const [plaidAction, setPlaidAction] = useState<IntegrationAction>(null);
  const [xeroAction, setXeroAction] = useState<IntegrationAction>(null);

  const trimmedShopDomain = shopDomain.trim();
  const shopDomainValid = isShopifyShopDomain(trimmedShopDomain);

  const load = useCallback(async () => {
    try {
      const [quickBooksResponse, shopifyResponse, squareResponse, plaidResponse, xeroResponse] =
        await Promise.all([
        apiClient<QuickBooksStatus>('/integrations/quickbooks/status').catch((loadError) => ({
          data: { connected: false, configured: !isNotConfigured(loadError) } as QuickBooksStatus,
        })),
        apiClient<ShopifyStatus>('/integrations/shopify/status').catch((loadError) => ({
          data: { connected: false, configured: !isNotConfigured(loadError) } as ShopifyStatus,
        })),
        apiClient<SquareStatus>('/integrations/square/status').catch((loadError) => ({
          data: { connected: false, configured: !isNotConfigured(loadError) } as SquareStatus,
        })),
        apiClient<PlaidStatus>('/integrations/plaid/status').catch((loadError) => ({
          data: { connected: false, configured: !isNotConfigured(loadError) } as PlaidStatus,
        })),
        apiClient<XeroStatus>('/integrations/xero/status').catch((loadError) => ({
          data: { connected: false, configured: !isNotConfigured(loadError) } as XeroStatus,
        })),
      ]);
      setQuickBooks({ configured: true, ...quickBooksResponse.data });
      setShopify({ configured: true, ...shopifyResponse.data });
      setSquare({ configured: true, ...squareResponse.data });
      setPlaid({ configured: true, ...plaidResponse.data });
      setXero({ configured: true, ...xeroResponse.data });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Failed to load integrations');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // load yields on the status requests before updating state; this is the
    // hook's external-system synchronization, not a synchronous derived value.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  async function connectQuickBooks() {
    setQuickBooksAction('connecting');
    try {
      const { data } = await apiClient<{ authUrl: string }>('/integrations/quickbooks/connect', {
        method: 'POST',
      });
      window.location.href = data.authUrl;
    } catch (connectError) {
      setQuickBooksAction(null);
      setError(
        connectError instanceof Error
          ? connectError.message
          : 'Failed to start QuickBooks connection',
      );
    }
  }

  async function syncQuickBooks() {
    setQuickBooksAction('syncing');
    try {
      await apiClient('/integrations/quickbooks/sync', { method: 'POST' });
      await load();
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : 'Sync failed');
    } finally {
      setQuickBooksAction(null);
    }
  }

  async function disconnectQuickBooks() {
    setQuickBooksAction('disconnecting');
    try {
      await apiClient('/integrations/quickbooks', { method: 'DELETE' });
      setQuickBooks({ connected: false });
    } catch (disconnectError) {
      setError(disconnectError instanceof Error ? disconnectError.message : 'Failed to disconnect');
    } finally {
      setQuickBooksAction(null);
    }
  }

  async function connectXero() {
    setXeroAction('connecting');
    try {
      const { data } = await apiClient<{ authUrl: string }>('/integrations/xero/connect', {
        method: 'POST',
      });
      window.location.href = data.authUrl;
    } catch (connectError) {
      setXeroAction(null);
      setError(
        connectError instanceof Error ? connectError.message : 'Failed to start Xero connection',
      );
    }
  }

  async function syncXero() {
    setXeroAction('syncing');
    try {
      await apiClient('/integrations/xero/sync', { method: 'POST' });
      await load();
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : 'Sync failed');
    } finally {
      setXeroAction(null);
    }
  }

  async function disconnectXero() {
    setXeroAction('disconnecting');
    try {
      await apiClient('/integrations/xero', { method: 'DELETE' });
      setXero({ connected: false, configured: true });
    } catch (disconnectError) {
      setError(disconnectError instanceof Error ? disconnectError.message : 'Failed to disconnect');
    } finally {
      setXeroAction(null);
    }
  }

  async function connectSquare() {
    setSquareAction('connecting');
    try {
      const { data } = await apiClient<{ authUrl: string }>('/integrations/square/connect', {
        method: 'POST',
      });
      window.location.assign(data.authUrl);
    } catch (connectError) {
      setSquareAction(null);
      setError(
        connectError instanceof Error ? connectError.message : 'Failed to start Square connection',
      );
    }
  }

  async function syncSquare() {
    setSquareAction('syncing');
    try {
      await apiClient('/integrations/square/sync', { method: 'POST' });
      await load();
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : 'Failed to start Square sync');
    } finally {
      setSquareAction(null);
    }
  }

  async function disconnectSquare() {
    setSquareAction('disconnecting');
    try {
      await apiClient('/integrations/square', { method: 'DELETE' });
      setSquare({ connected: false });
    } catch (disconnectError) {
      setError(
        disconnectError instanceof Error ? disconnectError.message : 'Failed to disconnect Square',
      );
    } finally {
      setSquareAction(null);
    }
  }

  async function connectShopify() {
    setShopifyAction('connecting');
    try {
      const { data } = await apiClient<{ authUrl: string }>('/integrations/shopify/connect', {
        method: 'POST',
        body: JSON.stringify({ shop: trimmedShopDomain }),
      });
      window.location.href = data.authUrl;
    } catch (connectError) {
      setShopifyAction(null);
      setError(
        connectError instanceof Error ? connectError.message : 'Failed to start Shopify connection',
      );
    }
  }

  async function syncShopify() {
    setShopifyAction('syncing');
    try {
      await apiClient('/integrations/shopify/sync', { method: 'POST' });
      await load();
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : 'Sync failed');
    } finally {
      setShopifyAction(null);
    }
  }

  async function disconnectShopify() {
    setShopifyAction('disconnecting');
    try {
      await apiClient('/integrations/shopify', { method: 'DELETE' });
      setShopify({ connected: false });
    } catch (disconnectError) {
      setError(disconnectError instanceof Error ? disconnectError.message : 'Failed to disconnect');
    } finally {
      setShopifyAction(null);
    }
  }

  // Connecting is the only one that differs: Link opens in an iframe here
  // instead of navigating to the provider, so the flow lives in its own hook.
  const { connect: connectPlaid, connecting: plaidConnecting } = usePlaidConnect({
    onConnected: load,
    onError: setError,
  });

  async function syncPlaid() {
    setPlaidAction('syncing');
    try {
      await apiClient('/integrations/plaid/sync', { method: 'POST' });
      await load();
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : 'Failed to start bank sync');
    } finally {
      setPlaidAction(null);
    }
  }

  async function disconnectPlaid() {
    setPlaidAction('disconnecting');
    try {
      await apiClient('/integrations/plaid', { method: 'DELETE' });
      setPlaid({ connected: false, configured: true });
    } catch (disconnectError) {
      setError(disconnectError instanceof Error ? disconnectError.message : 'Failed to disconnect');
    } finally {
      setPlaidAction(null);
    }
  }

  return {
    quickBooks,
    shopify,
    square,
    shopDomain,
    setShopDomain,
    trimmedShopDomain,
    shopDomainValid,
    loading,
    error,
    dismissError: () => setError(null),
    quickBooksAction,
    shopifyAction,
    squareAction,
    connectQuickBooks,
    syncQuickBooks,
    disconnectQuickBooks,
    connectShopify,
    syncShopify,
    disconnectShopify,
    connectSquare,
    syncSquare,
    disconnectSquare,
    plaid,
    // usePlaidConnect owns the connecting state, so it is folded into the same
    // IntegrationAction the card already understands rather than exposed apart.
    plaidAction: plaidConnecting ? ('connecting' as IntegrationAction) : plaidAction,
    connectPlaid,
    syncPlaid,
    disconnectPlaid,
    xero,
    xeroAction,
    connectXero,
    syncXero,
    disconnectXero,
  };
}
