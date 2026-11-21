import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The landing page published 0.99 faithfulness and 1.00 completeness for months
// while docs/eval-history.md recorded 0.943 across 87 samples and said in as many
// words that the 0.96 to 0.99 band does not reproduce on either model. Three
// internal docs disagreed with the one surface a stranger actually reads.
//
// Pinned to the last row of the history table rather than to the document as a
// whole. The first version of this guard checked that a claimed score appeared
// somewhere in eval-history, and it passed when 0.99 was put back, because the
// prose quotes the wrong numbers in order to refute them. A doc that discusses
// its own errors cannot be used as an allowlist of its own figures.

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAGE_PATH = resolve(__dirname, '..', 'apps', 'web', 'app', 'page.tsx');
const HISTORY_PATH = resolve(__dirname, '..', 'docs', 'eval-history.md');

function latestRecordedRun(history: string): { score: string; row: string } {
  const rows = [...history.matchAll(/^\| (\d{4}-\d{2}-\d{2}) \| [^|]+\| ([^|]+)\|/gm)];
  const last = rows.at(-1);
  if (!last) throw new Error('no dated rows in the eval-history table; update this parser');
  const result = last[2] ?? '';
  const score = result.match(/\b(0\.\d{2,3})\b/)?.[1];
  if (!score) throw new Error(`last history row states no score: "${result.trim()}"`);
  return { score: Number(score).toFixed(3), row: last[0] ?? '' };
}

describe('landing page eval claims', () => {
  const page = readFileSync(PAGE_PATH, 'utf-8');
  const history = readFileSync(HISTORY_PATH, 'utf-8');
  const paragraph = page.match(/The summaries themselves are graded[\s\S]{0,900}?<\/p>/)?.[0];

  it('still has an eval paragraph to check', () => {
    expect(
      paragraph,
      'the graded-summaries paragraph moved or was reworded; update this matcher with it',
    ).toBeDefined();
  });

  it('quotes the score from the most recent recorded run', () => {
    const { score, row } = latestRecordedRun(history);
    const onPage = paragraph?.match(/\b(0\.\d{2,3}) faithfulness/)?.[1];
    expect(onPage, 'the page states no faithfulness score').toBeDefined();
    expect(
      Number(onPage).toFixed(3),
      `page says ${onPage}; newest row in docs/eval-history.md is ${score}\n  ${row.trim()}`,
    ).toBe(score);
  });

  it('names a sample count the history records', () => {
    const onPage = paragraph?.match(/across (\d+) samples/)?.[1];
    expect(onPage, 'the page no longer states a sample count').toBeDefined();
    expect(
      history.includes(`${onPage} samples`),
      `page says ${onPage} samples; eval-history does not mention that count`,
    ).toBe(true);
  });
});
