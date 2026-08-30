import { Registry, collectDefaultMetrics, Histogram, Counter, Gauge } from 'prom-client';
import { activeCount } from './activeStreams.js';

export const registry = new Registry();

collectDefaultMetrics({ register: registry });

export const httpRequestDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Request duration in seconds',
  labelNames: ['method', 'route', 'status'] as const,
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 15],
  registers: [registry],
});

export const aiSummaryTotal = new Counter({
  name: 'ai_summary_total',
  help: 'Total AI summary requests',
  labelNames: ['tier', 'cache_hit', 'outcome'] as const,
  registers: [registry],
});

// NFR2 (first token < 2s) and NFR3 (full summary < 15s) are the two performance
// targets CI cannot check, since the runner streams against a dummy Claude key.
// Buckets straddle each threshold so the SLO is one histogram_quantile away.
export const aiFirstTokenDuration = new Histogram({
  name: 'ai_summary_first_token_seconds',
  help: 'Seconds from stream start to the first streamed token',
  labelNames: ['tier'] as const,
  buckets: [0.25, 0.5, 1, 1.5, 2, 3, 5, 10],
  registers: [registry],
});

export const aiSummaryDuration = new Histogram({
  name: 'ai_summary_complete_seconds',
  help: 'Seconds from stream start to the done event',
  labelNames: ['tier', 'outcome'] as const,
  buckets: [1, 2.5, 5, 7.5, 10, 15, 20, 30],
  registers: [registry],
});

export const aiTokensUsed = new Counter({
  name: 'ai_tokens_used_total',
  help: 'Total Claude API tokens consumed',
  labelNames: ['tier', 'direction'] as const,
  registers: [registry],
});

export const statCitationTotal = new Counter({
  name: 'stat_citation_total',
  help: 'Total stat citation resolution requests',
  labelNames: ['outcome'] as const,
  registers: [registry],
});

export const rateLimitHits = new Counter({
  name: 'rate_limit_hits_total',
  help: 'Rate limit rejections',
  labelNames: ['limiter'] as const,
  registers: [registry],
});

export const circuitBreakerState = new Gauge({
  name: 'circuit_breaker_open',
  help: '1 if circuit breaker is open, 0 if closed',
  labelNames: ['name'] as const,
  registers: [registry],
});

// Counts post-call detections of cost anomalies. Labelled by caller because
// the generate path throws (request fails) while the stream path logs-only
// (response was already delivered), operators want to distinguish the two.
export const aiCostBudgetExceeded = new Counter({
  name: 'ai_cost_budget_exceeded_total',
  help: 'Times an AI call cost exceeded the rolling-median or absolute ceiling',
  labelNames: ['caller'] as const,
  registers: [registry],
});

// Labelled by caller (generateTool vs converseWithTools) and reason
// (max_tokens vs abnormal_stop_reason) so a spike is queryable instead of grep-only.
export const aiToolCallsDropped = new Counter({
  name: 'ai_tool_calls_dropped_total',
  help: 'Tool calls dropped because the response was truncated or ended abnormally',
  labelNames: ['caller', 'reason'] as const,
  registers: [registry],
});

// Labelled by stage (evaluate-org vs orchestrator-paging) so the two
// checkpoints in the agent orchestrator's run-level cost ceiling are
// queryable separately -- evaluate-org is where spend actually stops,
// orchestrator-paging is a weaker early-exit on the enqueue side. Increments
// once per check that finds the ceiling already tripped, not once per run --
// a single over-budget run can add many counts here (one per skipped org).
export const agentRunBudgetExceeded = new Counter({
  name: 'agent_run_budget_exceeded_total',
  help: 'Times a cost-ceiling check found the run budget already exceeded, by checkpoint stage',
  labelNames: ['stage'] as const,
  registers: [registry],
});

new Gauge({
  name: 'sse_active_streams',
  help: 'Number of active SSE streams',
  registers: [registry],
  collect() { this.set(activeCount()); },
});
