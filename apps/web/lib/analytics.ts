/**
 * Fire-and-forget client-side analytics. No await, no error throw
 * mirrors the backend trackEvent pattern.
 */
export function trackClientEvent(
  eventName: string,
  metadata?: Record<string, unknown>,
): void {
  fetch('/api/analytics', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ eventName, metadata }),
    credentials: 'same-origin',
  }).catch(() => {
    // swallow, analytics must never disrupt the user
  });
}
