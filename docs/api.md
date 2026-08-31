# API reference

Every request and response below was run against a local `docker compose up`
stack and pasted back verbatim. Where a route is not covered here, the pattern
from the closest example holds.

## Two things that will trip you up first

**There is no `/api` prefix on Express.** The browser calls `/api/datasets` on
Next.js at `:3000`, which proxies through to Express at `:3001` with the prefix
stripped. Curl talks to Express directly, so the path is `/datasets`. Sending
`/api/datasets` to `:3001` does not 404, which is the annoying part: it falls
through to the auth middleware and comes back
`{"error":{"code":"AUTHENTICATION_REQUIRED"}}`, so it reads like a credentials
problem when it is a path problem.

**Auth is httpOnly cookies, not a bearer header.** No token appears in any
response body for you to copy into the next call. Curl needs a cookie jar, which
is what `-c` (write) and `-b` (read) do below.

Responses use one of two envelopes:

```jsonc
{ "data": ... }                                                 // success
{ "error": { "code": "...", "message": "...", "details": {} } }  // failure
```

`data` is whatever the route returns, and it is often a bare array rather than an
object. `details` appears only on validation failures and carries Zod's
field-level output.

## Health

No auth, and deliberately outside the envelope above. Route53 and the deploy
smoke test both poll `ready`, and a flat shape is easier for an external checker
to match on than a nested one.

```bash
curl -s localhost:3001/health/live
```

```json
{"status":"ok"}
```

```bash
curl -s localhost:3001/health/ready
```

```json
{
  "status": "ok",
  "services": {
    "database": { "status": "ok", "latencyMs": 51 },
    "redis": { "status": "ok", "latencyMs": 2 },
    "email": { "provider": "resend", "status": "ok", "latencyMs": 0 }
  }
}
```

`live` answers as soon as the process is up. `ready` reaches Postgres, Redis and
the email provider, and returns 503 with the same shape when one of them is
down. The deploy treats a 503 as a failed release and rolls back, so the split
matters: a container that is running but cannot reach its database should not
count as a successful deploy.

## Auth

Invalid first, because the error shape is the useful part:

```bash
curl -s localhost:3001/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"not-an-email","password":"short"}'
```

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid sign-up parameters",
    "details": {
      "_errors": [],
      "email": { "_errors": ["Invalid email"] },
      "name": { "_errors": ["Required"] },
      "password": { "_errors": ["Password must be at least 8 characters"] }
    }
  }
}
```

All three problems come back at once rather than one per round trip. The
top-level `_errors: []` is Zod's own shape, not an empty slot we forgot to fill.

Valid, writing the cookies into a jar:

```bash
curl -s -c jar.txt localhost:3001/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","name":"You","password":"correct-horse-battery-staple"}'
```

```json
{
  "data": {
    "user": { "id": 3, "name": "You", "email": "you@example.com", "avatarUrl": null },
    "org": { "id": 5, "name": "You's Organization", "slug": "you-org" },
    "isNewUser": true
  }
}
```

Signing up creates the org too. There is no separate org-creation call, because
every table is keyed by `org_id` and a user without one has nothing to read.

Signing in on an existing account, and rotating an expired access token using
the refresh cookie already in the jar:

```bash
curl -s -c jar.txt localhost:3001/auth/signin \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"correct-horse-battery-staple"}'

curl -s -b jar.txt -c jar.txt -X POST localhost:3001/auth/refresh
```

Both need `-c` as well as `-b`: refresh rotates the pair, so the old refresh
cookie is dead the moment it is used and the jar has to be rewritten.

Calling a protected route with no jar:

```json
{"error":{"code":"AUTHENTICATION_REQUIRED","message":"Missing access token"}}
```

## Datasets

Uploading is two calls, not one. The first parses and returns a preview without
writing anything:

```bash
curl -s -b jar.txt localhost:3001/datasets -F 'file=@rev.csv'
```

```json
{
  "data": {
    "headers": ["date", "amount", "category"],
    "sampleRows": [{ "date": "2026-01-15", "amount": "12000", "category": "Revenue" }],
    "rowCount": 3,
    "validRowCount": 3,
    "skippedRowCount": 0,
    "columnTypes": { "date": "date", "amount": "number", "category": "text" },
    "warnings": [],
    "fileName": "rev.csv",
    "previewToken": "eyJoYXNoIjoiNWRhOTJmNDUy..."
  }
}
```

Nothing is persisted yet. `GET /datasets/manage` still returns `{"data":[]}` at
this point, which is the single most confusing thing about this API if you have
not read this far. The preview exists so the owner can see what the parser made
of their file, including `skippedRowCount` and `warnings`, before committing.

`previewToken` is a signed blob carrying a hash of the parsed content plus the
org id, so the confirm call cannot be pointed at a different file or replayed
into someone else's org.

The second call commits it, taking the same file plus the token:

```bash
curl -s -b jar.txt localhost:3001/datasets/confirm \
  -F 'file=@rev.csv' -F "previewToken=$TOK"
