const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

// Covers fetch only. Anything reaching the network through node:http or a raw
// socket still gets out, so this is a tripwire for the common case rather than
// a sandbox.
function targetHost(input: RequestInfo | URL): string | null {
  const raw =
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try {
    return new URL(raw).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return null;
  }
}

export function blockExternalNetwork(): void {
  const realFetch = globalThis.fetch;

  globalThis.fetch = function guardedFetch(input: RequestInfo | URL, init?: RequestInit) {
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
