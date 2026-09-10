import { describe, it, expect } from 'vitest';
import { z } from 'zod';

import { askJudge, parseJudge } from './parse-judge.js';

// Every judge reply goes through here, and a reply this cannot parse discards the
// whole sample: the generation, all three judge calls, and whatever signal that
// sample carried. One cash-crunch sample was lost this way on a fixture that was
// already failing, which is precisely where a missing sample costs the most.
//
// The judges are told to emit bare JSON. They mostly do. These cover what happens
// when they do not.

const schema = z.object({ verdict: z.string() });
const parse = (raw: string) => parseJudge(raw, schema, 'test');
const prompt = { system: 's', user: 'u' };

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

describe('askJudge', () => {
  const fakeProvider = (replies: string[]) => {
    const calls: number[] = [];
    return {
      provider: {
        generate: async () => {
          calls.push(1);
          return replies[calls.length - 1] ?? '';
        },
      } as never,
      count: () => calls.length,
    };
  };

  it('asks once when the first reply parses', async () => {
    const { provider, count } = fakeProvider(['{"verdict":"ok"}']);
    await expect(askJudge(provider, prompt, schema, 'test')).resolves.toEqual({ verdict: 'ok' });
    expect(count()).toBe(1);
  });

  it('asks again when the first reply is unusable', async () => {
    const { provider, count } = fakeProvider(['not json at all', '{"verdict":"ok"}']);
    await expect(askJudge(provider, prompt, schema, 'test')).resolves.toEqual({ verdict: 'ok' });
    expect(count()).toBe(2);
  });

  // A judge that mangles this particular prompt every time is a real failure, not
  // a blip, and swallowing it would score the sample on nothing.
  it('gives up after the second reply', async () => {
    const { provider, count } = fakeProvider(['nope', 'still nope']);
    await expect(askJudge(provider, prompt, schema, 'test')).rejects.toThrow(/non-JSON/);
    expect(count()).toBe(2);
  });

  // The shape check runs after JSON.parse succeeds, and it used to be the one
  // failure that never retried.
  it('asks again when the reply parses but is the wrong shape', async () => {
    const { provider, count } = fakeProvider(['{"wrong":"field"}', '{"verdict":"ok"}']);
    await expect(askJudge(provider, prompt, schema, 'test')).resolves.toEqual({ verdict: 'ok' });
    expect(count()).toBe(2);
  });
});
