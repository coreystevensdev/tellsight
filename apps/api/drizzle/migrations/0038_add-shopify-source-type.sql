-- Adds 'shopify' to the source_type enum for the new Shopify integration.
-- integration_connections and sync_jobs need no schema change, provider is
-- already a free-text varchar there ('shopify' just works as a new value).
ALTER TYPE "source_type" ADD VALUE 'shopify';
