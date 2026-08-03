import { describe, it, expect } from 'vitest';

import { round4 } from './round4.js';

describe('round4', () => {
  it('rounds to 4 decimal places', () => {
    expect(round4(2 / 3)).toBe(0.6667);
  });

  it('leaves a value already at 4 decimals unchanged', () => {
    expect(round4(0.75)).toBe(0.75);
  });

  it('rounds a negative delta correctly', () => {
    expect(round4(-0.12345)).toBe(-0.1234);
  });
});
