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
 * Needs a real CLAUDE_API_KEY. Costs tokens (N samples x 3 fixtures x ~3 calls each).
 *
 * console.log/error is intentional, this is a standalone script, not app code;
 * the Pino rule applies to apps/ only (same posture as validate-seed.ts).
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

// These two are config-free, so they're safe at top level (validate-seed.ts
// imports the same surface and runs keyless in CI). The provider, by contrast,
// pulls in config.ts and must be imported dynamically after the key guard.
import { scoreInsights } from '../apps/api/src/services/curation/scoring.js';
import { assemblePrompt } from '../apps/api/src/services/curation/assembly.js';
import type { LlmProvider } from '../apps/api/src/services/aiInterpretation/provider.js';
import type { StatType } from '../apps/api/src/services/curation/types.js';
import { FIXTURES } from './eval-fixtures/fixtures.js';
import { faithfulnessJudge, completenessJudge, insightJudge } from './eval-fixtures/judge-prompts.js';
import { askJudge } from './eval-fixtures/parse-judge.js';
import { insightGate, INSIGHT_MISS_CEILING } from './eval-fixtures/insight-gate.js';
import { scoreLegalPosture } from './eval-fixtures/legal-posture.js';

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


// The statSummaries block sits between these two anchors in the rendered v1.6
// user prompt. Slicing it out gives the exact bytes the model received as ground
// truth, with no need to re-implement or export assembly's formatStat.
const SUMMARIES_START = "computed from the business's uploaded data:\n\n";
const SUMMARIES_END = '\n\n**Data lineage:**';

// The user prompt opens with "Today is <date>." and the model reasons from it:
// 2.4 months of runway against a dated balance becomes a calendar month in the
// summary. The ground truth handed to the faithfulness judge started at the stats
// block, so it never contained that line, and every date the model derived came
// back unsupported however correct the arithmetic was. That accounted for most of
// what the judge was flagging.
const TODAY_LINE = /^Today is .+$/m;

const faithfulnessSchema = z.object({
  claims: z.array(
    z.object({
      claim: z.string(),
      label: z.enum(['supported', 'derived', 'unsupported']),
      reason: z.string().optional(),
    }),
  ),
});

const completenessSchema = z.object({
  items: z.array(
    z.object({
      statType: z.string(),
      addressed: z.boolean(),
      evidence: z.string().optional(),
    }),
  ),
});

const insightSchema = z.object({
  insights: z.array(
    z.object({
      insight: z.string(),
      nonObvious: z.boolean(),
      actionable: z.boolean(),
      reason: z.string(),
    }),
  ),
});

interface SampleScore {
  faithfulness: number;
  completeness: number;
  legalPass: boolean;
  legalViolations: string[];
  insightPass: boolean;
  qualifyingInsight: string | null;
  insightShortfall: string[];
}

interface FixtureScore {
  id: string;
  label: string;
  faithfulness: { mean: number; min: number };
  completeness: { mean: number; min: number };
  legalPosture: { pass: boolean; violations: string[] };
  insight: { misses: number; examples: string[]; missed: string[] };
  sampledCount: number;
}

// Everything the model was given as fact, which is what "unsupported" has to be
// measured against.
function extractGroundTruth(userPrompt: string): string {
  const stats = extractStatSummaries(userPrompt);
  const today = TODAY_LINE.exec(userPrompt)?.[0];
  return today ? `${today}\n\n${stats}` : stats;
}

function extractStatSummaries(userPrompt: string): string {
  const start = userPrompt.indexOf(SUMMARIES_START);
  const end = userPrompt.indexOf(SUMMARIES_END);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      'Could not find the statSummaries block in the assembled prompt. The v1.6 ' +
        'template likely changed; update SUMMARIES_START/SUMMARIES_END in eval-summaries.ts.',
    );
  }
  return userPrompt.slice(start + SUMMARIES_START.length, end).trim();
}


async function scoreFaithfulness(
  provider: LlmProvider,
  groundTruth: string,
  summary: string,
): Promise<number> {
  const { claims } = await askJudge(
    provider,
    faithfulnessJudge(groundTruth, summary),
    faithfulnessSchema,
    'faithfulness',
  );
  if (claims.length === 0) return 1; // nothing checkable means nothing unfaithful
  const honest = claims.filter((c) => c.label !== 'unsupported').length;
  return honest / claims.length;
}

