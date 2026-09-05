import { describe, it, expect } from 'vitest';

import { BANNED_IMPERATIVES } from './constants.js';
import {
  ACTION_MUTATES,
  ACTION_TYPES,
  actionMutates,
  agentProposalSchema,
} from './proposal.js';

function validProposal(over: Record<string, unknown> = {}) {
  return {
    kind: 'trend',
    severity: 'notice',
    title: 'Revenue dipped 15%',
    explanation: 'Month-over-month revenue fell by 15%.',
    recommendation: 'Consider reviewing your highest-cost categories.',
    confidence: 0.82,
    evidence: ['monthly_revenue'],
    dedupKey: 'trend:revenue:default',
    period: '2026-06',
    ...over,
  };
}

describe('agentProposalSchema advisory-voice boundary', () => {
  it('accepts an advisory-phrased proposal', () => {
    expect(agentProposalSchema.safeParse(validProposal()).success).toBe(true);
  });

  it('rejects a recommendation phrased as a directive', () => {
    const result = agentProposalSchema.safeParse(validProposal({ recommendation: 'You should reduce payroll.' }));
    expect(result.success).toBe(false);
  });

  it('rejects an explanation phrased as a directive', () => {
    const result = agentProposalSchema.safeParse(validProposal({ explanation: 'You must act on this immediately.' }));
    expect(result.success).toBe(false);
  });

  it('rejects every banned imperative, not just "you should"', () => {
    for (const phrase of BANNED_IMPERATIVES) {
      const result = agentProposalSchema.safeParse(validProposal({ recommendation: `${phrase} cut costs.` }));
      expect(result.success).toBe(false);
    }
  });
});

describe('agentProposalSchema currency case boundary', () => {
  function withCurrency(currency: string) {
    return validProposal({
      action: { type: 'notify', targetRef: 'x', estimatedImpact: { amount: 100, currency } },
    });
  }

  it('accepts an uppercase currency code', () => {
    expect(agentProposalSchema.safeParse(withCurrency('USD')).success).toBe(true);
  });

  it('rejects a lowercase currency code', () => {
    expect(agentProposalSchema.safeParse(withCurrency('usd')).success).toBe(false);
  });

  it('rejects a mixed-case currency code', () => {
    expect(agentProposalSchema.safeParse(withCurrency('Usd')).success).toBe(false);
  });

  it('rejects a currency code shorter than 3 letters', () => {
    expect(agentProposalSchema.safeParse(withCurrency('US')).success).toBe(false);
  });

  it('rejects a currency code longer than 3 letters', () => {
    expect(agentProposalSchema.safeParse(withCurrency('USDD')).success).toBe(false);
  });

  it('rejects an empty currency code', () => {
    expect(agentProposalSchema.safeParse(withCurrency('')).success).toBe(false);
  });
});

// grep for actionMutates or ACTION_MUTATES across every test file in the repo
// returned nothing before this. The fallback is the gate's last line of defence:
// an action type added to the schema but never registered here has to route to
// human approval rather than run unattended, and flipping the default to false
// was invisible to both this package and the API suite.
describe('actionMutates', () => {
  it('reports the registered flag for every known action type', () => {
    expect(actionMutates('notify')).toBe(false);
    expect(actionMutates('createNote')).toBe(false);
    expect(actionMutates('flagInvoice')).toBe(false);
    expect(actionMutates('reclassify')).toBe(true);
  });

  it('covers every type in ACTION_TYPES, so a new one cannot slip through', () => {
    for (const type of ACTION_TYPES) {
      expect(ACTION_MUTATES, `${type} has no registered mutates flag`).toHaveProperty(type);
      expect(typeof ACTION_MUTATES[type]).toBe('boolean');
    }
  });

  // The fail-safe direction. An unregistered type must be treated as mutating,
  // so it goes to a human instead of executing on its own.
  it.each(['reclassifyV2', 'postToQuickbooks', 'sendPayment', '', 'toString'])(
    'treats the unregistered type %s as mutating',
    (type) => {
      expect(actionMutates(type)).toBe(true);
    },
  );
});
