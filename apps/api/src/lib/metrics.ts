import { Registry, collectDefaultMetrics, Histogram, Counter, Gauge } from 'prom-client';
import { activeCount } from './activeStreams.js';

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

// -- request latency by route + method + status --
export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Request duration in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15],
  registers: [registry],
});

// -- AI summary metrics --
export const aiSummaryTotal = new Counter({
  name: 'ai_summary_total',
  help: 'Total AI summary requests',
  labelNames: ['tier', 'cache_hit', 'outcome'] as const,
  registers: [registry],
});

export const aiTokensUsed = new Counter({
  name: 'ai_tokens_used_total',
  help: 'Total Claude API tokens consumed',
  labelNames: ['tier', 'direction'] as const,
  registers: [registry],
});

// -- rate limiting --
export const rateLimitHits = new Counter({
  name: 'rate_limit_hits_total',
  help: 'Rate limit rejections',
  labelNames: ['limiter'] as const,
  registers: [registry],
});

// -- circuit breaker --
export const circuitBreakerState = new Gauge({
  name: 'circuit_breaker_open',
  help: '1 if circuit breaker is open, 0 if closed',
  labelNames: ['name'] as const,
  registers: [registry],
});

// -- AI cost ceiling --
// Counts post-call detections of cost anomalies. Labelled by caller because
// the generate path throws (request fails) while the stream path logs-only
// (response was already delivered), operators want to distinguish the two.
export const aiCostBudgetExceeded = new Counter({
  name: 'ai_cost_budget_exceeded_total',
  help: 'Times an AI call cost exceeded the rolling-median or absolute ceiling',
  labelNames: ['caller'] as const,
  registers: [registry],
});

// -- active SSE streams (pulled from activeStreams registry) --
new Gauge({
  name: 'sse_active_streams',
  help: 'Number of active SSE streams',
  registers: [registry],
  collect() { this.set(activeCount()); },
});
