# 4. Clear an unverifiable `movement` instead of dropping the proposal, and keep the contradiction check on the evidence it now has

- Status: Accepted, implemented 2026-11-12
- Date: 2026-11-12
- Deciders: Corey Stevens
- Supersedes part of: [ADR 0003](0003-direction-checks-echo-the-stat-token.md)

## Context

ADR 0003 added an optional `movement` to the proposal contract: the model copies the direction token from the stat it cites, and `validateProposalCandidate` compares it by string equality. Two rules enforced it, and both dropped the whole proposal.

It also parked itself. Its own closing section says to revisit once the eval arm has a baseline, and names what to read off that baseline: "whether proposals cite multiple direction-bearing stats often enough that the skip rule makes the check pointless, and whether declared contradictions occur at all. If the model never contradicts its own cited token, this check buys nothing and should be dropped rather than shipped for completeness."

It recorded why nobody had read it: "The arm that grades `v1-agent` landed in PR 255 and has never run: the API key reports a zero credit balance."

That arm has now run, twice.

## What the baseline says

36 samples on `cash-crunch`, 0 shed, 0 errored, `v1-agent`, subject `claude-sonnet-4-6`, judge `claude-sonnet-5`. A second arm of 36 ran the same fixture with two fields reordered in `RECORD_PROPOSAL_TOOL`, which is recorded separately in DW-265 and changed nothing here.

- 67 `record_proposal` calls, 15 proposals kept. **77.6% dropped.**
- **Declared contradictions: 0.** Not rare, absent. In 67 calls the model never once stated a direction token that disagreed with the single direction-bearing stat it cited.
- Present-when-absent drops: **19.**
- Silent samples: 21 of 36, split **0 abstained, 21 all-dropped.** Across a full baseline the agent was never once silent by choice. The prompt sanctions calling the tool zero times and the model never took it.
- Material-risk coverage: **0.417.** The 2.4-month runway reached the output in 42% of samples, and the other 58% is this rule, not the model missing it.

Every readable title lost to the present-when-absent rule is the same correct finding: "Cash runway of 2.4 months with zero crossing projected in ~60 days", "Runway at 2.4 months with cash crossing zero by month 2", "Cash exhausted in ~2.4 months with zero crossing projected mid-March 2026".

## Decision

Present-when-absent clears `movement` and keeps the proposal. The contradiction rule is unchanged and still drops the whole proposal.

The asymmetry is the point, and ADR 0003 already contains the argument for it without having drawn the line there. Its case for dropping is that a proposal reporting `surplus` against a `burning` stat is *wrong*: the prose and the data disagree and no part of the finding can be trusted. A proposal that states a movement no cited stat declares is not wrong, it is *unverifiable* in one optional field. ADR 0003 justified that second case in a single sentence, "Present-when-absent is itself a defect worth dropping on", and it is the only rule in that document with no argument behind it.

Clearing costs nothing a reader can observe. `deriveDedupKey` is `kind:subject:facet`, so dedup is untouched. The only consumers of `.movement` anywhere in the repo are the tool schema, this validator, and the Zod schema; nothing renders it. It exists so the model echoes a token that can be compared, and a cleared field means there was nothing to compare against.

## Consequences

**The contradiction check keeps its mechanism and loses its justification-by-assumption.** Zero firings over 67 calls is the result ADR 0003 said would mean "this check buys nothing". It is kept anyway, deliberately: the cost is now one cleared field rather than a deleted finding, and a check that has never fired on a sound model is the one you want present the day the model stops being sound. What has changed is that its value is a measured zero rather than an assumed positive, and that is recorded here rather than implied.

**The skip rule's premise is untested.** ADR 0003's other parked question was whether multi-stat citations make the check a no-op. This baseline does not answer it, because `cash-crunch` carries exactly one direction-bearing stat (`cash_flow`). A fixture with two would be needed and none exists.

**Risk coverage becomes the metric to watch.** The eval now scores the agent arm on whether it flagged the material risks the prompt names by number, replacing a completeness score that graded this arm against the summary arm's answer key and sat at exactly 0.75 on all 36 samples (DW-259). Whether this change moves 0.417 is the next measurement, and it is the number a rerun should treat as primary rather than faithfulness, which the drop rate confounds.

**The 77.6% drop rate is mostly not this rule.** 33 of 52 drops were figures judged not derivable, and at least part of that is a broken fixture rather than a broken model: `cash-crunch` hand-authors a `break_even` stat with no `margin_trend`, a combination `computeBreakEven` cannot produce, which leaves the prompt printing "at 20.0% margin" with nothing contributing 20 to the allowed set (DW-262). That is a separate fix and it will move the headline number more than this one does.

## Alternatives considered

**Drop the movement mechanism entirely**, which is the literal reading of ADR 0003's revisit test. Rejected: the test was written to decide whether the mechanism earns a *whole-proposal drop*, and the answer is that it does not. At field level the cost is close to zero, so the threshold for keeping it is correspondingly lower.

**Make the contradiction case field-level too.** Rejected, and a test now pins the asymmetry. A proposal whose stated direction contradicts its own cited stat has a prose/data disagreement that clearing one field does not repair.

**Leave it and raise the model's compliance through the prompt.** Rejected on sequence. The model is already copying the prompt faithfully; the same baseline showed it reproducing a v2.3 example clause verbatim. Asking it to be more careful about an optional field is a smaller lever than not deleting its correct findings.