```

```json
{"data":{"datasetId":5,"rowCount":3,"demoState":"user_only"}}
```

`demoState` reports which of the four demo-mode states the org landed in. Once
real data exists it stops showing seed data, and this field is how the dashboard
knows.

The CSV needs `date`, `amount` and `category` columns. Anything else is a 400
that names both what was expected and what you actually sent:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "CSV validation failed",
    "details": {
      "errors": [
        {
          "column": "amount",
          "message": "We expected a column named 'amount'. Your file has columns: date, revenue, expenses"
        }
      ],
      "fileName": "rev.csv"
    }
  }
}
```

Listing. Note `/manage`: bare `POST /datasets` is the upload, and the list lives
one path segment deeper.

```bash
curl -s -b jar.txt localhost:3001/datasets/manage
```

```json
{
  "data": [
    {
      "id": 5,
      "orgId": 5,
      "name": "rev.csv",
      "sourceType": "csv",
      "isSeedData": false,
      "createdAt": "2026-08-31T01:34:58.792Z",
      "rowCount": 3,
      "uploadedBy": { "id": 3, "name": "Api Doc" },
      "isActive": true
    }
  ]
}
```

This filters `isSeedData = false`, so demo rows never appear here even when the
org is in a seed state.

Deleting is owner-only, and a member of the same org gets 403 rather than 404
because the row exists and they simply cannot act on it:

```bash
curl -s -b jar.txt -X DELETE localhost:3001/datasets/manage/5
```

```json
{"error":{"code":"FORBIDDEN","message":"Owner access required"}}
```

Asking for a dataset belonging to another org returns 404, not 403:

```json
{"error":{"code":"NOT_FOUND","message":"Dataset not found"}}
```

That is deliberate. A 403 would confirm the row exists, which leaks the presence
of another tenant's data. Row-level security enforces the same boundary inside
Postgres, so the route check is the outer of two layers rather than the only one.

## AI summaries

```bash
curl -s -b jar.txt localhost:3001/ai-summaries/5/latest
```

Reads the cache only. A dataset that has never been summarised returns 404
rather than triggering generation, so this is safe to poll:

```json
{"error":{"code":"NOT_FOUND","message":"No summary exists for this dataset yet"}}
```

`GET /ai-summaries/:datasetId` is the generating call and goes through the
subscription gate, which annotates rather than blocks: free-tier callers get a
real summary truncated to roughly 150 words plus an `upgrade_required` marker in
the stream. Both it and `POST /qa/:datasetId` stream SSE, so pass `-N` to stop
curl buffering.

Show-me-the-math for a single stat, and the rows behind it:

```bash
curl -s -b jar.txt localhost:3001/ai-summaries/5/stats/revenue_mom
curl -s -b jar.txt localhost:3001/ai-summaries/5/stats/revenue_mom/rows
```

These sit on a separate dashboard-compute rate-limit tier, so auditing a number
cannot spend the caller's summary budget.

## Shared links

The only route where the credential is in the URL rather than a cookie. The
token is 64 hex characters, and the format is checked before any database
lookup:

```bash
curl -s localhost:3001/shares/aB3xY9kL2mNp
```

```json
{"error":{"code":"VALIDATION_ERROR","message":"Invalid share token"}}
```

That is a 400. A well-formed token that matches nothing is a 404:

```json
{"error":{"code":"NOT_FOUND","message":"Share not found"}}
```

The two are distinguishable, and that is fine: the format check tells an attacker
only that tokens are 64 hex characters, which is already obvious from any real
link, while saving a database round trip on garbage input.

## Analytics

```bash
curl -s -b jar.txt localhost:3001/analytics/events \
  -H 'Content-Type: application/json' \
  -d '{"eventName":"dashboard.viewed","metadata":{"source":"nav"}}'
```

Returns 200 with an empty body. `eventName` is checked against an allowlist
rather than a schema, so a typo is rejected instead of silently recorded as an
event nobody will ever think to query:

```bash
curl -s -b jar.txt localhost:3001/analytics/events \
  -H 'Content-Type: application/json' \
  -d '{"eventName":"dashboard.veiwed"}'
```

```json
{"error":{"code":"VALIDATION_ERROR","message":"Unknown event name"}}
```

`metadata` goes into a jsonb column and is capped at 4KB:

```json
{"error":{"code":"VALIDATION_ERROR","message":"metadata is too large"}}
```

## Rate limits

Four tiers, all Redis-backed and all fail-open, so a Redis outage degrades to no
limiting rather than to a locked-out API. Auth routes, AI generation,
dashboard-compute and everything public are counted separately. Exceeding one
returns 429 with `code: "RATE_LIMITED"` and a `Retry-After` header in seconds,
which is the value a client should back off by rather than guessing.

Worth triggering one deliberately if you are writing a client. A 429 on
`/auth/signin` looks exactly like bad credentials if you are only reading status
codes, and the retry behaviour you want for the two is opposite.
