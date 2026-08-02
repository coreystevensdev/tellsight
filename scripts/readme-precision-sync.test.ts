import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// README.md hand-quotes the proposal-precision eval's result rather than
// reading the snapshot, so nothing forces the two to move together. This
// pins the claimed sentence to the committed snapshot the same way the eval
// script itself does.

const __dirname = dirname(fileURLToPath(import.meta.url));
const README_PATH = resolve(__dirname, '..', 'README.md');
const SNAPSHOT_PATH = resolve(__dirname, '__snapshots__', 'proposal-precision.snap.json');

describe('README proposal-precision claim', () => {
  it('matches the committed proposal-precision snapshot', () => {
    const readme = readFileSync(README_PATH, 'utf-8');
    const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8'));

    const match = readme.match(
      /current measured precision is ([\d.]+) \((\d+) of (\d+) needs_approval fixtures\)/,
    );
    expect(
      match,
      'README precision sentence not found or reworded, update this regex alongside the wording change',
    ).not.toBeNull();

    const [, precision, correctCount, needsApprovalCount] = match!;
    expect(Number(precision)).toBe(snapshot.precision);
    expect(Number(correctCount)).toBe(snapshot.correctCount);
    expect(Number(needsApprovalCount)).toBe(snapshot.needsApprovalCount);
  });
});
