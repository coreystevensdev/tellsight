import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ANALYTICS_EVENTS } from 'shared/constants';

import { trackClientEvent } from './analytics';

describe('trackClientEvent', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('sends POST to /api/analytics with event data', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());

    trackClientEvent(ANALYTICS_EVENTS.TRANSPARENCY_PANEL_OPENED, { datasetId: 42 });

    expect(fetchSpy).toHaveBeenCalledWith('/api/analytics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ eventName: 'transparency_panel.opened', metadata: { datasetId: 42 } }),
      credentials: 'same-origin',
    });
  });

  it('works without metadata', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response());

    trackClientEvent(ANALYTICS_EVENTS.DASHBOARD_VIEWED);

    expect(fetchSpy).toHaveBeenCalledWith('/api/analytics', expect.objectContaining({
      body: JSON.stringify({ eventName: ANALYTICS_EVENTS.DASHBOARD_VIEWED }),
    }));
  });

  it('swallows fetch errors silently', () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'));

    // should not throw
    expect(() => trackClientEvent(ANALYTICS_EVENTS.DASHBOARD_VIEWED)).not.toThrow();
  });
});
