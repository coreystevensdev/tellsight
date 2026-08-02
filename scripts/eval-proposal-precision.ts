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
import {
  checkAgainstBaseline,
  isPrecisionSnapshot,
  summarizePrecision,
  type PrecisionSnapshot,
} from './eval-fixtures/proposal-precision-check.js';

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

function writeSnapshot(snap: PrecisionSnapshot): void {
  const dir = dirname(SNAPSHOT_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snap, null, 2) + '\n');
}

function evaluate(): void {
  const results = routeFixtures();
  printScorecardTable(results);

  // An emptied needs_approval lane must fail loudly, not silently report an
  // undefined or vacuous 100% precision.
  const actual = summarizePrecision(results);
  if (actual === null) {
    console.error('\nFAIL: zero fixtures routed to needs_approval, precision is undefined');
    process.exit(1);
  }

  console.log(
    `\nPrecision (needs_approval): ${actual.precision} (${actual.correctCount}/${actual.needsApprovalCount} fixtures worth approval)`,
  );

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

  let baseline: unknown;
  try {
    baseline = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8'));
  } catch (err) {
    console.error(`\nFAIL: ${SNAPSHOT_PATH} is not valid JSON (${(err as Error).message})`);
    console.error('Run with --update to regenerate it from the current fixture set.');
    process.exit(1);
  }

  if (!isPrecisionSnapshot(baseline)) {
    console.error(
      `\nFAIL: ${SNAPSHOT_PATH} is malformed, expected numeric precision/needsApprovalCount/correctCount plus a correctFixtureIds array`,
    );
    console.error('Run with --update to regenerate it from the current fixture set.');
    process.exit(1);
  }

  const verdict = checkAgainstBaseline(actual, baseline);
  if (!verdict.ok) {
    verdict.messages.forEach((message) => console.error(message));
    process.exit(1);
  }

  console.log(`\nPASS: precision ${actual.precision} meets or exceeds baseline ${baseline.precision}`);
}

evaluate();
