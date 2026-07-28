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
});
