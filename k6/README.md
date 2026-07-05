# k6 Load Tests

Baseline load tests targeting the SLOs defined in `docs/slo.md`.

## Prerequisites

```bash
brew install k6
```

## Running

Start the stack first:

```bash
docker compose up -d
```

Then run the load test against the local API:

```bash
k6 run k6/load-test.js
```

To test against a deployed environment, pass the base URL and a valid JWT:

```bash
K6_BASE_URL=https://api.example.com K6_JWT_TOKEN=<token> k6 run k6/load-test.js
```

## What it measures

The test ramps from 10 to 50 virtual users over 2 minutes, then ramps back down.

Thresholds (derived from SLOs):
- `http_req_duration p(95) < 2000ms`
- `http_req_duration p(99) < 5000ms`
- `http_req_failed rate < 0.005` (0.5% error budget)
- `health_duration_ms p(95) < 300ms`
- `dataset_duration_ms p(95) < 800ms`

k6 exits with a non-zero status code if any threshold is violated, making it CI-compatible.

## Baseline results (local docker-compose, 2026-07-05)

| Metric | p50 | p95 | p99 |
|---|---|---|---|
| All requests | ~25ms | ~120ms | ~280ms |
| /health | ~2ms | ~8ms | ~15ms |
| /api/datasets | ~40ms | ~180ms | ~350ms |

Run against a real deployment before accepting this baseline as representative of production latency.
