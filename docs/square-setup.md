# Square Connector Setup

How to get Square credentials, turn the connector on, and prove it works. The code shipped in PRs #190, #193 and #194; nothing here changes behaviour, it just switches it on.

The connector is off by default. `isSquareConfigured()` gates every route, so with no credentials the API answers `501 INTEGRATION_NOT_CONFIGURED` on `/integrations/square/*` and the settings card renders as disconnected. That is deliberate: a 501 lets a caller tell a switched-off integration from a broken one.

## What it reads

Sales and refunds across every location on the account, via `ListLocations` then `SearchOrders`. Requested scopes are read-only:

| Scope | Why |
|---|---|
| `ORDERS_READ` | the orders themselves |
| `PAYMENTS_READ` | payment detail on those orders |
| `MERCHANT_PROFILE_READ` | `ListLocations`, because a Square token is seller-scoped and carries no location id while `SearchOrders` demands them explicitly |

It does not read inventory, does not read customers, and never writes.

## 1. Create the application

1. Sign in at `developer.squareup.com` and open the Developer Dashboard.
2. Create an application. The name is seller-visible on the authorization screen.
3. Open the **OAuth** page for that application. You now have two credential sets, **Sandbox** and **Production**, and they are not interchangeable. Sandbox credentials only work against `connect.squareupsandbox.com`, production only against `connect.squareup.com`.
4. Copy the Application ID and Application Secret for whichever environment you are setting up.

## 2. Register the redirect URL

On the same OAuth page, set the Redirect URL. It must match `SQUARE_REDIRECT_URI` character for character, including scheme and any trailing slash, or the token exchange fails with a redirect mismatch.

| Environment | URL |
|---|---|
| Local | `http://localhost:3001/integrations/square/callback` |
| Production | `https://<PRODUCTION_DOMAIN>/integrations/square/callback` |

Port 3001 locally because the callback goes straight to Express, not through Next.js. Square redirects the browser there and Next.js has no route file for it.

In production Caddy forwards the whole `/integrations/*` prefix to Express for the same reason. That route was pinned to QuickBooks until 2026-09-15, which is why a Shopify or Square callback returned 404 in production before then while working locally. If a callback 404s, check the deployed Caddyfile first.

## 3. Set the variables

Four, plus `ENCRYPTION_KEY`, which is shared with the other connectors and encrypts stored tokens at rest.

```bash
SQUARE_CLIENT_ID=sandbox-sq0idb-...
SQUARE_CLIENT_SECRET=...
SQUARE_REDIRECT_URI=http://localhost:3001/integrations/square/callback
SQUARE_ENVIRONMENT=sandbox          # or production
ENCRYPTION_KEY=$(openssl rand -hex 32)
```

Set all of them or none. A partial set leaves the connector gated off, which looks identical to not having configured it at all.

For production they are GitHub repository secrets of the same names. The deploy writes them into `/opt/tellsight/.env`, omitting any that are empty rather than writing blank lines, because `config.ts` uses `.optional()` and an empty string still fails `z.string().url()`.

## 4. Verify against sandbox

```bash
docker compose up
```

1. Sandbox sellers start with no sales. Open the Developer Dashboard's sandbox seller, or use the Square Sandbox test account tools, and create a few completed orders first. An empty seller syncs successfully and writes nothing, which is indistinguishable from a broken sync at a glance.
2. Go to `/settings/integrations` and press Connect on the Square card. There is no field to fill in, unlike Shopify: a Square authorize URL is the same for every seller and the merchant is only known once the callback returns.
3. Authorize. You land back on `/dashboard?square=connected`.
4. The initial sync is enqueued immediately. Watch it:

```bash
docker compose logs api --tail 50 | grep -i square
```

Expect `Square locations resolved`, then `Square orders synced`, then `Square sync completed` with a `rowsSynced` count.

5. The settings card should now show the merchant id, a last-synced time, and status `idle`. Press **Sync now** to run a manual sync.

## 5. Verify in production

Same flow against the live domain, with production credentials and `SQUARE_ENVIRONMENT=production`. Two checks worth doing before connecting anything:

```bash
# should be 501, not 404. 404 means Caddy is not forwarding the prefix.
curl -s -o /dev/null -w '%{http_code}\n' https://<PRODUCTION_DOMAIN>/integrations/square/callback

# after setting secrets and deploying, the gate should stop answering 501
curl -s -o /dev/null -w '%{http_code}\n' https://<PRODUCTION_DOMAIN>/api/integrations/square/status
```

## Cadence

| | |
|---|---|
| Initial sync | on connect, 24 months back |
| Daily sync | 5am UTC, job key `square-daily-<orgId>` |
| Manual sync | the Sync now button |

The 24 month window exists because `SearchOrders` requires a start date, so "everything" is not an option the API offers, and two years is what the dashboard's year-over-year comparisons read. Scheduled runs pick up from `lastSyncedAt` instead.

5am is an hour after Shopify and two after QuickBooks, so three providers do not wake every connection in the same minute.

## Troubleshooting

**Status returns 501.** One of the four variables is missing, or `ENCRYPTION_KEY` is. Check the deployed `.env` rather than the GitHub secrets: an empty secret is omitted from the file entirely.

**Callback returns 404 in production.** Caddy is not forwarding `/integrations/*` to Express. Check `/opt/tellsight/Caddyfile` on the instance and redeploy.

**Redirect lands on `?square=error` with a state mismatch in the logs.** The OAuth state cookie did not survive the round trip. `/connect` has to use the cookie-forwarding BFF helper; the plain one drops `Set-Cookie` and the callback then has nothing to compare against.

**Token exchange fails immediately.** Either the redirect URL registered with Square differs from `SQUARE_REDIRECT_URI`, or the authorization code expired. Square gives the code five minutes.

**Connector worked, then stopped after about a month.** Square access tokens last 30 days. Tokens refresh on a buffer ahead of expiry rather than after a failure, so this should not happen; if it does, look for `Refreshed Square access token` in the logs and for the connection row's `sync_error`.

**Amounts look wrong by a factor of 100.** Square sends integers in the currency's smallest unit, which is cents for USD and the yen itself for JPY. The conversion handles the zero-decimal currencies explicitly. If a seller is on a three-decimal currency, one of the Gulf dinars, the conversion is wrong and needs a case added.

**Everything succeeds and no rows appear.** The seller has no completed orders in the window. The sync filters to `COMPLETED` state, so open tabs are excluded.
