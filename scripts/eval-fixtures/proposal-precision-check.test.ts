import { describe, it, expect } from 'vitest';

import { round4 } from '../round4.js';
import {
  checkAgainstBaseline,
  isPrecisionSnapshot,
  summarizePrecision,
  type PrecisionFixtureVerdict,
  type PrecisionSnapshot,
} from './proposal-precision-check.js';

describe('summarizePrecision', () => {
  it('returns null when every fixture routes outside needs_approval', () => {
    const results: PrecisionFixtureVerdict[] = [
      { id: 'a', expectedWorthApproval: true, countsTowardPrecision: false },
      { id: 'b', expectedWorthApproval: false, countsTowardPrecision: false },
    ];
    expect(summarizePrecision(results)).toBeNull();
  });

  it('computes precision, correctCount, and correctFixtureIds for a mixed set', () => {
    const results: PrecisionFixtureVerdict[] = [
      { id: 'tp-1', expectedWorthApproval: true, countsTowardPrecision: true },
      { id: 'fp-1', expectedWorthApproval: false, countsTowardPrecision: true },
      { id: 'tp-2', expectedWorthApproval: true, countsTowardPrecision: true },
      { id: 'excluded', expectedWorthApproval: true, countsTowardPrecision: false },
    ];
    expect(summarizePrecision(results)).toEqual({
      precision: 0.6667,
      needsApprovalCount: 3,
      correctCount: 2,
      correctFixtureIds: ['tp-1', 'tp-2'],
    });
  });

  it('dedupes a fixture id that appears twice instead of double-counting it', () => {
    const results: PrecisionFixtureVerdict[] = [
      { id: 'dup', expectedWorthApproval: true, countsTowardPrecision: true },
      { id: 'dup', expectedWorthApproval: true, countsTowardPrecision: true },
      { id: 'fp-1', expectedWorthApproval: false, countsTowardPrecision: true },
    ];
    const snapshot = summarizePrecision(results);
    expect(snapshot?.correctFixtureIds).toEqual(['dup']);
    expect(snapshot?.correctCount).toBe(1);
    // needsApprovalCount stays the raw verdict count (not deduped), so a
    // duplicate id can only pull precision down, never inflate it.
    expect(snapshot?.needsApprovalCount).toBe(3);
    expect(snapshot?.precision).toBe(round4(1 / 3));
  });
});

describe('isPrecisionSnapshot', () => {
  const valid: PrecisionSnapshot = {
    precision: 0.75,
    needsApprovalCount: 4,
    correctCount: 3,
    correctFixtureIds: ['a', 'b', 'c'],
  };

  it('accepts a well-formed snapshot', () => {
    expect(isPrecisionSnapshot(valid)).toBe(true);
  });

  it('rejects null', () => {
    expect(isPrecisionSnapshot(null)).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(isPrecisionSnapshot('not a snapshot')).toBe(false);
  });

  it('rejects a missing field', () => {
    const { correctCount, ...rest } = valid;
    expect(isPrecisionSnapshot(rest)).toBe(false);
  });

  it('rejects a wrong-typed field', () => {
    expect(isPrecisionSnapshot({ ...valid, precision: '0.75' })).toBe(false);
  });

  it('rejects a non-array correctFixtureIds', () => {
    expect(isPrecisionSnapshot({ ...valid, correctFixtureIds: 'a,b,c' })).toBe(false);
  });

  it('rejects a non-string element in correctFixtureIds', () => {
    expect(isPrecisionSnapshot({ ...valid, correctFixtureIds: ['a', 1, 'c'] })).toBe(false);
  });

  it('rejects correctCount exceeding needsApprovalCount', () => {
    expect(isPrecisionSnapshot({ ...valid, needsApprovalCount: 2, correctCount: 3 })).toBe(false);
  });

  it('rejects precision below 0', () => {
    expect(isPrecisionSnapshot({ ...valid, precision: -0.1 })).toBe(false);
  });

  it('rejects precision above 1', () => {
    expect(isPrecisionSnapshot({ ...valid, precision: 1.2 })).toBe(false);
  });

  it('rejects correctFixtureIds.length not matching correctCount', () => {
    expect(isPrecisionSnapshot({ ...valid, correctCount: 2, correctFixtureIds: ['a'] })).toBe(false);
  });

  it('rejects a duplicate id inside correctFixtureIds', () => {
    expect(isPrecisionSnapshot({ ...valid, correctCount: 2, correctFixtureIds: ['a', 'a'] })).toBe(false);
  });

  it('rejects needsApprovalCount of 0', () => {
    expect(
      isPrecisionSnapshot({ precision: 0, needsApprovalCount: 0, correctCount: 0, correctFixtureIds: [] }),
    ).toBe(false);
  });

  it('rejects a negative needsApprovalCount', () => {
    expect(isPrecisionSnapshot({ ...valid, needsApprovalCount: -1 })).toBe(false);
  });

  it('rejects a negative correctCount', () => {
    expect(isPrecisionSnapshot({ ...valid, correctCount: -1 })).toBe(false);
  });

  it('rejects a fractional needsApprovalCount', () => {
    expect(isPrecisionSnapshot({ ...valid, needsApprovalCount: 4.5 })).toBe(false);
  });

  it('rejects a fractional correctCount', () => {
    expect(isPrecisionSnapshot({ ...valid, correctCount: 3.5 })).toBe(false);
  });
});

describe('checkAgainstBaseline', () => {
  const baseline: PrecisionSnapshot = {
    precision: 0.75,
    needsApprovalCount: 4,
    correctCount: 3,
    correctFixtureIds: ['a', 'b', 'c'],
  };

  it('passes when precision, count, and fixture identity all hold', () => {
    expect(checkAgainstBaseline({ ...baseline }, baseline)).toEqual({ ok: true });
  });

  it('passes when precision improves', () => {
    const actual: PrecisionSnapshot = { ...baseline, precision: 1, correctCount: 4 };
    expect(checkAgainstBaseline(actual, baseline)).toEqual({ ok: true });
  });

  it('fails when precision regresses', () => {
    const actual: PrecisionSnapshot = { ...baseline, precision: 0.5, correctCount: 2, correctFixtureIds: ['a', 'b'] };
    const verdict = checkAgainstBaseline(actual, baseline);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.messages[0]).toContain('precision regressed');
    expect(verdict.messages[0]).toContain('0.5 < baseline 0.75');
  });

  it('fails when the needs_approval sample shrinks even with precision holding steady or higher', () => {
    const actual: PrecisionSnapshot = {
      ...baseline,
      needsApprovalCount: 2,
      correctCount: 2,
      correctFixtureIds: ['a', 'b'],
      precision: 1,
    };
    const verdict = checkAgainstBaseline(actual, baseline);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.messages[0]).toContain('needs_approval sample shrank');
    expect(verdict.messages[0]).toContain('2 < baseline 4');
  });

  it('fails when a previously-correct fixture drops out despite steady aggregates', () => {
    const actual: PrecisionSnapshot = { ...baseline, correctFixtureIds: ['a', 'b', 'd'] };
    const verdict = checkAgainstBaseline(actual, baseline);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.messages[0]).toContain('fixture(s) previously correct in needs_approval no longer are: c');
  });
});
