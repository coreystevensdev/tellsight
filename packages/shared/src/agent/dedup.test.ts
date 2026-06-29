import { describe, it, expect } from 'vitest';

import { deriveDedupKey } from './dedup.js';

describe('deriveDedupKey', () => {
  it('is stable across runs for the same finding identity', () => {
    const a = deriveDedupKey({ kind: 'trend', subject: 'Marketing', facet: 'down' });
    const b = deriveDedupKey({ kind: 'trend', subject: 'Marketing', facet: 'down' });
    expect(a).toBe(b);
  });

  it('ignores casing and whitespace in the subject', () => {
    const a = deriveDedupKey({ kind: 'anomaly', subject: 'Cost of  Goods' });
    const b = deriveDedupKey({ kind: 'anomaly', subject: 'cost of goods' });
    expect(a).toBe(b);
  });

  it('changes when the facet flips, so a worsening condition re-alerts', () => {
    const warning = deriveDedupKey({ kind: 'threshold', subject: 'runway', facet: 'warning' });
    const critical = deriveDedupKey({ kind: 'threshold', subject: 'runway', facet: 'critical' });
    expect(warning).not.toBe(critical);
  });

  it('separates different kinds about the same subject', () => {
    const trend = deriveDedupKey({ kind: 'trend', subject: 'runway' });
    const threshold = deriveDedupKey({ kind: 'threshold', subject: 'runway' });
    expect(trend).not.toBe(threshold);
  });

  it('does not collapse the subject/facet boundary', () => {
    const x = deriveDedupKey({ kind: 'trend', subject: 'a:b' });
    const y = deriveDedupKey({ kind: 'trend', subject: 'a', facet: 'b' });
    expect(x).not.toBe(y);
  });
});
