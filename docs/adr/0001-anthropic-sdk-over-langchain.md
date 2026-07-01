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

## Revisited 2026-06-30 (agent tier shipped)

The agent tier landed and did not change this decision. "Adding agents" here means a single structured-generation call followed by deterministic code, not a model-driven agent loop, so the reconsider-trigger named above ("a genuine agent or multi-step chain") is not met.

The path is three stages, and only the first touches the model:

1. One call through the existing provider seam produces a JSON array of proposals, prompted by `services/curation/config/prompt-templates/v1-agent-{system,user}.md` and fed the same curated `ComputedStat[]` the interpretation path uses.
2. `parseProposals()` (`apps/api/src/services/curation/parseProposals.ts`) validates each item against `agentProposalSchema` and drops any whose `evidence` cites a stat ID outside the allowed set. Pure function, no model call.
3. `routeProposal()` (`packages/shared/src/agent/gate.ts`) assigns each proposal a lane, `auto_notify`, `needs_approval`, or `suppress`, by a fixed precedence: confidence floor first, then a mutating or over-threshold action forces a human, then dedup, else auto-notify. Pure and side-effect-free; the caller does the IO and writes the audit row.

No `tools`, no `tool_use` / `tool_choice`, no observe-act loop, no second model call. The model emits data; our code makes every control-flow decision. It is the interpretation pipeline's shape (curated input, one call, structured output, deterministic handling) applied to a different output type.

Adopting LangChain now would still buy nothing this path uses, and it would cost two things we want in plain, tested code we own:

- The safety gate. `routeProposal` is what keeps a low-confidence or mutating proposal from auto-executing. That policy belongs in an audited pure function, not inside a framework's agent executor.
- The privacy edge. The "evidence must cite an allowed stat ID, else drop" rule in `parseProposals` enforces the no-raw-data-leak boundary at the output. A generic output parser would not scope that for us.

What would reopen the question: proposals that require the model to call tools and observe results across multiple turns, which is a real tool-use agent. Even then the first move is to grow the provider seam's `PromptInput` and return type to carry tool calls (the Anthropic SDK supports tool use natively), and to lean on Postgres plus BullMQ for any durable human-in-the-loop state, rather than adopt an orchestration framework. Status stays Accepted.
