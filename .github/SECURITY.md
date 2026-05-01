# Security policy

## Reporting a vulnerability

If you find a security issue in Tellsight, please email **cstevens3446@gmail.com** with:

- A description of the issue.
- Steps to reproduce, ideally with the smallest input that triggers it.
- The impact you believe it has (data exposure, auth bypass, billing-state corruption, prompt-injection that leaks across tenants, etc.).

I'll respond within 72 hours and aim to ship a fix or mitigation within 7 days for high-severity issues.

Please do not file a public GitHub issue for security reports.

## Supported versions

This project tracks `main` only. There are no maintained release branches at this stage.

## Threat model context

Tellsight is a multi-tenant SaaS application with several security-relevant surfaces. Reports about any of the following are especially welcome:

- **Privacy contract bypasses.** The core thesis is that the AI pipeline sees computed statistics, never raw rows of customer data. Any code path that could route raw rows or row-level identifiers to the LLM (system prompt, user prompt, tool inputs, structured-output schema fields) is a high-severity bug. The curation pipeline (`computation` → `scoring` → `assembly`) is the boundary; reports should reference where the leak occurs in that chain.
- **Row-level security (RLS) bypasses.** PostgreSQL RLS policies enforce org isolation on every table. A query that returns rows belonging to a different `org_id` than the authenticated user's is an isolation breach. Reports identifying a specific endpoint and the SQL that crosses the boundary are most useful.
- **JWT and refresh-token issues.** The auth layer uses `jose` for JWT signing and a refresh-rotation flow. Issues with token validation, refresh-replay, signature confusion, or session fixation belong here.
- **Stripe webhook handling.** Webhook signature verification is required before any billing-state mutation. Reports about replay, signature bypass, or state-corruption via crafted events are in scope.
- **SSE channel abuse.** The AI summary streams over Server-Sent Events. Cross-tenant subscription, summary-stream poisoning, or rate-limit bypass on the SSE handler are in scope.
- **Demo-mode escape.** Demo mode is a deliberately-permissive read path with cached AI summary. Reports where demo mode grants access beyond its intended scope are welcome.
