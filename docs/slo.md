# Tellsight Service Level Objectives

Defines the reliability targets for the Tellsight API and the error budget for each.

## Availability

| SLO | Target | Measurement window |
|---|---|---|
| API availability | 99.5% | Rolling 30 days |
| Error budget | 3.65 hours/month | Time where API is unavailable |

Availability is measured as the fraction of health check probes that return HTTP 200. A probe interval of 30 seconds means one probe per window of ~86,400 probes/month. The error budget is exhausted when more than 432 probes fail in a rolling 30-day window.

## Latency

| Endpoint type | p50 target | p95 target | p99 target |
|---|---|---|---|
| Auth (login, register) | 50ms | 200ms | 500ms |
| Dataset read (cached) | 80ms | 300ms | 800ms |
| Dataset read (uncached) | 200ms | 600ms | 1500ms |
| AI summary (fresh) | 3s | 8s | 15s |
| AI summary (cached) | 30ms | 100ms | 250ms |

Latency SLOs are measured at the API layer (before CDN/proxy). The `http_request_duration_seconds` histogram in Prometheus is the source of truth. Evaluate with:

```promql
histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, route))
```

## Error Rate

| SLO | Target |
|---|---|
| HTTP 5xx rate across all routes | < 0.5% of requests |
| AI summary failure rate | < 2% of summary requests |

The 5xx error rate SLO is evaluated over a 5-minute rolling window. A sustained spike above 0.5% for more than 2 minutes should alert.

## Error Budget Policy

- When the monthly error budget is above 50%: normal development velocity, experiments allowed.
- When the error budget is between 10% and 50%: no new experiments touching the AI summary or SSE path. Prioritize reliability work.
- When the error budget is below 10%: freeze all non-critical changes. Focus exclusively on root cause and remediation.

## Metrics Sources

All SLO measurements pull from the Prometheus instance at `:9090` provisioned in `docker-compose.yml`. The Grafana dashboard at `:3002` provides the latency percentile panels. No additional tooling is required for local SLO evaluation.
