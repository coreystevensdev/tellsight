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
import { scoreInsights } from '../apps/api/src/services/curation/scoring.js';
import { assemblePrompt } from '../apps/api/src/services/curation/assembly.js';
import { FIXTURES } from './eval-fixtures/fixtures.js';
import { insightGate, INSIGHT_MISS_CEILING } from './eval-fixtures/insight-gate.js';
import { scoreLegalPosture } from './eval-fixtures/legal-posture.js';
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

// Freeze the date so the {{today}} placeholder doesn't drift the prompt between
// runs, same posture as validate-seed.ts:161.
const FROZEN_NOW = new Date('2026-01-15T12:00:00Z');
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

// Only the initial value of the reported version; the real one is read back from
// assemblePrompt's metadata per fixture, so a default-version bump can't leave the
// scorecard lying about which prompt was scored.
const DEFAULT_PROMPT_VERSION = 'v1.6';

// Floors apply to the mean (the number that lands in the README). Legal posture
// still has to hold on every sample: a banned imperative is a defect, not a rate.
const FLOORS = { faithfulness: 0.85, completeness: 0.8 };

function printScorecardTable(rows: FixtureScore[]): void {
  console.log('\n| Fixture | Faithfulness | Completeness | Legal posture | FR22 misses |');
  console.log('|---|---|---|---|---|');
  for (const r of rows) {
    const f = `${r.faithfulness.mean.toFixed(2)} (min ${r.faithfulness.min.toFixed(2)})`;
    const c = `${r.completeness.mean.toFixed(2)} (min ${r.completeness.min.toFixed(2)})`;
    const degraded = r.sampledCount < SAMPLES ? ` (n=${r.sampledCount}/${SAMPLES})` : '';
    const missed = `${r.insight.misses}/${r.sampledCount}`;
    console.log(`| ${r.id}${degraded} | ${f} | ${c} | ${r.legalPosture.pass ? 'pass' : 'FAIL'} | ${missed} missed |`);
  }
}

