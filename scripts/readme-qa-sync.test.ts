import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Same gap readme-precision-sync.test.ts closes for the proposal eval: README.md
// hand-quotes this snapshot instead of reading it. The model name is in here too
// because stamping a new one onto a committed snapshot is how the claim drifted
// in the first place.

const __dirname = dirname(fileURLToPath(import.meta.url));
const README_PATH = resolve(__dirname, '..', 'README.md');
const SNAPSHOT_PATH = resolve(__dirname, '__snapshots__', 'qa-interpretation.snap.json');

describe('README eval:qa claim', () => {
  it('matches the committed qa-interpretation snapshot', () => {
    const readme = readFileSync(README_PATH, 'utf-8');
    const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf-8'));

    const match = readme.match(
      /Its committed snapshot records ([\d.]+) aggregate accuracy across all (\d+) fixtures against a floor of ([\d.]+), measured (\d{4}-\d{2}-\d{2}) on `([^`]+)`/,
    );
    expect(
      match,
      'README eval:qa sentence not found or reworded, update this regex alongside the wording change',
    ).not.toBeNull();

    const [, aggregate, fixtureCount, floor, measuredAt, judgeModel] = match!;
    expect(Number(aggregate)).toBe(snapshot.aggregate);
    expect(Number(fixtureCount)).toBe(snapshot.fixtures.length);
    expect(Number(floor)).toBe(snapshot.floor);
    expect(measuredAt).toBe(snapshot.measuredAt);
    expect(judgeModel).toBe(snapshot.judgeModel);
  });
});
