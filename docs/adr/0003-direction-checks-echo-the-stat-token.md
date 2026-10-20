# 3. Have the agent echo the stat's own direction token instead of defining a shared up/down vocabulary

- Status: Accepted, implemented 2026-10-18
- Date: 2026-10-18
- Deciders: Corey Stevens

## Context

`proposalValidation.ts` now re-derives every figure in an agent proposal against the ComputedStat set and drops the proposal when a number is not derivable. That closed the first of three checks that claim-level verification was supposed to cover: is the number present, does the named window match, does the stated direction match. This records why the second and third are not built, and what the third will look like when it is.

The obvious shape for a direction check is a `direction: 'up' | 'down' | 'flat'` field on the proposal, validated against the sign of the cited stat. It does not survive contact with the stat types.

**Direction is not one thing in this codebase.** Three of the twelve detail shapes in `types.ts` declare a direction, and no two of them use the same vocabulary:

- `AnomalyDetails.direction: 'above' | 'below'`
- `MarginTrendDetails.direction: 'expanding' | 'shrinking' | 'stable'`
- `CashFlowDetails.direction: 'burning' | 'surplus'`

The other nine have no direction field at all. `TrendDetails` carries the sign implicitly in `growthPercent` and `slope`; `TotalDetails`, `AverageDetails`, `CategoryBreakdownDetails`, `RunwayDetails`, `BreakEvenDetails`, `SeasonalProjectionDetails`, `YearOverYearDetails` and `CashForecastDetails` carry none.

So a shared up/down field needs a mapping from each of those onto two or three buckets, and the mapping is a judgment call rather than a translation. An expense anomaly `'above'` its bound is directionally up and semantically bad. A revenue trend up is up and good. Whether `'burning'` is "down" depends on whether the axis is cash or cash burn. Picking a convention does not make the ambiguity go away, it hides it in a lookup table that later readers will have to reverse-engineer.

**A proposal citing two stats can correctly describe opposite movements.** "Margin shrank while revenue grew" is true, common, and the shape the agent prompt actively asks for: it tells the model to prefer findings that connect multiple stats. A sign check over the evidence set would read that as a contradiction.

**Matching direction words in the prose is the failure mode this repo already has on record.** `hasDirectiveLanguage` flagged a cash-crunch sample for the literal phrase "you need to". The sentence was "the gap between what you're earning and what you need to break even", which names a figure rather than telling anyone to do anything, and a substring match cannot separate the two. Words like fell, rose, declined and improved are the same shape of problem with a wider surface.

That precedent is worse here than it was there. `streamHandler.ts` only flags, because by the time the full summary text exists it has already streamed to the browser. The proposal path **drops**. A false positive in the summary path produces a log line; a false positive here silently deletes a correct finding on the path that feeds the weekly digest.

## Decision

Do not define a shared direction vocabulary. The model echoes the stat's own token.

Add an optional `movement` to `RECORD_PROPOSAL_TOOL` and `agentProposalSchema`, described to the model as: the direction token from the stat you cited, copied exactly as it appears, for example `burning`, `shrinking`, `above`. Omit it when the cited stat declares no direction.

Validation is string equality against `details.direction` on the cited stat. No mapping, no semantics, no prose parsing. Two rules keep it sound:

- A proposal whose cited stat has no `direction` field must omit `movement`. Present-when-absent is itself a defect worth dropping on.
- When `evidence` names more than one direction-bearing stat, skip the check. That is what keeps "margin shrank while revenue grew" legal.

This reuses the mechanism that already works on this path. The model copies stat ids verbatim out of `[cite: id]` tokens and `validateProposalCandidate` verifies them with `Set.has()`. It works because the model is transcribing rather than interpreting, and because code compares literals. Direction can borrow it exactly: the token is in the prompt, the model copies it, equality decides.

The window check gets no equivalent and is not planned. There is no token to copy, because a stat's window is implied by the evidence rather than stated in it. The alternatives are temporal parsing of phrases like "in Q3", which is the substring problem again, or a schema field duplicating what `evidence` already determines.

## Consequences

**It catches declared contradiction, not prose contradiction.** A proposal that cites a `'burning'` cash-flow stat and reports `'surplus'` is dropped. A proposal that echoes `'burning'` correctly and still writes optimistic sentences passes. That is the ceiling without natural-language analysis, and naming the ceiling is better than implying the broader check exists.

**It fires on a subset.** Only three stat types declare a direction, so most proposals will omit `movement` and the check will be a no-op for them. Worth knowing before reading a clean result as coverage.

**It shipped before the eval arm could grade it, deliberately and against the recommendation below.** The arm that grades `v1-agent` landed in PR 255 and has never run: the API key reports a zero credit balance. Shipping an unmeasured prompt change one commit after merging a fix whose entire point was that this prompt was ungraded would repeat the defect in a new place. Order of operations: credits, then `pnpm eval` for a baseline, then the prompt change, then re-run and compare.

**Revisit when the eval arm has a baseline.** Two things to read off it. Whether proposals cite multiple direction-bearing stats often enough that the skip rule makes the check pointless, and whether declared contradictions occur at all. If the model never contradicts its own cited token, this check buys nothing and should be dropped rather than shipped for completeness.

## Alternatives considered

**A shared `up | down | flat` field with a per-type mapping table.** Rejected: the mapping is a judgment call, three of the cases are genuinely ambiguous, and nine of twelve types would need a convention invented for them. It also fails on multi-stat proposals.

**Parsing direction words from the prose.** Rejected on the `hasDirectiveLanguage` precedent, and more firmly here because this path drops rather than flags.

**Normalising all twelve detail shapes onto one direction field.** Rejected as the wrong fix at the wrong layer. The three existing vocabularies are each correct for their own stat, and `'expanding'` carries meaning that `'up'` does not. Flattening them to serve one validator would make every other consumer worse.

**Checking the sign of `growthPercent` for Trend stats only.** This is the narrow version and it is sound. Not taken yet because it answers a smaller question than the one asked, and the echo design covers it with the same machinery once the eval can grade the prompt change. Worth taking if the eval later shows direction-bearing citations are rare.
