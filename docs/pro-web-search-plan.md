# Pro Tier: Live Web Search for AI Insights

## What

Add real-time web search to the AI curation pipeline for Pro tier users. When generating insights, the system fetches current market data (commodity prices, industry news, local economic conditions) and injects it into the Claude prompt alongside the user's computed stats and static benchmarks.

Free tier continues using static industry benchmarks only.

## Why

Static benchmarks tell a user "your food costs are above industry average." Live web search tells them "your food costs are up 15%, and wholesale food prices rose 8% nationally this quarter -- so about half of your increase is market-driven." The difference is actionable context vs. generic advice.

## Architecture

### Pre-fetch approach (recommended over tool-use)

```
User uploads CSV
  → compute stats (existing)
  → score insights (existing)
  → [NEW] generate 1-2 search queries from top insights + business type
  → [NEW] fetch results from Brave Search API
  → [NEW] extract relevant snippets (3-5 sentences max)
  → assemble prompt with stats + benchmarks + web context
  → one Claude API call (existing)
```

Single Claude call. The search queries are generated deterministically from the data, not by Claude. This keeps costs predictable.

### Query generation logic

Based on the top-scored insights and business type, generate targeted queries:

```typescript
function generateSearchQueries(
  insights: ScoredInsight[],
  businessType: string,
): string[] {
  const queries: string[] = [];

  // always fetch industry-specific current conditions
  queries.push(`${businessType} industry trends ${currentQuarter} ${currentYear}`);

  // if there's a significant cost anomaly, check if it's market-driven
  const costAnomaly = insights.find(
    (i) => i.stat.statType === 'anomaly' && i.stat.category !== 'Revenue'
  );
  if (costAnomaly) {
    queries.push(`${costAnomaly.stat.category} costs ${businessType} ${currentYear}`);
  }

  // if margins are shrinking, check industry pricing trends
  const margin = insights.find((i) => i.stat.statType === 'margin_trend');
  if (margin?.stat.details.direction === 'shrinking') {
    queries.push(`${businessType} pricing trends inflation ${currentYear}`);
  }

  return queries.slice(0, 2); // max 2 queries to control costs
}
```

### Search API

**Brave Search API** -- $0.003 per query, no rate limiting concerns at our volume. Returns structured results with snippets. Alternative: Google Custom Search ($0 for first 100/day, $5 per 1000 after).

### Prompt injection format

```markdown
## Current market context (auto-fetched, Pro tier)

Sources checked on April 14, 2026:
- US restaurant food costs rose 4.2% YoY in Q1 2026 (USDA Economic Research Service)
- National diesel average: $3.89/gallon, up 8% from Q1 2025 (EIA)

Note: These are general indicators. Your specific costs depend on your suppliers, location, and contracts.
```

### Gating

```typescript
// in assembly.ts
const webContext = tier === 'pro' && businessProfile
  ? await fetchWebContext(insights, businessProfile.businessType)
  : null;

prompt = prompt.replace('{{webContext}}', webContext ?? 'Upgrade to Pro for real-time market context.');
```

Free users see "Upgrade to Pro for real-time market context" in the transparency panel, not in the AI output.

## Cost estimate

| Component | Cost per summary |
|-----------|-----------------|
| Brave Search (2 queries) | $0.006 |
| Extra input tokens (~400) | $0.001 |
| Total additional cost | ~$0.007 |
| Current summary cost | ~$0.01-0.03 |
| **Pro summary cost** | **~$0.02-0.04** |

At 100 summaries/month (Pro quota), that's $0.70-4.00/month in additional API costs per Pro user. Well within the $29-49/month Pro pricing.

## Implementation steps

1. Add `BRAVE_SEARCH_API_KEY` to config.ts env validation
2. Create `services/webSearch/braveClient.ts` -- thin wrapper around Brave Search API
3. Create `services/webSearch/queryGenerator.ts` -- deterministic query generation from insights
4. Create `services/webSearch/snippetExtractor.ts` -- parse search results into 3-5 relevant sentences
5. Update `assembly.ts` to accept and inject web context
6. Update prompt template with `{{webContext}}` placeholder
7. Gate behind `tier === 'pro'` in the stream handler
8. Add `WEB_CONTEXT_FETCHED` analytics event
9. Show "Powered by real-time market data" badge on Pro AI summaries
10. Add web context to transparency panel metadata

## Dependencies

- Brave Search API key ($0.003/query)
- No new npm packages needed (native `fetch` is sufficient)
- Pro tier subscription check (already exists via `subscriptionGate` middleware)

## Timeline

Estimated 4-6 hours of implementation. Can be shipped as a single PR.

## Risks

- **Search result quality**: Brave may return irrelevant results for niche business types. Mitigation: validate results contain the business type keyword before including. Fall back to static benchmarks if search returns nothing useful.
- **Latency**: Each search query adds 200-500ms. Two queries = 400ms-1s additional latency before Claude starts streaming. Mitigation: run queries in parallel with `Promise.all`.
- **Stale results**: Search results are current at query time but cached AI summaries may be served days later. Mitigation: include the fetch date in the web context so the AI can hedge ("as of April 14").
