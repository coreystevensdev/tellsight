# 1. Use the Anthropic SDK directly instead of LangChain

- Status: Accepted
- Date: 2026-06-16 (documents a decision made at project start; the cost and provider-seam mitigations shipped 2026-04-25)
- Deciders: Corey Stevens

## Context

Tellsight has exactly one LLM use case: take a set of pre-computed statistics, assemble a prompt, and stream back a plain-English interpretation. There is no agent loop, no tool calling, no retrieval step, no chain of model calls. The curation pipeline does all the data work locally (computation, scoring, assembly) and hands the LLM a finished prompt. By design the model never sees raw rows, only `ComputedStat[]`.

The question was whether to reach for a framework (LangChain was the obvious candidate in early 2026) or call the provider SDK directly.

Frameworks earn their keep when you need the things they abstract: swapping providers without touching call sites, composing multi-step chains, managing agent state, wiring retrieval. The cost is a large transitive dependency surface, an extra abstraction layer between our code and the API, and version churn that tends to lag provider feature releases.

## Decision

Call `@anthropic-ai/sdk` directly. Wrap it behind a small in-house provider interface (`LlmProvider`, 27 lines in `apps/api/src/services/aiInterpretation/provider.ts`) so the rest of the codebase depends on our contract, not on Anthropic's types.

The interface is three methods: `generate`, `stream`, `checkHealth`, over a `PromptInput` of `{ system, user }`. Callers reach the active provider through `getProvider()` and never import the Anthropic SDK. A future provider swap is a `registerProvider()` change at boot, not a migration across call sites.

Everything a framework would have managed for this use case, we own explicitly in `claudeClient.ts`:

- Streaming via the SDK's native `client.messages.stream()` with `AbortSignal` wiring, so a client disconnect aborts the upstream call.
- A circuit breaker (3 consecutive failures opens for 30s) that ignores client-initiated aborts so they don't trip it.
- A post-call cost gate (`computeCost` / `exceedsBudget` / `recordCost`) that refuses anomalous requests against a rolling median floor and emits a Prometheus counter.
- Prompt caching through `cache_control: ephemeral` on the system block, attached only when a system prompt is present.
- Typed error mapping: `AuthenticationError` and `BadRequestError` are non-retryable and logged at error level; everything else maps to a domain `ExternalServiceError` and surfaces as a 503.

## Consequences

What we get:

- No framework dependency surface. The only LLM dependency is the provider's own SDK.
- The provider seam is small enough to read in one sitting, and it expresses exactly the swappability a framework would sell, scoped to our two methods plus health.
- We adopt provider features (prompt caching, streaming helpers, typed errors) the day the SDK ships them, with no wrapper lag.
- Every behavior a framework hides (retries, breaker thresholds, cost policy, error taxonomy) is explicit and unit-tested in our code.

What we give up:

- If Tellsight grows a genuine agent or multi-step chain, we would build that orchestration ourselves rather than inherit it. The provider seam does not extend to chains; it would need a different abstraction. That is an accepted future cost, not a hidden one.
- We do not get LangChain's ecosystem of off-the-shelf integrations (retrievers, vector-store adapters, output parsers). None are needed for a single-prompt interpretation step, and the privacy-by-architecture stance (curated stats in, no raw rows) makes most retrieval adapters inapplicable anyway.

## Alternatives considered

- LangChain (TypeScript). Rejected: the abstractions it charges for (chains, agents, retrieval) are not used here, so the dependency is cost without benefit. The one thing it would buy us, provider swappability, is 27 lines of our own interface.
- LangChain plus LangSmith tracing. Tracing is genuinely useful, but it does not require adopting the orchestration framework. Structured Pino logs plus Sentry already cover the single-call observability we need; per-call usage and cost are logged on every request.
- No abstraction at all (call the SDK inline at each site). Rejected: it would scatter Anthropic types across services and make a provider swap a multi-file migration. The thin seam costs almost nothing and removes that coupling.
