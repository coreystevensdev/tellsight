import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { parseJudge } from './parse-judge.js';

// Every judge reply goes through here, and a reply this cannot parse discards the
// whole sample: the generation, all three judge calls, and whatever signal that
// sample carried. One cash-crunch sample was lost this way on a fixture that was
// already failing, which is precisely where a missing sample costs the most.
//
// The judges are told to emit bare JSON. They mostly do. These cover what happens
// when they do not.

const schema = z.object({ verdict: z.string() });
const parse = (raw: string) => parseJudge(raw, schema, 'test');

describe('parseJudge', () => {
  it('reads a bare object', () => {
    expect(parse('{"verdict":"ok"}')).toEqual({ verdict: 'ok' });
  });

  it('reads one wrapped in a closed json fence', () => {
    expect(parse('```json\n{"verdict":"ok"}\n```')).toEqual({ verdict: 'ok' });
  });

  it('reads one wrapped in a bare fence', () => {
    expect(parse('```\n{"verdict":"ok"}\n```')).toEqual({ verdict: 'ok' });
  });

  // The two shapes fence-stripping alone cannot reach, because the fence no
  // longer starts the string or no longer ends it.
  it('reads one behind a sentence of preamble', () => {
    expect(parse('Here is my assessment:\n\n{"verdict":"ok"}')).toEqual({ verdict: 'ok' });
  });

  it('reads one inside a fence that was never closed', () => {
    expect(parse('```json\n{"verdict":"ok"}')).toEqual({ verdict: 'ok' });
  });

  it('reads one with trailing commentary after the object', () => {
    expect(parse('{"verdict":"ok"}\n\nLet me know if you need more detail.')).toEqual({
      verdict: 'ok',
    });
  });

  // Recovery must not turn a genuinely broken reply into a silent pass: a sample
  // that cannot be scored has to fail loudly rather than score as something.
  it('still rejects a reply with no object in it', () => {
    expect(() => parse('I was unable to complete this assessment.')).toThrow(/non-JSON/);
  });

  it('still rejects an object that never closes', () => {
    expect(() => parse('{"verdict":"ok"')).toThrow(/non-JSON/);
  });

  it('still rejects a well-formed object of the wrong shape', () => {
    expect(() => parse('{"result":"ok"}')).toThrow(/unexpected shape/);
  });
});
