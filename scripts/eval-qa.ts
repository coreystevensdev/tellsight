/**
 * Lookup-vs-interpretation eval, NFR-13.3's gating scorer.
 *
 * The Q&A tool shape biases answers toward interpretation over bare numbers,
 * but nothing enforces it. This grades a small hand-labeled set of Q&A
 * answers as "interpretive" or "lookup" using an LLM judge, backed by a
 * deterministic no-figure guard so verbose padding can't fake its way to a
 * pass. It does not run the real runQaLoop, its tool dispatch is hardcoded to
 * live DB-backed functions with no fixture-injection seam, so fixture answers
 * are hand-authored instead.
 *
 * Run: pnpm eval:qa  (from the repo root; loads .env, then runs this via tsx)
 * Needs a real CLAUDE_API_KEY. Costs tokens (8 fixtures x 3 samples, judge only).
 *
 * console.log/error is intentional, this is a standalone script, not app code;
 * the Pino rule applies to apps/ only (same posture as eval-summaries.ts).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import type { LlmProvider } from '../apps/api/src/services/aiInterpretation/provider.js';
import { QA_FIXTURES, type QaEvalFixture } from './eval-fixtures/qa-fixtures.js';
import { interpretationJudge } from './eval-fixtures/judge-prompts.js';
import { hasNumericFigure } from './eval-fixtures/interpretation-guard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(__dirname, '__snapshots__', 'qa-interpretation.snap.json');

const SAMPLES = 3;
const FLOOR = 0.85;

const verdictSchema = z.object({
  verdict: z.enum(['interpretive', 'lookup']),
  reason: z.string().optional(),
});

interface FixtureScore {
  id: string;
  label: string;
  expectedVerdict: 'interpretive' | 'lookup';
  accuracy: number;
  overrideCount: number;
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
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${ctx} judge returned unexpected shape (${result.error.message}): ${raw.slice(0, 200)}`);
  }
  return result.data;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

async function scoreFixture(provider: LlmProvider, fixture: QaEvalFixture): Promise<FixtureScore> {
  // Guard runs once, the fixture's answer text is fixed across samples; only
  // the judge call is resampled to average out judge variance.
  const guardAllowsInterpretive = hasNumericFigure(fixture.answer, fixture.knownFigures);

  let correctCount = 0;
  let overrideCount = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const raw = await provider.generate(interpretationJudge(fixture.question, fixture.knownFigures, fixture.answer));
    const { verdict, reason } = parseJudge(raw, verdictSchema, 'interpretation');

    const overridden = !guardAllowsInterpretive && verdict === 'interpretive';
    const finalVerdict = guardAllowsInterpretive ? verdict : 'lookup';
    const correct = finalVerdict === fixture.expectedVerdict;
    if (correct) correctCount++;
    if (overridden) overrideCount++;

    console.log(
      `  ${fixture.id} sample ${i + 1}/${SAMPLES}: judge said ${verdict}` +
        (overridden ? ' (guard overrode to lookup, no figure outside cite tags)' : '') +
        `, expected ${fixture.expectedVerdict} (${correct ? 'match' : 'MISS'})`,
    );
    // Reason is otherwise paid for and thrown away; a MISS is exactly when a
    // future maintainer will want to know what the judge was thinking.
    if (!correct && reason) console.log(`    judge reason: ${reason}`);
  }

  return {
    id: fixture.id,
    label: fixture.label,
    expectedVerdict: fixture.expectedVerdict,
    accuracy: correctCount / SAMPLES,
    overrideCount,
  };
}

function printScorecardTable(rows: FixtureScore[]): void {
  console.log('\n| Fixture | Expected | Accuracy | Guard overrides |');
  console.log('|---|---|---|---|');
  for (const r of rows) {
    console.log(`| ${r.id} | ${r.expectedVerdict} | ${r.accuracy.toFixed(2)} | ${r.overrideCount} |`);
  }
}

async function main(): Promise<void> {
  // Read process.env directly (scripts/ is exempt from the no-process.env rule)
  // and exit 0 so an unkeyed environment reads as "skipped", not "regressed".
  if (!process.env.CLAUDE_API_KEY) {
    console.error('eval:qa requires CLAUDE_API_KEY; skipping');
    process.exit(0);
  }

  // Dynamic + after the guard: importing claudeClient constructs the Anthropic
  // client from config.ts, which throws at load when the key is unset.
  await import('../apps/api/src/services/aiInterpretation/claudeClient.js');
  const { getProvider } = await import('../apps/api/src/services/aiInterpretation/provider.js');
  const provider = getProvider();

  console.log(`Running ${QA_FIXTURES.length} fixtures x ${SAMPLES} samples...`);
  const results: FixtureScore[] = [];
  const failedFixtureIds: string[] = [];
  for (const fixture of QA_FIXTURES) {
    try {
      results.push(await scoreFixture(provider, fixture));
    } catch (err) {
      failedFixtureIds.push(fixture.id);
      console.error(`  ${fixture.id} failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // mean() of an empty array is NaN, and NaN < FLOOR is false, so an emptied
  // fixture set would otherwise print PASS with a garbage snapshot instead of
  // failing loudly.
  if (results.length === 0) {
    console.error('FAIL: no fixtures were scored');
    process.exit(1);
  }

  const aggregate = mean(results.map((r) => r.accuracy));

  const snapshot = {
    floor: FLOOR,
    samplesPerFixture: SAMPLES,
    fixtures: results,
    aggregate,
    failedFixtureIds,
  };
  mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + '\n');
  console.log(`\nWrote ${SNAPSHOT_PATH}`);

  printScorecardTable(results);
  console.log(`\nAggregate accuracy: ${aggregate.toFixed(2)} (floor ${FLOOR})`);

  let failed = false;

  if (aggregate < FLOOR) {
    console.error(`\nFAIL: aggregate accuracy ${aggregate.toFixed(2)} < floor ${FLOOR}`);
    failed = true;
  }

  if (failedFixtureIds.length > 0) {
    console.error(`\nFAIL: ${failedFixtureIds.length} fixture(s) errored: ${failedFixtureIds.join(', ')}`);
    failed = true;
  }

  if (failed) process.exit(1);

  console.log('\nPASS: aggregate accuracy meets the floor');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
