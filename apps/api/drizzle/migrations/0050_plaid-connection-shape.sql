-- DW-282. integration_connections was shaped around redirect OAuth, where every
-- provider hands back an access token, a refresh token and an expiry. A Plaid
-- access token has none of the last two: it does not expire and there is nothing
-- to refresh it with, because re-authorization means the owner runs Link again.
--
-- Dropping the NOT NULLs rather than writing sentinel values. A sentinel expiry
-- would make refreshAccessToken look applicable to a provider it cannot serve,
-- and the first scheduled sync would try to refresh a token that has no refresh
-- endpoint. Null is the honest representation of "this provider has no expiry".
--
-- Safe in both directions: relaxing NOT NULL rewrites no rows and every existing
-- connector still writes all three columns.
ALTER TABLE integration_connections ALTER COLUMN encrypted_refresh_token DROP NOT NULL;
ALTER TABLE integration_connections ALTER COLUMN access_token_expires_at DROP NOT NULL;

-- Plaid's /transactions/sync is cursor-based rather than date-windowed: it
-- returns added, modified and removed since a cursor, and the cursor is meant to
-- be persisted per connection. Without somewhere to keep it every sync would
-- start from the beginning of history and re-fetch everything.
--
-- Nullable with no default. Absent means "never synced", which is exactly what
-- Plaid wants in the request to get the first page from the start of history, so
-- an empty string default would be a different and wrong thing.
ALTER TABLE integration_connections ADD COLUMN sync_cursor text;
