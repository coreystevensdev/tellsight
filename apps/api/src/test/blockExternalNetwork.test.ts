import { describe, it, expect } from 'vitest';
import http from 'node:http';

// The guard is registered by setupFiles, so it is already active here. Without
// this file nothing would notice if the setup wiring were dropped.
describe('outbound network guard', () => {
  it.each(['https://api.resend.com/emails', 'https://api.stripe.com/v1/charges'])(
    'blocks %s',
    async (url) => {
      await expect(async () => fetch(url)).rejects.toThrow(/Blocked outbound fetch/);
    },
  );

  it('still allows loopback, which every route test depends on', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as { port: number };

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(await res.text()).toBe('ok');

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
