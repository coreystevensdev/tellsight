/**
 * AI summary eval harness.
 *
 * validate-seed.ts grades the prompt going INTO the model (deterministic, free).
 * This grades the summary coming OUT: faithfulness (no invented figures),
 * completeness (covers the stats that matter), and legal posture (analytics, not
 * advice). It runs each labeled fixture through the real pipeline, samples N
 * generations, and judges them with an LLM (faithfulness, completeness) plus a
 * deterministic string scan (legal posture).
 *
 * Run: pnpm eval  (from the repo root; loads .env, then runs this via tsx)
 * Needs a real CLAUDE_API_KEY. EVAL_MODEL and EVAL_JUDGE_MODEL independently
 * override the subject and judge. Costs tokens (N samples x 3 fixtures x ~3 calls each).
 *
 * console.log/error is intentional, this is a standalone script, not app code;
 * the Pino rule applies to apps/ only (same posture as validate-seed.ts).
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// These two are config-free, so they're safe at top level (validate-seed.ts
// imports the same surface and runs keyless in CI). The provider, by contrast,
// pulls in config.ts and must be imported dynamically after the key guard.
import { rankInsights } from '../apps/api/src/services/curation/scoring.js';
import { assemblePrompt } from '../apps/api/src/services/curation/assembly.js';
import { FIXTURES, FROZEN_NOW } from './eval-fixtures/fixtures.js';
import { agentGate } from './eval-fixtures/agent-gate.js';
import { insightGate, INSIGHT_MISS_CEILING } from './eval-fixtures/insight-gate.js';
import { scoreLegalPosture } from './eval-fixtures/legal-posture.js';
import { formatGloss, scorePlainLanguage } from './eval-fixtures/plain-language.js';
import { warrantedRisks, scoreRiskCoverage } from './eval-fixtures/material-risk.js';
import { dashboardGate } from './eval-fixtures/dashboard-gate.js';
import { freshShedState, onShed, sleep, SHED_RETRY_WAIT_MS } from './eval-fixtures/shed-retry.js';
import { isPermanentUpstreamFailure } from './eval-fixtures/permanent-failure.js';
import type { GenerateProvider } from './eval-fixtures/parse-judge.js';
import {
  AGENT_SUMMARIES_START,
  extractGroundTruth,
  mean,
  scoreActionability,
  scoreCompleteness,
  scoreFaithfulness,
  summarizeAgentSamples,
  summarizeFixtureSamples,
  type AgentFixtureScore,
  type AgentSample,
  type FixtureScore,
  type SampleScore,
} from './eval-fixtures/summary-scoring.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCORECARD_PATH = resolve(__dirname, 'eval-fixtures', 'scorecard.json');
const MARKER_PATH = resolve(__dirname, 'eval-fixtures', 'scorecard.zero-results.json');

// 10 per fixture, 30 total. At 3 the gate was bad at both ends: a single miss is
// 22% so it failed a healthy run 10.6% of the time, while catching a regression
// the size of v1.7's only 77% of the time. 10 puts those at 3.8% and 95% for
// about $0.84 a run. 15 buys 2.2% and 98% for half as much again, which is not
// worth it. Worth knowing that more samples is not monotonically better here:
// the ceiling is crossed in whole misses, so 60 samples needs 10 of them (16.7%)
// and is actually worse than 45 at catching a 20% rate.
const SAMPLES = Number(process.env.EVAL_SAMPLES ?? 10);

// Pinned literally, never read from CLAUDE_MODEL, so a local override cannot
// move either side of a benchmark. The subject tracks what production serves,
// since a score for a model nobody is served by describes nothing. The judge
// stays on a different model: one grading its own output is a lenient grader.
const SUBJECT_MODEL = process.env.EVAL_MODEL ?? 'claude-sonnet-4-6';
const JUDGE_MODEL = process.env.EVAL_JUDGE_MODEL ?? 'claude-sonnet-5';

// Diagnosing one fixture should not cost three. Misses are the thing worth
// reading and they concentrate: cash-crunch carried 4 of the 6 in the last run.
const ONLY_FIXTURE = process.env.EVAL_FIXTURE ?? '';

// Undefined means assemblePrompt's own default. Set it to score a prompt the
// default has already moved past: comparing v2.0 against v2.1 at equal n is the
// only way to tell a prompt change from run-to-run noise, and once the default
// bumps there is otherwise no way back to the old one.
const PINNED_PROMPT_VERSION = process.env.EVAL_PROMPT_VERSION || undefined;

// Only the initial value of the reported version; the real one is read back from
// assemblePrompt's metadata per fixture, so a default-version bump can't leave the
// scorecard lying about which prompt was scored.
const DEFAULT_PROMPT_VERSION = 'v1.6';

// Floors apply to the mean (the number that lands in the README). Legal posture
// still has to hold on every sample: a banned imperative is a defect, not a rate.
//
// riskCoverage is null, meaning measured and printed but not gated. completeness
// 0.8 was set against a judge scoring how many answer-key stats a summary
// covered; risk coverage asks whether the agent flagged a material risk the
// prompt names by number, and reusing 0.8 would be borrowing a threshold from a
// metric that measures something else. It gets a number once a run has measured
// it. Revisit at the next agent-arm run; if this is still null after one, the
// decision was never made rather than made deliberately.
const FLOORS = { faithfulness: 0.85, completeness: 0.8, riskCoverage: null };

function printScorecardTable(rows: FixtureScore[]): void {
  console.log(
    '\n| Fixture | Faithfulness | Completeness | Legal posture | Plain language | FR22 misses |',
  );
  console.log('|---|---|---|---|---|---|');
  for (const r of rows) {
    const f = `${r.faithfulness.mean.toFixed(2)} (min ${r.faithfulness.min.toFixed(2)})`;
    const c = `${r.completeness.mean.toFixed(2)} (min ${r.completeness.min.toFixed(2)})`;
    const degraded = r.sampledCount < SAMPLES ? ` (n=${r.sampledCount}/${SAMPLES})` : '';
    const missed = `${r.insight.misses}/${r.sampledCount}`;
    // The gate result and the ungated gloss rate in one cell: "pass" alone would
    // read as rule 9 being met, and the second half of that rule is not.
    const plain = `${r.plainLanguage.pass ? 'pass' : 'FAIL'} (${r.plainLanguage.unglossedSamples}/${r.sampledCount} unglossed)`;
    console.log(
      `| ${r.id}${degraded} | ${f} | ${c} | ${r.legalPosture.pass ? 'pass' : 'FAIL'} | ${plain} | ${missed} missed |`,
    );
  }
}

// The agent arm. The dashboard arm above grades v2.0 prose from provider.generate;
// this one grades v1-agent, which the agent path renders through the same
// assemblePrompt but answers with a record_proposal tool call rather than prose.
// Calling generateProposals rather than rebuilding its steps means the candidate
// build, the stat-id validator and the dedup gate are all the shipped ones, so a
// proposal the production path would drop is dropped here too.
//
// Scores faithfulness, material-risk coverage, legal posture and plain language.
// Deliberately NOT gated on INSIGHT_MISS_CEILING: FR22's ceiling was calibrated
// against the dashboard summary, and whether it should also bind the agent is a
// product decision, not something to assume by wiring it up.
async function scoreAgentFixture(
  judgeProvider: GenerateProvider,
  fixture: (typeof FIXTURES)[number],
): Promise<AgentFixtureScore> {
  // Dynamic for the same reason the provider is: proposals.ts reaches claudeClient,
  // which builds the Anthropic client from config.ts and throws at load when the
  // key is unset. The import is cached, so the per-fixture cost is one lookup.
  const { generateProposals, PROMPT_VERSION } =
    await import('../apps/api/src/services/curation/proposals.js');

  const stats = fixture.build();
  const scored = rankInsights(stats);
  const { user } = assemblePrompt(scored, 1, PROMPT_VERSION, undefined, FROZEN_NOW);
  const groundTruth = extractGroundTruth(user, AGENT_SUMMARIES_START);
  // Off the raw stats, not the ranked ones: a risk the ranker dropped is still a
  // risk the prompt names, and scoring against the survivors would let curation
  // quietly shrink the denominator.
  const risks = warrantedRisks(stats);

  const samples: AgentSample[] = [];
  const shedState = freshShedState();
  // A breaker trip sheds every subsequent sample, and samples run back to back,
  // so the 30s cooldown never closes. Whatever survives is therefore whatever
  // ran before the trip, not a random subset, which is why a partial arm under
  // shedding is inconclusive rather than a smaller measurement (DW-242).
  let unmeasured = 0;
  let errored = 0;
  for (let i = 0; i < SAMPLES; i++) {
    try {
      let toolCalls = 0;
      const proposals = await generateProposals(
        scored,
        1,
        undefined,
        FROZEN_NOW,
        undefined,
        (n) => {
          toolCalls = n;
        },
      );
      // Nothing to judge, but far from nothing to report: the prompt tells the
      // model to call the tool "or not at all when nothing is worth flagging",
      // so silence is a legitimate answer and its rate is the interesting number.
      if (proposals.length === 0) {
        samples.push({
          proposalCount: 0,
          toolCalls,
          faithfulness: null,
          // 0 when this fixture warrants a risk the agent said nothing about,
          // null when it warrants none. Silence is only free in the second case.
          riskCoverage: scoreRiskCoverage(risks, []).score,
          legalPass: true,
          legalViolations: [],
          plainPass: true,
          plainViolations: [],
          unglossed: [],
        });
        console.log(
          `  ${fixture.id} agent sample ${i + 1}/${SAMPLES}: no proposals ` +
            (toolCalls === 0 ? 'ABSTAINED' : `(${toolCalls} call(s), all dropped)`) +
            (risks.length ? ` MISSED ${risks.map((r) => r.statType).join(', ')}` : ''),
        );
        continue;
      }

      const prose = proposals
        .map((p) => [p.title, p.explanation, p.recommendation].filter(Boolean).join('\n'))
        .join('\n\n');
      // One judge call, not two. The completeness judge used to run here against
      // fixture.answerKey, which is the summary arm's contract: "top-K stat types
      // the summary must cover". Proposals are targeted alerts, and the agent
      // prompt calls a proposal that "just restates what a stat label already
      // says" weak and tells the model to skip it, so grading this arm on stat
      // coverage rewarded the behaviour the prompt forbids. It also sat at
      // exactly 0.75 on all 36 samples of the last run, mean equal to min, which
      // is what a structurally unreachable answer-key item looks like.
      const faith = await scoreFaithfulness(judgeProvider, groundTruth, prose);
      const faithfulness = faith.score;
      const coverage = scoreRiskCoverage(risks, proposals);
      const legal = scoreLegalPosture(prose);
      const plain = scorePlainLanguage(prose);
      samples.push({
        proposalCount: proposals.length,
        toolCalls,
        faithfulness,
        riskCoverage: coverage.score,
        legalPass: legal.pass,
        legalViolations: legal.violations,
        plainPass: plain.pass,
        plainViolations: plain.violations,
        unglossed: plain.unglossed,
      });
      console.log(
        `  ${fixture.id} agent sample ${i + 1}/${SAMPLES}: ${proposals.length} proposal(s), faith ${faithfulness.toFixed(2)}, risk ${coverage.score === null ? 'n/a' : coverage.score.toFixed(2)}, legal ${legal.pass ? 'pass' : 'FAIL'}, plain ${plain.pass ? 'pass' : 'FAIL'}, gloss [${formatGloss(plain)}]`,
      );
    } catch (err) {
      // Matched on the code rather than the message, which is user-facing copy
      // ("Service temporarily unavailable, please retry shortly.") and free to
      // change. CircuitOpenError sets CIRCUIT_OPEN at circuitBreaker.ts:107.
      // Nothing downstream improves across 36 samples once the upstream is
      // permanently refusing, and the run has already paid for the discovery.
      if (isPermanentUpstreamFailure(err)) {
        throw new Error(
          `${fixture.id}: upstream failure is permanent, abandoning the run after ` +
            `${samples.length} of ${SAMPLES} agent samples: ${err instanceof Error ? err.message : err}`,
        );
      }
      const shed = (err as { code?: string } | null)?.code === 'CIRCUIT_OPEN';
      if (shed) {
        const { action, attempt } = onShed(shedState, i);
        if (action === 'retry') {
          console.error(
            `  ${fixture.id} agent sample ${i + 1}/${SAMPLES} shed; waiting ` +
              `${SHED_RETRY_WAIT_MS / 1000}s for the breaker to half-open (attempt ${attempt})`,
          );
          await sleep(SHED_RETRY_WAIT_MS);
          i--;
          continue;
        }
        unmeasured++;
      } else errored++;
      console.error(
        `  ${fixture.id} agent sample ${i + 1}/${SAMPLES} ${shed ? 'shed, never reached the API' : 'failed'}: ` +
          `${err instanceof Error ? err.message : err}`,
      );
    }
  }

  if (samples.length === 0) {
    // Distinguished in the message because the two need different responses:
    // shed means re-run when the upstream is healthy, failed means investigate.
    throw new Error(
      `${fixture.id}: 0 of ${SAMPLES} agent samples measured (${unmeasured} shed, ${errored} errored)`,
    );
  }

  return summarizeAgentSamples(fixture, samples, { unmeasured, errored });
}

async function scoreFixture(
  provider: GenerateProvider,
  judgeProvider: GenerateProvider,
  fixture: (typeof FIXTURES)[number],
): Promise<{ score: FixtureScore; promptVersion: string }> {
  const scored = rankInsights(fixture.build());
  const { system, user, metadata } = assemblePrompt(
    scored,
    1,
    PINNED_PROMPT_VERSION,
    undefined,
    FROZEN_NOW,
  );
  const groundTruth = extractGroundTruth(user);

  const samples: SampleScore[] = [];
  // DW-250: this arm's floors decide the exit code, so a shed sample has to be
  // distinguishable from a bad one here even more than on the agent arm.
  let unmeasured = 0;
  let errored = 0;
  // DW-251: a third category. The cap refuses the priciest samples, cost tracks
  // output length, so unlike a shed or errored sample this exclusion is
  // correlated with the thing being scored.
  const shedState = freshShedState();
  let capRefused = 0;
  const capRefusedCostsUsd: number[] = [];
  const { spentOn } = await import('../apps/api/src/lib/cost.js');
  const spent = () => spentOn(SUBJECT_MODEL) + spentOn(JUDGE_MODEL);
  for (let i = 0; i < SAMPLES; i++) {
    const spentBefore = spent();
    try {
      const summary = await provider.generate({ system, user });
      const [faith, completeness, insight] = await Promise.all([
        scoreFaithfulness(judgeProvider, groundTruth, summary),
        scoreCompleteness(judgeProvider, fixture.answerKey, summary),
        scoreActionability(judgeProvider, summary),
      ]);
      const faithfulness = faith.score;
      for (const { claim, reason } of faith.unsupported) {
        console.log(`    unsupported: ${claim}${reason ? ` (${reason})` : ''}`);
      }
      const legal = scoreLegalPosture(summary);
      const plain = scorePlainLanguage(summary);
      samples.push({
        costUsd: Number((spent() - spentBefore).toFixed(6)),
        faithfulness,
        unsupported: faith.unsupported,
        completeness,
        legalPass: legal.pass,
        legalViolations: legal.violations,
        plainPass: plain.pass,
        plainViolations: plain.violations,
        unglossed: plain.unglossed,
        insightPass: insight.pass,
        qualifyingInsight: insight.qualifying,
        insightShortfall: insight.shortfall,
      });
      console.log(
        `  ${fixture.id} sample ${i + 1}/${SAMPLES}: faith ${faithfulness.toFixed(2)}, comp ${completeness.toFixed(2)}, legal ${legal.pass ? 'pass' : 'FAIL'}, plain ${plain.pass ? 'pass' : 'FAIL'}, gloss [${formatGloss(plain)}], insight ${insight.pass ? 'pass' : 'FAIL'}`,
      );
    } catch (err) {
      if (isPermanentUpstreamFailure(err)) {
        throw new Error(
          `${fixture.id}: upstream failure is permanent, abandoning the run after ` +
            `${samples.length} of ${SAMPLES} samples: ${err instanceof Error ? err.message : err}`,
        );
      }
      const code = (err as { code?: string } | null)?.code;
      let why = 'failed';
      if (code === 'CIRCUIT_OPEN') {
        const { action, attempt } = onShed(shedState, i);
        if (action === 'retry') {
          console.error(
            `  ${fixture.id} sample ${i + 1}/${SAMPLES} shed; waiting ` +
              `${SHED_RETRY_WAIT_MS / 1000}s for the breaker to half-open (attempt ${attempt})`,
          );
          await sleep(SHED_RETRY_WAIT_MS);
          i--;
          continue;
        }
        unmeasured++;
        why = 'shed, never reached the API';
      } else if (code === 'COST_BUDGET_EXCEEDED') {
        capRefused++;
        capRefusedCostsUsd.push((err as { observedUsd?: number }).observedUsd ?? 0);
        why = 'refused by the cost cap, so an expensive sample is missing from the mean';
      } else {
        errored++;
      }
      console.error(
        `  ${fixture.id} sample ${i + 1}/${SAMPLES} ${why}: ` +
          `${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // One bad sample shouldn't discard the fixture's other, already-scored samples.
  // Bail before Math.min() on an empty array (which is Infinity, not a real score).
  if (samples.length === 0) {
    throw new Error(
      `${fixture.id}: 0 of ${SAMPLES} samples measured ` +
        `(${unmeasured} shed, ${errored} errored, ${capRefused} refused by the cost cap)`,
    );
  }

  return {
    score: summarizeFixtureSamples(fixture, samples, {
      unmeasured,
      errored,
      capRefused,
      capRefusedCostsUsd,
    }),
    promptVersion: metadata.promptVersion,
  };
}

async function main(): Promise<void> {
  // AC9: guard before anything that pulls in config.ts. Read process.env directly
  // (scripts/ is exempt from the no-process.env rule) and exit 0 so an unkeyed
  // environment reads as "skipped", not "regressed".
  if (!process.env.CLAUDE_API_KEY) {
    console.error('eval requires CLAUDE_API_KEY; skipping');
    process.exit(0);
  }

  // Set the eval subject before importing config.ts. The provider reads
  // CLAUDE_MODEL during module initialization, while the eval-specific setting
  // stays independent from the production default and local .env overrides.
  process.env.CLAUDE_MODEL = SUBJECT_MODEL;

  // Dynamic + after the guard: importing claudeClient registers the provider as a
  // module side effect, but it also constructs the Anthropic client from config.ts,
  // which throws at load when the key is unset. Static-importing it would crash
  // before the guard could skip cleanly.
  await import('../apps/api/src/services/aiInterpretation/claudeClient.js');
  const { getProvider } = await import('../apps/api/src/services/aiInterpretation/provider.js');
  const provider = getProvider();

  // The grader has to be the same in both arms. Subject and judge are selected
  // independently so a more lenient model cannot look like a better writer.
  // Both are printed and recorded so a scorecard says what produced and graded it.
  const { generateWithModel } =
    await import('../apps/api/src/services/aiInterpretation/claudeClient.js');
  const judgeProvider: GenerateProvider = {
    generate: (input: { system: string; user: string }) => generateWithModel(input, JUDGE_MODEL),
  };

  console.log(`  generating with: ${SUBJECT_MODEL}`);
  console.log(`  judging with:    ${JUDGE_MODEL}`);

  console.log(`Running ${ONLY_FIXTURE ? 1 : FIXTURES.length} fixture(s) x ${SAMPLES} samples...`);
  const results: FixtureScore[] = [];
  const failedFixtureIds: string[] = [];
  let promptVersion = DEFAULT_PROMPT_VERSION;
  const selected = ONLY_FIXTURE ? FIXTURES.filter((f) => f.id === ONLY_FIXTURE) : FIXTURES;
  if (ONLY_FIXTURE && selected.length === 0) {
    console.error(
      `No fixture named "${ONLY_FIXTURE}". Have: ${FIXTURES.map((f) => f.id).join(', ')}`,
    );
    process.exit(1);
  }
  for (const fixture of selected) {
    try {
      const { score, promptVersion: version } = await scoreFixture(
        provider,
        judgeProvider,
        fixture,
      );
      promptVersion = version;
      results.push(score);
    } catch (err) {
      failedFixtureIds.push(fixture.id);
      console.error(`  ${fixture.id} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // On by default: the agent prompt shipping ungraded while the scorecard reported
  // on v2.0 is the exact gap this arm closes, so skipping has to be deliberate.
  // EVAL_AGENT=0 opts out when only the dashboard arm is being iterated on.
  const agentResults: AgentFixtureScore[] = [];
  const failedAgentFixtureIds: string[] = [];
  const agentArmRan = process.env.EVAL_AGENT !== '0';
  if (agentArmRan) {
    console.log(`\nAgent arm (v1-agent, record_proposal tool) x ${SAMPLES} samples...`);
    for (const fixture of selected) {
      try {
        agentResults.push(await scoreAgentFixture(judgeProvider, fixture));
      } catch (err) {
        // Recorded, not just logged. A fixture that dies leaves no entry in
        // agentResults, so a floor applied to that array cannot see it either:
        // the absence is the thing that has to be caught (DW-242).
        failedAgentFixtureIds.push(fixture.id);
        console.error(
          `  ${fixture.id} agent arm failed: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  }

  if (results.length === 0) {
    console.error('FAIL: no fixtures were scored');
    mkdirSync(dirname(MARKER_PATH), { recursive: true });
    writeFileSync(
      MARKER_PATH,
      JSON.stringify(
        { zeroResults: true, timestamp: new Date().toISOString(), failedFixtureIds },
        null,
        2,
      ) + '\n',
    );
    process.exit(1);
  }

  // Clear a marker left by a prior total-failure run. ENOENT is the common
  // case (most runs never had one); anything else is logged, not fatal, this
  // run's real results still need to reach the scorecard.
  try {
    rmSync(MARKER_PATH);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.error(
        `Failed to clear zero-results marker at ${MARKER_PATH}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  const aggregate = {
    faithfulness: mean(results.map((r) => r.faithfulness.mean)),
    completeness: mean(results.map((r) => r.completeness.mean)),
    legalPosture: results.every((r) => r.legalPosture.pass),
    plainLanguage: results.every((r) => r.plainLanguage.pass),
    // Rule 9's second half, measured and not gated. A rising rate here is the
    // model drifting away from explaining its own terms, which is worth seeing
    // even though no healthy run has ever had this at zero.
    unglossedSamples: results.reduce((n, r) => n + r.plainLanguage.unglossedSamples, 0),
    unglossedTerms: [...new Set(results.flatMap((r) => r.plainLanguage.unglossedTerms))],
    // A rate, not a boolean, and with its denominator: 1 miss reads very
    // differently at 9 samples than at 36, and the scorecard is the only place a
    // later reader can recover which one this was.
    insightMisses: results.reduce((n, r) => n + r.insight.misses, 0),
    insightSamples: results.reduce((n, r) => n + r.sampledCount, 0),
  };

  const scorecard = {
    promptVersion, // the version assemblePrompt actually rendered, not a hardcoded guess
    subjectModel: SUBJECT_MODEL,
    judgeModel: JUDGE_MODEL,
    // Its own section rather than folded into the aggregate above: these are a
    // different prompt answering with a different mechanism, and averaging them
    // together would hide a regression in either one.
    agent: agentResults.length
      ? {
          promptVersion: 'v1-agent',
          fixtures: agentResults,
          legalPosture: agentResults.every((r) => r.legalPosture.pass),
          plainLanguage: agentResults.every((r) => r.plainLanguage.pass),
          // Ungated today; FLOORS.riskCoverage records why and the printed block
          // above carries the per-fixture numbers a floor would be set from.
          riskCoverageGated: FLOORS.riskCoverage !== null,
          silentSamples: agentResults.reduce((n, r) => n + r.silentSamples, 0),
          totalSamples: agentResults.reduce((n, r) => n + r.sampledCount, 0),
        }
      : null,
    generatedAt: new Date().toISOString(), // lives only here, never in the printed/compared surface
    samplesPerFixture: SAMPLES,
    floors: FLOORS,
    // The faithfulness/completeness judges request temperature 0 in-prompt, but the
    // LlmProvider interface exposes no temperature knob, so the API runs at the
    // provider default. Recorded here so the scores aren't read as if they were
    // fully deterministic. See story EVAL.1 Dev Agent Record (carry-forward to a
    // provider `generate(input, opts?)` overload).
    judgeTemperature:
      'provider default (temperature 0 requested in-prompt, not enforced at the API)',
    fixtures: results,
    aggregate,
    failedFixtureIds,
    failedAgentFixtureIds,
  };
  mkdirSync(dirname(SCORECARD_PATH), { recursive: true });
  writeFileSync(SCORECARD_PATH, JSON.stringify(scorecard, null, 2) + '\n');
  console.log(`\nWrote ${SCORECARD_PATH}`);

  printScorecardTable(results);

  // DW-251. Printed rather than gated: the cap is a production guard doing its
  // job, and a refusal is not a failure. What it is, though, is a sample missing
  // from the mean for a reason that tracks output length.
  //
  // What this deliberately does NOT do is compare the refused figure against a
  // scored sample's cost. The first version did, and they are different units:
  // CostBudgetExceededError carries one request's cost, while costUsd is a
  // generation plus both judge calls. Every refusal therefore looked about three
  // times cheaper than every scored sample by construction, and it printed
  // "not uniformly dearer" as though that meant something.
  for (const r of results) {
    if (r.capRefused === 0) continue;
    console.log(
      `  ${r.id}: cost cap refused ${r.capRefused} of ${SAMPLES} sample(s), on single calls costing ` +
        `${r.capRefusedCostsUsd.map((c) => `$${c.toFixed(4)}`).join(', ')}. Each exceeded its model's ` +
        `rolling median by the cap multiplier, so these are among the longest outputs in the run and ` +
        `are absent from the mean below. Their sample totals are unknown: the sample died at that call.`,
    );
  }

  // The pairing DW-251 exists for, reported with its interval because at this
  // sample size a coefficient alone is not a finding: n=32 on 2026-11-09 gave
  // r=-0.200 with a 95% interval from -0.513 to +0.159.
  for (const r of results) {
    const rows = r.sampleScores;
    if (rows.length < 8) continue;
    const c = rows.map((x) => x.costUsd);
    const y = rows.map((x) => x.faithfulness);
    const n = rows.length;
    const mc = c.reduce((a, b) => a + b, 0) / n;
    const my = y.reduce((a, b) => a + b, 0) / n;
    const sc = Math.sqrt(c.reduce((a, x) => a + (x - mc) ** 2, 0));
    const sy = Math.sqrt(y.reduce((a, x) => a + (x - my) ** 2, 0));
    if (sc === 0 || sy === 0) {
      console.log(
        `  ${r.id}: cost/faithfulness correlation undefined, one of them has no variance`,
      );
      continue;
    }
    const corr = c.reduce((a, x, i) => a + (x - mc) * (y[i]! - my), 0) / (sc * sy);
    // Fisher z, which is what makes the interval honest about n.
    const z = 0.5 * Math.log((1 + corr) / (1 - corr));
    const se = 1 / Math.sqrt(n - 3);
    const lo = Math.tanh(z - 1.96 * se);
    const hi = Math.tanh(z + 1.96 * se);
    const sign = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(3)}`;
    console.log(
      `  ${r.id}: r(cost, faithfulness) = ${sign(corr)} over ${n} samples, ` +
        `95% CI ${sign(lo)} to ${sign(hi)}` +
        (lo > 0 || hi < 0
          ? '. Excludes zero, so cost and score do move together here.'
          : '. Includes zero, so no correlation is detectable at this sample size.'),
    );
  }

  const breaches: string[] = dashboardGate(results, SAMPLES, FLOORS);

  // Both arms' gates now live beside their tests. DW-242 extracted the agent's
  // after a gate shipped ungated; DW-258 extracted this one after `if (false)`
  // in place of a breach condition left all 190 tests green.
  const agent = agentGate(agentResults, failedAgentFixtureIds, selected.length, SAMPLES, FLOORS);
  if (agentArmRan) {
    breaches.push(...agent.breaches);
    for (const line of agent.ungraded) console.log(`  ${line}`);

    // Printed even though FLOORS.riskCoverage is null, because a number that
    // only lands in the scorecard JSON is a number nobody reads. The silent
    // count is on the same line: coverage below 1 on a fixture that warrants a
    // risk is usually the agent saying nothing rather than citing the wrong stat.
    const graded = agentResults.filter((r) => r.riskCoverage !== null);
    if (graded.length > 0) {
      const gate = FLOORS.riskCoverage === null ? 'ungated' : `floor ${FLOORS.riskCoverage}`;
      console.log(`\nAgent material-risk coverage (${gate}):`);
      for (const r of graded) {
        const cov = r.riskCoverage as { mean: number; min: number };
        console.log(
          `  ${r.id}: ${cov.mean.toFixed(2)} mean, ${cov.min.toFixed(2)} min ` +
            `over ${r.sampledCount} samples ` +
            `(${r.silentSamples} silent = ${r.abstained} abstained + ${r.allDropped} all-dropped)`,
        );
      }
    }
  }

  const fr22 = insightGate(results);
  const ceiling = `${(INSIGHT_MISS_CEILING * 100).toFixed(0)}%`;
  console.log(
    `\nFR22 insight misses: ${fr22.misses}/${fr22.samples} ` +
      `(${(fr22.rate * 100).toFixed(1)}%, ceiling ${ceiling})`,
  );
  if (fr22.over) {
    breaches.push(
      `FR22 insight miss rate ${(fr22.rate * 100).toFixed(1)}% ` +
        `(${fr22.misses}/${fr22.samples}) over the ${ceiling} ceiling`,
    );
  }

  if (breaches.length > 0) {
    console.error('\nFAIL: floor breaches');
    for (const b of breaches) console.error(`  ${b}`);
  }

  if (failedFixtureIds.length > 0) {
    console.error(
      `\nFAIL: ${failedFixtureIds.length} fixture(s) errored: ${failedFixtureIds.join(', ')}`,
    );
  }

  if (breaches.length > 0 || failedFixtureIds.length > 0) {
    process.exit(1);
  }

  console.log('\nPASS: all fixtures meet the floors');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
