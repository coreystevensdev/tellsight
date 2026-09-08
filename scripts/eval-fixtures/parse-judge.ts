// Pure, and in its own module so it can be tested: importing eval-summaries.ts
// pulls in config.ts, which throws at module load when the env is unset, so a
// test that imported it there never ran at all.

import { z } from 'zod';

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
      throw new Error(`${ctx} judge returned non-JSON: ${raw.slice(0, 200)}`);
    }
    try {
      parsed = JSON.parse(cleaned.slice(first, last + 1));
    } catch {
      throw new Error(`${ctx} judge returned non-JSON: ${raw.slice(0, 200)}`);
    }
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`${ctx} judge returned unexpected shape (${result.error.message}): ${raw.slice(0, 200)}`);
  }
  return result.data;
}
