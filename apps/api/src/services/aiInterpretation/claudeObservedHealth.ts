import type { ProviderHealth } from './provider.js';

/**
 * What live Claude traffic last learned about the account.
 *
 * Kept apart from the probe cache in claudeClient rather than written into it,
 * for two reasons. That cache stores the answer to "what did a paid probe
 * find", and overwriting it would also reset its TTL, so a steady trickle of
 * requests would keep it looking fresh and the admin panel's real probe would
 * stop running. And this module imports nothing but a type, so the request path
 * can record without pulling config and an SDK client in behind it.
 *
 * Nothing here is on a schedule. An instance serving no AI traffic reports
 * whatever it last saw, which is why the health route publishes the age.
 */
let observed: { value: ProviderHealth; at: number } | null = null;

export function recordObservedClaudeHealth(value: ProviderHealth): void {
  observed = { value, at: Date.now() };
}

export function peekObservedClaudeHealth(): { value: ProviderHealth; at: number } | null {
  return observed;
}

/** Test seam. Nothing in the request path clears this. */
export function resetObservedClaudeHealth(): void {
  observed = null;
}

/**
 * Anthropic reports an exhausted balance as a 400 invalid_request_error, with
 * nothing but the message to tell it from any other malformed request. So the
 * text is the signal, and anything that does not match keeps the behaviour it
 * had rather than being called a billing problem.
 */
export function isCreditExhausted(err: unknown): boolean {
  const status = (err as { status?: number })?.status;
  const message = (err as Error)?.message ?? '';
  return status === 400 && /credit balance/i.test(message);
}

export const NO_CREDIT_DETAIL = 'Anthropic account has no credit, every AI feature is down';

// latencyMs is 0 on both because neither came from a probe, and the duration of
// a real generation is not the same measurement. The detail says where the
// answer came from so the payload does not imply a probe ran.
export const observedDown: ProviderHealth = {
  status: 'error',
  latencyMs: 0,
  detail: NO_CREDIT_DETAIL,
};

export const observedUp: ProviderHealth = {
  status: 'ok',
  latencyMs: 0,
  detail: 'verified by a live request rather than a probe',
};
