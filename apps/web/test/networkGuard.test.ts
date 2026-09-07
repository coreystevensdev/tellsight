import { describe, it, expect } from 'vitest';

// The guard is registered by setupFiles and lives in packages/shared, so this
// file is what notices if the web config stops loading it. Nineteen test files
// here spy on globalThis.fetch with queued mockResolvedValueOnce; once a queue
// is exhausted the spy falls through to the real fetch, and until the guard was
// wired in there was nothing on this side of the repo to catch that.
describe('outbound network guard, wired into the web suite', () => {
  // Thunked: the guard throws where fetch is called rather than returning a
  // rejected promise, so passing the call's result to expect never gets there.
  it('blocks a third-party host', async () => {
    await expect(async () => fetch('https://api.resend.com/emails')).rejects.toThrow(
      /Blocked outbound fetch/,
    );
  });

  // jsdom resolves a relative URL against a loopback base. Every BFF call in the
  // app is relative, so blocking these would make the guard unusable here.
  it('leaves a relative app URL alone', async () => {
    const err: unknown = await Promise.resolve()
      .then(() => fetch('/api/datasets'))
      .catch((e: unknown) => e);

    expect(String(err)).not.toMatch(/Blocked outbound fetch/);
  });
});
