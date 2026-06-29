import { describe, it, expect } from 'vitest';

import { scoreLegalPosture } from './legal-posture.js';

// A real-shaped, compliant paragraph: hedged framing, no imperatives. Mirrors the
// GOOD examples in v1.6-system.md.
const COMPLIANT = `Your shipping costs jumped 40% in March, worth investigating whether a
vendor raised rates. At this burn rate, cash reserves cover about four months. You
might want to look into which months drove the spike, and consider discussing the
trend with your accountant.`;

describe('scoreLegalPosture', () => {
  it('passes a compliant, hedged paragraph', () => {
    const r = scoreLegalPosture(COMPLIANT);
    expect(r.pass).toBe(true);
    expect(r.violations).toEqual([]);
  });

  it.each([
    'you should',
    'you need to',
    'you must',
    'I recommend',
    "I'd recommend",
    'I suggest you',
  ])('fails on banned imperative %s', (phrase) => {
    // Wrap with an approved hedge so only the banned phrase is the reason it fails.
    const text = `Consider the trend. ${phrase} review the payroll line more closely.`;
    const r = scoreLegalPosture(text);
    expect(r.pass).toBe(false);
    expect(r.violations.some((v) => v.toLowerCase().includes(phrase.toLowerCase()))).toBe(true);
  });

  it('word boundary: "shoulder" does not trip "should"', () => {
    const text = `Revenue leaned on one shoulder of the quarter, worth investigating further.`;
    const r = scoreLegalPosture(text);
    expect(r.violations.some((v) => v.includes('should'))).toBe(false);
  });

  it('catches "you should" even next to similar words', () => {
    const text = `That is a shoulder season, and you should look at it, worth investigating.`;
    const r = scoreLegalPosture(text);
    expect(r.pass).toBe(false);
    expect(r.violations.some((v) => v.toLowerCase().includes('you should'))).toBe(true);
  });

  it('fails the "you should cut payroll" shape from the AC', () => {
    const r = scoreLegalPosture('Margins slipped. You should cut payroll next month.');
    expect(r.pass).toBe(false);
  });

  it.each([
    'Buy new equipment before the quarter closes.',
    'Sell the underperforming inventory now.',
    'Hire two more people to cover the gap.',
    'Fire the vendor and find a cheaper one.',
    'Borrow against the receivables to bridge the gap.',
    'Invest the surplus in a money market account.',
  ])('fails on a direct financial command: %s', (command) => {
    // Prefix a hedge so the failure is the command, not a missing hedge.
    const r = scoreLegalPosture(`Worth investigating the numbers. ${command}`);
    expect(r.pass).toBe(false);
    expect(r.violations.some((v) => v.startsWith('financial command'))).toBe(true);
  });

  it('does not flag gerunds or past tense of the financial verbs', () => {
    const text = `Spending on hiring rose while investing slowed and a vendor was fired last
year, all worth investigating with your accountant.`;
    const r = scoreLegalPosture(text);
    expect(r.violations.some((v) => v.startsWith('financial command'))).toBe(false);
  });

  it('does not flag hedged suggestions that mention a financial verb', () => {
    const text = `You might want to look into whether to invest the surplus, worth
investigating with your accountant.`;
    const r = scoreLegalPosture(text);
    expect(r.violations.some((v) => v.startsWith('financial command'))).toBe(false);
  });

  it('fails a paragraph with no approved hedge even when otherwise clean', () => {
    const text = `Revenue rose 12% and expenses held flat. Margins widened to 24%.`;
    const r = scoreLegalPosture(text);
    expect(r.pass).toBe(false);
    expect(r.violations).toContain('no approved hedge present');
  });

  it.each(['could indicate', 'worth investigating', 'might want to', 'consider', 'you might'])(
    'accepts the approved hedge %s as satisfying the hedge floor',
    (hedge) => {
      const text = `Revenue rose 12%. This ${hedge} a seasonal pattern.`;
      const r = scoreLegalPosture(text);
      expect(r.violations).not.toContain('no approved hedge present');
    },
  );
});
