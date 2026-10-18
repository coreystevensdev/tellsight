import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// Relative, not the `shared/constants` alias: scripts/vitest.config.ts declares
// no aliases, so the sibling tests in here reach into packages/shared the same way.
import { FREE_PREVIEW_WORD_LIMIT } from '../packages/shared/src/constants/index.js';

// README.md and docs/api.md both hand-quote the free-preview cap. They said ~150
// while the constant has been 50, in two README places including the Known
// Limitations section whose whole job is being the accurate part. Same fix as
// readme-precision-sync.test.ts: pin the prose to the value it describes.

const __dirname = dirname(fileURLToPath(import.meta.url));
const README_PATH = resolve(__dirname, '..', 'README.md');
const API_DOC_PATH = resolve(__dirname, '..', 'docs', 'api.md');

describe('free-preview cap claims', () => {
  it('README states the constant, everywhere it states a number', () => {
    const readme = readFileSync(README_PATH, 'utf-8');
    const claims = [...readme.matchAll(/(\d+)-word AI preview|capped at (\d+) words/g)];

    expect(
      claims.length,
      'no free-preview cap sentence found in README, update this regex alongside the wording change',
    ).toBeGreaterThanOrEqual(2);

    for (const claim of claims) {
      const stated = Number(claim[1] ?? claim[2]);
      expect(stated, `README says ${stated}, constant is ${FREE_PREVIEW_WORD_LIMIT}: "${claim[0]}"`).toBe(
        FREE_PREVIEW_WORD_LIMIT,
      );
    }
  });

  it('docs/api.md states the constant', () => {
    const apiDoc = readFileSync(API_DOC_PATH, 'utf-8');
    const match = apiDoc.match(/truncated at (\d+) words/);

    expect(
      match,
      'free-preview cap sentence not found in docs/api.md, update this regex alongside the wording change',
    ).not.toBeNull();
    expect(Number(match![1])).toBe(FREE_PREVIEW_WORD_LIMIT);
  });
});
