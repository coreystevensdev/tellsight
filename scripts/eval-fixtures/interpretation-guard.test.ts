import { describe, it, expect } from 'vitest';

import { hasNumericFigure } from './interpretation-guard.js';

describe('hasNumericFigure', () => {
  it('is true when the prose itself carries a digit', () => {
    expect(hasNumericFigure('Payroll came in at $9,200 last month.')).toBe(true);
  });

  it('is true for a percent figure', () => {
    expect(hasNumericFigure('Marketing spend dropped 18% from last quarter.')).toBe(true);
  });

  it('is false when the only digits are inside a cite tag', () => {
    const text = 'Cash flow is trending in a concerning direction <cite id="5:cash_flow:_:_"/>.';
    expect(hasNumericFigure(text)).toBe(false);
  });

  it('is false when the answer has no digits anywhere', () => {
    const text = 'Cash flow has been trending in a concerning direction lately, worth keeping an eye on.';
    expect(hasNumericFigure(text)).toBe(false);
  });

  it('strips multiple cite tags before scanning', () => {
    const text = 'Revenue is up <cite id="1:trend:Revenue:0"/> and margin is steady <cite id="2:margin_trend:_:_"/>.';
    expect(hasNumericFigure(text)).toBe(false);
  });

  it('is false when the only figure restates a known figure', () => {
    expect(hasNumericFigure('Yes, payroll was $9,200 last month.', ['$9,200'])).toBe(false);
  });

  it('is true when the answer restates a known figure and adds a new one', () => {
    expect(
      hasNumericFigure('Yes, payroll was $9,200 last month, up from $8,400 the month before.', ['$9,200']),
    ).toBe(true);
  });

  it('is true for a spelled-out fraction with zero digits', () => {
    expect(hasNumericFigure('Revenue dropped almost a fifth compared to last month.')).toBe(true);
  });

  it('is false when "quarter" only refers to the calendar period', () => {
    expect(hasNumericFigure('Spending held steady this quarter compared to last quarter.')).toBe(false);
  });

  it('is false for the "double-check" idiom, since bare "double" carries no figure', () => {
    expect(hasNumericFigure("Let's double-check that number before reporting it.")).toBe(false);
  });

  it('is true for "doubled" describing an actual change', () => {
    expect(hasNumericFigure('Marketing spend basically doubled from last quarter.')).toBe(true);
  });

  it('treats a restated figure with different decimal formatting as the same figure', () => {
    expect(hasNumericFigure('Margin held at 18.0% last month.', ['18%'])).toBe(false);
  });
});