// The agent arm. The dashboard arm above grades v2.0 prose from provider.generate;
// this one grades v1-agent, which the agent path renders through the same
// assemblePrompt but answers with a record_proposal tool call rather than prose.
// Calling generateProposals rather than rebuilding its steps means the candidate
// build, the stat-id validator and the dedup gate are all the shipped ones, so a
// proposal the production path would drop is dropped here too.
//
// Scores faithfulness, completeness and legal posture, which transfer directly.
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
  const { generateProposals, PROMPT_VERSION } = await import(
    '../apps/api/src/services/curation/proposals.js'
  );

  const scored = scoreInsights(fixture.build());
  const { user } = assemblePrompt(scored, 1, PROMPT_VERSION, undefined, FROZEN_NOW);
  const groundTruth = extractGroundTruth(user, AGENT_SUMMARIES_START);

  const samples: AgentSample[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    try {
      const proposals = await generateProposals(scored, 1, undefined, FROZEN_NOW);
      // Nothing to judge, but far from nothing to report: the prompt tells the
      // model to call the tool "or not at all when nothing is worth flagging",
      // so silence is a legitimate answer and its rate is the interesting number.
      if (proposals.length === 0) {
        samples.push({ proposalCount: 0, faithfulness: null, completeness: null, legalPass: true, legalViolations: [] });
        console.log(`  ${fixture.id} agent sample ${i + 1}/${SAMPLES}: no proposals`);
        continue;
      }

      const prose = proposals
        .map((p) => [p.title, p.explanation, p.recommendation].filter(Boolean).join('\n'))
        .join('\n\n');
      const [faithfulness, completeness] = await Promise.all([
        scoreFaithfulness(judgeProvider, groundTruth, prose),
        scoreCompleteness(judgeProvider, fixture.answerKey, prose),
      ]);
      const legal = scoreLegalPosture(prose);
      samples.push({
        proposalCount: proposals.length,
        faithfulness,
        completeness,
        legalPass: legal.pass,
        legalViolations: legal.violations,
      });
      console.log(
        `  ${fixture.id} agent sample ${i + 1}/${SAMPLES}: ${proposals.length} proposal(s), faith ${faithfulness.toFixed(2)}, comp ${completeness.toFixed(2)}, legal ${legal.pass ? 'pass' : 'FAIL'}`,
      );
    } catch (err) {
      console.error(`  ${fixture.id} agent sample ${i + 1}/${SAMPLES} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (samples.length === 0) {
    throw new Error(`${fixture.id}: all ${SAMPLES} agent samples failed`);
  }

  return summarizeAgentSamples(fixture, samples);
}

async function scoreFixture(
  provider: GenerateProvider,
  judgeProvider: GenerateProvider,
  fixture: (typeof FIXTURES)[number],
): Promise<{ score: FixtureScore; promptVersion: string }> {
  const scored = scoreInsights(fixture.build());
  const { system, user, metadata } = assemblePrompt(scored, 1, undefined, undefined, FROZEN_NOW);
  const groundTruth = extractGroundTruth(user);

  const samples: SampleScore[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    try {
      const summary = await provider.generate({ system, user });
      const [faithfulness, completeness, insight] = await Promise.all([
        scoreFaithfulness(judgeProvider, groundTruth, summary),
        scoreCompleteness(judgeProvider, fixture.answerKey, summary),
        scoreActionability(judgeProvider, summary),
      ]);
      const legal = scoreLegalPosture(summary);
      samples.push({
        faithfulness,
        completeness,
        legalPass: legal.pass,
        legalViolations: legal.violations,
        insightPass: insight.pass,
        qualifyingInsight: insight.qualifying,
        insightShortfall: insight.shortfall,
      });
      console.log(
        `  ${fixture.id} sample ${i + 1}/${SAMPLES}: faith ${faithfulness.toFixed(2)}, comp ${completeness.toFixed(2)}, legal ${legal.pass ? 'pass' : 'FAIL'}, insight ${insight.pass ? 'pass' : 'FAIL'}`,
      );
    } catch (err) {
      console.error(`  ${fixture.id} sample ${i + 1}/${SAMPLES} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // One bad sample shouldn't discard the fixture's other, already-scored samples.
  // Bail before Math.min() on an empty array (which is Infinity, not a real score).
  if (samples.length === 0) {
    throw new Error(`${fixture.id}: all ${SAMPLES} samples failed`);
  }

  return {
    score: summarizeFixtureSamples(fixture, samples),
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
  const { generateWithModel } = await import('../apps/api/src/services/aiInterpretation/claudeClient.js');
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
    console.error(`No fixture named "${ONLY_FIXTURE}". Have: ${FIXTURES.map((f) => f.id).join(', ')}`);
    process.exit(1);
  }
  for (const fixture of selected) {
    try {
      const { score, promptVersion: version } = await scoreFixture(provider, judgeProvider, fixture);
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
  if (process.env.EVAL_AGENT !== '0') {
    console.log(`\nAgent arm (v1-agent, record_proposal tool) x ${SAMPLES} samples...`);
    for (const fixture of selected) {
      try {
        agentResults.push(await scoreAgentFixture(judgeProvider, fixture));
      } catch (err) {
        console.error(`  ${fixture.id} agent arm failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  if (results.length === 0) {
    console.error('FAIL: no fixtures were scored');
    mkdirSync(dirname(MARKER_PATH), { recursive: true });
    writeFileSync(
      MARKER_PATH,
      JSON.stringify({ zeroResults: true, timestamp: new Date().toISOString(), failedFixtureIds }, null, 2) + '\n',
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
      console.error(`Failed to clear zero-results marker at ${MARKER_PATH}: ${err instanceof Error ? err.message : err}`);
    }
  }

  const aggregate = {
    faithfulness: mean(results.map((r) => r.faithfulness.mean)),
    completeness: mean(results.map((r) => r.completeness.mean)),
    legalPosture: results.every((r) => r.legalPosture.pass),
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
    judgeTemperature: 'provider default (temperature 0 requested in-prompt, not enforced at the API)',
    fixtures: results,
    aggregate,
    failedFixtureIds,
  };
  mkdirSync(dirname(SCORECARD_PATH), { recursive: true });
  writeFileSync(SCORECARD_PATH, JSON.stringify(scorecard, null, 2) + '\n');
  console.log(`\nWrote ${SCORECARD_PATH}`);

  printScorecardTable(results);

  const breaches: string[] = [];
  for (const r of results) {
    if (r.faithfulness.mean < FLOORS.faithfulness) {
      breaches.push(
        `${r.id}: faithfulness ${r.faithfulness.mean.toFixed(2)} < ${FLOORS.faithfulness}`,
      );
    }
    if (r.completeness.mean < FLOORS.completeness) {
      breaches.push(
        `${r.id}: completeness ${r.completeness.mean.toFixed(2)} < ${FLOORS.completeness}`,
      );
    }
    if (!r.legalPosture.pass) {
      breaches.push(`${r.id}: legal posture failed (${r.legalPosture.violations.join('; ')})`);
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
    console.error(`\nFAIL: ${failedFixtureIds.length} fixture(s) errored: ${failedFixtureIds.join(', ')}`);
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
