import { describe, expect, it } from 'vitest';

import {
  costBlindSources,
  counterpartyBlindSources,
  isCounterpartyBlindSource,
} from './computationPrimitives.js';

/**
 * DW-288. Customer concentration cannot compute for a Shopify or Square org,
 * and said nothing about it, which is the same silent degradation DW-279 was
 * opened for one insight over.
 *
 * The scope that would fix it at the source was declined: Shopify classifies a
 * customer's name as Level 2 protected customer data, alongside address, phone
 * and email, so reaching it means `read_customers` plus meeting Shopify's
 * protected-customer-data requirements, and it grants all four fields to show
 * one. Xero needed none of that, because `Contact.Name` arrives embedded in the
 * transaction (141 of 141 rows in production).
 */

const row = (sourceType: string | null) => ({ sourceType });

describe('counterpartyBlindSources', () => {
  it.each(['shopify', 'square'])('names %s, which cannot say who bought', (source) => {
    expect(counterpartyBlindSources([row(source)])).toEqual([source]);
  });

  it('names every blind source sorted, so the sentence can list them', () => {
    expect(counterpartyBlindSources([row('square'), row('shopify'), row('square')])).toEqual([
      'shopify',
      'square',
    ]);
  });

  // All, not any: one QuickBooks row alongside Shopify means concentration can
  // compute, and there is nothing to warn about.
  it.each(['quickbooks', 'xero', 'plaid', 'csv'])(
    'reports nothing once a %s row is present',
    (source) => {
      expect(counterpartyBlindSources([row('shopify'), row(source)])).toEqual([]);
    },
  );

  it.each(['quickbooks', 'xero', 'plaid', 'csv'])('treats %s as able to name a customer', (s) => {
    expect(counterpartyBlindSources([row(s)])).toEqual([]);
  });

  // Subtractive, like every other source predicate here: a connector added
  // without being classified is never accused of anonymity.
  it('reports nothing for a source it does not recognise', () => {
    expect(counterpartyBlindSources([row('paypal')])).toEqual([]);
  });

  it('reports nothing when any row carries no source at all', () => {
    expect(counterpartyBlindSources([row('shopify'), row(null)])).toEqual([]);
  });

  it('reports nothing for an empty dataset', () => {
    expect(counterpartyBlindSources([])).toEqual([]);
  });
});

/**
 * The two predicates agree on every source that exists today, which is exactly
 * why they are written separately. Collapsing them would be correct right now
 * and would make the notice explain the wrong absence the first time a source
 * sees both sides of the ledger and still names nobody.
 */
describe('the two blindnesses are different questions', () => {
  it.each(['shopify', 'square'])('%s happens to be both today', (source) => {
    expect(costBlindSources([row(source)])).toEqual([source]);
    expect(counterpartyBlindSources([row(source)])).toEqual([source]);
  });

  // The case that would break a merged predicate. Not reachable with today's
  // six sources, which is the point: it is reachable with the seventh.
  it('a hypothetical cost-visible, nameless source would need its own answer', () => {
    expect(isCounterpartyBlindSource('shopify')).toBe(true);
    expect(isCounterpartyBlindSource('quickbooks')).toBe(false);
    // Unrecognised is never accused, so a new source defaults to "can name".
    expect(isCounterpartyBlindSource('something-new')).toBe(false);
    expect(isCounterpartyBlindSource(null)).toBe(false);
  });
});
