import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The eval subject is pinned literally rather than read from CLAUDE_MODEL, which
// is deliberate, but it means the two drift apart silently: on 2026-10-31 the
// eval measured claude-sonnet-5 while production had been serving
// claude-sonnet-4-6 since 0a3f5c8, so a run scored a model nobody was served by.

const __dirname = dirname(fileURLToPath(import.meta.url));
const read = (f: string) => readFileSync(resolve(__dirname, f), 'utf-8');

describe('eval subject model', () => {
  it('matches the model the deploy script ships to production', () => {
    const deployed = read('deploy-via-ssm.py').match(
      /\("CLAUDE_MODEL",\s*os\.environ\.get\('CLAUDE_MODEL'\)\s*or\s*'([^']+)'\)/,
    );
    expect(
      deployed,
      'CLAUDE_MODEL default not found in deploy-via-ssm.py, update this regex alongside the change',
    ).not.toBeNull();

    const subject = read('eval-summaries.ts').match(
      /const SUBJECT_MODEL = process\.env\.EVAL_MODEL \?\? '([^']+)'/,
    );
    expect(
      subject,
      'SUBJECT_MODEL default not found in eval-summaries.ts, update this regex alongside the change',
    ).not.toBeNull();

    expect(subject![1]).toBe(deployed![1]);
  });

  it('does not judge with the model under test', () => {
    const src = read('eval-summaries.ts');
    const subject = src.match(/const SUBJECT_MODEL = process\.env\.EVAL_MODEL \?\? '([^']+)'/);
    const judge = src.match(/const JUDGE_MODEL = process\.env\.EVAL_JUDGE_MODEL \?\? '([^']+)'/);
    expect(subject).not.toBeNull();
    expect(judge).not.toBeNull();
    expect(judge![1]).not.toBe(subject![1]);
  });
});
