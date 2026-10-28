'use client';

import { useCallback, useEffect, useState } from 'react';

import { isShopifyShopDomain } from 'shared/constants';
import { apiClient } from '@/lib/api-client';
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

function isNotConfigured(error: unknown) {
  return (error as { code?: string } | null)?.code === 'INTEGRATION_NOT_CONFIGURED';
}

export function useIntegrations() {
  const [quickBooks, setQuickBooks] = useState<QuickBooksStatus | null>(null);
  const [shopify, setShopify] = useState<ShopifyStatus | null>(null);
  const [square, setSquare] = useState<SquareStatus | null>(null);
  const [shopDomain, setShopDomain] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [quickBooksAction, setQuickBooksAction] = useState<IntegrationAction>(null);
  const [shopifyAction, setShopifyAction] = useState<IntegrationAction>(null);
  const [squareAction, setSquareAction] = useState<IntegrationAction>(null);

  const trimmedShopDomain = shopDomain.trim();
  const shopDomainValid = isShopifyShopDomain(trimmedShopDomain);

  const load = useCallback(async () => {
    try {
      const [quickBooksResponse, shopifyResponse, squareResponse] = await Promise.all([
        apiClient<QuickBooksStatus>('/integrations/quickbooks/status').catch((loadError) => ({
          data: { connected: false, configured: !isNotConfigured(loadError) } as QuickBooksStatus,
        })),
        apiClient<ShopifyStatus>('/integrations/shopify/status').catch((loadError) => ({
          data: { connected: false, configured: !isNotConfigured(loadError) } as ShopifyStatus,
        })),
        apiClient<SquareStatus>('/integrations/square/status').catch((loadError) => ({
          data: { connected: false, configured: !isNotConfigured(loadError) } as SquareStatus,
        })),
      ]);
      setQuickBooks({ configured: true, ...quickBooksResponse.data });
      setShopify({ configured: true, ...shopifyResponse.data });
      setSquare({ configured: true, ...squareResponse.data });
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
  };
}
