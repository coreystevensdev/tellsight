import type { AnalyticsEventName } from 'shared/constants';

export function trackClientEvent(
  eventName: AnalyticsEventName,
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
