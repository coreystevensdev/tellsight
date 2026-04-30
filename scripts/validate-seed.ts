/**
 * Seed validation, Stage 3 of the CI pipeline.
 *
 * Runs the curation pipeline against synthetic seed data and validates
 * deterministic output via snapshot comparison. Catches drift in seed data,
 * scoring weights, or prompt templates without calling the LLM.
 *
 * Snapshot workflow:
 *   First run:  auto-generates snapshot, prints "commit this file"
 *   Normal run: compares against stored snapshot, fails on mismatch
 *   --update:   overwrites snapshot with current output
 *
 * Run: pnpm -C apps/api exec tsx ../../scripts/validate-seed.ts [--update]
 *
 * Note: console.log/error used intentionally, this is a standalone CI script,
 * not application code. The project's Pino logging rule applies to apps/ only.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeStats } from '../apps/api/src/services/curation/computation.js';
import { scoreInsights } from '../apps/api/src/services/curation/scoring.js';
import { assemblePrompt } from '../apps/api/src/services/curation/assembly.js';
import { StatType } from '../apps/api/src/services/curation/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(__dirname, '__snapshots__', 'seed-validation.snap.json');
const shouldUpdate = process.argv.includes('--update');

function buildValidationRows() {
  const months = Array.from({ length: 12 }, (_, i) => i);
  const rows: Array<{
    category: string;
    parentCategory: string;
    date: Date;
    amount: string;
    label: string | null;
  }> = [];

  for (const m of months) {
    const date = new Date(Date.UTC(2025, m, 15));

    const revenue = m === 11 ? '28000.00' : lerp('12000.00', '18000.00', m);
    rows.push({ category: 'Revenue', parentCategory: 'Income', date, amount: revenue, label: null });

    const payroll = m === 9 ? '9200.00' : lerp('5500.00', '6500.00', m);
    rows.push({ category: 'Payroll', parentCategory: 'Expenses', date, amount: payroll, label: null });

    const isQ3 = m >= 6 && m <= 8;
    const marketing = isQ3 ? lerp('200.00', '300.00', m - 6) : lerp('800.00', '1200.00', m);
    rows.push({ category: 'Marketing', parentCategory: 'Expenses', date, amount: marketing, label: null });

    rows.push({ category: 'Rent', parentCategory: 'Expenses', date, amount: '3000.00', label: null });
    rows.push({ category: 'Supplies', parentCategory: 'Expenses', date, amount: lerp('1500.00', '2500.00', m), label: null });
    rows.push({ category: 'Utilities', parentCategory: 'Expenses', date, amount: lerp('600.00', '400.00', m), label: null });
  }

  return rows;
}

function lerp(minVal: string, maxVal: string, monthIndex: number): string {
  const lo = parseFloat(minVal);
  const hi = parseFloat(maxVal);
  const t = monthIndex / 11;
  return (lo + (hi - lo) * t).toFixed(2);
}

// Intentionally NOT extending TransparencyMetadata from types.ts:
// - drops `generatedAt` (non-deterministic, would break every snapshot)
// - adds `promptLength` + `promptHash` (detect template drift without storing the raw prompt)
interface Snapshot {
  statTypes: string[];
  categoryCount: number;
  insightCount: number;
  scoringWeights: { novelty: number; actionability: number; specificity: number };
  promptVersion: string;
  promptLength: number;
  promptHash: string;
}

function roundWeights(w: { novelty: number; actionability: number; specificity: number }) {
  return {
    novelty: round4(w.novelty),
    actionability: round4(w.actionability),
    specificity: round4(w.specificity),
  };
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function buildSnapshot(prompt: string, metadata: {
  statTypes: string[];
  categoryCount: number;
  insightCount: number;
  scoringWeights: { novelty: number; actionability: number; specificity: number };
  promptVersion: string;
}): Snapshot {
  const hash = createHash('sha256').update(prompt).digest('hex');
  return {
    statTypes: [...metadata.statTypes].sort(),
    categoryCount: metadata.categoryCount,
    insightCount: metadata.insightCount,
    scoringWeights: roundWeights(metadata.scoringWeights),
    promptVersion: metadata.promptVersion,
    promptLength: prompt.length,
    promptHash: hash,
  };
}

function writeSnapshot(snap: Snapshot) {
  const dir = dirname(SNAPSHOT_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snap, null, 2) + '\n');
}

function diffSnapshots(expected: Snapshot, actual: Snapshot): string[] {
  const diffs: string[] = [];
  const keys = Object.keys(expected) as (keyof Snapshot)[];

  for (const key of keys) {
    const exp = JSON.stringify(expected[key]);
    const act = JSON.stringify(actual[key]);
    if (exp !== act) {
      diffs.push(`  ${key}:\n    expected: ${exp}\n    actual:   ${act}`);
    }
  }

  return diffs;
}

const ALL_STAT_TYPES = new Set(Object.values(StatType));

function validate() {
  const rows = buildValidationRows();
  console.log(`Built ${rows.length} validation rows across ${new Set(rows.map(r => r.category)).size} categories`);

  // phase 1: pipeline guard rails (existing pass/fail checks)
  const stats = computeStats(rows, { trendMinPoints: 3 });
  if (stats.length === 0) {
    console.error('FAIL: computeStats returned 0 stats');
    process.exit(1);
  }
  console.log(`computeStats produced ${stats.length} stats`);

  const scored = scoreInsights(stats);
  if (scored.length === 0) {
    console.error('FAIL: scoreInsights returned 0 insights');
    process.exit(1);
  }
  console.log(`scoreInsights produced ${scored.length} ranked insights`);

  // Freeze the date so the snapshot stays deterministic. Otherwise the
  // `{{today}}` placeholder in the prompt template rolls over at UTC midnight
  // and the hash drifts. Same posture as any other snapshot test, inputs
  // are fixed, output is fixed. Real runtime uses `new Date()` by default.
  const FROZEN_NOW = new Date('2026-01-15T12:00:00Z');
  const { system, user, metadata } = assemblePrompt(scored, undefined, undefined, FROZEN_NOW);
  // assemblePrompt now returns { system, user } (cacheable + variable). Snapshot
  // hashes the canonical "what Claude sees", same join the dropped `.prompt`
  // back-compat field used, so existing snapshots stay valid across the split.
  const prompt = system ? `${system}\n\n${user}` : user;
  if (!prompt || prompt.length === 0) {
    console.error('FAIL: assemblePrompt returned empty prompt');
    process.exit(1);
  }
  console.log(`assemblePrompt produced ${prompt.length}-char prompt`);

  const presentTypes = new Set(metadata.statTypes);
  const validTypes = [...presentTypes].filter(t => ALL_STAT_TYPES.has(t as StatType));

  if (validTypes.length < 2) {
    console.error(`FAIL: expected 2+ distinct stat types, got ${validTypes.length}: [${validTypes.join(', ')}]`);
    process.exit(1);
  }

  console.log(`\nPASS (guards): ${validTypes.length} distinct stat types: [${validTypes.join(', ')}]`);

  // phase 2: anomaly-specific assertions. Tracks the seed fixture through scoring
  //, December revenue spike + October payroll drive the anomalies; 12 months of
  // revenue-vs-expense drives margin_trend; per-category series drives trend.
  // category_breakdown no longer makes top-N once trend + margin_trend land in the
  // mix (pre-Epic-8 snapshot pre-dated that scoring reshuffle).
  assertStatType(metadata.statTypes, 'anomaly', 'December revenue spike + October payroll');
  assertStatType(metadata.statTypes, 'trend', 'revenue growth + marketing patterns');
  assertStatType(metadata.statTypes, 'margin_trend', '12 months of income + expenses');

  if (metadata.insightCount < 3) {
    console.error(`FAIL: expected insightCount >= 3, got ${metadata.insightCount}`);
    process.exit(1);
  }

  // categoryCount reflects curated insights (top-N scoring), not raw data categories.
  // Top-N for this fixture is 2 anomalies + 5 trends + 1 margin_trend = 5 distinct
  // categories once margin_trend (null category) is excluded.
  if (metadata.categoryCount < 4) {
    console.error(`FAIL: expected categoryCount >= 4, got ${metadata.categoryCount}`);
    process.exit(1);
  }

  console.log(`PASS (anomaly assertions): all expected stat types present, ${metadata.categoryCount} categories, ${metadata.insightCount} insights`);

  // phase 3: snapshot comparison
  const actual = buildSnapshot(prompt, metadata);

  if (shouldUpdate) {
    writeSnapshot(actual);
    console.log(`\nSnapshot updated: ${SNAPSHOT_PATH}`);
    console.log('Commit the updated snapshot file.');
    return;
  }

  if (!existsSync(SNAPSHOT_PATH)) {
    writeSnapshot(actual);
    console.log(`\nSnapshot created: ${SNAPSHOT_PATH}`);
    console.log('Commit this file, subsequent runs will compare against it.');
    return;
  }

  const expected: Snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8'));
  const diffs = diffSnapshots(expected, actual);

  if (diffs.length > 0) {
    console.error('\nFAIL: snapshot mismatch\n');
    console.error(diffs.join('\n\n'));
    console.error(`\nIf this change is intentional, run with --update to regenerate the snapshot:`);
    console.error(`  pnpm -C apps/api exec tsx ../../scripts/validate-seed.ts --update`);
    process.exit(1);
  }

  console.log('\nPASS (snapshot): pipeline output matches stored snapshot');
  console.log(`Metadata: ${metadata.insightCount} insights, ${metadata.categoryCount} categories, prompt version ${metadata.promptVersion}`);
}

function assertStatType(types: string[], expected: string, reason: string) {
  if (!types.includes(expected)) {
    console.error(`FAIL: expected statTypes to include '${expected}' (${reason}), got: [${types.join(', ')}]`);
    process.exit(1);
  }
}

validate();
