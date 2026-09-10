// Getting a usable object back from a judge, in its own module so it can be
// tested: importing eval-summaries.ts pulls in config.ts, which throws at module
// load when the env is unset, so a test that imported it there never ran at all.
// The provider import below is type-only and erases, so that stays true.

import { z } from 'zod';

import type { LlmProvider, PromptInput } from '../../apps/api/src/services/aiInterpretation/provider.js';

// Judges run through claudeClient's 1024 max_tokens, so this is the whole
// response in practice. It used to be 200, which cut off inside the opening
// ```json fence and made every failure look like a fence-stripping bug. One real
// failure went undiagnosed because of it: the visible prefix was identical to
// output this function handles correctly.
const RAW_IN_ERROR = 4000;

export function parseJudge<T>(raw: string, schema: z.ZodType<T>, ctx: string): T {
  // Judges are told to emit bare JSON, but strip a stray ```json fence just in case.
  const cleaned = raw
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // Fence-stripping only handles a fence that opens at the start and closes at
    // the end. A judge that adds a sentence first, or opens a fence and never
    // closes it, still returned a usable object, and discarding the sample costs
    // a real generation: one cash-crunch sample was thrown away this way on a
    // fixture that was already failing, which is where the signal was needed.
    const first = cleaned.indexOf('{');
    const last = cleaned.lastIndexOf('}');
    if (first === -1 || last <= first) {
      throw new Error(`${ctx} judge returned non-JSON: ${raw.slice(0, RAW_IN_ERROR)}`);
    }
    try {
      parsed = JSON.parse(cleaned.slice(first, last + 1));
    } catch {
      throw new Error(`${ctx} judge returned non-JSON: ${raw.slice(0, RAW_IN_ERROR)}`);
    }
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${ctx} judge returned unexpected shape (${result.error.message}): ${raw.slice(0, RAW_IN_ERROR)}`);
  }
  return result.data;
}

// Losing a judge to unparseable JSON throws away the whole sample, including the
// generation it was judging and the other two judges that already ran on it. That
// happened once in 36 and skewed a fixture to n=11 against the other two at 12,
// which is the kind of imbalance that still looks like data afterwards. Re-asking
// the judge costs one call.
export async function askJudge<T>(
  provider: LlmProvider,
  prompt: PromptInput,
  schema: z.ZodType<T>,
  ctx: string,
): Promise<T> {
  try {
    return parseJudge(await provider.generate(prompt), schema, ctx);
  } catch (err) {
    console.error(`  ${ctx} judge output was unusable, asking once more: ${err instanceof Error ? err.message : err}`);
    return parseJudge(await provider.generate(prompt), schema, ctx);
  }
}

