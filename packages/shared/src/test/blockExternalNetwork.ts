const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

// Covers fetch only. Anything reaching the network through node:http or a raw
// socket still gets out, so this is a tripwire for the common case rather than
// a sandbox.
// Derived from fetch rather than written as RequestInfo | URL: this package has
// no DOM lib, and pulling one in to type a test helper would widen what every
// other file here can reach for.
type FetchInput = Parameters<typeof fetch>[0];

function targetHost(input: FetchInput): string | null {
  const raw =
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  // jsdom gives a relative URL a base, and that base is loopback, so `/api/x`
  // resolves and is allowed. Node has no base, where a bare relative path was
  // never a fetchable target to begin with.
  const base = (globalThis as { location?: { href: string } }).location?.href;
  try {
    return new URL(raw, base).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

export function blockExternalNetwork(): void {
  const realFetch = globalThis.fetch;

  globalThis.fetch = function guardedFetch(input: FetchInput, init?: RequestInit) {
    const host = targetHost(input);
    if (host === null || !LOOPBACK.has(host)) {
      const message =
        `Blocked outbound fetch to ${host ?? 'an unparseable URL'} from a unit test. ` +
        'Unit tests must not depend on a third-party service being reachable, or on ' +
        'whatever credentials happen to be in the environment. Mock the client, or ' +
        'pin the config so this code path is not selected.';

      // SDK clients catch whatever fetch throws and re-report it as their own
      // generic transport failure, which buries this. stderr survives that.
      process.stderr.write(`\n[network guard] ${message}\n`);
      throw new Error(message);
    }
    return realFetch(input, init);
  } as typeof fetch;
}

blockExternalNetwork();
