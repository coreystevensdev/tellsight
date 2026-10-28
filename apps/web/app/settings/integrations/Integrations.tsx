'use client';

import { Loader2, AlertCircle, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { BackLink } from '@/components/common/BackLink';
import { IntegrationCard } from './IntegrationCard';
import { useIntegrations } from './useIntegrations';

export default function Integrations() {
  const integrations = useIntegrations();

  if (integrations.loading) {
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

      {integrations.error && (
        <div className="mb-4 flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <p className="flex-1 text-sm text-destructive">{integrations.error}</p>
          <button
            onClick={integrations.dismissError}
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
            integrations.quickBooks?.connected
              ? `Connected to ${integrations.quickBooks.companyName ?? 'your company'}`
              : 'Sync your accounting data for automated insights.'
          }
          status={integrations.quickBooks}
          action={integrations.quickBooksAction}
          onConnect={integrations.connectQuickBooks}
          onSync={integrations.syncQuickBooks}
          onDisconnect={integrations.disconnectQuickBooks}
        />

        <IntegrationCard
          connector="shopify"
          title="Shopify"
          description={
            integrations.shopify?.connected
              ? `Connected to ${integrations.shopify.shopDomain ?? 'your store'}`
              : 'Sync orders, refunds, and inventory for automated insights.'
          }
          status={integrations.shopify}
          action={integrations.shopifyAction}
          onConnect={integrations.connectShopify}
          onSync={integrations.syncShopify}
          onDisconnect={integrations.disconnectShopify}
          connectDisabled={!integrations.shopDomainValid}
        >
          {!integrations.shopify?.connected && integrations.shopify?.configured !== false && (
            <>
              <input
                type="text"
                value={integrations.shopDomain}
                onChange={(event) => integrations.setShopDomain(event.target.value)}
                placeholder="your-store.myshopify.com"
                aria-label="Shopify store domain"
                aria-invalid={
                  integrations.trimmedShopDomain.length > 0 && !integrations.shopDomainValid
                }
                aria-describedby="shopify-domain-hint"
                className={cn(
                  'mt-2 w-full max-w-xs rounded-md border bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1',
                  integrations.trimmedShopDomain.length > 0 && !integrations.shopDomainValid
                    ? 'border-destructive focus:border-destructive focus:ring-destructive'
                    : 'border-border focus:border-primary focus:ring-primary',
                )}
              />
              <p
                id="shopify-domain-hint"
                className={cn(
                  'mt-1 text-xs',
                  integrations.trimmedShopDomain.length > 0 && !integrations.shopDomainValid
                    ? 'text-destructive'
                    : 'text-muted-foreground',
                )}
              >
                {integrations.trimmedShopDomain.length === 0
                  ? 'Enter your store domain to connect.'
                  : integrations.shopDomainValid
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
            integrations.square?.connected
              ? `Connected to merchant ${integrations.square.merchantId ?? 'account'}`
              : 'Sync sales and refunds from every location you run.'
          }
          status={integrations.square}
          action={integrations.squareAction}
          onConnect={integrations.connectSquare}
          onSync={integrations.syncSquare}
          onDisconnect={integrations.disconnectSquare}
          iconClassName="bg-slate-100 dark:bg-slate-800"
        />
      </div>
    </div>
  );
}
