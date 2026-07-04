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

import { mkdirSync, writeFileSync } from 'node:fs';
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
import { faithfulnessJudge, completenessJudge } from './eval-fixtures/judge-prompts.js';
import { scoreLegalPosture } from './eval-fixtures/legal-posture.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCORECARD_PATH = resolve(__dirname, 'eval-fixtures', 'scorecard.json');

// Freeze the date so the {{today}} placeholder doesn't drift the prompt between
// runs, same posture as validate-seed.ts:161.
const FROZEN_NOW = new Date('2026-01-15T12:00:00Z');
const SAMPLES = 3;

// Only the initial value of the reported version; the real one is read back from
// assemblePrompt's metadata per fixture, so a default-version bump can't leave the
// scorecard lying about which prompt was scored.
const DEFAULT_PROMPT_VERSION = 'v1.6';

// Floors apply to the mean (the number that lands in the README). Legal posture
// is a floor of its own: it must pass on every sample, not on average.
const FLOORS = { faithfulness: 0.85, completeness: 0.8 };

// The statSummaries block sits between these two anchors in the rendered v1.6
// user prompt. Slicing it out gives the exact bytes the model received as ground
// truth, with no need to re-implement or export assembly's formatStat.
const SUMMARIES_START = "computed from the business's uploaded data:\n\n";
const SUMMARIES_END = '\n\n**Data lineage:**';

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

interface SampleScore {
  faithfulness: number;
  completeness: number;
  legalPass: boolean;
  legalViolations: string[];
}

interface FixtureScore {
  id: string;
  label: string;
  faithfulness: { mean: number; min: number };
  completeness: { mean: number; min: number };
  legalPosture: { pass: boolean; violations: string[] };
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

function parseJudge<T>(raw: string, schema: z.ZodType<T>, ctx: string): T {
  // Judges are told to emit bare JSON, but strip a stray ```json fence just in case.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`${ctx} judge returned non-JSON: ${raw.slice(0, 200)}`);
  }
  return schema.parse(parsed);
}

async function scoreFaithfulness(
  provider: LlmProvider,
  groundTruth: string,
  summary: string,
): Promise<number> {
  const raw = await provider.generate(faithfulnessJudge(groundTruth, summary));
  const { claims } = parseJudge(raw, faithfulnessSchema, 'faithfulness');
  if (claims.length === 0) return 1; // nothing checkable means nothing unfaithful
  const honest = claims.filter((c) => c.label !== 'unsupported').length;
  return honest / claims.length;
}

async function scoreCompleteness(
  provider: LlmProvider,
  answerKey: StatType[],
  summary: string,
): Promise<number> {
  const raw = await provider.generate(completenessJudge(answerKey, summary));
  const { items } = parseJudge(raw, completenessSchema, 'completeness');

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

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function printScorecardTable(rows: FixtureScore[]): void {
  console.log('\n| Fixture | Faithfulness | Completeness | Legal posture |');
  console.log('|---|---|---|---|');
  for (const r of rows) {
    const f = `${r.faithfulness.mean.toFixed(2)} (min ${r.faithfulness.min.toFixed(2)})`;
    const c = `${r.completeness.mean.toFixed(2)} (min ${r.completeness.min.toFixed(2)})`;
    console.log(`| ${r.id} | ${f} | ${c} | ${r.legalPosture.pass ? 'pass' : 'FAIL'} |`);
  }
}

async function scoreFixture(
  provider: LlmProvider,
  fixture: (typeof FIXTURES)[number],
): Promise<{ score: FixtureScore; promptVersion: string }> {
  const scored = scoreInsights(fixture.build());
  const { system, user, metadata } = assemblePrompt(scored, undefined, undefined, FROZEN_NOW);
  const groundTruth = extractStatSummaries(user);

  const samples: SampleScore[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const summary = await provider.generate({ system, user });
    const [faithfulness, completeness] = await Promise.all([
      scoreFaithfulness(provider, groundTruth, summary),
      scoreCompleteness(provider, fixture.answerKey, summary),
    ]);
    const legal = scoreLegalPosture(summary);
    samples.push({
      faithfulness,
      completeness,
      legalPass: legal.pass,
      legalViolations: legal.violations,
    });
    console.log(
      `  ${fixture.id} sample ${i + 1}/${SAMPLES}: faith ${faithfulness.toFixed(2)}, comp ${completeness.toFixed(2)}, legal ${legal.pass ? 'pass' : 'FAIL'}`,
    );
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

  console.log(`Running ${FIXTURES.length} fixtures x ${SAMPLES} samples...`);
  const results: FixtureScore[] = [];
  let promptVersion = DEFAULT_PROMPT_VERSION;
  for (const fixture of FIXTURES) {
    const { score, promptVersion: version } = await scoreFixture(provider, fixture);
    promptVersion = version;
    results.push(score);
  }

  const aggregate = {
    faithfulness: mean(results.map((r) => r.faithfulness.mean)),
    completeness: mean(results.map((r) => r.completeness.mean)),
    legalPosture: results.every((r) => r.legalPosture.pass),
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

  if (breaches.length > 0) {
    console.error('\nFAIL: floor breaches');
    for (const b of breaches) console.error(`  ${b}`);
    process.exit(1);
  }

  console.log('\nPASS: all fixtures meet the floors');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