async function scoreCompleteness(
  provider: LlmProvider,
  answerKey: StatType[],
  summary: string,
): Promise<number> {
  const { items } = await askJudge(provider, completenessJudge(answerKey, summary), completenessSchema, 'completeness');

  // The judge is told to echo the exact statType literal. If it drifts (returns
  // "Cash Flow" instead of "cash_flow", or drops an item), the set lookup below
  // scores that item as not-addressed and completeness silently reads worse than
  // reality. Surface the drift so it doesn't get mistaken for a real regression.
  const keySet = new Set<string>(answerKey);
  const returned = new Set(items.map((i) => i.statType));
  const unknown = [...new Set(items.map((i) => i.statType))].filter((t) => !keySet.has(t));
  const missing = answerKey.filter((t) => !returned.has(t));
  if (unknown.length > 0) {
    console.error(`  completeness judge returned unrecognized statTypes (echo drift?): ${unknown.join(', ')}`);
  }
  if (missing.length > 0) {
    console.error(`  completeness judge omitted answer-key items: ${missing.join(', ')}`);
  }

  const addressed = new Set(items.filter((i) => i.addressed).map((i) => i.statType));
  const covered = answerKey.filter((t) => addressed.has(t)).length;
  return covered / answerKey.length;
}

// FR22 is satisfied by one insight carrying both properties, so the qualifying
// one is returned for the scorecard: a bare false is very hard to act on, and the
// quote shows whether the judge and the requirement agree about what counts.
async function scoreActionability(
  provider: LlmProvider,
  summary: string,
): Promise<{ pass: boolean; qualifying: string | null; shortfall: string[] }> {
  const { insights } = await askJudge(provider, insightJudge(summary), insightSchema, 'insight');
  const qualifying = insights.find((i) => i.nonObvious && i.actionable);
  if (qualifying) return { pass: true, qualifying: qualifying.insight, shortfall: [] };

  // On a miss the scorecard used to keep the 16 passes and drop the 4 failures,
  // which is the wrong half: an insight that scored is not evidence about the one
  // that did not. Record which property each candidate was missing.
  return {
    pass: false,
    qualifying: null,
    shortfall: insights.map(
      (i) => `[${i.nonObvious ? 'non-obvious' : 'OBVIOUS'}/${i.actionable ? 'actionable' : 'NOT actionable'}] ${i.insight} -- ${i.reason}`,
    ),
  };
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

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

async function scoreFixture(
  provider: LlmProvider,
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
        scoreFaithfulness(provider, groundTruth, summary),
        scoreCompleteness(provider, fixture.answerKey, summary),
        scoreActionability(provider, summary),
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

  const faithVals = samples.map((s) => s.faithfulness);
  const compVals = samples.map((s) => s.completeness);
  return {
    score: {
      id: fixture.id,
      label: fixture.label,
      faithfulness: { mean: mean(faithVals), min: Math.min(...faithVals) },
      completeness: { mean: mean(compVals), min: Math.min(...compVals) },
      legalPosture: {
        pass: samples.every((s) => s.legalPass),
        violations: [...new Set(samples.flatMap((s) => s.legalViolations))],
      },
      insight: {
        misses: samples.filter((s) => !s.insightPass).length,
        examples: [...new Set(samples.map((s) => s.qualifyingInsight).filter((q): q is string => q !== null))],
        missed: samples.filter((s) => !s.insightPass).flatMap((s) => s.insightShortfall),
      },
      sampledCount: samples.length,
    },
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

  // Dynamic + after the guard: importing claudeClient registers the provider as a
  // module side effect, but it also constructs the Anthropic client from config.ts,
  // which throws at load when the key is unset. Static-importing it would crash
  // before the guard could skip cleanly.
  await import('../apps/api/src/services/aiInterpretation/claudeClient.js');
  const { getProvider } = await import('../apps/api/src/services/aiInterpretation/provider.js');
  const provider = getProvider();

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
      const { score, promptVersion: version } = await scoreFixture(provider, fixture);
      promptVersion = version;
      results.push(score);
    } catch (err) {
      failedFixtureIds.push(fixture.id);
      console.error(`  ${fixture.id} failed: ${err instanceof Error ? err.message : err}`);
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
