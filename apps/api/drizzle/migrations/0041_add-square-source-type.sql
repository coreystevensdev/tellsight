-- Adds 'square' to the source_type enum for the Square integration.
-- integration_connections and sync_jobs need no schema change, provider is
-- already a free-text varchar there ('square' just works as a new value).
ALTER TYPE "source_type" ADD VALUE 'square';
