import type { ClientAnalyticsEventName } from 'shared/constants';

// Narrowed to the set the API will actually accept. A call site passing a
// server-emitted event is a type error here rather than a 400 that disappears
// into the catch below.
export function trackClientEvent(
  eventName: ClientAnalyticsEventName,
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
