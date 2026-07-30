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

  it('collapses "cash runway" and "runway" to the same key', () => {
    const a = deriveDedupKey({ kind: 'trend', subject: 'cash runway', facet: 'down' });
    const b = deriveDedupKey({ kind: 'trend', subject: 'runway', facet: 'down' });
    expect(a).toBe(b);
  });

  it('collapses "profit margin", "gross margin", and "margin" to the same key', () => {
    const a = deriveDedupKey({ kind: 'trend', subject: 'profit margin', facet: 'down' });
    const b = deriveDedupKey({ kind: 'trend', subject: 'gross margin', facet: 'down' });
    const c = deriveDedupKey({ kind: 'trend', subject: 'margin', facet: 'down' });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('does not fuzzy-collapse unaliased freeform subjects', () => {
    const a = deriveDedupKey({ kind: 'trend', subject: 'Marketing' });
    const b = deriveDedupKey({ kind: 'trend', subject: 'Market' });
    expect(a).not.toBe(b);
  });

  it('does not run facet through the subject alias table', () => {
    const a = deriveDedupKey({ kind: 'trend', subject: 'runway', facet: 'margin' });
    const b = deriveDedupKey({ kind: 'trend', subject: 'runway', facet: 'gross_margin' });
    expect(a).not.toBe(b);
  });

  it('collapses a hyphenated alias variant the same as the space-separated form', () => {
    const a = deriveDedupKey({ kind: 'trend', subject: 'cash-runway', facet: 'down' });
    const b = deriveDedupKey({ kind: 'trend', subject: 'runway', facet: 'down' });
    expect(a).toBe(b);
  });

  it('collapses a trailing colon the same as the bare subject', () => {
    const a = deriveDedupKey({ kind: 'trend', subject: 'cash runway:', facet: 'down' });
    const b = deriveDedupKey({ kind: 'trend', subject: 'runway', facet: 'down' });
    expect(a).toBe(b);
  });

  it('does not fall through to Object.prototype for a subject like "__proto__"', () => {
    const a = deriveDedupKey({ kind: 'trend', subject: '__proto__' });
    const b = deriveDedupKey({ kind: 'trend', subject: 'constructor' });
    expect(a).toBe('trend:proto:default');
    expect(b).toBe('trend:constructor:default');
    expect(a).not.toBe(b);
  });
});
