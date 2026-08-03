// Pure decision logic for eval-proposal-precision.ts, split out so it can be
// unit tested without touching the filesystem or process.exit. The CLI shell
// stays responsible for file I/O, --update, and printing these messages.

import { round4 } from '../round4.js';

export interface PrecisionFixtureVerdict {
  id: string;
  expectedWorthApproval: boolean;
  countsTowardPrecision: boolean;
}

export interface PrecisionSnapshot {
  precision: number;
  needsApprovalCount: number;
  correctCount: number;
  // Which specific fixtures counted as correct, not just how many. Aggregate
  // counts alone can't catch a same-size swap (fixture A goes wrong while
  // fixture B goes right) since precision and correctCount stay identical.
  correctFixtureIds: string[];
}

export function summarizePrecision(results: PrecisionFixtureVerdict[]): PrecisionSnapshot | null {
  const needsApproval = results.filter((r) => r.countsTowardPrecision);
  if (needsApproval.length === 0) return null;

  // Dedupe before deriving correctCount, two fixtures sharing an id would
  // otherwise double-count and inflate precision.
  const correctFixtureIds = [
    ...new Set(needsApproval.filter((r) => r.expectedWorthApproval).map((r) => r.id)),
  ].sort();
  const correctCount = correctFixtureIds.length;
  const precision = round4(correctCount / needsApproval.length);

  return { precision, needsApprovalCount: needsApproval.length, correctCount, correctFixtureIds };
}

export function isPrecisionSnapshot(value: unknown): value is PrecisionSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (
    typeof v.precision !== 'number' ||
    typeof v.needsApprovalCount !== 'number' ||
    typeof v.correctCount !== 'number' ||
    !Array.isArray(v.correctFixtureIds) ||
    !v.correctFixtureIds.every((id) => typeof id === 'string')
  ) {
    return false;
  }

  return (
    Number.isInteger(v.needsApprovalCount) &&
    Number.isInteger(v.correctCount) &&
    // summarizePrecision returns null (never a snapshot) once needsApproval
    // is empty, so a written snapshot never has needsApprovalCount 0.
    v.needsApprovalCount >= 1 &&
    v.correctCount >= 0 &&
    v.correctCount <= v.needsApprovalCount &&
    v.precision >= 0 &&
    v.precision <= 1 &&
    v.correctFixtureIds.length === v.correctCount &&
    new Set(v.correctFixtureIds).size === v.correctFixtureIds.length
  );
}

export function checkAgainstBaseline(
  actual: PrecisionSnapshot,
  baseline: PrecisionSnapshot,
): { ok: true } | { ok: false; messages: string[] } {
  if (actual.precision < baseline.precision) {
    return {
      ok: false,
      messages: [
        `\nFAIL: precision regressed, ${actual.precision} < baseline ${baseline.precision} (delta ${round4(actual.precision - baseline.precision)})`,
        'If this drop is intentional, run with --update to regenerate the snapshot:',
        '  pnpm -C apps/api exec tsx ../../scripts/eval-proposal-precision.ts --update',
      ],
    };
  }

  // A shrinking needs_approval lane can hold precision steady (or raise it)
  // while masking a real drop in coverage, so a shrinking sample also fails.
  if (actual.needsApprovalCount < baseline.needsApprovalCount) {
    return {
      ok: false,
      messages: [
        `\nFAIL: needs_approval sample shrank, ${actual.needsApprovalCount} < baseline ${baseline.needsApprovalCount} fixtures (precision alone can't catch this)`,
        'If this drop is intentional, run with --update to regenerate the snapshot:',
        '  pnpm -C apps/api exec tsx ../../scripts/eval-proposal-precision.ts --update',
      ],
    };
  }

  // Precision and needsApprovalCount can hold steady while the gate gets a
  // different fixture right in exchange for one it used to get right, e.g. a
  // rule change that swaps which fixture the "false positive" is. Neither
  // aggregate number moves, so this checks fixture identity directly.
  const flipped = baseline.correctFixtureIds.filter((id) => !actual.correctFixtureIds.includes(id));
  if (flipped.length > 0) {
    return {
      ok: false,
      messages: [
        `\nFAIL: fixture(s) previously correct in needs_approval no longer are: ${flipped.join(', ')} (aggregate precision/count can mask this if a different fixture became correct)`,
        'If this is intentional, run with --update to regenerate the snapshot:',
        '  pnpm -C apps/api exec tsx ../../scripts/eval-proposal-precision.ts --update',
      ],
    };
  }

  return { ok: true };
}
