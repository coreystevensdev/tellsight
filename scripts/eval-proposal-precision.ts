/**
 * Proposal-precision eval.
 *
 * The agent's needs_approval lane has never been measured against a ground
 * truth. This runs routeProposal() (packages/shared/src/agent/gate.ts) over
 * a hand-labeled fixture set and computes precision: of the fixtures the
 * gate actually routes to needs_approval, what share were labeled worth a
 * human's click. No LLM call, no DB, fully deterministic.
 *
 * Snapshot workflow (mirrors validate-seed.ts):
 *   First run:  auto-generates snapshot, prints "commit this file"
 *   Normal run: fails only if aggregate precision drops below the snapshot
 *   --update:   overwrites snapshot with current output
 *
 * Run: pnpm eval:proposals (or: pnpm -C apps/api exec tsx ../../scripts/eval-proposal-precision.ts [--update])
 *
 * console.log/error used intentionally, this is a standalone CI script, not
 * application code; the project's Pino logging rule applies to apps/ only.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { routeProposal, type GateConfig, type GateContext, type GateLane } from '../packages/shared/src/agent/gate.js';
import { PROPOSAL_FIXTURES } from './eval-fixtures/proposal-fixtures.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(__dirname, '__snapshots__', 'proposal-precision.snap.json');
const shouldUpdate = process.argv.includes('--update');

// Same reference config gate.test.ts uses; this eval scores the gate's
// behavior, not a specific org's tuning of it.
const cfg: GateConfig = { approvalThreshold: 1000, minConfidence: 0.6, suppressSeenDays: 14 };

interface FixtureResult {
  id: string;
  label: string;
  lane: GateLane;
  expectedWorthApproval: boolean;
  countsTowardPrecision: boolean;
}

interface Snapshot {
  precision: number;
  needsApprovalCount: number;
  correctCount: number;
  // Which specific fixtures counted as correct, not just how many. Aggregate
  // counts alone can't catch a same-size swap (fixture A goes wrong while
  // fixture B goes right) since precision and correctCount stay identical.
  correctFixtureIds: string[];
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function routeFixtures(): FixtureResult[] {
  const ctx: GateContext = {
    recentDedupKeys: new Set(PROPOSAL_FIXTURES.filter((f) => f.seedDedup).map((f) => f.proposal.dedupKey)),
  };

  return PROPOSAL_FIXTURES.map((f) => {
    const decision = routeProposal(f.proposal, cfg, ctx);
    return {
      id: f.id,
      label: f.label,
      lane: decision.lane,
      expectedWorthApproval: f.expectedWorthApproval,
      countsTowardPrecision: decision.lane === 'needs_approval',
    };
  });
}

function printScorecardTable(results: FixtureResult[]): void {
  console.log('\n| Fixture | Label | Lane | Worth approval | Precision |');
  console.log('|---|---|---|---|---|');
  for (const r of results) {
    const contribution = r.countsTowardPrecision
      ? r.expectedWorthApproval
        ? 'counted, correct'
        : 'counted, false positive'
      : 'excluded (not needs_approval)';
    console.log(`| ${r.id} | ${r.label} | ${r.lane} | ${r.expectedWorthApproval} | ${contribution} |`);
  }
}

function writeSnapshot(snap: Snapshot): void {
  const dir = dirname(SNAPSHOT_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snap, null, 2) + '\n');
}

function evaluate(): void {
  const results = routeFixtures();
  printScorecardTable(results);

  const needsApproval = results.filter((r) => r.countsTowardPrecision);

  // An emptied needs_approval lane must fail loudly, not silently report an
  // undefined or vacuous 100% precision.
  if (needsApproval.length === 0) {
    console.error('\nFAIL: zero fixtures routed to needs_approval, precision is undefined');
    process.exit(1);
  }

  const correctFixtureIds = needsApproval.filter((r) => r.expectedWorthApproval).map((r) => r.id).sort();
  const correctCount = correctFixtureIds.length;
  const precision = round4(correctCount / needsApproval.length);

  console.log(
    `\nPrecision (needs_approval): ${precision} (${correctCount}/${needsApproval.length} fixtures worth approval)`,
  );

  const actual: Snapshot = { precision, needsApprovalCount: needsApproval.length, correctCount, correctFixtureIds };

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

  let baseline: Snapshot;
  try {
    baseline = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8'));
  } catch (err) {
    console.error(`\nFAIL: ${SNAPSHOT_PATH} is not valid JSON (${(err as Error).message})`);
    console.error('Run with --update to regenerate it from the current fixture set.');
    process.exit(1);
  }

  if (
    typeof baseline.precision !== 'number' ||
    typeof baseline.needsApprovalCount !== 'number' ||
    typeof baseline.correctCount !== 'number' ||
    !Array.isArray(baseline.correctFixtureIds)
  ) {
    console.error(
      `\nFAIL: ${SNAPSHOT_PATH} is malformed, expected numeric precision/needsApprovalCount/correctCount plus a correctFixtureIds array`,
    );
    console.error('Run with --update to regenerate it from the current fixture set.');
    process.exit(1);
  }

  if (actual.precision < baseline.precision) {
    console.error(
      `\nFAIL: precision regressed, ${actual.precision} < baseline ${baseline.precision} (delta ${round4(actual.precision - baseline.precision)})`,
    );
    console.error('If this drop is intentional, run with --update to regenerate the snapshot:');
    console.error('  pnpm -C apps/api exec tsx ../../scripts/eval-proposal-precision.ts --update');
    process.exit(1);
  }

  // A shrinking needs_approval lane can hold precision steady (or raise it)
  // while masking a real drop in coverage, so a shrinking sample also fails.
  if (actual.needsApprovalCount < baseline.needsApprovalCount) {
    console.error(
      `\nFAIL: needs_approval sample shrank, ${actual.needsApprovalCount} < baseline ${baseline.needsApprovalCount} fixtures (precision alone can't catch this)`,
    );
    console.error('If this drop is intentional, run with --update to regenerate the snapshot:');
    console.error('  pnpm -C apps/api exec tsx ../../scripts/eval-proposal-precision.ts --update');
    process.exit(1);
  }

  // Precision and needsApprovalCount can hold steady while the gate gets a
  // different fixture right in exchange for one it used to get right, e.g. a
  // rule change that swaps which fixture the "false positive" is. Neither
  // aggregate number moves, so this checks fixture identity directly.
  const flipped = baseline.correctFixtureIds.filter((id: string) => !actual.correctFixtureIds.includes(id));
  if (flipped.length > 0) {
    console.error(
      `\nFAIL: fixture(s) previously correct in needs_approval no longer are: ${flipped.join(', ')} (aggregate precision/count can mask this if a different fixture became correct)`,
    );
    console.error('If this is intentional, run with --update to regenerate the snapshot:');
    console.error('  pnpm -C apps/api exec tsx ../../scripts/eval-proposal-precision.ts --update');
    process.exit(1);
  }

  console.log(`\nPASS: precision ${actual.precision} meets or exceeds baseline ${baseline.precision}`);
}

evaluate();
